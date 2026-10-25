/**
 * Beaded Finery — review storage (underscore prefix = not a public route).
 *
 * Same idea as _orders.js: each review is its own field in a Redis hash and ids come from an
 * atomic counter, so two reviews posted at the same moment can never overwrite each other and
 * approving/deleting one review can never disturb another. The old single-list key is copied
 * over once, automatically, and left in place as a backup.
 */
const HASH = 'beadedfinery:feedback:h';
const SEQ = 'beadedfinery:feedback:seq';
const FLAG = 'beadedfinery:feedback:migrated';
const LEGACY = 'beadedfinery:feedback';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

let migratedHere = false;

export async function ensureMigrated(redis) {
  if (migratedHere) return;
  if (await redis.get(FLAG)) { migratedHere = true; return; }
  const legacy = await redis.get(LEGACY);
  if (Array.isArray(legacy)) {
    const entries = {};
    for (const f of legacy) if (f && f.id) entries[String(f.id)] = f;
    const ids = Object.keys(entries);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = {};
      for (const id of ids.slice(i, i + 50)) chunk[id] = entries[id];
      await redis.hset(HASH, chunk);
    }
  }
  await redis.set(SEQ, 0, { nx: true });
  await redis.set(FLAG, '1');
  migratedHere = true;
}

/** All reviews, newest first. */
export async function listFeedback(redis) {
  await ensureMigrated(redis);
  const h = (await redis.hgetall(HASH)) || {};
  const list = Object.values(h).map(parse).filter(Boolean);
  list.sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
  return list;
}

export async function getFeedback(redis, id) {
  await ensureMigrated(redis);
  const v = await redis.hget(HASH, String(id));
  return v ? parse(v) : null;
}

export async function saveFeedback(redis, item) {
  await redis.hset(HASH, { [item.id]: item });
}

export async function removeFeedback(redis, id) {
  await ensureMigrated(redis);
  return Number(await redis.hdel(HASH, String(id))) || 0;
}

export async function countFeedback(redis) {
  await ensureMigrated(redis);
  return Number(await redis.hlen(HASH)) || 0;
}

/** Atomic, never repeats. */
export async function nextFeedbackNumber(redis) {
  await ensureMigrated(redis);
  return Number(await redis.incr(SEQ));
}
