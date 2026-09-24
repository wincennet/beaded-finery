/**
 * Beaded Finery — category / collection cover photos
 *
 * GET /api/covers                    -> { "Bangles": "data:image/...", "Bridal Radiance": "...", ... }   [public]
 * PUT /api/covers { name, image }    -> set one cover (image = data: URI or https URL)                [owner — x-admin-key]
 * PUT /api/covers { name, image:'' } -> remove that cover (site falls back to a product photo)        [owner]
 *
 * Stored one field per cover in the Redis hash "beadedfinery:covers" so each upload is a small,
 * independent request (a single big settings blob would exceed Upstash's request-size limit).
 */
import { Redis } from '@upstash/redis';

const KEY = 'beadedfinery:covers';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_IMG = 250000;   // chars — the admin shrinks covers to ~70 KB before sending

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
const okImg = (v) => typeof v === 'string' && v.length < MAX_IMG && (/^data:image\/(jpeg|png|webp);base64,/.test(v) || /^https:\/\//.test(v));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'PUT' && !isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!redis) {
    if (req.method === 'GET') return res.status(200).json({});
    return res.status(200).json({ ok: true, persisted: false });
  }

  try {
    if (req.method === 'GET') {
      const all = (await redis.hgetall(KEY)) || {};
      const out = {};
      for (const [k, v] of Object.entries(all)) if (okImg(v)) out[k] = v;
      return res.status(200).json(out);
    }
    if (req.method === 'PUT') {
      const { name, image } = readBody(req);
      const field = String(name || '').trim().slice(0, 60);
      if (!field) return res.status(400).json({ error: 'name required' });
      if (!image) { await redis.hdel(KEY, field); return res.status(200).json({ ok: true, removed: true }); }
      if (!okImg(image)) return res.status(400).json({ error: 'Image must be a JPG/PNG/WebP under ~180 KB' });
      await redis.hset(KEY, { [field]: image });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
