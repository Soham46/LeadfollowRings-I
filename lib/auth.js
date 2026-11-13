import crypto from 'node:crypto';
import { redis, K, parse } from './store.js';
import { normName } from '../public/core.js';

const SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = 14;
export const ROLES = ['admin', 'manager', 'expert'];

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function send(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); }

// Wraps a handler: method check, config check, error -> JSON
export function route(methods, fn) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) throw new HttpError(405, 'Method not allowed');
      if (!redis) throw new HttpError(500, 'Database not connected. Add Upstash Redis to the Vercel project (Storage tab) and redeploy.');
      if (!SECRET || SECRET.length < 16) throw new HttpError(500, 'SESSION_SECRET is missing or too short (min 16 characters). Set it in Vercel → Settings → Environment Variables and redeploy.');
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
      await fn(req, res, body || {});
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Server error. Try again.' });
    }
  };
}

const b64 = b => Buffer.from(b).toString('base64url');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
export function signToken(user) {
  const p = b64(JSON.stringify({ u: user.username, pv: user.pv, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return p + '.' + hmac(p);
}
function readToken(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [p, sig] = t.split('.');
  if (!p || !sig) return null;
  const good = hmac(p);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const data = parse(Buffer.from(p, 'base64url').toString());
  if (!data || data.exp < Date.now()) return null;
  return data;
}

export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
export function pinMatches(user, pin) {
  if (user.env) return safeEq(String(pin), process.env.ADMIN_PIN || '');
  if (!user.salt || !user.hash) return false;
  return safeEq(hashPin(pin, user.salt).hash, user.hash);
}
function safeEq(a, b) { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B); }

// Break-glass admin from environment variables (cannot be locked out by data mistakes)
export const envAdminName = () => (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
function envAdmin() {
  if (!process.env.ADMIN_PIN) return null;
  return { username: envAdminName(), name: process.env.ADMIN_DISPLAY_NAME || 'Admin', role: 'admin', re: '', active: true, pv: 'env', env: true };
}
export async function getUser(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  if (u === envAdminName()) return envAdmin();
  return parse(await redis.hget(K.users, u));
}
export async function requireUser(req, roles) {
  const t = readToken(req);
  if (!t) throw new HttpError(401, 'Please log in again.');
  const user = await getUser(t.u);
  if (!user || user.active === false || String(user.pv) !== String(t.pv)) throw new HttpError(401, 'Your session has ended. Please log in again.');
  if (roles && !roles.includes(user.role)) throw new HttpError(403, 'Your profile doesn\'t have access to this.');
  return user;
}
export const publicUser = u => ({ username: u.username, name: u.name, role: u.role, re: u.re || '', env: !!u.env });

// Who sees which lead
export const seesAll = u => u.role === 'admin' || u.role === 'manager';
export const canSee = (u, L) => seesAll(u) || (!!u.re && normName(L.re) === normName(u.re));
