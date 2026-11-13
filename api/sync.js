// Changes since a timestamp: GET /api/sync?since=ms -> { leads (visible & changed), removed (ids), serverTime }
import { route, send, requireUser, canSee, HttpError } from '../lib/auth.js';
import { redis, K, parse } from '../lib/store.js';

export default route(['GET'], async (req, res) => {
  const user = await requireUser(req);
  const since = Number(req.query.since);
  if (!Number.isFinite(since) || since <= 0) throw new HttpError(400, 'Bad since');
  const serverTime = Date.now() - 2000; // overlap so writes in flight are never missed
  const ids = (await redis.zrange(K.ts, since + 1, 9e15, { byScore: true })).map(String);
  const leads = [], removed = [];
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const got = (await redis.hmget(K.leads, ...part)) || {};
      for (const id of part) { const L = parse(got[id]); if (L && canSee(user, L)) leads.push({ ...L, id }); else removed.push(id); }
    }
  }
  send(res, 200, { leads, removed, serverTime });
});
