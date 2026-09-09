/**
 * Beaded Finery — orders API (Vercel serverless function)
 *
 * GET    /api/orders        → list all orders (newest first)   [owner admin panel]
 * POST   /api/orders        → create an order                  [checkout]
 * PATCH  /api/orders        → { id, status } update one order   [admin status toggle]
 * DELETE /api/orders        → { id } remove one order          [admin delete]
 *
 * Storage: Upstash Redis (Vercel Marketplace → "Upstash for Redis", free tier).
 * Once connected to the project, Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN
 * (or UPSTASH_REDIS_REST_URL / _TOKEN). Until then this endpoint still responds
 * gracefully (empty list / accepts but does not persist) so the site keeps working.
 */
import { Redis } from '@upstash/redis';

const KEY = 'beadedfinery:orders';
const MAX = 800;

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) {
  redis = null;
}

const readBody = (req) => {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // No datastore connected yet — degrade gracefully instead of 500ing.
  if (!redis) {
    if (req.method === 'GET') return res.status(200).json([]);
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      return res.status(200).json({ ok: true, persisted: false });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (req.method === 'GET') {
      const list = (await redis.get(KEY)) || [];
      return res.status(200).json(Array.isArray(list) ? list : []);
    }

    if (req.method === 'POST') {
      const order = readBody(req);
      order.id = order.id || 'BF-' + Date.now().toString().slice(-7);
      order.createdAt = new Date().toISOString();
      order.status = order.status || 'Pending Payment Verification';
      const list = (await redis.get(KEY)) || [];
      const next = [order, ...list.filter((o) => o.id !== order.id)].slice(0, MAX);
      await redis.set(KEY, next);
      return res.status(200).json(order);
    }

    if (req.method === 'PATCH') {
      const { id, status } = readBody(req);
      const list = (await redis.get(KEY)) || [];
      const o = list.find((x) => x.id === id);
      if (o) o.status = status;
      await redis.set(KEY, list);
      return res.status(200).json({ ok: true, updated: !!o });
    }

    if (req.method === 'DELETE') {
      const { id } = readBody(req);
      const list = (await redis.get(KEY)) || [];
      const next = list.filter((o) => o.id !== id);
      await redis.set(KEY, next);
      return res.status(200).json({ ok: true, removed: list.length - next.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
