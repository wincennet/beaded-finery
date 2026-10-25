/**
 * Beaded Finery — order storage (underscore prefix = not a public route).
 *
 * Orders used to live in ONE Redis value (a JSON list) that every request read, changed and
 * wrote back. Two orders arriving at the same moment could each read the same list and the
 * second write would silently erase the first. Now:
 *
 *   • each order is its own field in a Redis hash  -> saving one order can never touch another
 *   • order numbers come from an atomic counter (INCR) -> two customers can never get the same one
 *   • a tracker -> order index makes Safepay confirmations a direct lookup
 *
 * The old single-list key is migrated once, automatically, on first use and left in place as a
 * backup (nothing reads it any more).
 */
const HASH = 'beadedfinery:orders:h';
const SEQ = 'beadedfinery:orders:seq';
const FLAG = 'beadedfinery:orders:migrated';
const LEGACY = 'beadedfinery:orders';
const TRACKERS = 'beadedfinery:orders:trackers';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const numOf = (id) => { const m = /(\d+)$/.exec(String(id)); return m ? Number(m[1]) : 0; };

let migratedHere = false;

/** One-time move of the old list into the hash. Safe to run twice (it only copies). */
export async function ensureMigrated(redis) {
  if (migratedHere) return;
  if (await redis.get(FLAG)) { migratedHere = true; return; }
  const legacy = await redis.get(LEGACY);
  let max = 1042;
  if (Array.isArray(legacy)) {
    const entries = {};
    for (const o of legacy) {
      if (!o || !o.id) continue;
      entries[String(o.id)] = o;
      const m = /^BF-(\d{1,9})$/.exec(String(o.id));
      if (m) max = Math.max(max, Number(m[1]));
    }
    const ids = Object.keys(entries);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = {};
      for (const id of ids.slice(i, i + 50)) chunk[id] = entries[id];
      await redis.hset(HASH, chunk);
    }
  }
  await redis.set(SEQ, max, { nx: true });   // never lowers an existing counter
  await redis.set(FLAG, '1');
  migratedHere = true;
}

/** All orders, newest first. */
export async function listOrders(redis) {
  await ensureMigrated(redis);
  const h = (await redis.hgetall(HASH)) || {};
  const list = Object.values(h).map(parse).filter(Boolean);
  list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || numOf(b.id) - numOf(a.id));
  return list;
}

export async function getOrder(redis, id) {
  await ensureMigrated(redis);
  const v = await redis.hget(HASH, String(id));
  return v ? parse(v) : null;
}

/** Writes exactly one order; never touches any other. */
export async function saveOrder(redis, order) {
  await redis.hset(HASH, { [order.id]: order });
}

export async function removeOrder(redis, id) {
  await ensureMigrated(redis);
  return Number(await redis.hdel(HASH, String(id))) || 0;
}

export async function countOrders(redis) {
  await ensureMigrated(redis);
  return Number(await redis.hlen(HASH)) || 0;
}

/** Atomic: every call returns a different number, even for simultaneous requests. */
export async function nextOrderNumber(redis) {
  await ensureMigrated(redis);
  return Number(await redis.incr(SEQ));
}

export async function indexTracker(redis, tracker, orderId) {
  await redis.hset(TRACKERS, { [tracker]: orderId });
}

/** The order a Safepay tracker belongs to (index first, full scan as a fallback for older orders). */
export async function findOrderByTracker(redis, tracker) {
  await ensureMigrated(redis);
  const id = await redis.hget(TRACKERS, tracker);
  if (id) {
    const o = await getOrder(redis, String(id));
    if (o && o.safepayTracker === tracker) return o;
  }
  const o = (await listOrders(redis)).find((x) => x.safepayTracker === tracker) || null;
  if (o) { try { await indexTracker(redis, tracker, o.id); } catch (e) { /* index is an optimisation only */ } }
  return o;
}
