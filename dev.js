// Local preview that mimics Vercel: serves /public and runs /api/*.js.
// Without Upstash env vars it uses an in-memory database (data resets on restart).
//   SESSION_SECRET=any-long-random-text ADMIN_PIN=1234 npm run dev
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) process.env.LOCAL_MEMORY_DB = '1';
process.env.SESSION_SECRET ||= 'local-dev-secret-change-me-please';
process.env.ADMIN_PIN ||= '1234';
const PORT = +process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, '');
    const file = path.join(root, 'api', name + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
    let raw = ''; for await (const c of req) raw += c;
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    const mod = await import(file);
    return mod.default(req, res);
  }
  let p = path.join(root, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!p.startsWith(path.join(root, 'public')) || !fs.existsSync(p)) p = path.join(root, 'public', 'index.html');
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log(`Lead engine on http://localhost:${PORT}  (admin login: ${process.env.ADMIN_USERNAME || 'admin'} / ADMIN_PIN)`));
