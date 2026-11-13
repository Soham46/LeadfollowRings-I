import { Redis } from '@upstash/redis';

// Vercel's Upstash integration injects KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = url && token
  ? new Redis({ url, token, automaticDeserialization: false })
  : process.env.LOCAL_MEMORY_DB ? memoryRedis() : null;

// Keys
export const K = {
  leads: 'lfe:leads',        // hash  id -> lead JSON
  ts: 'lfe:leads:ts',        // zset  id -> last change (ms); deleted leads stay here so clients drop them
  users: 'lfe:users',        // hash  username -> user JSON
  fail: u => 'lfe:fail:' + u // login attempt counter
};

export const parse = v => { if (v == null) return null; try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

/* In-memory stand-in for local development only (npm run dev without Upstash). Data is lost on restart. */
function memoryRedis() {
  const h = new Map(), z = new Map(), kv = new Map();
  const hash = k => h.get(k) || h.set(k, new Map()).get(k);
  const zs = k => z.get(k) || z.set(k, new Map()).get(k);
  return {
    async hget(k, f) { return hash(k).get(f) ?? null; },
    async hset(k, obj) { for (const [f, v] of Object.entries(obj)) hash(k).set(f, typeof v === 'string' ? v : JSON.stringify(v)); return 1; },
    async hmget(k, ...fs) { const o = {}; let any = false; for (const f of fs) { o[f] = hash(k).get(f) ?? null; if (o[f] != null) any = true; } return any ? o : null; },
    async hdel(k, ...fs) { let n = 0; for (const f of fs) n += hash(k).delete(f) ? 1 : 0; return n; },
    async hgetall(k) { const m = hash(k); return m.size ? Object.fromEntries(m) : null; },
    async hscan(k, cursor, { count = 10 } = {}) {
      const keys = [...hash(k).keys()], start = +cursor || 0, part = keys.slice(start, start + count), out = [];
      for (const f of part) out.push(f, hash(k).get(f));
      const next = start + count >= keys.length ? '0' : String(start + count);
      return [next, out];
    },
    async zadd(k, ...pairs) { for (const { score, member } of pairs) zs(k).set(member, score); return pairs.length; },
    async zrange(k, min, max, opts) { return [...zs(k).entries()].filter(([, s]) => s >= min && s <= max).sort((a, b) => a[1] - b[1]).map(([m]) => m); },
    async get(k) { return kv.get(k) ?? null; },
    async incr(k) { const v = (+kv.get(k) || 0) + 1; kv.set(k, String(v)); return v; },
    async expire() { return 1; },
    async del(k) { return kv.delete(k) ? 1 : 0; },
  };
}
