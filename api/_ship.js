/**
 * Beaded Finery — shared shipping defaults + calculator (underscore prefix = not a public route).
 * Used by /api/settings (what the owner can edit) and /api/orders (the server re-computes
 * shipping itself, so a customer can't send their own shipping price).
 */

// suggested courier rates from Pakistan for a small (~250 g) jewellery parcel (PKR), by region
export const DEFAULT_ZONES = {
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

export const DEFAULTS = {
  pk: { rate: 300, freeOver: 3000 },
  blocked: ['IN'],
  intl: { default: 2500, zones: DEFAULT_ZONES },
  home: { whyImg: '', heroImg: '' },   // editable homepage photos (data URI or URL)
};


/**
 * PKR shipping for an order, or null if we don't ship to that country.
 * Mirrors the storefront's shipCost() exactly.
 */
export function shippingFor(settings, country, subtotal) {
  const st = settings && settings.pk && settings.intl ? settings : DEFAULTS;
  const cc = String(country || 'PK').toUpperCase();
  if ((st.blocked || []).includes(cc)) return null;
  if (cc === 'PK') return (!subtotal || subtotal >= (st.pk.freeOver || 0)) ? 0 : (st.pk.rate || 0);
  const z = (st.intl && st.intl.zones) || {};
  return z[cc] != null ? z[cc] : ((st.intl && st.intl.default) || 0);
}
