/**
 * Beaded Finery — visitor geo + currency rates
 *
 * GET /api/geo -> { country, currency, symbol, rate, rates }
 *   country : ISO-2 from Vercel's edge geo header (may be null locally)
 *   currency: best-guess currency for that country
 *   rate    : how many <currency> per 1 PKR
 *   rates   : full PKR->X map so the client can switch currency without another call
 *
 * FX rates come from open.er-api.com (free, no key), cached 12h in Redis,
 * with a hard-coded fallback so pricing never breaks.
 */
import { Redis } from '@upstash/redis';

const RATES_KEY = 'beadedfinery:fxrates';

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) { redis = null; }

const FALLBACK = { PKR: 1, USD: 0.0036, GBP: 0.0028, EUR: 0.0033, AED: 0.0132, SAR: 0.0135, CAD: 0.0049, AUD: 0.0055, INR: 0.30 };

const COUNTRY_CUR = {
  PK: 'PKR', US: 'USD', GB: 'GBP', AE: 'AED', SA: 'SAR', CA: 'CAD', AU: 'AUD', IN: 'INR',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', IE: 'EUR', BE: 'EUR', AT: 'EUR',
  PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', CY: 'EUR', MT: 'EUR',
};
const SYMBOL = { PKR: 'Rs. ', USD: '$', GBP: '£', EUR: '€', AED: 'AED ', SAR: 'SR ', CAD: 'C$', AUD: 'A$', INR: '₹' };
const WANT = Object.keys(FALLBACK);

async function getRates() {
  try {
    if (redis) {
      const c = await redis.get(RATES_KEY);
      if (c && c.t && Date.now() - c.t < 12 * 3600 * 1000 && c.r) return c.r;
    }
  } catch (e) {}
  try {
    const j = await fetch('https://open.er-api.com/v6/latest/PKR').then((r) => r.json());
    if (j && j.result === 'success' && j.rates && j.rates.USD) {
      const r = {};
      for (const k of WANT) if (j.rates[k] != null) r[k] = j.rates[k];
      r.PKR = 1;
      if (redis) redis.set(RATES_KEY, { t: Date.now(), r }).catch(() => {});
      return r;
    }
  } catch (e) {}
  return FALLBACK;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Per-visitor — must never be cached by the CDN/browser (FX rates are cached server-side in Redis).
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Vary', 'x-vercel-ip-country');

  const cc = String(req.headers['x-vercel-ip-country'] || '').toUpperCase() || null;
  const currency = (cc && COUNTRY_CUR[cc]) || 'PKR';
  const rates = await getRates();
  const rate = currency === 'PKR' ? 1 : (rates[currency] || FALLBACK[currency] || 1);

  res.status(200).json({
    country: cc,
    currency,
    symbol: SYMBOL[currency] || '',
    rate,
    rates,
    symbols: SYMBOL,
  });
}
