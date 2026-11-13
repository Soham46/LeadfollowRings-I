// One change to one lead: POST /api/action { id, action, ... } -> { lead } | { deleted: true }
import { route, send, requireUser, canSee, seesAll, HttpError } from '../lib/auth.js';
import { redis, K, parse } from '../lib/store.js';
import { STAGE_LABEL, DEAD, progressIdx, normName } from '../public/core.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_\-.~:@+]{1,160}$/;
const inr = n => '₹' + Math.round(n).toLocaleString('en-IN');
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export default route(['POST'], async (req, res, b) => {
  const user = await requireUser(req);
  const id = String(b.id || '');
  if (!ID.test(id)) throw new HttpError(400, 'Bad lead id');
  const L = parse(await redis.hget(K.leads, id));
  if (!L || !canSee(user, L)) throw new HttpError(404, 'This lead no longer exists or isn\'t assigned to you.');
  const now = new Date().toISOString(), by = user.name;
  const hist = [];
  const patch = {};

  switch (b.action) {
    case 'stage': {
      const stage = String(b.stage || '');
      if (!STAGE_LABEL[stage]) throw new HttpError(400, 'Unknown stage');
      patch.stage = stage;
      let text = '';
      if (stage === 'order') {
        const v = b.orderValue === '' || b.orderValue == null ? null : Number(b.orderValue);
        if (v != null && (!Number.isFinite(v) || v < 0)) throw new HttpError(400, 'Order value must be a number');
        patch.orderValue = v;
        patch.orderDate = DATE.test(b.orderDate || '') ? b.orderDate : now.slice(0, 10);
        patch.orderRef = str(b.orderRef, 100);
        text = ['Order', v ? inr(v) : '', patch.orderRef].filter(Boolean).join(' · ');
      } else if (L.stage === 'order') { patch.orderValue = null; patch.orderDate = ''; patch.orderRef = ''; }
      if (progressIdx(stage) < 0) { patch.lostReason = str(b.lostReason, 300); text = patch.lostReason; }
      else patch.lostReason = '';
      if (DEAD.has(stage)) patch.followUp = '';
      if (stage === L.stage && stage !== 'order' && patch.lostReason === (L.lostReason || '')) return send(res, 200, { lead: { ...L, id } });
      hist.push({ type: 'stage', stage, from: L.stage, text });
      break;
    }
    case 'followup': {
      const d = String(b.date || '');
      if (d && !DATE.test(d)) throw new HttpError(400, 'Bad date');
      patch.followUp = d;
      if (d) hist.push({ type: 'followup', text: 'Next follow-up set for ' + d.split('-').reverse().join('-') });
      break;
    }
    case 'note': {
      const t = str(b.text, 2000);
      if (!t) throw new HttpError(400, 'Note is empty');
      hist.push({ type: 'note', text: t });
      break;
    }
    case 'assign': {
      if (!seesAll(user)) throw new HttpError(403, 'Only managers and admins can reassign leads.');
      const re = normName(str(b.re, 80));
      if (re === (L.re || '')) return send(res, 200, { lead: { ...L, id } });
      patch.re = re;
      hist.push({ type: 'assign', text: `${L.re || 'Unassigned'} → ${re || 'Unassigned'}` });
      break;
    }
    case 'delete': {
      if (user.role !== 'admin') throw new HttpError(403, 'Only admins can remove leads.');
      await redis.hdel(K.leads, id);
      await redis.zadd(K.ts, { score: Date.now(), member: id });
      return send(res, 200, { deleted: true });
    }
    default: throw new HttpError(400, 'Unknown action');
  }

  const next = { ...L, ...patch, updatedAt: now, lastActivityAt: now };
  if (hist.length) next.history = [...(L.history || []), ...hist.map(h => ({ ...h, at: now, by }))].slice(-200);
  delete next.id;
  await redis.hset(K.leads, { [id]: JSON.stringify(next) });
  await redis.zadd(K.ts, { score: Date.now(), member: id });
  send(res, 200, { lead: { ...next, id } });
});
