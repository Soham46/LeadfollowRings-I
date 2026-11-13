// Admin user management. GET -> { users }. POST { op: create|update|reset|deactivate|activate, ... }
import { route, send, requireUser, HttpError, hashPin, publicUser, ROLES, envAdminName } from '../lib/auth.js';
import { redis, K, parse } from '../lib/store.js';
import { normName } from '../public/core.js';

const UNAME = /^[a-z0-9._-]{2,32}$/;
const checkPin = p => { if (String(p || '').length < 4 || String(p).length > 64) throw new HttpError(400, 'PIN / password must be 4–64 characters.'); };
const view = u => ({ ...publicUser(u), active: u.active !== false, createdAt: u.createdAt || '', updatedAt: u.updatedAt || '' });

export default route(['GET', 'POST'], async (req, res, b) => {
  await requireUser(req, ['admin']);
  if (req.method === 'GET') {
    const all = (await redis.hgetall(K.users)) || {};
    const users = Object.values(all).map(parse).filter(Boolean).map(view).sort((a, c) => a.name.localeCompare(c.name));
    return send(res, 200, { users });
  }
  const username = String(b.username || '').trim().toLowerCase();
  if (!UNAME.test(username)) throw new HttpError(400, 'Username: 2–32 characters, lowercase letters, numbers, dot, dash or underscore.');
  if (username === envAdminName()) throw new HttpError(400, 'That username is reserved for the built-in admin.');
  const now = new Date().toISOString();
  const cur = parse(await redis.hget(K.users, username));
  let next;
  const role = b.role, re = normName(b.re || '');
  if (role !== undefined && !ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
  switch (b.op) {
    case 'create': {
      if (cur) throw new HttpError(409, 'That username already exists.');
      const name = String(b.name || '').trim().slice(0, 60);
      if (!name) throw new HttpError(400, 'Enter a display name.');
      checkPin(b.pin);
      if (!role) throw new HttpError(400, 'Choose a role.');
      if (role === 'expert' && !re) throw new HttpError(400, 'Pick the Ring Expert name this profile should see leads for.');
      next = { username, name, role, re: role === 'expert' ? re : '', active: true, pv: 1, ...hashPin(b.pin), createdAt: now, updatedAt: now };
      break;
    }
    case 'update': {
      if (!cur) throw new HttpError(404, 'User not found');
      const name = b.name !== undefined ? String(b.name).trim().slice(0, 60) : cur.name;
      const r = role || cur.role;
      const rre = r === 'expert' ? (b.re !== undefined ? re : cur.re) : '';
      if (r === 'expert' && !rre) throw new HttpError(400, 'Pick the Ring Expert name this profile should see leads for.');
      next = { ...cur, name: name || cur.name, role: r, re: rre, updatedAt: now };
      break;
    }
    case 'reset': { if (!cur) throw new HttpError(404, 'User not found'); checkPin(b.pin); next = { ...cur, ...hashPin(b.pin), pv: (cur.pv || 1) + 1, updatedAt: now }; await redis.del(K.fail(username)); break; }
    case 'deactivate': { if (!cur) throw new HttpError(404, 'User not found'); next = { ...cur, active: false, pv: (cur.pv || 1) + 1, updatedAt: now }; break; }
    case 'activate': { if (!cur) throw new HttpError(404, 'User not found'); next = { ...cur, active: true, updatedAt: now }; break; }
    default: throw new HttpError(400, 'Unknown operation');
  }
  await redis.hset(K.users, { [username]: JSON.stringify(next) });
  send(res, 200, { user: view(next) });
});
