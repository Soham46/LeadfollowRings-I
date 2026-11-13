import { STAGES, CLOSED, ALL_STAGES, STAGE_LABEL, DEAD, pad, toLocalISO, todayStr, addDays, daysBetween, parseDate, normName, waNumber, FIELDS, autoMap, groupRows, planLead, progressIdx, reachedIdx } from './core.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('lfe:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lfe:' + k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem('lfe:' + k); } catch { } },
};
const inr = n => n == null || n === '' || isNaN(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN');
const inrShort = n => { if (!n) return '₹0'; if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr'; if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1) + ' L'; return inr(n); };
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 + '%' : '—';
const fmtDate = s => { if (!s) return '—'; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return `${pad(d)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${String(y).slice(2)}`; };
const fmtDT = s => !s ? '—' : fmtDate(s) + (s.length > 10 && s.slice(11, 16) !== '00:00' ? ' · ' + s.slice(11, 16) : '');
const ago = iso => { if (!iso) return '—'; const d = daysBetween(iso.slice(0, 10), todayStr()); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : d + ' days ago'; };
const nowISO = () => new Date().toISOString();
const ROLE_LABEL = { admin: 'Admin', manager: 'Manager', expert: 'Ring Expert' };

const S = {
  token: LS.get('token', ''), me: null,
  leads: new Map(), since: 0, status: 'connecting', confirmed: false, users: null,
  view: 'dashboard',
  f: { q: '', re: 'all', stage: 'open', market: 'all', sort: 'appt_desc', mode: LS.get('mode', 'table'), limit: 200 },
  df: { re: 'all', market: 'all', period: 'all' },
  fu: { re: 'all' },
  openId: null, pending: null, drafts: {}, confirmDelete: false, modal: null,
  imp: null, busy: false,
};
const isAdmin = () => S.me && S.me.role === 'admin';
const seesAll = () => S.me && (S.me.role === 'admin' || S.me.role === 'manager');

/* ---------- API ---------- */
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new ApiError(0, 'Can\'t reach the server. Check your internet connection.'); }
  let data = {}; try { data = await r.json(); } catch { }
  if (r.status === 401 && path !== 'login') { logout('Your session ended. Please log in again.'); throw new ApiError(401, data.error || 'Logged out'); }
  if (!r.ok) throw new ApiError(r.status, data.error || 'Something went wrong (' + r.status + ').');
  return data;
}
const upsert = L => S.leads.set(L.id, L);
async function doAction(id, action, data = {}) {
  try {
    const r = await api('action', { method: 'POST', body: { id, action, ...data } });
    if (r.deleted) S.leads.delete(id); else if (r.lead) upsert(r.lead);
    render(); if (S.openId) renderDrawer();
    return r;
  } catch (e) { toast(e.message, 'err'); if (e.status === 404) { S.leads.delete(id); closeLead(); render(); } throw e; }
}
const who = by => by || 'CRM import';

/* ---------- derived ---------- */
function experts() {
  const set = new Set((S.users || []).filter(u => u.role === 'expert' && u.re).map(u => u.re));
  for (const L of S.leads.values()) if (L.re) set.add(L.re);
  return [...set].sort((a, b) => a.localeCompare(b));
}
const leadsArr = () => [...S.leads.values()];
const isOverdue = L => L.followUp && !DEAD.has(L.stage) && L.followUp < todayStr();
const isDueToday = L => L.followUp && !DEAD.has(L.stage) && L.followUp === todayStr();
const isStale = L => !DEAD.has(L.stage) && !['cancelled'].includes(L.stage) && daysBetween((L.lastActivityAt || L.createdAt || '').slice(0, 10), todayStr()) >= 7;
function stageKind(k) { if (k === 'order') return 'won'; const c = CLOSED.find(x => x.key === k); return c ? c.kind : 'open'; }
function chip(k) {
  const i = progressIdx(k); const kind = stageKind(k);
  return `<span class="chip ${kind}"><i></i>${i >= 0 ? (i + 1) + ' · ' : ''}${esc(STAGE_LABEL[k] || k)}</span>`;
}
function matchStage(L, f) {
  if (f === 'all') return true;
  if (f === 'open') return progressIdx(L.stage) >= 0 && L.stage !== 'order';
  if (f === 'overdue') return isOverdue(L);
  if (f === 'closed') return progressIdx(L.stage) < 0;
  return L.stage === f;
}
function inPeriod(L, p) {
  if (p === 'all') return true;
  const d = (L.firstAppt || L.createdAt || '').slice(0, 10); if (!d) return false;
  const t = todayStr(), [y, m] = t.split('-').map(Number);
  if (p === 'this_month') return d.slice(0, 7) === t.slice(0, 7);
  if (p === 'last_month') { const lm = new Date(y, m - 2, 1); return d.slice(0, 7) === `${lm.getFullYear()}-${pad(lm.getMonth() + 1)}`; }
  const n = +p; return d >= addDays(t, -n + 1) && d <= t;
}

/* ---------- toast & tooltip ---------- */
let toastT;
function toast(msg, kind = '') { const el = $('#toast'); el.textContent = msg; el.className = 'show ' + kind; clearTimeout(toastT); toastT = setTimeout(() => el.className = '', kind === 'err' ? 6000 : 2500); }
function tip(e, html) { const t = $('#tip'); if (!html) { t.style.display = 'none'; return; } t.innerHTML = html; t.style.display = 'block'; const x = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 8); t.style.left = x + 'px'; t.style.top = (e.clientY + 14) + 'px'; }

/* ---------- render: shell ---------- */
function render() {
  document.body.classList.toggle('logged-out', !S.me);
  if (!S.me) { $('#main').innerHTML = viewLogin(); return; }
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.v === S.view));
  $('#tab-import').style.display = isAdmin() ? '' : 'none';
  $('#tab-users').style.display = isAdmin() ? '' : 'none';
  const dot = $('#sync'); const st = S.status;
  dot.className = 'sync ' + st;
  dot.textContent = st === 'live' ? 'Up to date' : st === 'error' ? 'Offline — retrying' : 'Loading…';
  $('#who').innerHTML = `<b>${esc(S.me.name)}</b> <span>${ROLE_LABEL[S.me.role]}${S.me.role === 'expert' ? '' : ''}</span>`;
  const main = $('#main');
  if (S.view === 'dashboard') main.innerHTML = viewDashboard();
  else if (S.view === 'leads') main.innerHTML = viewLeads();
  else if (S.view === 'followups') main.innerHTML = viewFollowups();
  else if (S.view === 'import') main.innerHTML = viewImport();
  else if (S.view === 'users') main.innerHTML = viewUsers();
  if (S.openId) { const L = S.leads.get(S.openId); if (!L || L.updatedAt !== S.drawerStamp || !$('#drawer').innerHTML) renderDrawer(); }
  renderModal();
}

function viewLogin() {
  return `<div class="login"><form id="login-form" class="card" autocomplete="on">
    <div class="lbrand">Rings &amp; I</div><h2>Lead Follow-up Engine</h2><p class="sub">Log in with your username and PIN.</p>
    <label>Username<input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(LS.get('lastUser', ''))}"></label>
    <label>PIN / password<input type="password" name="pin" autocomplete="current-password" required></label>
    <p class="warn" id="login-err"></p>
    <button class="btn" type="submit" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Logging in…' : 'Log in'}</button>
    <p class="mut">Forgot your PIN? Ask the admin to reset it.</p></form></div>`;
}

function emptyState() {
  if (!S.confirmed && !S.leads.size) return `<div class="empty"><p>Loading leads…</p></div>`;
  if (S.me.role === 'expert') return `<div class="empty"><h3>No leads assigned to you yet</h3><p>Leads appear here once the CRM export is imported with your name (${esc(S.me.re || 'not set')}) as the Ring Expert.</p></div>`;
  return `<div class="empty"><h3>No leads yet</h3><p>${isAdmin() ? 'Go to <a href="#import">Import</a> and upload the appointment export from Zoho Bookings to start.' : 'The admin hasn\'t imported the appointment book yet.'}</p></div>`;
}
const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(label)}</option>`;
const reFilter = (attr, cur) => seesAll() ? `<label>Ring Expert <select ${attr}>${reOptions(cur)}</select></label>` : '';
const reOptions = cur => opt('all', 'All Ring Experts', cur) + experts().map(n => opt(n, n, cur)).join('') + opt('__none', 'Unassigned', cur);
const reMatch = (L, re) => re === 'all' || (re === '__none' ? !L.re : L.re === re);

/* ---------- dashboard ---------- */
function viewDashboard() {
  if (!S.leads.size) return emptyState();
  const f = S.df;
  const ls = leadsArr().filter(L => reMatch(L, f.re) && (f.market === 'all' || L.market === f.market) && inPeriod(L, f.period));
  const n = ls.length;
  const orders = ls.filter(L => L.stage === 'order');
  const value = orders.reduce((a, L) => a + (+L.orderValue || 0), 0);
  const withVal = orders.filter(L => +L.orderValue > 0);
  const open = ls.filter(L => progressIdx(L.stage) >= 0 && L.stage !== 'order');
  const overdue = ls.filter(isOverdue).length;
  const stale = ls.filter(isStale).length;
  const cycle = orders.map(L => daysBetween(L.firstAppt, L.orderDate)).filter(x => x != null && x >= 0);
  const avgCycle = cycle.length ? Math.round(cycle.reduce((a, b) => a + b, 0) / cycle.length) : null;
  const reached = STAGES.map((s, i) => ls.filter(L => reachedIdx(L) >= i).length);
  const consulted = reached[1];

  const filters = `<div class="filters">
    ${reFilter('data-df="re"', f.re)}
    <label>Market <select data-df="market">${opt('all', 'All', f.market)}${opt('Domestic', 'Domestic', f.market)}${opt('International', 'International (NRI)', f.market)}</select></label>
    <label>First appointment <select data-df="period">${opt('all', 'All time', f.period)}${opt('this_month', 'This month', f.period)}${opt('last_month', 'Last month', f.period)}${opt('30', 'Last 30 days', f.period)}${opt('90', 'Last 90 days', f.period)}</select></label>
  </div>`;

  const kpi = (label, val, sub, act) => `<div class="kpi ${act ? 'click' : ''}" ${act ? `data-act="${act}"` : ''}><div class="kl">${label}</div><div class="kv">${val}</div><div class="ks">${sub || '&nbsp;'}</div></div>`;
  const kpis = `<div class="kpis">
    ${kpi('Leads booked', n, `${open.length} still in the pipeline`)}
    ${kpi('Consultations done', consulted, `${pct(consulted, n)} of bookings`)}
    ${kpi('Orders placed', orders.length, `${pct(orders.length, n)} booking → order`)}
    ${kpi('Order value', inrShort(value), withVal.length ? `AOV ${inrShort(value / withVal.length)}` : 'Add value when marking orders')}
    ${kpi('Avg days to order', avgCycle == null ? '—' : avgCycle, 'first appointment → order')}
    ${kpi('Overdue follow-ups', overdue, `${stale} leads untouched 7+ days`, 'goto-overdue')}
  </div>`;

  const max = Math.max(1, reached[0]);
  const funnel = STAGES.map((s, i) => {
    const v = reached[i], w = v / max * 100, step = i ? pct(v, reached[i - 1]) : '';
    return `<div class="frow" data-tip="${esc(`<b>${s.label}</b><br>${v} leads reached this stage or later<br>${pct(v, n)} of bookings${i ? `<br>${step} of previous stage` : ''}`)}">
      <div class="fl">${i + 1}. ${s.label}</div>
      <div class="ft"><div class="fb ${s.key === 'order' ? 'won' : ''}" style="width:${Math.max(w, v ? 1.5 : 0)}%"></div></div>
      <div class="fv"><b>${v}</b> <span>${pct(v, n)}</span></div>
      <div class="fs">${i ? step + ' from prev.' : ''}</div></div>`;
  }).join('');

  const nowCounts = ALL_STAGES.map(s => ({ s, v: ls.filter(L => L.stage === s.key).length }));
  const nmax = Math.max(1, ...nowCounts.map(x => x.v));
  const nowRows = nowCounts.map(({ s, v }) => `<div class="frow small click" data-act="goto-stage" data-stage="${s.key}" data-tip="${esc(`<b>${s.label}</b><br>${v} leads are here now<br>Click to see them`)}">
      <div class="fl">${chip(s.key)}</div>
      <div class="ft"><div class="fb ${stageKind(s.key)}" style="width:${Math.max(v / nmax * 100, v ? 1.5 : 0)}%"></div></div>
      <div class="fv"><b>${v}</b></div><div class="fs"></div></div>`).join('');

  // RE table
  const res = [...new Set(ls.map(L => L.re || ''))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const reRows = res.map(re => {
    const g = ls.filter(L => (L.re || '') === re);
    const o = g.filter(L => L.stage === 'order');
    const val = o.reduce((a, L) => a + (+L.orderValue || 0), 0);
    return `<tr class="click" data-act="goto-re" data-re="${esc(re || '__none')}">
      <td><b>${esc(re || 'Unassigned')}</b></td><td class="n">${g.length}</td>
      <td class="n">${g.filter(L => progressIdx(L.stage) >= 0 && L.stage !== 'order').length}</td>
      <td class="n">${g.filter(L => reachedIdx(L) >= 1).length}</td>
      <td class="n">${g.filter(L => reachedIdx(L) >= 4).length}</td>
      <td class="n">${g.filter(L => reachedIdx(L) >= 6).length}</td>
      <td class="n"><b>${o.length}</b></td><td class="n">${pct(o.length, g.length)}</td>
      <td class="n">${inrShort(val)}</td>
      <td class="n ${g.filter(isOverdue).length ? 'warn' : ''}">${g.filter(isOverdue).length}</td>
      <td class="n">${g.filter(isStale).length}</td></tr>`;
  }).join('');

  const lostReasons = {};
  ls.filter(L => ['not_interested', 'bought_elsewhere', 'postponed'].includes(L.stage)).forEach(L => { const k = STAGE_LABEL[L.stage] + (L.lostReason ? ' — ' + L.lostReason : ''); lostReasons[k] = (lostReasons[k] || 0) + 1; });
  const lr = Object.entries(lostReasons).sort((a, b) => b[1] - a[1]).slice(0, 12);

  return `${filters}${kpis}
  <div class="grid2">
    <section class="card"><h2>Conversion funnel</h2><p class="sub">Leads that reached each stage or a later one. Hover for step conversion.</p>${funnel}</section>
    <section class="card"><h2>Where customers are right now</h2><p class="sub">Current stage of every lead. Click a row to open that list.</p>${nowRows}</section>
  </div>
  <section class="card"><h2>${seesAll() ? 'Ring Expert performance' : 'Your numbers'}</h2><p class="sub">Same filters as above. Click a row to see that Ring Expert's leads.</p>
    <div class="tw"><table class="tbl"><thead><tr><th>Ring Expert</th><th class="n">Leads</th><th class="n">In pipeline</th><th class="n">Consulted</th><th class="n">Quote shared+</th><th class="n">Store visit done+</th><th class="n">Orders</th><th class="n">Conv. %</th><th class="n">Order value</th><th class="n">Overdue</th><th class="n">Stale 7d+</th></tr></thead><tbody>${reRows}</tbody></table></div></section>
  ${lr.length ? `<section class="card"><h2>Why leads stalled or were lost</h2><p class="sub">From the reasons Ring Experts enter when closing a lead.</p><div class="tw"><table class="tbl"><thead><tr><th>Stage — reason</th><th class="n">Leads</th></tr></thead><tbody>${lr.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
}

/* ---------- leads ---------- */
function filteredLeads() {
  const f = S.f, q = f.q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
  let ls = leadsArr().filter(L => reMatch(L, f.re) && (f.market === 'all' || L.market === f.market) && matchStage(L, f.stage) &&
    (!q || (L.name || '').toLowerCase().includes(q) || (L.email || '').includes(q) || (L.city || '').toLowerCase().includes(q) || (qd.length >= 3 && (L.phone || '').replace(/\D/g, '').includes(qd))));
  const s = f.sort;
  const cmp = {
    appt_desc: (a, b) => (b.lastAppt || '').localeCompare(a.lastAppt || ''),
    appt_asc: (a, b) => (a.lastAppt || '').localeCompare(b.lastAppt || ''),
    follow: (a, b) => (a.followUp || '9999').localeCompare(b.followUp || '9999'),
    activity: (a, b) => (a.lastActivityAt || '').localeCompare(b.lastActivityAt || ''),
    stage: (a, b) => (progressIdx(b.stage) - progressIdx(a.stage)),
    name: (a, b) => (a.name || '').localeCompare(b.name || ''),
  }[s];
  return ls.sort(cmp);
}
function viewLeads() {
  if (!S.leads.size) return emptyState();
  const f = S.f; const ls = filteredLeads();
  const stageOpts = opt('open', 'Open pipeline (stages 1–7)', f.stage) + opt('all', 'All stages', f.stage) + opt('overdue', 'Follow-up overdue', f.stage) + opt('closed', 'Paused / lost', f.stage) +
    ALL_STAGES.map(s => opt(s.key, (progressIdx(s.key) >= 0 ? (progressIdx(s.key) + 1) + '. ' : '') + s.label, f.stage)).join('');
  const bar = `<div class="filters">
    <input type="search" placeholder="Search name, phone, email, city" value="${esc(f.q)}" data-f="q" class="grow">
    ${reFilter('data-f="re"', f.re)}
    <label>Stage <select data-f="stage">${stageOpts}</select></label>
    <label>Market <select data-f="market">${opt('all', 'All', f.market)}${opt('Domestic', 'Domestic', f.market)}${opt('International', 'International', f.market)}</select></label>
    <label>Sort <select data-f="sort">${opt('appt_desc', 'Latest appointment', f.sort)}${opt('appt_asc', 'Oldest appointment', f.sort)}${opt('follow', 'Next follow-up', f.sort)}${opt('activity', 'Least recently updated', f.sort)}${opt('stage', 'Furthest stage', f.sort)}${opt('name', 'Name A–Z', f.sort)}</select></label>
    <div class="seg"><button class="${f.mode === 'table' ? 'on' : ''}" data-act="mode" data-mode="table">List</button><button class="${f.mode === 'board' ? 'on' : ''}" data-act="mode" data-mode="board">Board</button></div>
    <button class="btn ghost" data-act="csv">Download CSV</button>
  </div><p class="count">${ls.length} lead${ls.length === 1 ? '' : 's'}</p>`;
  if (f.mode === 'board') return bar + board(ls);
  const rows = ls.slice(0, f.limit).map(L => `<tr class="click" data-act="open" data-id="${esc(L.id)}">
    <td><b>${esc(L.name)}</b><div class="mut">${esc(L.phone || L.email || '')}</div></td>
    <td>${esc(L.re || '—')}</td>
    <td>${fmtDT(L.lastAppt)}<div class="mut">${esc(L.lastApptStatus || '')}</div></td>
    <td>${esc(L.city || '—')}<div class="mut">${esc(L.market || '')}</div></td>
    <td>${chip(L.stage)}</td>
    <td class="${isOverdue(L) ? 'warn' : isDueToday(L) ? 'due' : ''}">${L.followUp ? fmtDate(L.followUp) : (DEAD.has(L.stage) ? '' : '<span class="mut">Not set</span>')}</td>
    <td class="mut">${ago(L.lastActivityAt)}</td>
    <td class="n">${L.stage === 'order' ? inr(L.orderValue) : ''}</td></tr>`).join('');
  return bar + `<div class="card flush"><div class="tw"><table class="tbl leads"><thead><tr><th>Customer</th><th>Ring Expert</th><th>Latest appointment</th><th>City</th><th>Stage</th><th>Follow-up</th><th>Last update</th><th class="n">Order value</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${ls.length > f.limit ? `<div class="more"><button class="btn ghost" data-act="more">Show more (${ls.length - f.limit} left)</button></div>` : ''}</div>`;
}
function board(ls) {
  const cols = [...STAGES.map(s => ({ key: s.key, label: s.label, items: ls.filter(L => L.stage === s.key) })),
    { key: 'closed', label: 'Paused / lost', items: ls.filter(L => progressIdx(L.stage) < 0) }];
  return `<div class="board">${cols.map((c, i) => `<div class="col"><div class="colh"><span>${i < 8 ? i + 1 + '. ' : ''}${esc(c.label)}</span><b>${c.items.length}</b></div>
    ${c.items.slice(0, 60).map(L => `<div class="bc ${isOverdue(L) ? 'od' : ''}" data-act="open" data-id="${esc(L.id)}"><b>${esc(L.name)}</b>
      <div class="mut">${esc(L.re || 'Unassigned')}${c.key === 'closed' ? ' · ' + esc(STAGE_LABEL[L.stage]) : ''}</div>
      <div class="mut">${L.followUp && !DEAD.has(L.stage) ? (isOverdue(L) ? '<span class="warn">Overdue · ' : 'Follow-up · ') + fmtDate(L.followUp) + (isOverdue(L) ? '</span>' : '') : 'Appt ' + fmtDate(L.lastAppt)}</div></div>`).join('')}
    ${c.items.length > 60 ? `<div class="mut pad">+${c.items.length - 60} more — use the list view</div>` : ''}</div>`).join('')}</div>`;
}

/* ---------- follow-ups ---------- */
function viewFollowups() {
  if (!S.leads.size) return emptyState();
  const t = todayStr();
  const ls = leadsArr().filter(L => reMatch(L, S.fu.re) && !DEAD.has(L.stage) && L.stage !== 'cancelled');
  const groups = [
    { k: 'Overdue', cls: 'warn', items: ls.filter(L => L.followUp && L.followUp < t).sort((a, b) => a.followUp.localeCompare(b.followUp)) },
    { k: 'Today', cls: 'due', items: ls.filter(L => L.followUp === t) },
    { k: 'Next 7 days', items: ls.filter(L => L.followUp > t && L.followUp <= addDays(t, 7)).sort((a, b) => a.followUp.localeCompare(b.followUp)) },
    { k: 'No follow-up date set', items: ls.filter(L => !L.followUp).sort((a, b) => (a.lastActivityAt || '').localeCompare(b.lastActivityAt || '')) },
  ];
  const row = L => {
    const lastNote = [...(L.history || [])].reverse().find(h => h.type === 'note');
    const wa = waNumber(L.phone);
    return `<div class="fu">
      <div class="fu-main click" data-act="open" data-id="${esc(L.id)}"><b>${esc(L.name)}</b> ${chip(L.stage)}
        <div class="mut">${esc(L.re || 'Unassigned')} · ${esc(L.phone || L.email || '')}${L.followUp ? ' · due ' + fmtDate(L.followUp) : ''} · updated ${ago(L.lastActivityAt)}</div>
        ${lastNote ? `<div class="note-snip">“${esc(lastNote.text.slice(0, 140))}${lastNote.text.length > 140 ? '…' : ''}”</div>` : ''}</div>
      <div class="fu-act">${wa ? `<a class="btn ghost sm" href="https://wa.me/${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        <button class="btn sm" data-act="open" data-id="${esc(L.id)}">Update</button></div></div>`;
  };
  return `<div class="filters">${reFilter('data-fu="re"', S.fu.re)}
    <p class="sub grow">Every open lead should have a next follow-up date. Suggested cadence after a consultation: day 0 recap, day 2, day 5, day 10.</p></div>
    ${groups.map(g => `<section class="card"><h2 class="${g.cls || ''}">${g.k} <span class="cnt">${g.items.length}</span></h2>
      ${g.items.length ? g.items.slice(0, 150).map(row).join('') + (g.items.length > 150 ? `<p class="mut">+${g.items.length - 150} more</p>` : '') : '<p class="mut">Nothing here.</p>'}</section>`).join('')}`;
}

/* ---------- import ---------- */
function viewImport() {
  if (!isAdmin()) return `<div class="empty"><p>Only admins can import the CRM export.</p></div>`;
  const I = S.imp;
  let body = `<section class="card"><h2>1. Upload the appointment book export</h2>
    <p class="sub">CSV or Excel export from Zoho Bookings. Upload the full export every time: customers already in the engine are matched by phone number (then email), new appointments are added to their history, and the stages Ring Experts have set are kept.</p>
    <label class="drop" id="drop"><input type="file" id="file" accept=".csv,.xlsx,.xls" hidden><span>${I && I.fileName ? esc(I.fileName) + ` — ${I.rows.length} rows` : 'Click to choose a file, or drop it here'}</span></label></section>`;
  if (I && I.rows.length) {
    const sample = I.rows.slice(0, 3);
    body += `<section class="card"><h2>2. Check the columns</h2><p class="sub">Matched automatically. Fix any that are wrong.</p>
      <div class="tw"><table class="tbl map"><thead><tr><th>Field</th><th>Column in your file</th><th>Sample values</th></tr></thead><tbody>
      ${FIELDS.map(fd => `<tr><td><b>${fd.label}</b>${fd.req ? ' *' : ''}</td><td><select data-map="${fd.k}">${opt('', '— not in file —', I.map[fd.k])}${I.headers.map(h => opt(h, h, I.map[fd.k])).join('')}</select></td>
        <td class="mut">${I.map[fd.k] ? sample.map(r => esc(String(r[I.map[fd.k]] ?? '').slice(0, 30))).join(' · ') : ''}</td></tr>`).join('')}
      </tbody></table></div></section>`;
    const P = I.plan;
    if (P) {
      const bad = !I.map.name || !I.map.appt || (!I.map.phone && !I.map.email);
      body += `<section class="card"><h2>3. Review and import</h2>
        ${bad ? `<p class="warn">Map Customer name, Appointment date and at least one of Phone or Email first.</p>` : `
        <div class="kpis small">
          <div class="kpi"><div class="kl">New customers</div><div class="kv">${P.nw.length}</div></div>
          <div class="kpi"><div class="kl">Existing with new info</div><div class="kv">${P.up.length}</div><div class="ks">${P.up.filter(x => x.plan.stageChange).length} stage changes</div></div>
          <div class="kpi"><div class="kl">Unchanged</div><div class="kv">${P.same}</div></div>
          <div class="kpi"><div class="kl">Rows skipped</div><div class="kv">${P.skipped}</div><div class="ks">no name, phone or email</div></div>
        </div>
        <p class="sub">${P.rowsWithoutDate ? `${P.rowsWithoutDate} rows had a date that couldn't be read — check the Appointment date column. ` : ''}New customers start at the stage their latest CRM status implies: Completed → Consultation Done, No Show → No Show, Cancelled → Cancelled, anything else → Appointment Booked.</p>
        ${S.confirmed ? '' : '<p class="warn">Waiting for the live lead list before importing…</p>'}
        ${I.running ? `<div class="prog"><div style="width:${I.done / I.total * 100}%"></div></div><p class="sub">${I.done} of ${I.total} saved…</p>`
            : I.result ? `<p class="ok">${esc(I.result)}</p>`
            : `<button class="btn" data-act="run-import" ${(!S.confirmed || !(P.nw.length + P.up.length)) ? 'disabled' : ''}>Import ${P.nw.length + P.up.length} customers</button>`}`}
      </section>`;
    }
  }
  return body;
}
async function readFile(file) {
  if (typeof XLSX === 'undefined') { toast('The file reader didn\'t load. Reload the page and try again.', 'err'); return; }
  const isCsv = /\.csv$/i.test(file.name);
  const wb = isCsv ? XLSX.read(await file.text(), { type: 'string', raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const sig = headers.join('|');
  const saved = LS.get('map:' + sig, null);
  S.imp = { fileName: file.name, rows, headers, map: saved || autoMap(headers) };
  computePlan(); render();
}
function computePlan() {
  const I = S.imp; if (!I) return;
  const { groups, skipped } = groupRows(I.rows, I.map, leadsArr());
  const nw = [], up = []; let same = 0;
  const at = nowISO();
  for (const g of groups) {
    const ex = S.leads.get(g.id);
    const plan = planLead(g, ex, at, S.me.name);
    if (plan.type === 'new') nw.push({ id: g.id, plan }); else if (plan.type === 'update') up.push({ id: g.id, plan }); else same++;
  }
  const rowsWithoutDate = I.map.appt ? I.rows.filter(r => r[I.map.appt] !== '' && !parseDate(r[I.map.appt])).length : 0;
  I.plan = { nw, up, same, skipped, rowsWithoutDate };
  I.result = null;
}
async function runImport() {
  const I = S.imp; if (!I || !I.plan || I.running) return;
  await syncNow(); computePlan(); // diff against the latest data
  const { groups } = groupRows(I.rows, I.map, leadsArr());
  const send = groups.filter(g => { const p = planLead(g, S.leads.get(g.id), new Date().toISOString(), S.me.name); return p.type !== 'same'; });
  I.running = true; I.done = 0; I.total = send.length; render();
  let created = 0, updated = 0, failed = 0;
  for (let i = 0; i < send.length; i += 100) {
    const chunk = send.slice(i, i + 100);
    try {
      const r = await api('import', { method: 'POST', body: { groups: chunk } });
      r.leads.forEach(upsert); created += r.created; updated += r.updated;
    } catch (e) { failed += chunk.length; toast(e.message, 'err'); if (e.status === 401 || e.status === 403) break; }
    I.done = Math.min(i + 100, send.length);
    const pb = $('.prog div'); if (pb) pb.style.width = (I.done / I.total * 100) + '%'; const t = $('.prog + p'); if (t) t.textContent = `${I.done} of ${I.total} saved…`;
  }
  I.running = false;
  LS.set('map:' + I.headers.join('|'), I.map);
  I.result = failed ? `Imported ${created + updated} customers. ${failed} failed — run the import again to retry them.` : `Done. ${created} new customers added and ${updated} updated.`;
  render();
}

/* ---------- users (admin) ---------- */
function viewUsers() {
  if (!isAdmin()) return `<div class="empty"><p>Only admins can manage users.</p></div>`;
  if (!S.users) { loadUsers(); return `<div class="empty"><p>Loading users…</p></div>`; }
  const reNames = experts();
  const reSel = (cur, attr) => `<select ${attr}>${opt('', '— pick —', cur)}${reNames.map(n => opt(n, n, cur)).join('')}${cur && !reNames.includes(cur) ? opt(cur, cur, cur) : ''}</select>`;
  const rows = S.users.map(u => `<tr class="${u.active ? '' : 'inactive'}">
    <td><b>${esc(u.name)}</b><div class="mut">${esc(u.username)}</div></td>
    <td><select data-uset="role" data-u="${esc(u.username)}">${['admin', 'manager', 'expert'].map(r => opt(r, ROLE_LABEL[r], u.role)).join('')}</select></td>
    <td>${u.role === 'expert' ? reSel(u.re, `data-uset="re" data-u="${esc(u.username)}"`) : '<span class="mut">Sees all leads</span>'}</td>
    <td>${u.active ? '<span class="chip won"><i></i>Active</span>' : '<span class="chip lost"><i></i>Deactivated</span>'}</td>
    <td class="acts"><button class="btn ghost sm" data-act="u-reset" data-u="${esc(u.username)}">Reset PIN</button>
      ${u.active ? `<button class="btn ghost sm" data-act="u-off" data-u="${esc(u.username)}">Deactivate</button>` : `<button class="btn ghost sm" data-act="u-on" data-u="${esc(u.username)}">Activate</button>`}</td></tr>`).join('');
  return `<section class="card"><h2>Add a profile</h2><p class="sub">Each person logs in with their own username and PIN. Ring Experts only see leads where the CRM's Ring Expert name matches the name picked here.</p>
    <form id="user-form" class="ugrid">
      <label>Display name<input name="name" required placeholder="e.g. Roshan Kedari"></label>
      <label>Username<input name="username" required placeholder="e.g. roshan" autocapitalize="none" spellcheck="false"></label>
      <label>Role<select name="role" id="nu-role">${opt('expert', 'Ring Expert — own leads only', 'expert')}${opt('manager', 'Manager — all leads, no import or users', '')}${opt('admin', 'Admin — everything', '')}</select></label>
      <label id="nu-re-wrap">Ring Expert name in CRM${reSel('', 'name="re"')}</label>
      <label>Starting PIN / password<input name="pin" required minlength="4" placeholder="min 4 characters"></label>
      <button class="btn" type="submit">Add profile</button>
    </form>${reNames.length ? '' : '<p class="mut">Ring Expert names appear in the list after the first CRM import.</p>'}</section>
    <section class="card flush"><div class="tw"><table class="tbl"><thead><tr><th>Person</th><th>Role</th><th>Leads visible</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="mut">No profiles yet. You are logged in as the built-in admin.</td></tr>'}</tbody></table></div></section>
    <p class="mut">Deactivating a profile or resetting a PIN logs that person out everywhere straight away.</p>`;
}
async function loadUsers() { if (S.usersLoading) return; S.usersLoading = true; try { S.users = (await api('users')).users; render(); } catch (e) { toast(e.message, 'err'); } S.usersLoading = false; }
async function userOp(body, okMsg) {
  try { const r = await api('users', { method: 'POST', body }); const i = S.users.findIndex(u => u.username === r.user.username); if (i >= 0) S.users[i] = r.user; else S.users.push(r.user); S.users.sort((a, b) => a.name.localeCompare(b.name)); toast(okMsg); render(); return true; }
  catch (e) { toast(e.message, 'err'); render(); return false; }
}

/* ---------- modal (PIN change / reset) ---------- */
function renderModal() {
  const m = S.modal, el = $('#modal');
  if (!m) { el.innerHTML = ''; el.className = ''; return; }
  if (el.dataset.k === m.k) return; // keep typed values
  el.dataset.k = m.k; el.className = 'show';
  el.innerHTML = `<form class="card mbox" id="modal-form"><h2>${esc(m.title)}</h2>
    ${m.k === 'mypin' ? `<label>Current PIN<input type="password" name="current" required autocomplete="current-password"></label>` : `<p class="sub">Set a new PIN for <b>${esc(m.user)}</b> and share it with them privately.</p>`}
    <label>New PIN / password<input type="password" name="next" required minlength="4" autocomplete="new-password"></label>
    <label>Repeat it<input type="password" name="again" required minlength="4" autocomplete="new-password"></label>
    <p class="warn" id="modal-err"></p>
    <div class="row"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="modal-close">Cancel</button></div></form>`;
  const f = el.querySelector('input'); if (f) f.focus();
}
function closeModal() { S.modal = null; const el = $('#modal'); el.dataset.k = ''; renderModal(); }

/* ---------- drawer ---------- */
function openLead(id) { S.openId = id; S.pending = null; S.confirmDelete = false; document.body.classList.add('drawer-open'); renderDrawer(); }
function closeLead() { S.openId = null; S.pending = null; document.body.classList.remove('drawer-open'); $('#drawer').innerHTML = ''; }
function renderDrawer() {
  const L = S.leads.get(S.openId); const el = $('#drawer');
  if (!L) { closeLead(); return; }
  const dis = '';
  const cur = progressIdx(L.stage), reached = reachedIdx(L);
  const wa = waNumber(L.phone);
  const hist = [...(L.history || [])].reverse();
  const ae = document.activeElement, focusKey = ae && el.contains(ae) && ae.dataset ? ae.dataset.draft : null;
  const selStart = focusKey && 'selectionStart' in ae ? ae.selectionStart : null;
  const scrollTop = (el.querySelector('.db') || {}).scrollTop || 0;
  S.drawerStamp = L.updatedAt;
  const P = S.pending;
  let pendingForm = '';
  if (P && P.stage === 'order') {
    pendingForm = `<div class="pend"><h4>Mark order placed</h4>
      <div class="row wrap"><label>Order value (₹)<input type="number" min="0" step="1000" data-draft="ov" value="${esc(S.drafts.ov ?? (L.orderValue ?? ''))}" placeholder="e.g. 145000"></label>
      <label>Order date<input type="date" data-draft="od" value="${esc(S.drafts.od || L.orderDate || todayStr())}"></label>
      <label>Order / invoice no.<input type="text" data-draft="or" value="${esc(S.drafts.or ?? (L.orderRef || ''))}" placeholder="optional"></label></div>
      <div class="row"><button class="btn won" data-act="confirm-stage" ${dis}>Save order</button><button class="btn ghost" data-act="cancel-pending">Cancel</button></div></div>`;
  } else if (P) {
    const c = CLOSED.find(x => x.key === P.stage);
    pendingForm = `<div class="pend"><h4>Move to ${esc(c.label)}</h4>
      <label>Reason${c.key === 'postponed' ? ' / when to reconnect' : ''}<input type="text" data-draft="lr" value="${esc(S.drafts.lr ?? '')}" placeholder="${c.key === 'bought_elsewhere' ? 'e.g. Tanishq, price' : c.key === 'postponed' ? 'e.g. Wedding moved to Dec 2027' : 'e.g. Budget too low'}"></label>
      <div class="row"><button class="btn" data-act="confirm-stage" ${dis}>Save</button><button class="btn ghost" data-act="cancel-pending">Cancel</button></div></div>`;
  }
  el.innerHTML = `<div class="dh"><div><h3>${esc(L.name)}</h3><div class="mut">${chip(L.stage)} ${L.market === 'International' ? '<span class="chip">NRI</span>' : ''}</div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
  <div class="db">
    <div class="contact">
      ${L.phone ? `<div><span class="mut">Phone</span> ${esc(L.phone)} ${wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener" class="lnk">WhatsApp ↗</a>` : ''}</div>` : ''}
      ${L.email ? `<div><span class="mut">Email</span> ${esc(L.email)}</div>` : ''}
      <div><span class="mut">City</span> ${esc(L.city || '—')} · <span class="mut">Occasion</span> ${fmtDate(L.occasion)}${L.occasion ? ` (${(d => d < 0 ? Math.abs(d) + ' days ago' : 'in ' + d + ' days')(daysBetween(todayStr(), L.occasion))})` : ''}</div>
      <div class="row"><span class="mut">Ring Expert</span><select data-act-change="re" ${seesAll() ? '' : 'disabled'}>${opt('', 'Unassigned', L.re || '')}${experts().map(n => opt(n, n, L.re || '')).join('')}</select></div>
    </div>

    <h4>Journey stage</h4>
    <div class="stepper">${STAGES.map((s, i) => `<button class="step ${i === cur ? 'cur' : ''} ${i < cur || (cur < 0 && i <= reached) ? 'past' : ''} ${s.key === 'order' ? 'final' : ''}" data-act="stage" data-stage="${s.key}" ${dis}><span>${i + 1}</span>${s.label}</button>`).join('')}</div>
    <div class="closed-row">${CLOSED.map(c => `<button class="btn ghost sm ${L.stage === c.key ? 'on ' + c.kind : ''}" data-act="stage" data-stage="${c.key}" ${dis}>${c.label}</button>`).join('')}</div>
    ${pendingForm}
    ${L.stage === 'order' ? `<p class="ok">Order placed ${fmtDate(L.orderDate)} · ${inr(L.orderValue)}${L.orderRef ? ' · ' + esc(L.orderRef) : ''}</p>` : ''}
    ${L.lostReason && progressIdx(L.stage) < 0 ? `<p class="mut">Reason: ${esc(L.lostReason)}</p>` : ''}

    ${DEAD.has(L.stage) ? '' : `<h4>Next follow-up</h4>
    <div class="row wrap"><input type="date" value="${esc(L.followUp || '')}" data-act-change="followup" ${dis}>
      ${[['Tomorrow', 1], ['+2 days', 2], ['+5 days', 5], ['+10 days', 10]].map(([l, n]) => `<button class="btn ghost sm" data-act="fu-quick" data-n="${n}" ${dis}>${l}</button>`).join('')}
      ${L.followUp ? `<button class="btn ghost sm" data-act="fu-clear" ${dis}>Clear</button>` : ''}</div>
    ${isOverdue(L) ? `<p class="warn">Overdue since ${fmtDate(L.followUp)}</p>` : ''}`}

    <h4>Add a note</h4>
    <textarea rows="3" data-draft="note" placeholder="What happened on the call? Budget, designs liked, objections, next step…" ${dis}>${esc(S.drafts.note || '')}</textarea>
    <div class="row"><button class="btn" data-act="add-note" ${dis}>Add note</button><span class="mut">Logged with your name and the time.</span></div>

    <h4>Appointments from CRM</h4>
    <div class="bk">${(L.bookings || []).slice().reverse().map(b => `<div><b>${fmtDT(b.date)}</b> · ${esc(b.status || '—')}<div class="mut">${esc(b.service || '')}${b.re ? ' · ' + esc(b.re) : ''}${b.id ? ' · #' + esc(b.id) : ''}</div></div>`).join('') || '<p class="mut">None</p>'}</div>

    <h4>Activity</h4>
    <div class="tl">${hist.map(h => `<div class="ti ${h.type}"><div class="tt">${h.type === 'stage' ? `Moved to <b>${esc(STAGE_LABEL[h.stage] || h.stage)}</b>` : h.type === 'note' ? 'Note' : h.type === 'assign' ? 'Reassigned' : h.type === 'followup' ? 'Follow-up' : 'CRM update'}
      <span class="mut">· ${esc(who(h.by))} · ${fmtDT(h.at ? toLocalISO(new Date(h.at)) : '')}</span></div>${h.text ? `<div class="tx">${esc(h.text)}</div>` : ''}</div>`).join('')}</div>

    ${isAdmin() ? `<div class="danger">${S.confirmDelete ? `<span>Remove ${esc(L.name)} from the engine? This can't be undone.</span><button class="btn red sm" data-act="delete-yes">Remove</button><button class="btn ghost sm" data-act="delete-no">Keep</button>` : `<button class="btn ghost sm" data-act="delete">Remove lead (test or duplicate booking)</button>`}</div>` : ''}
  </div>`;
  const body = el.querySelector('.db'); if (body) body.scrollTop = scrollTop;
  if (focusKey) { const n = el.querySelector(`[data-draft="${focusKey}"]`); if (n) { n.focus(); try { if (selStart != null) n.setSelectionRange(selStart, selStart); } catch { } } }
}
async function setStage(stage, extra = {}) {
  const L = S.leads.get(S.openId); if (!L) return;
  try { await doAction(L.id, 'stage', { stage, ...extra }); toast('Moved to ' + STAGE_LABEL[stage]); } catch { }
}

/* ---------- export ---------- */
function downloadCsv() {
  const ls = filteredLeads();
  const cols = ['Name', 'Phone', 'Email', 'City', 'Market', 'Ring Expert', 'First appointment', 'Latest appointment', 'CRM status', 'Stage', 'Next follow-up', 'Last update', 'Order value', 'Order date', 'Reason', 'Latest note'];
  const q = v => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const lines = [cols.join(',')].concat(ls.map(L => {
    const note = [...(L.history || [])].reverse().find(h => h.type === 'note');
    return [L.name, L.phone, L.email, L.city, L.market, L.re, (L.firstAppt || '').replace('T', ' '), (L.lastAppt || '').replace('T', ' '), L.lastApptStatus, STAGE_LABEL[L.stage], L.followUp, (L.lastActivityAt || '').slice(0, 10), L.orderValue ?? '', L.orderDate, L.lostReason, note ? note.text : ''].map(q).join(',');
  }));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `leads-${todayStr()}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  if (a === 'open') return openLead(t.dataset.id);
  if (a === 'close') return closeLead();
  if (a === 'mode') { S.f.mode = t.dataset.mode; LS.set('mode', S.f.mode); return render(); }
  if (a === 'more') { S.f.limit += 200; return render(); }
  if (a === 'csv') return downloadCsv();
  if (a === 'logout') return logout();
  if (a === 'mypin') { S.modal = { k: 'mypin', title: 'Change your PIN' }; return renderModal(); }
  if (a === 'refresh') { await syncNow(); return toast('Up to date'); }
  if (a === 'modal-close') return closeModal();
  if (a === 'u-reset') { S.modal = { k: 'reset:' + t.dataset.u, title: 'Reset PIN', user: t.dataset.u }; return renderModal(); }
  if (a === 'u-off') return userOp({ op: 'deactivate', username: t.dataset.u }, 'Profile deactivated');
  if (a === 'u-on') return userOp({ op: 'activate', username: t.dataset.u }, 'Profile activated');
  if (a === 'goto-overdue') { S.f.stage = 'overdue'; S.f.re = S.df.re; location.hash = 'leads'; return; }
  if (a === 'goto-stage') { S.f.stage = t.dataset.stage; S.f.re = S.df.re; S.f.market = S.df.market; location.hash = 'leads'; return; }
  if (a === 'goto-re') { S.f.re = t.dataset.re; S.f.stage = 'all'; location.hash = 'leads'; return; }
  if (a === 'stage') {
    const k = t.dataset.stage; const c = CLOSED.find(x => x.key === k);
    if (k === 'order' || (c && c.reason)) { S.pending = { stage: k }; S.drafts.ov = undefined; S.drafts.od = undefined; S.drafts.or = undefined; S.drafts.lr = undefined; return renderDrawer(); }
    S.pending = null; return setStage(k);
  }
  if (a === 'cancel-pending') { S.pending = null; return renderDrawer(); }
  if (a === 'confirm-stage') {
    const P = S.pending; if (!P) return;
    const extra = P.stage === 'order'
      ? { orderValue: S.drafts.ov !== undefined && S.drafts.ov !== '' ? +S.drafts.ov : (S.leads.get(S.openId).orderValue ?? null), orderDate: S.drafts.od || todayStr(), orderRef: (S.drafts.or ?? '').trim() }
      : { lostReason: (S.drafts.lr ?? '').trim() };
    S.pending = null; return setStage(P.stage, extra);
  }
  if (a === 'fu-quick') { const v = addDays(todayStr(), +t.dataset.n); try { await doAction(S.openId, 'followup', { date: v }); toast('Follow-up set for ' + fmtDate(v)); } catch { } return; }
  if (a === 'fu-clear') { try { await doAction(S.openId, 'followup', { date: '' }); } catch { } return; }
  if (a === 'add-note') {
    const txt = (S.drafts.note || '').trim(); if (!txt) return toast('Write the note first.');
    try { S.drafts.note = ''; await doAction(S.openId, 'note', { text: txt }); renderDrawer(); toast('Note added'); } catch { S.drafts.note = txt; renderDrawer(); }
    return;
  }
  if (a === 'delete') { S.confirmDelete = true; return renderDrawer(); }
  if (a === 'delete-no') { S.confirmDelete = false; return renderDrawer(); }
  if (a === 'delete-yes') { const id = S.openId; closeLead(); try { await doAction(id, 'delete'); toast('Lead removed'); } catch { } return; }
  if (a === 'run-import') return runImport();
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.draft) { S.drafts[t.dataset.draft] = t.value; return; }
  if (t.dataset.f === 'q') { S.f.q = t.value; S.f.limit = 200; const pos = t.selectionStart; render(); const n = $('[data-f="q"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'nu-role') { $('#nu-re-wrap').style.display = t.value === 'expert' ? '' : 'none'; return; }
  if (t.dataset.uset) { const u = t.dataset.u, f = t.dataset.uset; return userOp({ op: 'update', username: u, [f]: t.value }, 'Profile updated'); }
  if (t.dataset.f && t.dataset.f !== 'q') { S.f[t.dataset.f] = t.value; S.f.limit = 200; return render(); }
  if (t.dataset.df) { S.df[t.dataset.df] = t.value; return render(); }
  if (t.dataset.fu) { S.fu[t.dataset.fu] = t.value; return render(); }
  if (t.dataset.map) { S.imp.map[t.dataset.map] = t.value; computePlan(); return render(); }
  if (t.id === 'file' && t.files[0]) return readFile(t.files[0]).catch(() => toast('Couldn\'t read that file. Export it again as CSV or .xlsx.', 'err'));
  if (t.dataset.actChange === 're') { try { await doAction(S.openId, 'assign', { re: t.value }); toast('Reassigned'); } catch { } return; }
  if (t.dataset.actChange === 'followup') { try { await doAction(S.openId, 'followup', { date: t.value }); } catch { } return; }
});
document.addEventListener('dragover', e => { if (e.target.closest('#drop')) { e.preventDefault(); e.target.closest('#drop').classList.add('over'); } });
document.addEventListener('dragleave', e => { const d = e.target.closest('#drop'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', e => { const d = e.target.closest('#drop'); if (!d) return; e.preventDefault(); d.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readFile(f).catch(() => toast('Couldn\'t read that file.', 'err')); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.openId) closeLead(); });
document.addEventListener('mousemove', e => { const r = e.target.closest('[data-tip]'); tip(e, r ? r.dataset.tip : null); });

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  if (f.id === 'login-form') {
    S.busy = true; render();
    try {
      const r = await api('login', { method: 'POST', body: { username: d.username, pin: d.pin } });
      S.token = r.token; LS.set('token', r.token); LS.set('lastUser', r.user.username); S.busy = false;
      await start(r.user);
    } catch (err) { S.busy = false; render(); const el = $('#login-err'); if (el) el.textContent = err.message; }
    return;
  }
  if (f.id === 'user-form') {
    if (await userOp({ op: 'create', name: d.name, username: String(d.username).trim().toLowerCase(), role: d.role, re: d.re, pin: d.pin }, 'Profile added. Share the username and PIN with them.')) f.reset();
    return;
  }
  if (f.id === 'modal-form') {
    const err = $('#modal-err');
    if (d.next !== d.again) { err.textContent = 'The two PINs don\'t match.'; return; }
    try {
      if (S.modal.k === 'mypin') { const r = await api('pin', { method: 'POST', body: { current: d.current, next: d.next } }); S.token = r.token; LS.set('token', r.token); toast('PIN changed'); }
      else { await api('users', { method: 'POST', body: { op: 'reset', username: S.modal.user, pin: d.next } }); toast('PIN reset. Share it with them privately.'); }
      closeModal();
    } catch (x) { err.textContent = x.message; }
  }
});

function route() {
  const h = location.hash.slice(1);
  const allowed = ['dashboard', 'leads', 'followups'].concat(isAdmin() ? ['import', 'users'] : []);
  const v = allowed.includes(h) ? h : 'dashboard';
  if (v !== S.view && S.openId) closeLead();
  S.view = v;
  render();
}
window.addEventListener('hashchange', route);

/* ---------- boot & sync ---------- */
const POLL_MS = 60000;
let pollT = null, syncing = null;
async function fullLoad() {
  const map = new Map(); let cursor = '0', first = true, since = 0;
  do {
    const r = await api('leads?cursor=' + encodeURIComponent(cursor));
    if (first) { since = r.serverTime - 2000; first = false; }
    r.leads.forEach(L => map.set(L.id, L)); cursor = r.cursor;
  } while (cursor !== '0');
  S.leads = map; S.since = since; S.confirmed = true; S.status = 'live';
}
async function syncNow() {
  if (!S.me) return;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      if (!S.confirmed) await fullLoad();
      else {
        const r = await api('sync?since=' + S.since);
        r.leads.forEach(upsert); r.removed.forEach(id => S.leads.delete(id));
        S.since = r.serverTime; S.status = 'live';
        if (S.openId && !S.leads.has(S.openId)) closeLead();
      }
    } catch (e) { if (e.status !== 401) S.status = 'error'; }
    if (S.imp && !S.imp.running && S.view === 'import') computePlan();
    render();
  })();
  try { return await syncing; } finally { syncing = null; }
}
function schedulePoll() { clearTimeout(pollT); pollT = setTimeout(async () => { if (document.visibilityState === 'visible') await syncNow(); schedulePoll(); }, POLL_MS); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.me) syncNow(); });

async function start(user) {
  S.me = user; S.leads = new Map(); S.confirmed = false; S.status = 'connecting'; S.users = null;
  if (user.role === 'expert') { S.f.re = 'all'; S.fu.re = 'all'; S.df.re = 'all'; }
  route();
  await syncNow();
  if (isAdmin()) loadUsers();
  schedulePoll();
}
function logout(msg) {
  S.token = ''; LS.del('token'); S.me = null; S.leads = new Map(); S.users = null; S.confirmed = false; clearTimeout(pollT);
  closeLead(); closeModal(); render();
  if (msg) { const el = $('#login-err'); if (el) el.textContent = msg; }
}
async function boot() {
  if (!S.token) return render();
  try { const r = await api('me'); await start(r.user); }
  catch (e) { if (e.status !== 401) { S.me = null; render(); const el = $('#login-err'); if (el) el.textContent = e.message; } }
}
boot();
