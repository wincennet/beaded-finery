/**
 * Beaded Finery — Safepay return handler
 *
 * Safepay sends the shopper back here after the hosted page, with ?tracker=track_...
 * We do NOT trust that URL: we ask Safepay's reporter API (with our secret key) what
 * actually happened to that tracker, and only mark the order paid if the tracker has
 * ended successfully. The tracker -> order mapping is the one we stored when we created
 * the session, so a shopper can't point a paid tracker at a different order.
 *
 *   GET {api}/reporter/api/v1/payments/{tracker}   ->  data.tracker.state === 'TRACKER_ENDED'
 *
 * Then 302 the browser to a friendly confirmation page. Every card order is also visible
 * in the admin panel regardless, so nothing is lost if a redirect is missed.
 */
import { Redis } from '@upstash/redis';

const ORDERS_KEY = 'beadedfinery:orders';
const ENV = (process.env.SAFEPAY_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const SECRET = process.env.SAFEPAY_SECRET_KEY || '';
const API_BASE = ENV === 'production' ? 'https://api.getsafepay.com' : 'https://sandbox.api.getsafepay.com';

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) { redis = null; }

function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function collectParams(req) {
  const out = { ...(req.query || {}) };
  if (req.body && typeof req.body === 'object') Object.assign(out, req.body);
  else if (typeof req.body === 'string' && req.body) {
    try { Object.assign(out, JSON.parse(req.body)); }
    catch (e) { for (const [k, v] of new URLSearchParams(req.body)) out[k] = v; }
  }
  return out;
}

/** Ask Safepay for the tracker's real state. Returns { ended } or null if unreachable. */
async function fetchTracker(tracker) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${API_BASE}/reporter/api/v1/payments/${encodeURIComponent(tracker)}`, {
      headers: { 'X-SFPY-MERCHANT-SECRET': SECRET },
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const state = j && j.data && j.data.tracker && j.data.tracker.state;
    return { ended: state === 'TRACKER_ENDED' };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const base = siteUrl(req);
  const p = collectParams(req);
  const tracker = String(p.tracker || p.beacon || '').slice(0, 120);

  let orderId = '';
  let verified = false;

  if (tracker && /^[A-Za-z0-9_-]+$/.test(tracker) && redis && SECRET) {
    try {
      const list = (await redis.get(ORDERS_KEY)) || [];
      const o = Array.isArray(list) ? list.find((x) => x.safepayTracker === tracker) : null;
      if (o) {
        orderId = o.id;
        if (o.paid) {
          verified = true;
        } else {
          const t = await fetchTracker(tracker);
          if (t && t.ended) {
            o.paid = true;
            o.paidAt = new Date().toISOString();
            o.paymentRef = tracker.slice(0, 60);
            o.status = 'Processing';
            await redis.set(ORDERS_KEY, list);
            verified = true;
          }
        }
      }
    } catch (e) { /* fall through to the redirect anyway */ }
  }

  const dest = verified
    ? `${base}/?paid=${encodeURIComponent(orderId)}`
    : `${base}/?paycheck=${encodeURIComponent(orderId)}`; // unverified -> "we're confirming"
  res.statusCode = 302;
  res.setHeader('Location', dest);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}
