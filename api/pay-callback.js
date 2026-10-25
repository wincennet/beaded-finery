/**
 * Beaded Finery — Safepay return handler
 *
 * Safepay sends the shopper back here after the hosted page, with ?tracker=track_...
 * We do NOT trust that URL: confirmTracker() (api/_safepay.js) asks Safepay's reporter API
 * what actually happened to the tracker and only marks the order paid if it ended
 * successfully. Then we 302 the browser to a friendly confirmation page.
 *
 * Every card order is also visible in the admin panel regardless, and /api/pay-webhook is
 * a backup path if the shopper never makes it back here.
 */
import { Redis } from '@upstash/redis';
import { confirmTracker } from './_safepay.js';
import { clientIp, rateLimited, siteUrl } from './_lib.js';

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) { redis = null; }

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
  const tracker = String(p.tracker || p.beacon || '').slice(0, 120);

  // each valid-looking callback can trigger a call to Safepay — cap how fast one visitor can do that
  if (await rateLimited(redis, `beadedfinery:rl:paycb:${clientIp(req)}`, 60, 600)) {
    res.statusCode = 302;
    res.setHeader('Location', `${base}/?paycheck=`);
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }

  const { orderId, verified } = await confirmTracker(redis, tracker);

  const dest = verified
    ? `${base}/?paid=${encodeURIComponent(orderId)}`
    : `${base}/?paycheck=${encodeURIComponent(orderId)}`; // unverified -> "we're confirming"
  res.statusCode = 302;
  res.setHeader('Location', dest);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}
