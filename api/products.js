/**
 * Beaded Finery — product catalogue API
 *
 * GET    /api/products          list all products                 [public]
 * PUT    /api/products          { product } upsert one            [owner]
 * PUT    /api/products          { products:[...] } replace all    [owner — "publish catalogue"]
 * DELETE /api/products          { id } remove one                 [owner]
 *
 * Storage: Upstash Redis hash "beadedfinery:products" (field = product id, value = JSON).
 * Product images are stored inline as compressed data: URIs (the admin shrinks them
 * client-side before sending) or as plain http(s) URLs.
 */
import { Redis } from '@upstash/redis';

const KEY = 'beadedfinery:products';
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

const CATEGORIES = ['Bangles','Bracelets','Rings/Ringlets','Earrings','Necklaces','Anklets','Stainless steel jewelry','Sets','Keychains','Others'];

function clean(p) {
  const o = p && typeof p === 'object' ? p : {};
  const out = {
    id: String(o.id || 'p' + Math.random().toString(36).slice(2, 9)).slice(0, 32),
    name: String(o.name || '').slice(0, 120),
    category: CATEGORIES.includes(o.category) ? o.category : 'Others',
    price: Math.max(0, Math.round(Number(o.price) || 0)),
    stock: o.stock !== false,
    bestSeller: !!o.bestSeller,
    newArrival: !!o.newArrival,
    desc: String(o.desc || '').slice(0, 600),
    tag: o.tag ? String(o.tag).slice(0, 30) : undefined,
  };
  if (o.oldPrice) out.oldPrice = Math.max(0, Math.round(Number(o.oldPrice)));
  const sizes = Array.isArray(o.sizes)
    ? [...new Set(o.sizes.map((s) => String(s || '').replace(/[|"']/g, '').trim().slice(0, 20)).filter(Boolean))].slice(0, 24)
    : [];
  if (sizes.length) out.sizes = sizes;
  // accept data:image URIs (compressed by the client) and normal http(s) URLs
  const okImg = (s) => s && (/^data:image\//.test(s) || /^https?:\/\//.test(s)) && s.length < 800000;
  let imgs = Array.isArray(o.images) ? o.images.map((x) => String(x || '')).filter(okImg) : [];
  const single = o.img ? String(o.img) : '';
  if (!imgs.length && okImg(single)) imgs = [single];
  imgs = imgs.slice(0, 6);
  // backstop so one product can't blow up the Redis field
  while (imgs.length > 1 && imgs.join('').length > 1600000) imgs.pop();
  if (imgs.length) { out.images = imgs; out.img = imgs[0]; }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (['PUT', 'DELETE'].includes(req.method) && !isOwner(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!redis) {
    if (req.method === 'GET') return res.status(200).json([]);
    return res.status(200).json({ ok: true, persisted: false });
  }

  try {
    if (req.method === 'GET') {
      const hash = (await redis.hgetall(KEY)) || {};
      const list = Object.values(hash).map((v) => (typeof v === 'string' ? JSON.parse(v) : v));
      return res.status(200).json(list);
    }

    if (req.method === 'PUT') {
      const body = readBody(req);
      if (Array.isArray(body.products)) {
        // replace the whole catalogue
        await redis.del(KEY);
        const entries = {};
        for (const p of body.products.slice(0, 300)) { const c = clean(p); entries[c.id] = JSON.stringify(c); }
        if (Object.keys(entries).length) await redis.hset(KEY, entries);
        return res.status(200).json({ ok: true, count: Object.keys(entries).length });
      }
      const c = clean(body.product || body);
      if (!c.name) return res.status(400).json({ error: 'Name required' });
      await redis.hset(KEY, { [c.id]: JSON.stringify(c) });
      return res.status(200).json({ ok: true, product: c });
    }

    if (req.method === 'DELETE') {
      const { id } = readBody(req);
      if (id) await redis.hdel(KEY, id);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
