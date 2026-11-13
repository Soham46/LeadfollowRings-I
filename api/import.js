// Admin import: POST /api/import { groups } (customer records grouped in the browser) -> { leads, created, updated, unchanged }
// The diff is re-run here against the stored data, so stages Ring Experts set in the meantime are never overwritten.
import { route, send, requireUser, HttpError } from '../lib/auth.js';
import { redis, K, parse } from '../lib/store.js';
import { planLead } from '../public/core.js';

const ID = /^[A-Za-z0-9_\-.~:@+]{1,160}$/;
const s = (v, n) => String(v ?? '').slice(0, n);
function cleanGroup(g) {
  if (!g || !ID.test(String(g.id || '')) || !Array.isArray(g.bookings)) return null;
  return {
    id: String(g.id), name: s(g.name, 120), phone: s(g.phone, 40), phoneKey: s(g.phoneKey, 20), email: s(g.email, 160).toLowerCase(),
    city: s(g.city, 80), occasion: /^\d{4}-\d{2}-\d{2}$/.test(g.occasion || '') ? g.occasion : '',
    bookings: g.bookings.slice(0, 100).map(b => ({ id: s(b.id, 60), date: s(b.date, 16), status: s(b.status, 40), service: s(b.service, 120), re: s(b.re, 80), key: s(b.key, 160) })).filter(b => b.key),
  };
}

export default route(['POST'], async (req, res, body) => {
  const user = await requireUser(req, ['admin']);
  const groups = (Array.isArray(body.groups) ? body.groups : []).map(cleanGroup).filter(Boolean);
  if (groups.length > 200) throw new HttpError(400, 'Send at most 200 customers per request');
  if (!groups.length) return send(res, 200, { leads: [], created: 0, updated: 0, unchanged: 0 });
  const existing = (await redis.hmget(K.leads, ...groups.map(g => g.id))) || {};
  const now = new Date().toISOString(), writes = {}, out = [];
  let created = 0, updated = 0, unchanged = 0;
  for (const g of groups) {
    const ex = parse(existing[g.id]);
    const plan = planLead(g, ex || undefined, now, user.name);
    if (plan.type === 'new') { writes[g.id] = JSON.stringify(plan.doc); out.push({ ...plan.doc, id: g.id }); created++; }
    else if (plan.type === 'update') { const doc = { ...ex, ...plan.patch }; delete doc.id; writes[g.id] = JSON.stringify(doc); out.push({ ...doc, id: g.id }); updated++; }
    else unchanged++;
  }
  const ids = Object.keys(writes);
  if (ids.length) {
    await redis.hset(K.leads, writes);
    const t = Date.now();
    await redis.zadd(K.ts, ...ids.map(id => ({ score: t, member: id })));
  }
  send(res, 200, { leads: out, created, updated, unchanged });
});
