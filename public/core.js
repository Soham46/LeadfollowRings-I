/* Shared by the browser (public/app.js) and the API (api/*.js). No DOM, no database. */
const STAGES = [
  { key: 'booked',       label: 'Appointment Booked' },
  { key: 'consulted',    label: 'Consultation Done' },
  { key: 'designs',      label: 'Designs Shared' },
  { key: 'shortlisted',  label: 'Shortlisted' },
  { key: 'quote',        label: 'Quote Shared' },
  { key: 'visit_booked', label: 'Store Visit Booked' },
  { key: 'visit_done',   label: 'Store Visit Done' },
  { key: 'order',        label: 'Order Placed' },
];
const CLOSED = [
  { key: 'no_show',          label: 'No Show',          kind: 'paused', reason: false },
  { key: 'postponed',        label: 'Postponed',        kind: 'paused', reason: true },
  { key: 'cancelled',        label: 'Cancelled',        kind: 'lost',   reason: false },
  { key: 'not_interested',   label: 'Not Interested',   kind: 'lost',   reason: true },
  { key: 'bought_elsewhere', label: 'Bought Elsewhere', kind: 'lost',   reason: true },
];
const ALL_STAGES = [...STAGES, ...CLOSED];
const STAGE_LABEL = Object.fromEntries(ALL_STAGES.map(s => [s.key, s.label]));
// Stages where the lead no longer needs follow-up
const DEAD = new Set(['order', 'not_interested', 'bought_elsewhere']);

const pad = n => String(n).padStart(2, '0');
function toLocalISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dayStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dayStr(new Date()); }
function addDays(str, n) { const [y, m, d] = str.split('-').map(Number); return dayStr(new Date(y, m - 1, d + n)); }
function daysBetween(a, b) { // a, b: 'YYYY-MM-DD...' strings
  if (!a || !b) return null;
  const pa = a.slice(0, 10).split('-').map(Number), pb = b.slice(0, 10).split('-').map(Number);
  return Math.round((new Date(pb[0], pb[1] - 1, pb[2]) - new Date(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { // Excel serial date
      const d = new Date(Math.round((v - 25569) * 86400000));
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
    }
    return null;
  }
  const s = String(v).trim(); if (!s) return null;
  let hh = 0, mm = 0;
  const t = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (t) { hh = +t[1]; mm = +t[2]; if (t[3]) { const pm = /p/i.test(t[3]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; } }
  const yr = y => { y = +y; return y < 100 ? 2000 + y : y; };
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return new Date(+m[1], +m[2] - 1, +m[3], hh, mm);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) return new Date(yr(m[3]), +m[2] - 1, +m[1], hh, mm); // day-first (India)
  if ((m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3,9})[-\/ ,]+(\d{2,4})/))) { const mo = MON[m[2].toLowerCase().slice(0, 3)]; if (mo != null) return new Date(yr(m[3]), mo, +m[1], hh, mm); }
  if ((m = s.match(/^([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2,4})/))) { const mo = MON[m[1].toLowerCase().slice(0, 3)]; if (mo != null) return new Date(yr(m[3]), mo, +m[2], hh, mm); }
  const p = Date.parse(s); return isNaN(p) ? null : new Date(p);
}

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
function normName(v) { const s = clean(v); return s ? s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()) : ''; }
function phoneKey(raw) { const d = String(raw ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function waNumber(raw) { const d = String(raw ?? '').replace(/\D/g, ''); if (!d) return ''; return d.length === 10 ? '91' + d : d.replace(/^0+/, ''); }
const slug = s => String(s).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 150);

// Stage implied by all bookings: any completed consultation wins, else the latest booking's status
function bookingsStage(bookings) {
  if (bookings.some(b => crmStage(b.status) === 'consulted')) return 'consulted';
  const last = bookings[bookings.length - 1] || {};
  return crmStage(last.status);
}
function crmStage(status) {
  const s = String(status || '').toLowerCase();
  if (/no[\s-]?show/.test(s)) return 'no_show';
  if (/cancel/.test(s)) return 'cancelled';
  if (/complet|done|attended/.test(s)) return 'consulted';
  return 'booked';
}

const FIELDS = [
  { k: 'name',      label: 'Customer name',           req: true, c: ['customer', 'customer name', 'name', 'client name', 'full name'] },
  { k: 'phone',     label: 'Phone',                   c: ['customer contact number', 'contact number', 'phone', 'mobile', 'phone number', 'mobile number', 'customer phone'] },
  { k: 'email',     label: 'Email',                   c: ['customer email', 'email', 'email address', 'e-mail'] },
  { k: 'appt',      label: 'Appointment date & time', req: true, c: ['start time', 'appointment date', 'appointment time', 'booking date', 'start date', 'scheduled time', 'date'] },
  { k: 'status',    label: 'Appointment status',      c: ['status', 'booking status', 'appointment status'] },
  { k: 're',        label: 'Ring Expert',             c: ['ring expert', 'staff', 'staff name', 'assigned to', 'consultant'] },
  { k: 'service',   label: 'Service',                 c: ['service', 'service name', 'appointment type'] },
  { k: 'city',      label: 'City',                    c: ['response 1', 'city', 'location'] },
  { k: 'occasion',  label: 'Occasion date',           c: ['response 3', 'occasion date', 'occasion'] },
  { k: 'bookingId', label: 'Booking ID',              c: ['booking id', 'bookingid', 'appointment id'] },
];
function autoMap(headers) {
  const norm = h => String(h).toLowerCase().replace(/\s+/g, ' ').trim();
  const H = headers.map(h => ({ h, n: norm(h) }));
  const used = new Set(), map = {};
  for (const f of FIELDS) {
    let hit = null;
    for (const c of f.c) { hit = H.find(x => !used.has(x.h) && x.n === c); if (hit) break; }
    if (!hit) for (const c of f.c) { if (c.length < 5) continue; hit = H.find(x => !used.has(x.h) && x.n.includes(c)); if (hit) break; }
    if (hit) { used.add(hit.h); map[f.k] = hit.h; } else map[f.k] = '';
  }
  return map;
}

const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
const isIntl = s => /international|\bnri\b|overseas|global/i.test(s || '');

// Group raw rows into one record per customer
function groupRows(rows, map, existing = []) {
  const groups = new Map(); let skipped = 0;
  const get = (r, k) => (map[k] ? r[map[k]] : '');
  // Email -> customer id, so repeat bookings without a phone still land on the same customer
  const exIds = new Set(existing.map(L => L.id));
  const emailIdx = new Map();
  for (const L of existing) if (L.email && !emailIdx.has(L.email)) emailIdx.set(L.email, L.id);
  for (const r of rows) {
    const pk = phoneKey(get(r, 'phone')), em = clean(get(r, 'email')).toLowerCase();
    if (pk && em && !emailIdx.has(em)) emailIdx.set(em, 'p' + pk);
  }
  for (const r of rows) {
    const name = normName(get(r, 'name'));
    const phone = clean(get(r, 'phone'));
    const email = clean(get(r, 'email')).toLowerCase();
    const d = parseDate(get(r, 'appt'));
    const pk = phoneKey(phone);
    const id = pk ? (exIds.has('p' + pk) ? 'p' + pk : (email && emailIdx.get(email)) || 'p' + pk)
      : email ? (emailIdx.get(email) || 'e' + slug(email))
      : name ? 'n' + slug(name.toLowerCase()) : null;
    if (!id) { skipped++; continue; }
    const occ = parseDate(get(r, 'occasion'));
    const b = { id: clean(get(r, 'bookingId')), date: d ? toLocalISO(d) : '', status: clean(get(r, 'status')), service: clean(get(r, 'service')), re: normName(get(r, 're')) };
    b.key = slug(b.id || (b.date + '|' + b.service));
    let g = groups.get(id);
    if (!g) { g = { id, name, phone, phoneKey: pk, email, city: '', occasion: '', bookings: [] }; groups.set(id, g); }
    if (!g.name && name) g.name = name;
    if (!g.email && email) g.email = email;
    if (!g.phone && phone) g.phone = phone;
    const city = normName(get(r, 'city')); if (city) g.city = city;
    if (occ) g.occasion = dayStr(occ);
    const i = g.bookings.findIndex(x => x.key === b.key);
    if (i >= 0) g.bookings[i] = b; else g.bookings.push(b);
  }
  for (const g of groups.values()) g.bookings.sort(byDate);
  return { groups: [...groups.values()], skipped };
}

// Decide what to write for one customer. existing = current lead doc or undefined.
function planLead(g, existing, nowISO, uid) {
  const last = g.bookings[g.bookings.length - 1] || {};
  const firstDated = g.bookings.find(b => b.date);
  const market = g.bookings.some(b => isIntl(b.service)) ? 'International' : 'Domestic';
  if (!existing) {
    const stage = bookingsStage(g.bookings);
    return {
      type: 'new',
      doc: {
        name: g.name || '(no name)', phone: g.phone, phoneKey: g.phoneKey, email: g.email, city: g.city, occasion: g.occasion,
        market, service: last.service || '', re: last.re || '', bookings: g.bookings,
        firstAppt: firstDated ? firstDated.date : '', lastAppt: last.date || '', lastApptStatus: last.status || '',
        stage, followUp: '', orderValue: null, orderDate: '', orderRef: '', lostReason: '',
        history: [{ type: 'stage', stage, from: null, text: 'Imported from CRM' + (last.status ? ` (status: ${last.status})` : ''), at: nowISO, by: uid }],
        createdAt: nowISO, updatedAt: nowISO, lastActivityAt: nowISO,
      },
    };
  }
  const prev = new Map((existing.bookings || []).map(b => [b.key, b]));
  const merged = new Map(prev);
  let changed = false;
  for (const b of g.bookings) {
    const o = merged.get(b.key);
    if (!o) { merged.set(b.key, b); changed = true; }
    else if (o.status !== b.status || (b.re && o.re !== b.re) || o.date !== b.date) { merged.set(b.key, { ...o, ...b }); changed = true; }
  }
  if (!changed) return { type: 'same' };
  const bookings = [...merged.values()].sort(byDate);
  const nl = bookings[bookings.length - 1];
  const newBooking = !prev.has(nl.key) && (nl.date || '') > (existing.lastAppt || '');
  const patch = {
    bookings, lastAppt: nl.date || existing.lastAppt || '', lastApptStatus: nl.status || '',
    firstAppt: (bookings.find(b => b.date) || {}).date || existing.firstAppt || '',
    market: bookings.some(b => isIntl(b.service)) ? 'International' : 'Domestic',
    updatedAt: nowISO,
  };
  if (!existing.email && g.email) patch.email = g.email;
  if (!existing.city && g.city) patch.city = g.city;
  if (g.occasion && g.occasion !== existing.occasion) patch.occasion = g.occasion;
  if (!existing.re && nl.re) patch.re = nl.re;
  const cur = existing.stage, target = newBooking ? crmStage(nl.status) : bookingsStage(bookings);
  let newStage = null, text = '';
  if (cur === 'order') { /* never touch a won lead */ }
  else if (['booked', 'no_show', 'cancelled'].includes(cur)) { if (target !== cur) { newStage = target; text = `CRM status: ${nl.status || 'booked'}`; } }
  else if (['postponed', 'not_interested', 'bought_elsewhere'].includes(cur)) { if (newBooking) { newStage = target; text = 'Re-booked an appointment (CRM)'; } }
  const hist = [...(existing.history || [])];
  if (newStage) hist.push({ type: 'stage', stage: newStage, from: cur, text, at: nowISO, by: uid });
  else if (newBooking) hist.push({ type: 'import', text: `New appointment booked for ${nl.date.replace('T', ' ')} (CRM)`, at: nowISO, by: uid });
  if (newStage || newBooking) { patch.history = hist.slice(-200); patch.lastActivityAt = nowISO; }
  if (newStage) patch.stage = newStage;
  return { type: 'update', patch, stageChange: newStage ? [cur, newStage] : null, newBooking };
}

const progressIdx = s => STAGES.findIndex(x => x.key === s);
function reachedIdx(L) {
  const i = progressIdx(L.stage); if (i >= 0) return i;
  let mx = 0; for (const h of L.history || []) if (h.type === 'stage') { const j = progressIdx(h.stage); if (j > mx) mx = j; }
  return mx;
}

export { STAGES, CLOSED, ALL_STAGES, STAGE_LABEL, DEAD, pad, toLocalISO, dayStr, todayStr, addDays, daysBetween, parseDate, clean, normName, phoneKey, waNumber, slug, crmStage, bookingsStage, FIELDS, autoMap, groupRows, planLead, progressIdx, reachedIdx };
