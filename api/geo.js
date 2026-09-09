/**
 * Beaded Finery — visitor geo + currency rates
 *
 * GET /api/geo -> { country, currency, symbol, rate, rates, symbols }
 *   country : ISO-2 from Vercel's edge geo header (null if undetectable)
 *   currency: currency used by that country (falls back to USD abroad, PKR at home)
 *   rate    : units of <currency> per 1 PKR
 *   rates   : full PKR->X map (every currency the FX source knows)
 *
 * FX from open.er-api.com (free, no key) cached 12h in Redis, hard-coded fallback.
 */
import { Redis } from '@upstash/redis';

const RATES_KEY = 'beadedfinery:fxrates';

let redis = null;
try {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) redis = new Redis({ url, token });
} catch (e) { redis = null; }

// approximate PKR-> rates, only used if the live fetch and cache both fail
const FALLBACK = {
  PKR: 1, USD: 0.0036, EUR: 0.0033, GBP: 0.0028, AED: 0.0132, SAR: 0.0135, CAD: 0.0049,
  AUD: 0.0055, INR: 0.30, JPY: 0.53, CNY: 0.026, HKD: 0.028, SGD: 0.0048, MYR: 0.017,
  THB: 0.12, IDR: 58, PHP: 0.21, KRW: 4.9, NZD: 0.006, CHF: 0.0032, SEK: 0.038,
  NOK: 0.039, DKK: 0.025, PLN: 0.014, TRY: 0.14, ZAR: 0.065, BRL: 0.020, MXN: 0.066,
  RUB: 0.33, ILS: 0.013, EGP: 0.18, NGN: 5.6, KES: 0.47, BDT: 0.43, LKR: 1.08, NPR: 0.48,
  QAR: 0.013, KWD: 0.0011, BHD: 0.0014, OMR: 0.0014, JOD: 0.0026, MAD: 0.036,
};

// country ISO-2 -> currency
const COUNTRY_CUR = {
  PK: 'PKR',
  US: 'USD', UM: 'USD', EC: 'USD', SV: 'USD', PA: 'USD', TL: 'USD', ZW: 'USD', BQ: 'USD', VG: 'USD', TC: 'USD',
  GB: 'GBP', IM: 'GBP', JE: 'GBP', GG: 'GBP', GI: 'GBP',
  IN: 'INR', BT: 'INR',
  AE: 'AED', SA: 'SAR', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', IL: 'ILS', LB: 'USD', TR: 'TRY',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', CH: 'CHF', LI: 'CHF',
  JP: 'JPY', CN: 'CNY', HK: 'HKD', MO: 'HKD', TW: 'USD', KR: 'KRW',
  SG: 'SGD', MY: 'MYR', TH: 'THB', ID: 'IDR', PH: 'PHP', VN: 'USD', BD: 'BDT', LK: 'LKR', NP: 'NPR', MM: 'USD', KH: 'USD',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RU: 'RUB', UA: 'UAH',
  ZA: 'ZAR', NG: 'NGN', KE: 'KES', GH: 'GHS', EG: 'EGP', MA: 'MAD', TN: 'TND', DZ: 'DZD', ET: 'ETB', TZ: 'TZS', UG: 'UGX',
  BR: 'BRL', MX: 'MXN', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', UY: 'UYU',
  // Eurozone
  AT: 'EUR', BE: 'EUR', CY: 'EUR', EE: 'EUR', FI: 'EUR', FR: 'EUR', DE: 'EUR', GR: 'EUR', IE: 'EUR', IT: 'EUR',
  LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', NL: 'EUR', PT: 'EUR', SK: 'EUR', SI: 'EUR', ES: 'EUR', HR: 'EUR',
  AD: 'EUR', MC: 'EUR', SM: 'EUR', VA: 'EUR', ME: 'EUR', XK: 'EUR',
};
const SYMBOL = {
  PKR: 'Rs. ', USD: '$', EUR: '€', GBP: '£', INR: '₹', AED: 'AED ', SAR: 'SR ', QAR: 'QR ', KWD: 'KD ',
  BHD: 'BD ', OMR: 'OMR ', JOD: 'JD ', ILS: '₪', CAD: 'C$', AUD: 'A$', NZD: 'NZ$', CHF: 'CHF ',
  JPY: '¥', CNY: '¥', HKD: 'HK$', KRW: '₩', SGD: 'S$', MYR: 'RM ', THB: '฿', IDR: 'Rp ', PHP: '₱',
  SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ', CZK: 'Kč ', HUF: 'Ft ', RON: 'lei ', RUB: '₽',
  ZAR: 'R ', NGN: '₦', KES: 'KSh ', EGP: 'E£ ', MAD: 'MAD ', BRL: 'R$', MXN: 'MX$', TRY: '₺',
  BDT: '৳', LKR: 'Rs ', NPR: 'Rs ',
};

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
      const r = { ...j.rates, PKR: 1 };
      if (redis) redis.set(RATES_KEY, { t: Date.now(), r }).catch(() => {});
      return r;
    }
  } catch (e) {}
  return FALLBACK;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Vary', 'x-vercel-ip-country');

  const cc = String(req.headers['x-vercel-ip-country'] || '').toUpperCase() || null;
  // detected & mapped -> that currency; detected & unmapped -> USD; undetectable -> PKR (home)
  const currency = cc ? (COUNTRY_CUR[cc] || 'USD') : 'PKR';
  const rates = await getRates();
  const rate = currency === 'PKR' ? 1 : (rates[currency] || FALLBACK[currency] || 1);

  res.status(200).json({
    country: cc,
    currency,
    symbol: SYMBOL[currency] || currency + ' ',
    rate,
    rates,
    symbols: SYMBOL,
  });
}
