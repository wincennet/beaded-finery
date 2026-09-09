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

// suggested courier rates from Pakistan for a small (~250 g) jewellery parcel (PKR), by region
const DEFAULT_ZONES = {
  // Gulf & Middle East
  AE: 1500, SA: 1500, QA: 1600, KW: 1600, BH: 1600, OM: 1600, JO: 1800, LB: 2000, IL: 2200, TR: 2200, IQ: 2000, IR: 1800, AF: 1500,
  // South Asia
  BD: 1500, LK: 1500, NP: 1500, BT: 1600, MV: 1800,
  // East & Southeast Asia
  CN: 2800, HK: 2800, TW: 2800, JP: 3000, KR: 3000, SG: 2800, MY: 2800, TH: 2800, ID: 3000, PH: 3000, VN: 3000, KH: 3200, MM: 3000, BN: 3000,
  // UK & Europe
  GB: 3200, IE: 3200, DE: 3200, FR: 3200, IT: 3200, ES: 3200, PT: 3400, NL: 3200, BE: 3200, LU: 3300, AT: 3300, CH: 3400,
  SE: 3500, NO: 3600, DK: 3500, FI: 3500, IS: 3800, PL: 3300, CZ: 3300, SK: 3300, HU: 3300, RO: 3400, BG: 3400, GR: 3400,
  HR: 3400, RS: 3400, SI: 3300, UA: 3400, RU: 3600, CY: 3400, MT: 3400, EE: 3400, LV: 3400, LT: 3400,
  // North America
  US: 3200, CA: 3300,
  // Oceania
  AU: 3500, NZ: 3700,
  // Africa
  EG: 3000, MA: 3200, TN: 3200, DZ: 3200, ZA: 4000, NG: 4200, KE: 4000, GH: 4200, TZ: 4000, UG: 4200, ET: 4200, RW: 4200,
  MU: 3600, ZM: 4200, ZW: 4200, BW: 4000, NA: 4000, SN: 4200,
  // Central Asia & Caucasus
  KZ: 2600, UZ: 2600, AZ: 2600, GE: 2600, AM: 2600,
  // Latin America & Caribbean
  BR: 4500, MX: 4300, AR: 4500, CL: 4500, CO: 4300, PE: 4500, UY: 4500, EC: 4300, CR: 4300, PA: 4300, DO: 4300, GT: 4300, JM: 4300, TT: 4300,
};

const DEFAULTS = {
  pk: { rate: 300, freeOver: 3000 },
  blocked: ['IN'],
  intl: { default: 2500, zones: DEFAULT_ZONES },
  home: { whyImg: '', heroImg: '' },   // editable homepage photos (data URI or URL)
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
