/**
 * Beaded Finery — Safepay webhook (backup confirmation)
 *
 * POST /api/pay-webhook   <- Safepay (Dashboard -> Developer -> Endpoints -> + Add an endpoint)
 *
 * The browser redirect to /api/pay-callback is the normal confirmation, but a shopper can
 * pay and then close the tab before being redirected. Safepay's webhook covers that gap.
 *
 * Security:
 *   1. Signature: header X-SFPY-SIGNATURE = hex HMAC-SHA512 of the payload, keyed with the
 *      endpoint's "shared secret" (env SAFEPAY_WEBHOOK_SECRET). Invalid -> 401, nothing done.
 *   2. Even a valid webhook is only used to learn WHICH tracker to check: the payment state
 *      itself is re-fetched from Safepay's reporter API (see _safepay.js), so we never rely
 *      on the shape of the webhook body.
 *
 * Responds 200 quickly (Safepay requires an answer within 10 seconds).
 */
import crypto from 'node:crypto';
import { Redis } from '@upstash/redis';
import { confirmTracker } from './_safepay.js';

// we need the exact bytes Safepay signed, so skip Vercel's JSON body parsing
export const config = { api: { bodyParser: false } };

const WEBHOOK_SECRET = process.env.SAFEPAY_WEBHOOK_SECRET || '';

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) { redis = null; }

/** Raw request bytes; falls back to re-serialising if the platform already parsed the body. */
async function rawBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    return Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  }
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function signatureOk(secret, header, candidates) {
  const sig = String(header || '').trim().toLowerCase();
  if (!secret || !sig) return false;
  for (const bytes of candidates) {
    const expected = crypto.createHmac('sha512', secret).update(bytes).digest('hex');
    if (expected.length === sig.length) {
      try { if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return true; } catch (e) { /* next */ }
    }
  }
  return false;
}

/** First string anywhere in the payload that looks like a Safepay tracker token. */
function findTracker(node, depth = 0) {
  if (depth > 6 || node == null) return '';
  if (typeof node === 'string') return /^track_[A-Za-z0-9_-]+$/.test(node) ? node : '';
  if (Array.isArray(node)) {
    for (const v of node) { const t = findTracker(v, depth + 1); if (t) return t; }
    return '';
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) { const t = findTracker(v, depth + 1); if (t) return t; }
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook not configured' });

  let raw;
  try { raw = await rawBody(req); } catch (e) { return res.status(400).json({ error: 'Bad body' }); }
  if (raw.length > 200000) return res.status(413).json({ error: 'Too large' });

  let payload = null;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { /* not JSON */ }

  // Safepay's docs show both "raw body" and "JSON.stringify(payload)" — accept either form.
  const candidates = [raw];
  if (payload !== null) candidates.push(Buffer.from(JSON.stringify(payload)));
  if (!signatureOk(WEBHOOK_SECRET, req.headers['x-sfpy-signature'], candidates)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const tracker = findTracker(payload);
  if (tracker) await confirmTracker(redis, tracker);   // ack either way; failures are retried by Safepay's own queue only on non-2xx
  return res.status(200).json({ ok: true });
}
