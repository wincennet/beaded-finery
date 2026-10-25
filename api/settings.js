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
import { ownerAuth, denyOwner, cors } from './_lib.js';

const KEY = 'beadedfinery:settings';

import { DEFAULTS, DEFAULT_ZONES } from './_ship.js';

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
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : d; };

function sanitize(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const zonesIn = (s.intl && s.intl.zones && typeof s.intl.zones === 'object') ? s.intl.zones : {};
  const zones = {};
  for (const [k, v] of Object.entries(zonesIn).slice(0, 300)) {
    const code = String(k).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    if (code.length === 2) zones[code] = num(v, DEFAULTS.intl.default);
  }
  const okImg = (v) => (/^data:image\//.test(v) || /^https?:\/\//.test(v)) && v.length < 800000;
  const whyImg = String((s.home && s.home.whyImg) || '');
  const heroImg = String((s.home && s.home.heroImg) || '');
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
    home: {
      whyImg: okImg(whyImg) ? whyImg : '',
      heroImg: okImg(heroImg) ? heroImg : '',
    },
  };
}

export default async function handler(req, res) {
  cors(req, res, 'GET, PUT, OPTIONS');
  // NOTE: vercel.json forces Cache-Control: no-store on every /api/* path at the
  // platform level (deliberately, since that's what fixed the geo/currency-leaking
  // bug earlier) — it wins over anything set here, so this stays no-store too.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'PUT') { const auth = await ownerAuth(req, redis); if (!auth.ok) return denyOwner(res, auth); }

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
