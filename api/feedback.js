/**
 * Beaded Finery — customer feedback / reviews API
 *
 * POST   /api/feedback            create a review            [public]
 * GET    /api/feedback?public=1   approved reviews only      [public]
 * GET    /api/feedback            all reviews                [owner — x-admin-key]
 * PATCH  /api/feedback            { id, approved }           [owner]
 * DELETE /api/feedback            { id }                     [owner]
 *
 * Storage: Upstash Redis, key "beadedfinery:feedback".
 */
import { Redis } from '@upstash/redis';

const KEY = 'beadedfinery:feedback';
const MAX = 500;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

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
const isOwner = (req) => ADMIN_KEY && req.headers['x-admin-key'] === ADMIN_KEY;
const publicView = (f) => ({ id: f.id, name: f.name, rating: f.rating, message: f.message, date: f.date });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const wantsPublic = req.method === 'GET' && (req.query?.public || /[?&]public/.test(req.url || ''));

  // owner-only unless it's a public GET or a POST
  if (['PATCH', 'DELETE'].includes(req.method) && !isOwner(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method === 'GET' && !wantsPublic && !isOwner(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!redis) {
    if (req.method === 'GET') return res.status(200).json([]);
    return res.status(200).json({ ok: true, persisted: false });
  }

  try {
    const list = (await redis.get(KEY)) || [];

    if (req.method === 'GET') {
      if (wantsPublic) {
        return res.status(200).json(list.filter((f) => f.approved).map(publicView).slice(0, 60));
      }
      return res.status(200).json(list);
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      const name = String(b.name || '').trim().slice(0, 60);
      const message = String(b.message || '').trim().slice(0, 600);
      const rating = Math.max(1, Math.min(5, Math.round(Number(b.rating) || 5)));
      if (!name || message.length < 3) return res.status(400).json({ error: 'Name and message required' });
      const item = {
        id: 'FB-' + Date.now().toString(36),
        name, message, rating,
        approved: false,
        date: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      };
      await redis.set(KEY, [item, ...list].slice(0, MAX));
      return res.status(200).json({ ok: true, id: item.id });
    }

    if (req.method === 'PATCH') {
      const { id, approved } = readBody(req);
      const f = list.find((x) => x.id === id);
      if (f) f.approved = !!approved;
      await redis.set(KEY, list);
      return res.status(200).json({ ok: true, updated: !!f });
    }

    if (req.method === 'DELETE') {
      const { id } = readBody(req);
      const next = list.filter((x) => x.id !== id);
      await redis.set(KEY, next);
      return res.status(200).json({ ok: true, removed: list.length - next.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
