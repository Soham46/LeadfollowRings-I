import { route, send, HttpError, getUser, pinMatches, signToken, publicUser } from '../lib/auth.js';
import { redis, K } from '../lib/store.js';

const MAX_FAILS = 5, LOCK_SECONDS = 15 * 60;

export default route(['POST'], async (req, res, body) => {
  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '');
  if (!username || !pin) throw new HttpError(400, 'Enter your username and PIN.');
  const fails = +(await redis.get(K.fail(username))) || 0;
  if (fails >= MAX_FAILS) throw new HttpError(429, 'Too many wrong attempts. Try again in 15 minutes or ask the admin to reset your PIN.');
  const user = await getUser(username);
  if (!user || user.active === false || !pinMatches(user, pin)) {
    await redis.incr(K.fail(username));
    await redis.expire(K.fail(username), LOCK_SECONDS);
    throw new HttpError(401, 'Wrong username or PIN.');
  }
  if (fails) await redis.del(K.fail(username));
  send(res, 200, { token: signToken(user), user: publicUser(user) });
});
