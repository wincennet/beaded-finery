/**
 * Beaded Finery — Safepay redirect callback
 *
 * Safepay sends the shopper here after payment (GET or POST) with:
 *   order_id, tracker, reference (Safepay ref code), sig / signature (HMAC-SHA256)
 *
 * We verify  HMAC_SHA256(tracker, SAFEPAY_SECRET_KEY) === signature , mark the order
 * paid in Redis, then 302 the browser to a friendly confirmation page.
 *
 * This is the primary confirmation for a small shop. Every card order is also visible
 * in the admin panel regardless, so nothing is ever lost if a redirect is missed.
 */
import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';

const ORDERS_KEY = 'beadedfinery:orders';
const SECRET = process.env.SAFEPAY_SECRET_KEY || '';

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

export default async function handler(req, res) {
  const base = siteUrl(req);
  const p = collectParams(req);
  const orderId = p.order_id || p.orderId || '';
  const tracker = p.tracker || p.beacon || '';
  const sig = p.sig || p.signature || '';
  const reference = p.reference || p.ref || p.reference_code || '';

  const expected = SECRET && tracker
    ? crypto.createHmac('sha256', SECRET).update(String(tracker)).digest('hex')
    : '';
  let verified = false;
  if (expected && sig && String(sig).length === expected.length) {
    try {
      verified = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
    } catch (e) { verified = false; }
  }

  if (verified && redis && orderId) {
    try {
      const list = (await redis.get(ORDERS_KEY)) || [];
      const o = Array.isArray(list) ? list.find((x) => x.id === orderId) : null;
      if (o && !o.paid) {
        o.paid = true;
        o.paidAt = new Date().toISOString();
        o.paymentRef = String(reference || tracker).slice(0, 60);
        o.status = 'Processing';
        await redis.set(ORDERS_KEY, list);
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
