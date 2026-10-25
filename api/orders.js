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
 * SECURITY — a public order is treated as untrusted input:
 *   • the server picks the order id (a customer can never overwrite or impersonate an order)
 *   • every item is looked up in the real catalogue: price comes from the catalogue, never
 *     from the browser; unknown / out-of-stock items are rejected
 *   • shipping, total and the cash-on-delivery advance are re-computed here
 *   • all text is stripped of control characters and angle brackets and length-limited
 *
 * Storage: Upstash Redis. Vercel injects KV_REST_API_URL / KV_REST_API_TOKEN.
 */
import { Redis } from '@upstash/redis';
import { clientIp, rateLimited, ownerAuth, denyOwner, cors } from './_lib.js';
import { DEFAULTS, shippingFor } from './_ship.js';
import { listOrders, getOrder, saveOrder, removeOrder, countOrders, nextOrderNumber } from './_orders.js';

const PRODUCTS_KEY = 'beadedfinery:products';
const SETTINGS_KEY = 'beadedfinery:settings';
const MAX = 800;

const METHODS = ['Credit / Debit Card', 'Cash on Delivery', 'Easypaisa', 'JazzCash', 'Bank Transfer'];
const ADVANCE_METHODS = ['Credit / Debit Card', 'Easypaisa', 'JazzCash', 'Bank Transfer'];

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

/** plain single-line text: no control characters, no angle brackets, trimmed, length-limited */
const txt = (v, n) => String(v == null ? '' : v)
  .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, n);

const fail = (res, msg, status = 400) => res.status(status).json({ error: msg });

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * Validate + price an incoming order. Returns { error } or { order }.
 * Nothing in `raw` is trusted except what the customer genuinely chooses
 * (what they want, their contact details, how they'd like to pay).
 */
async function buildOrder(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};

  const name = txt(o.name, 120);
  const phone = txt(o.phone, 40);
  const email = txt(o.email, 120);
  const address = txt(o.address, 400);
  const city = txt(o.city, 80);
  const postal = txt(o.postal, 20);
  const notes = txt(o.notes, 500);
  const country = /^[A-Za-z]{2}$/.test(String(o.country || '')) ? String(o.country).toUpperCase() : 'PK';
  const countryName = txt(o.countryName, 60);

  if (name.length < 2) return { error: 'Please enter your name.' };
  if (!/^[0-9+()\-\s]{7,40}$/.test(phone) || phone.replace(/\D/g, '').length < 7) return { error: 'Please enter a valid phone number.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please enter a valid email address.' };
  if (address.length < 3 || city.length < 2) return { error: 'Please enter your delivery address and city.' };

  const method = METHODS.includes(o.method) ? o.method : '';
  if (!method) return { error: 'Please choose a payment method.' };
  if (method === 'Cash on Delivery' && country !== 'PK') return { error: 'Cash on delivery is only available in Pakistan.' };

  // --- items: price/stock/options come from the real catalogue ---
  const hash = (await redis.hgetall(PRODUCTS_KEY)) || {};
  const products = Object.values(hash).map(parse).filter(Boolean);
  if (!products.length) return { error: 'The shop is being updated — please try again shortly.', status: 503 };
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const byName = new Map(products.map((p) => [String(p.name || '').trim().toLowerCase(), p]));

  const rawItems = Array.isArray(o.items) ? o.items.slice(0, 50) : [];
  if (!rawItems.length) return { error: 'Your cart is empty.' };
  const items = [];
  for (const i of rawItems) {
    const it = i && typeof i === 'object' ? i : {};
    const p = (it.id && byId.get(String(it.id))) || byName.get(txt(it.name, 120).toLowerCase());
    if (!p) return { error: 'An item in your cart is no longer available. Please refresh the page and try again.' };
    if (p.stock === false) return { error: `Sorry, "${txt(p.name, 60)}" is out of stock.` };
    const qty = Math.max(1, Math.min(20, Math.floor(Number(it.qty)) || 1));
    const line = { id: String(p.id), name: txt(p.name, 120), qty, price: Math.max(0, Math.round(Number(p.price) || 0)) };
    const size = txt(it.size, 40);
    const color = txt(it.color, 40);
    if (Array.isArray(p.sizes) && p.sizes.length) {
      if (!p.sizes.includes(size)) return { error: `Please choose a size for "${line.name}".` };
      line.size = size;
    }
    if (Array.isArray(p.colors) && p.colors.length) {
      if (!p.colors.includes(color)) return { error: `Please choose a colour for "${line.name}".` };
      line.color = color;
    }
    items.push(line);
  }
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);

  // --- shipping from the owner's current shipping rules ---
  const saved = await redis.get(SETTINGS_KEY);
  const settings = saved && typeof saved === 'object' && saved.pk && saved.intl ? saved : DEFAULTS;
  const shipping = shippingFor(settings, country, subtotal);
  if (shipping == null) return { error: `Sorry, we don't deliver to ${countryName || country} yet.` };
  const total = subtotal + shipping;

  // --- cash on delivery: 50% advance now, rest on delivery (always worked out here) ---
  const isCod = method === 'Cash on Delivery';
  const advance = isCod ? Math.ceil(total / 2) : 0;
  const advanceMethod = ADVANCE_METHODS.includes(o.advanceMethod) ? o.advanceMethod : 'Bank Transfer';

  return {
    order: {
      name, phone, email, city, address, postal, notes,
      country, countryName,
      method,
      items,
      subtotal, shipping, total,
      ...(isCod ? { advance, balance: total - advance, advanceMethod } : {}),
      status: 'Pending Payment Verification',
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
    },
  };
}

export default async function handler(req, res) {
  cors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Owner-only methods require the admin key.
  if (['GET', 'PATCH', 'DELETE'].includes(req.method)) {
    const auth = await ownerAuth(req, redis);
    if (!auth.ok) return denyOwner(res, auth);
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
      return res.status(200).json(await listOrders(redis));
    }

    if (req.method === 'POST') {
      // a real shopper places 1–2 orders; a bot places hundreds. Per-connection AND whole-shop caps
      // so junk orders can never crowd real ones out.
      if (await rateLimited(redis, `beadedfinery:rl:orders:${clientIp(req)}`, 10, 3600)) {
        return fail(res, 'Too many orders from this connection — please wait a while and try again.', 429);
      }
      if (await rateLimited(redis, 'beadedfinery:rl:orders:all', 80, 3600)) {
        return fail(res, 'We are very busy right now — please try again in a few minutes.', 429);
      }
      let raw;
      try { raw = readBody(req); } catch (e) { return fail(res, 'Invalid order'); }
      const built = await buildOrder(raw);
      if (built.error) return fail(res, built.error, built.status || 400);
      const order = built.order;

      // keep the store bounded without ever dropping live orders: only finished (Shipped) ones go
      if ((await countOrders(redis)) >= MAX) {
        const oldestShipped = [...(await listOrders(redis))].reverse().find((o) => o && o.status === 'Shipped');
        if (!oldestShipped) return fail(res, 'We cannot take new orders right now — please message us on WhatsApp.', 503);
        await removeOrder(redis, oldestShipped.id);
      }
      // atomic order number + a write that touches only THIS order: simultaneous customers can't clash
      order.id = 'BF-' + (await nextOrderNumber(redis));
      await saveOrder(redis, order);
      return res.status(200).json({
        ok: true, id: order.id,
        subtotal: order.subtotal, shipping: order.shipping, total: order.total,
        ...(order.advance != null ? { advance: order.advance, balance: order.balance, advanceMethod: order.advanceMethod } : {}),
      });
    }

    if (req.method === 'PATCH') {
      const { id, status } = readBody(req);
      const allowed = ['Pending Payment Verification', 'Processing', 'Shipped'];
      if (!allowed.includes(status)) return res.status(400).json({ error: 'Bad status' });
      const o = await getOrder(redis, String(id || ''));
      if (o) { o.status = status; await saveOrder(redis, o); }
      return res.status(200).json({ ok: true, updated: !!o });
    }

    if (req.method === 'DELETE') {
      const { id } = readBody(req);
      const removed = await removeOrder(redis, String(id || ''));
      return res.status(200).json({ ok: true, removed });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
