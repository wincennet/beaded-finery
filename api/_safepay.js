/**
 * Shared Safepay helper (underscore prefix = not exposed as a public route).
 *
 * confirmTracker(redis, tracker) is the ONE place an order gets marked paid. It never
 * trusts the caller (redirect URL or webhook body): it asks Safepay's reporter API what
 * really happened to the tracker, using our secret key.
 *
 *   GET {api}/reporter/api/v1/payments/{tracker}  ->  data.tracker.state === 'TRACKER_ENDED'
 *
 * The tracker -> order mapping is the one api/pay.js stored when it created the session,
 * so a paid tracker can't be pointed at a different order.
 */
const ORDERS_KEY = 'beadedfinery:orders';
const ENV = (process.env.SAFEPAY_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
const SECRET = process.env.SAFEPAY_SECRET_KEY || '';
const API_BASE = ENV === 'production' ? 'https://api.getsafepay.com' : 'https://sandbox.api.getsafepay.com';

export const TRACKER_RE = /^[A-Za-z0-9_-]{4,120}$/;

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

/**
 * Returns { orderId, verified }.
 *   orderId  — the order this tracker belongs to ('' if we don't know it)
 *   verified — true only if the order is (now) marked paid
 */
export async function confirmTracker(redis, tracker) {
  const out = { orderId: '', verified: false };
  tracker = String(tracker || '');
  if (!redis || !SECRET || !TRACKER_RE.test(tracker)) return out;
  try {
    const list = (await redis.get(ORDERS_KEY)) || [];
    const o = Array.isArray(list) ? list.find((x) => x.safepayTracker === tracker) : null;
    if (!o) return out;
    out.orderId = o.id;
    if (o.paid) { out.verified = true; return out; }
    const t = await fetchTracker(tracker);
    if (t && t.ended) {
      o.paid = true;
      o.paidAt = new Date().toISOString();
      o.paymentRef = tracker.slice(0, 60);
      o.status = 'Processing';
      await redis.set(ORDERS_KEY, list);
      out.verified = true;
    }
  } catch (e) { /* caller redirects/acks anyway */ }
  return out;
}
