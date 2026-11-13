// Change your own PIN: POST { current, next } -> { token }
import { route, send, requireUser, HttpError, pinMatches, hashPin, signToken } from '../lib/auth.js';
import { redis, K } from '../lib/store.js';

export default route(['POST'], async (req, res, b) => {
  const user = await requireUser(req);
  if (user.env) throw new HttpError(400, 'The built-in admin PIN is set by the ADMIN_PIN environment variable in Vercel.');
  if (!pinMatches(user, b.current || '')) throw new HttpError(400, 'Current PIN is wrong.');
  const n = String(b.next || '');
  if (n.length < 4 || n.length > 64) throw new HttpError(400, 'New PIN / password must be 4–64 characters.');
  const next = { ...user, ...hashPin(n), pv: (user.pv || 1) + 1, updatedAt: new Date().toISOString() };
  await redis.hset(K.users, { [user.username]: JSON.stringify(next) });
  send(res, 200, { token: signToken(next) });
});
