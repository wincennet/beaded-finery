/**
 * Beaded Finery — card payment (Safepay hosted checkout)
 *
 * GET  /api/pay            -> { enabled, env }         [public]  frontend uses this to
 *                                                                show the "Card" option
 * POST /api/pay { orderId }-> { url }                  [public]  creates a Safepay
 *                                                                checkout session for an
 *                                                                order that already
 *                                                                exists in Redis, returns
 *                                                                the URL to redirect the
 *                                                                shopper to.
 *
 * The shopper pays on Safepay's PCI-compliant page, then Safepay redirects to
 * /api/pay-callback which verifies the signature and marks the order paid.
 *
 * Env vars (set in Vercel once the merchant account is approved):
 *   SAFEPAY_ENV         "sandbox" | "production"     (default "sandbox")
 *   SAFEPAY_SECRET_KEY  sec_xxxxxxxx                 (from the Safepay dashboard)
 *   SITE_URL            https://beadedfinery.com     (optional; else derived from host)
 */
import { Redis } from '@upstash/redis';

const ORDERS_KEY = 'beadedfinery:orders';
const ENV = (process.env.SAFEPAY_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const SECRET = process.env.SAFEPAY_SECRET_KEY || '';
const ENABLED = !!SECRET;

const API_BASE = ENV === 'production'
  ? 'https://api.getsafepay.com'
  : 'https://sandbox.api.getsafepay.com';
const COMPONENTS_URL = ENV === 'production'
  ? 'https://www.getsafepay.com/components'
  : 'https://sandbox.api.getsafepay.com/components';

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
    const { orderId } = readBody(req);
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    // Look up the order the shopper just created — never trust an amount from the client.
    const list = (await redis.get(ORDERS_KEY)) || [];
    const order = Array.isArray(list) ? list.find((o) => o.id === orderId) : null;
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paid) return res.status(409).json({ error: 'Order already paid' });

    const amount = Math.max(1, Math.round(Number(order.total) || 0)); // PKR, whole rupees

    // 1. Create a Safepay payment session (tracker).
    const initRes = await fetch(`${API_BASE}/order/v1/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: SECRET,
        amount,
        currency: 'PKR',
        environment: ENV,
      }),
    });
    const initJson = await initRes.json().catch(() => ({}));
    // response shape has been { token } or { data: { token } } across Safepay versions
    const tracker = initJson.token || (initJson.data && (initJson.data.token || initJson.data.tracker)) || '';
    if (!initRes.ok || !tracker) {
      return res.status(502).json({ error: 'Safepay session failed', detail: initJson });
    }

    // 2. Build the hosted-checkout URL to send the shopper to.
    const base = siteUrl(req);
    const params = new URLSearchParams({
      env: ENV,
      beacon: tracker,
      source: 'beadedfinery',
      order_id: order.id,
      redirect_url: `${base}/api/pay-callback`,
      cancel_url: `${base}/?checkout=cancelled&order=${encodeURIComponent(order.id)}`,
    });

    return res.status(200).json({ url: `${COMPONENTS_URL}?${params.toString()}`, tracker });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
