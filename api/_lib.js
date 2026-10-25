/**
 * Beaded Finery — shared helpers for the API routes.
 * Filename starts with "_" so Vercel does NOT expose this as its own endpoint.
 */
import crypto from 'node:crypto';

/** Best-effort caller IP behind Vercel's proxy. */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Simple fixed-window rate limit backed by Redis (INCR + EXPIRE).
 * Returns true if the caller is OVER the limit (i.e. should be rejected).
 * Fails OPEN on any Redis error — a hiccup in the limiter should never block
 * a real customer from placing an order.
 */
export async function rateLimited(redis, key, limit, windowSec) {
  if (!redis) return false;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    return count > limit;
  } catch (e) {
    return false;
  }
}

/** Constant-time string comparison (hashes first so length differences don't leak either). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const AUTH_FAIL_LIMIT = 12;      // wrong keys allowed ...
const AUTH_FAIL_WINDOW = 900;    // ... per 15 minutes, per IP

/**
 * Owner (admin) check for every protected route.
 *  - constant-time comparison against ADMIN_KEY
 *  - locks an IP out for 15 minutes after 12 wrong keys, so the key can't be brute-forced
 *  - fails closed: with no ADMIN_KEY configured nobody is the owner
 * Returns { ok, locked }.
 */
export async function ownerAuth(req, redis) {
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const supplied = req.headers['x-admin-key'];
  if (!ADMIN_KEY || typeof supplied !== 'string' || !supplied) return { ok: false, locked: false };
  const failKey = `beadedfinery:rl:authfail:${clientIp(req)}`;
  if (redis) {
    try {
      const n = Number(await redis.get(failKey)) || 0;
      if (n >= AUTH_FAIL_LIMIT) return { ok: false, locked: true };
    } catch (e) { /* fail open on limiter errors */ }
  }
  if (safeEqual(supplied, ADMIN_KEY)) return { ok: true, locked: false };
  if (redis) {
    try {
      const c = await redis.incr(failKey);
      if (c === 1) await redis.expire(failKey, AUTH_FAIL_WINDOW);
    } catch (e) { /* ignore */ }
  }
  return { ok: false, locked: false };
}

/** Standard rejection for a failed owner check. */
export function denyOwner(res, auth) {
  if (auth && auth.locked) return res.status(429).json({ error: 'Too many wrong attempts — try again in 15 minutes.' });
  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * CORS: the storefront and the API are the same site, so browsers never need CORS for
 * our own pages. Only echo an origin back if it is ours — a random website must not be
 * able to read API responses from a visitor's browser.
 */
const ALLOWED_ORIGIN = /^https:\/\/((www\.)?beadedfinery\.com|[a-z0-9-]+\.vercel\.app)$/i;
export function cors(req, res, methods) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
}

/**
 * Our own public address, used for payment redirects. Never trust the Host header blindly:
 * only our domains (and Vercel preview URLs) are accepted, everything else falls back to the
 * real site, so a forged Host can't turn a redirect into an open redirect.
 */
export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (/^((www\.)?beadedfinery\.com|[a-z0-9-]+\.vercel\.app)$/.test(host)) return `https://${host}`;
  return 'https://beadedfinery.com';
}
