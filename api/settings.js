/**
 * Beaded Finery — store settings (shipping rules)
 *
 * GET /api/settings  -> shipping config (public; merged with defaults)
 * PUT /api/settings  -> replace config (owner; x-admin-key)
 *
 * All money values are in PKR (the owner manages everything in rupees;
 * the storefront converts for display).
 *
 * Shape:
 * {
 *   pk:      { rate: 300, freeOver: 3000 },
 *   blocked: ["IN"],                       // ISO-2 country codes we don't ship to
 *   intl:    { default: 2500, zones: { "US": 3000, "AE": 1500, ... } }
 * }
 */
import { Redis } from '@upstash/redis';

const KEY = 'beadedfinery:settings';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const DEFAULTS = {
  pk: { rate: 300, freeOver: 3000 },
  blocked: ['IN'],
  intl: {
    default: 2500,
    zones: { US: 3000, GB: 3000, CA: 3200, AU: 3200, DE: 3000, FR: 3000, AE: 1500, SA: 1500 },
  },
};

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
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : d; };

function sanitize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const zonesIn = (s.intl && s.intl.zones && typeof s.intl.zones === 'object') ? s.intl.zones : {};
  const zones = {};
  for (const [k, v] of Object.entries(zonesIn).slice(0, 100)) {
    const code = String(k).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    if (code.length === 2) zones[code] = num(v, DEFAULTS.intl.default);
  }
  return {
    pk: {
      rate: num(s.pk && s.pk.rate, DEFAULTS.pk.rate),
      freeOver: num(s.pk && s.pk.freeOver, DEFAULTS.pk.freeOver),
    },
    blocked: Array.isArray(s.blocked)
      ? [...new Set(s.blocked.map((c) => String(c).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)).filter((c) => c.length === 2))].slice(0, 60)
      : DEFAULTS.blocked,
    intl: {
      default: num(s.intl && s.intl.default, DEFAULTS.intl.default),
      zones,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'PUT' && !isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (!redis) {
    if (req.method === 'GET') return res.status(200).json(DEFAULTS);
    return res.status(200).json({ ok: true, persisted: false });
  }

  try {
    if (req.method === 'GET') {
      const saved = await redis.get(KEY);
      return res.status(200).json(saved ? sanitize(saved) : DEFAULTS);
    }
    if (req.method === 'PUT') {
      const clean = sanitize(readBody(req));
      await redis.set(KEY, clean);
      return res.status(200).json({ ok: true, settings: clean });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
