/**
 * Beaded Finery — tiny shared helpers for the API routes.
 * Filename starts with "_" so Vercel does NOT expose this as its own endpoint.
 */

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
