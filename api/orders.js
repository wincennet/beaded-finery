/**
 * Beaded Finery — orders API (Vercel serverless function)
 *
 * POST   /api/orders   → create an order                    [public — checkout]
 * GET    /api/orders   → list all orders (newest first)     [owner only]
 * PATCH  /api/orders   → { id, status } update one order     [owner only]
 * DELETE /api/orders   → { id } remove one order            [owner only]
 *
 * Auth: owner requests must send  x-admin-key: <ADMIN_KEY>  where ADMIN_KEY is a
 * Vercel Environment Variable (Project → Settings → Environment Variables).
 * Without ADMIN_KEY set, the owner endpoints are locked (401) — fail closed.
 *
 * Storage: Upstash Redis. Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN.
 */
import { Redis } from '@upstash/redis';

const KEY = 'beadedfinery:orders';
const MAX = 800;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

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

const isOwner = (req) => {
  if (!ADMIN_KEY) return false;
  const k = req.headers['x-admin-key'] || req.headers['X-Admin-Key'];
  return typeof k === 'string' && k === ADMIN_KEY;
};

const sanitizeOrder = (raw) => {
  const o = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(o.items)
    ? o.items.slice(0, 50).map((i) => {
        const it = {
          name: String(i.name || '').slice(0, 120),
          qty: Math.max(1, Math.min(99, Number(i.qty) || 1)),
          price: Math.max(0, Number(i.price) || 0),
        };
        if (i.size) it.size = String(i.size).slice(0, 40);
        if (i.color) it.color = String(i.color).slice(0, 40);
        return it;
      })
    : [];
  return {
    id: String(o.id || 'BF-' + Date.now().toString().slice(-7)).slice(0, 24),
    name: String(o.name || '').slice(0, 120),
    phone: String(o.phone || '').slice(0, 40),
    email: String(o.email || '').slice(0, 120),
    city: String(o.city || '').slice(0, 80),
    address: String(o.address || '').slice(0, 400),
    postal: String(o.postal || '').slice(0, 20),
    notes: String(o.notes || '').slice(0, 500),
    method: String(o.method || '').slice(0, 40),
    items,
    subtotal: Math.max(0, Number(o.subtotal) || 0),
    shipping: Math.max(0, Number(o.shipping) || 0),
    total: Math.max(0, Number(o.total) || 0),
    status: 'Pending Payment Verification',
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Owner-only methods require the admin key.
  if (['GET', 'PATCH', 'DELETE'].includes(req.method) && !isOwner(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
      const raw = readBody(req);
      if (!raw || !raw.name || !Array.isArray(raw.items) || raw.items.length === 0) {
        return res.status(400).json({ error: 'Invalid order' });
      }
      const order = sanitizeOrder(raw);
      const list = (await redis.get(KEY)) || [];
      const next = [order, ...list.filter((o) => o.id !== order.id)].slice(0, MAX);
      await redis.set(KEY, next);
      return res.status(200).json({ id: order.id, ok: true });
    }

    if (req.method === 'PATCH') {
      const { id, status } = readBody(req);
      const allowed = ['Pending Payment Verification', 'Processing', 'Shipped'];
      if (!allowed.includes(status)) return res.status(400).json({ error: 'Bad status' });
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
