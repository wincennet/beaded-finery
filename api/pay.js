/**
 * Beaded Finery — card payment (Safepay Express Checkout / hosted page)
 *
 * GET  /api/pay             -> { enabled, env }   [public]  frontend uses this to show the "Card" option
 * POST /api/pay { orderId } -> { url }            [public]  creates a Safepay payment session for an
 *                                                           order that already exists in Redis and
 *                                                           returns the hosted-checkout URL.
 *
 * Flow (https://safepay-docs.netlify.app/build-your-integration/express-checkout):
 *   1. POST {api}/order/payments/v3/        -> tracker token        (secret key header + public key in body)
 *   2. POST {api}/client/passport/v1/token  -> short-lived "tbt"    (secret key header)
 *   3. redirect shopper to {checkout}/embedded/?tracker=..&tbt=..&redirect_url=..&cancel_url=..
 *   4. Safepay sends the shopper back to /api/pay-callback?tracker=..  -> verified there.
 *
 * Env vars (Vercel -> Settings -> Environment Variables):
 *   SAFEPAY_SECRET_KEY   server-side secret key from the Safepay dashboard   (required)
 *   SAFEPAY_PUBLIC_KEY   client-side / public key from the same dashboard    (required)
 *   SAFEPAY_ENV          "sandbox" | "production"            (default "sandbox")
 *   SAFEPAY_INTENT       "CYBERSOURCE" (default) or whatever Safepay enables for the merchant
 *   SITE_URL             https://beadedfinery.com            (optional; else derived from host)
 */
import { Redis } from '@upstash/redis';
import { clientIp, rateLimited } from './_lib.js';

const ORDERS_KEY = 'beadedfinery:orders';
const ENV = (process.env.SAFEPAY_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const SECRET = process.env.SAFEPAY_SECRET_KEY || '';
const PUBLIC = process.env.SAFEPAY_PUBLIC_KEY || '';
const INTENT = (process.env.SAFEPAY_INTENT || 'CYBERSOURCE').toUpperCase();
const ENABLED = !!(SECRET && PUBLIC);

const API_BASE = ENV === 'production' ? 'https://api.getsafepay.com' : 'https://sandbox.api.getsafepay.com';
const CHECKOUT_BASE = ENV === 'production' ? 'https://getsafepay.com/embedded/' : 'https://sandbox.api.getsafepay.com/embedded/';

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) { redis = null; }

const readBody = (req) => {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
};

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

/** POST JSON to Safepay with the merchant secret, time-boxed so a hung upstream fails fast. */
async function safepayPost(path, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SFPY-MERCHANT-SECRET': SECRET },
      body: JSON.stringify(body || {}),
      signal: ac.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({ enabled: ENABLED, env: ENV });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!ENABLED) return res.status(503).json({ error: 'Card payments are not set up yet' });
  if (!redis) return res.status(503).json({ error: 'Store database unavailable' });

  try {
    // a shopper retrying a stuck payment might hit this a few times — cap it well
    // above that so it only catches actual abuse, not a real checkout
    if (await rateLimited(redis, `beadedfinery:rl:pay:${clientIp(req)}`, 30, 600)) {
      return res.status(429).json({ error: 'Too many payment attempts — please wait a moment and try again.' });
    }

    const { orderId } = readBody(req);
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    // Look up the order the shopper just created — never trust an amount from the client.
    const list = (await redis.get(ORDERS_KEY)) || [];
    const order = Array.isArray(list) ? list.find((o) => o.id === orderId) : null;
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paid) return res.status(409).json({ error: 'Order already paid' });

    // Safepay wants the currency's minor unit: PKR is sent in paisa (1 rupee = 100 paisa).
    const rupees = Math.max(1, Math.round(Number(order.total) || 0));
    const amount = rupees * 100;

    // 1. payment session -> tracker
    let session;
    try {
      session = await safepayPost('/order/payments/v3/', {
        merchant_api_key: PUBLIC,
        intent: INTENT,
        mode: 'payment',
        currency: 'PKR',
        amount,
        metadata: { order_id: order.id },
      });
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      return res.status(504).json({ error: timedOut ? 'Safepay took too long to respond — please try again.' : 'Could not reach Safepay' });
    }
    const tracker = session.json && session.json.data && session.json.data.tracker && session.json.data.tracker.token;
    if (!session.ok || !tracker) {
      return res.status(502).json({ error: 'Safepay session failed', detail: session.json });
    }

    // 2. short-lived auth token for the hosted page
    let pass;
    try {
      pass = await safepayPost('/client/passport/v1/token', {});
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      return res.status(504).json({ error: timedOut ? 'Safepay took too long to respond — please try again.' : 'Could not reach Safepay' });
    }
    const tbt = pass.json && pass.json.data;
    if (!pass.ok || typeof tbt !== 'string' || !tbt) {
      return res.status(502).json({ error: 'Safepay auth token failed', detail: pass.json });
    }

    // remember which tracker belongs to this order — the callback finds the order by it
    order.safepayTracker = tracker;
    await redis.set(ORDERS_KEY, list);

    // 3. hosted-checkout URL. redirect_url deliberately has no query string of its own:
    // Safepay appends ?tracker=... to it on return.
    const base = siteUrl(req);
    const params = new URLSearchParams({
      environment: ENV,
      tracker,
      tbt,
      source: 'hosted',
      redirect_url: `${base}/api/pay-callback`,
      cancel_url: `${base}/?checkout=cancelled&order=${encodeURIComponent(order.id)}`,
    });

    return res.status(200).json({ url: `${CHECKOUT_BASE}?${params.toString()}`, tracker });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
