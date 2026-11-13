// Paged full load: GET /api/leads?cursor=0  -> { leads, cursor, serverTime }  (cursor "0" = done)
import { route, send, requireUser, canSee } from '../lib/auth.js';
import { redis, K, parse } from '../lib/store.js';

export default route(['GET'], async (req, res) => {
  const user = await requireUser(req);
  const serverTime = Date.now();
  const [cursor, flat] = await redis.hscan(K.leads, String(req.query.cursor || '0'), { count: 250 });
  const leads = [];
  for (let i = 0; i < flat.length; i += 2) { const L = parse(flat[i + 1]); if (L && canSee(user, L)) leads.push({ ...L, id: String(flat[i]) }); }
  send(res, 200, { leads, cursor: String(cursor), serverTime });
});
