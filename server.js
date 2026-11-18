// Элементар · Планер — сервер.
// Node.js 18+, без внешних зависимостей. Данные — в data/db.json.
// Настройки через переменные окружения (см. README.md):
//   PORT           порт (по умолчанию 8080)
//   TEAM_CODE      общий код команды; пусто — вход только по имени
//   DESIGNER_CODE  код дизайнера (исполнителя); обязателен
//   DATA_DIR       папка с данными (по умолчанию ./data)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const TEAM_CODE = (process.env.TEAM_CODE || '').trim();
const DESIGNER_CODE = (process.env.DESIGNER_CODE || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const OPEN_LOGIN = process.env.OPEN_LOGIN === '1'; // вход по имени без личной ссылки
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!DESIGNER_CODE) { console.error('Задайте DESIGNER_CODE (код дизайнера) в переменных окружения.'); process.exit(1); }

const DEFAULT_BRANDS = ['Бадаевский', 'Дом спорта', 'Capital Group', 'Золотой', 'Роза Вельвет', 'Капиталист', 'Темп', 'Узоры'];
const DEFAULT_COLORS = { 'Бадаевский': '#D7263D', 'Дом спорта': '#1E9E5A', 'Capital Group': '#1B2F6E', 'Роза Вельвет': '#C9A27E', 'Золотой': '#F2B705', 'Темп': '#7B3FC4', 'Капиталист': '#1A1A1E', 'Узоры': '#35A7E8' };
const STATUSES = ['new', 'work', 'review', 'done'];

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { tasks: {}, logs: {}, users: {}, sessions: {}, config: { brands: DEFAULT_BRANDS, brandColors: DEFAULT_COLORS } };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') { console.error('Не читается', DB_FILE, e.message); process.exit(1); } }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 150);
}
function flushSync() { if (saveTimer) { clearTimeout(saveTimer); const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); } }
process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });

// ---------- helpers ----------
const id = (n = 10) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n);
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const normName = s => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const isDate = v => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = v => v === '' || /^\d{2}:\d{2}$/.test(v);
const isUrl = v => v === '' || /^https?:\/\/\S+$/i.test(v);

function send(res, code, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 200 * 1024) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}
function auth(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  if (!token) return null;
  const s = db.sessions[token]; if (!s) return null;
  const u = db.users[s.userId]; if (!u) return null;
  if (u.disabled) return null;
  if (s.role !== 'designer' && !s.viaInvite && TEAM_CODE && s.teamCode !== TEAM_CODE) return null; // код команды сменили — перелогин
  const admin = s.role === 'designer';
  return { token, user: u, admin, role: u.role || (admin ? 'designer' : 'manager') };
}
const publicUser = u => ({ id: u.id, name: u.name, role: u.role || 'manager', disabled: !!u.disabled });
const ROLES = ['designer', 'manager', 'head'];
const isDesigner = a => a.admin;                 // администратор (вход по коду дизайнера)
const isHead = a => a.admin || a.role === 'head';
const canExec = (a, t) => isHead(a) || t.assignee === a.user.id;
const canManage = (a, t) => isHead(a) || t.createdBy === a.user.id;
const canEdit = (a, t) => canManage(a, t) || canExec(a, t);
const assignable = id => { const u = db.users[id]; return !!u && !u.disabled && u.role === 'designer'; };
function migrate() {
  const adminSess = Object.values(db.sessions).find(x => x.role === 'designer');
  let changed = false;
  if (adminSess && db.users[adminSess.userId] && !db.users[adminSess.userId].role) { db.users[adminSess.userId].role = 'designer'; changed = true; }
  for (const u of Object.values(db.users)) if (!u.role) { u.role = 'manager'; changed = true; }
  const fallback = adminSess ? adminSess.userId : (Object.values(db.users).find(u => u.role === 'designer') || {}).id;
  if (fallback) for (const t of Object.values(db.tasks)) if (t.assignee === undefined) { t.assignee = fallback; changed = true; }
  db.config.added = db.config.added || [];
  if (!db.config.added.includes('Узоры')) { db.config.added.push('Узоры'); if (!db.config.brands.includes('Узоры')) db.config.brands = [...db.config.brands, 'Узоры']; db.config.brandColors = Object.assign({}, db.config.brandColors, { 'Узоры': db.config.brandColors['Узоры'] || '#35A7E8' }); changed = true; }
  if (!db.config.added.includes('colors-2')) { db.config.added.push('colors-2'); db.config.brandColors = Object.assign({}, db.config.brandColors, { 'Капиталист': '#1A1A1E', 'Узоры': '#35A7E8' }); changed = true; }
  if (changed) save();
}

const publicConfig = () => ({ brands: db.config.brands, brandColors: db.config.brandColors });

// ---------- admin code ----------
// Если код сменили через интерфейс, он хранится в базе как хэш и важнее DESIGNER_CODE из .env
function hashCode(code, salt) { return crypto.scryptSync(String(code), salt, 32).toString('hex'); }
function checkAdminCode(code) {
  const c = db.config.adminCode;
  if (c && c.salt && c.hash) return safeEq(hashCode(code, c.salt), c.hash);
  return safeEq(code, DESIGNER_CODE);
}
const loginFails = new Map();
function tooManyFails(ip) { const f = loginFails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60 * 1000; }
function noteFail(ip) { const f = loginFails.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - f.t > 10 * 60 * 1000) { f.n = 0; f.t = Date.now(); } f.n++; loginFails.set(ip, f); }

// ---------- realtime (SSE) ----------
const clients = new Set();
function broadcast(ev) { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(line); }
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

function addLog(taskId, entry) {
  const e = Object.assign({ id: id(12) }, entry);
  (db.logs[taskId] || (db.logs[taskId] = [])).push(e);
  broadcast({ type: 'log', taskId, entry: e });
  return e;
}
function cleanTask(input, base) {
  const t = Object.assign({}, base);
  if ('title' in input) { const v = str(input.title, 200); if (!v) throw Object.assign(new Error('Пустое название'), { status: 400 }); t.title = v; }
  if ('brand' in input) t.brand = str(input.brand, 60);
  if ('desc' in input) t.desc = str(input.desc, 5000);
  if ('link' in input) { const v = str(input.link, 500); if (!isUrl(v)) throw Object.assign(new Error('Плохая ссылка'), { status: 400 }); t.link = v; }
  if ('resultLink' in input) { const v = str(input.resultLink, 500); if (!isUrl(v)) throw Object.assign(new Error('Плохая ссылка'), { status: 400 }); t.resultLink = v; }
  if ('due' in input) { const v = str(input.due, 10); if (!isDate(v)) throw Object.assign(new Error('Плохая дата'), { status: 400 }); t.due = v; }
  if ('dueTime' in input) { const v = str(input.dueTime, 5); if (!isTime(v)) throw Object.assign(new Error('Плохое время'), { status: 400 }); t.dueTime = v; }
  if ('priority' in input) t.priority = input.priority === 'fire' ? 'fire' : 'normal';
  if ('size' in input) t.size = ['S', 'M', 'L', 'XL'].includes(input.size) ? input.size : '';
  if ('status' in input) { if (!STATUSES.includes(input.status)) throw Object.assign(new Error('Плохой статус'), { status: 400 }); t.status = input.status; }
  return t;
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;

  if (p === '/api/info' && m === 'GET') return send(res, 200, { teamCodeRequired: !!TEAM_CODE, openLogin: OPEN_LOGIN });

  if (p === '/api/session/invite' && m === 'POST') {
    const b = await readBody(req);
    const key = str(b.key, 80);
    const u = key && Object.values(db.users).find(x => x.inviteKey && !x.disabled && safeEq(x.inviteKey, key));
    if (!u) return send(res, 403, { error: 'Ссылка недействительна — попросите у администратора новую' });
    const token = id(32);
    db.sessions[token] = { userId: u.id, role: 'member', teamCode: TEAM_CODE, viaInvite: true, createdAt: Date.now() };
    u.lastSeen = Date.now();
    save();
    return send(res, 200, { token, me: publicUser(u), role: u.role || 'manager', admin: false });
  }

  if (p === '/api/session' && m === 'POST') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (tooManyFails(ip)) return send(res, 429, { error: 'Слишком много попыток — подождите 10 минут' });
    const b = await readBody(req);
    const name = str(b.name, 80).replace(/\s+/g, ' ');
    const code = str(b.code, 100);
    if (name.split(' ').filter(Boolean).length < 2) return send(res, 400, { error: 'Введите имя и фамилию' });
    let role = 'member';
    if (code && checkAdminCode(code)) role = 'designer';
    else if (!OPEN_LOGIN) { if (code) noteFail(ip); return send(res, 403, { error: code ? 'Неверный код' : 'Вход только по личной ссылке — попросите её у администратора' }); }
    else if (TEAM_CODE && !safeEq(code, TEAM_CODE)) return send(res, 403, { error: 'Неверный код команды' });
    let u = Object.values(db.users).find(x => normName(x.name) === normName(name));
    if (!u) { u = { id: 'u' + id(9), name, createdAt: Date.now() }; db.users[u.id] = u; }
    if (role === 'designer' && !u.role) u.role = 'designer';
    if (!u.role) u.role = 'manager';
    broadcast({ type: 'user', user: publicUser(u) });
    const token = id(32);
    db.sessions[token] = { userId: u.id, role, teamCode: TEAM_CODE, createdAt: Date.now() };
    save();
    migrate();
    return send(res, 200, { token, me: publicUser(u), role: u.role, admin: role === 'designer' });
  }

  const a = auth(req, url);
  if (!a) return send(res, 401, { error: 'Нужно войти' });

  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/me' && m === 'GET') return send(res, 200, { me: publicUser(a.user), role: a.role, admin: a.admin });
  if (p === '/api/logout' && m === 'POST') { delete db.sessions[a.token]; save(); return send(res, 200, {}); }

  if (p === '/api/state' && m === 'GET') {
    migrate();
    const designer = Object.values(db.sessions).find(s => s.role === 'designer');
    return send(res, 200, {
      me: publicUser(a.user), role: a.role, admin: a.admin,
      tasks: Object.values(db.tasks),
      users: Object.values(db.users).map(publicUser),
      config: Object.assign(publicConfig(), { ownerId: designer ? designer.userId : null }),
    });
  }

  if (p === '/api/admin/code' && m === 'POST') {
    if (!isDesigner(a)) return send(res, 403, { error: 'Только администратор' });
    const b = await readBody(req);
    const cur = typeof b.current === 'string' ? b.current : '';
    const next = typeof b.next === 'string' ? b.next : '';
    if (!checkAdminCode(cur)) return send(res, 403, { error: 'Текущий код неверный' });
    if (next.length < 8 || next.length > 100) return send(res, 400, { error: 'Новый код — от 8 до 100 символов' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.config.adminCode = { salt, hash: hashCode(next, salt), changedAt: Date.now() };
    for (const [t, s] of Object.entries(db.sessions)) if (s.role === 'designer' && t !== a.token) delete db.sessions[t];
    save();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/people' && m === 'GET') {
    if (!isDesigner(a)) return send(res, 403, { error: 'Только администратор' });
    return send(res, 200, Object.values(db.users).map(u => ({ id: u.id, name: u.name, role: u.role || 'manager', inviteKey: u.inviteKey || null, disabled: !!u.disabled, lastSeen: u.lastSeen || null, createdAt: u.createdAt })));
  }
  if (p === '/api/people' && m === 'POST') {
    if (!isDesigner(a)) return send(res, 403, { error: 'Только администратор' });
    const b = await readBody(req);
    const name = str(b.name, 80).replace(/\s+/g, ' ');
    if (name.split(' ').filter(Boolean).length < 2) return send(res, 400, { error: 'Введите имя и фамилию' });
    let u = Object.values(db.users).find(x => normName(x.name) === normName(name));
    if (u && !u.disabled) return send(res, 409, { error: 'Такой человек уже есть' });
    if (!u) { u = { id: 'u' + id(9), name, createdAt: Date.now() }; db.users[u.id] = u; }
    u.disabled = false; u.inviteKey = id(24); u.role = ROLES.includes(b.role) ? b.role : (u.role || 'manager');
    save(); broadcast({ type: 'user', user: publicUser(u) });
    return send(res, 201, { id: u.id, name: u.name, role: u.role, inviteKey: u.inviteKey, disabled: false });
  }
  let rm = p.match(/^\/api\/people\/([A-Za-z0-9]+)$/);
  if (rm && m === 'PATCH') {
    if (!isDesigner(a)) return send(res, 403, { error: 'Только администратор' });
    const u = db.users[rm[1]]; if (!u) return send(res, 404, { error: 'Нет такого человека' });
    const b = await readBody(req);
    if (ROLES.includes(b.role)) u.role = b.role;
    save(); broadcast({ type: 'user', user: publicUser(u) });
    return send(res, 200, publicUser(u));
  }
  let pm = p.match(/^\/api\/people\/([A-Za-z0-9]+)\/(reset|disable)$/);
  if (pm && m === 'POST') {
    if (!isDesigner(a)) return send(res, 403, { error: 'Только администратор' });
    const u = db.users[pm[1]]; if (!u) return send(res, 404, { error: 'Нет такого человека' });
    if (u.id === a.user.id) return send(res, 400, { error: 'Себя менять нельзя' });
    for (const [t, s] of Object.entries(db.sessions)) if (s.userId === u.id) delete db.sessions[t];
    if (pm[2] === 'reset') { u.inviteKey = id(24); u.disabled = false; } else { u.inviteKey = null; u.disabled = true; }
    save(); broadcast({ type: 'user', user: publicUser(u) });
    return send(res, 200, { id: u.id, name: u.name, inviteKey: u.inviteKey, disabled: !!u.disabled });
  }

  if (p === '/api/config' && m === 'PATCH') {
    if (!isDesigner(a)) return send(res, 403, { error: 'Только администратор' });
    const b = await readBody(req);
    if (Array.isArray(b.brands)) db.config.brands = b.brands.map(x => str(x, 60)).filter(Boolean).slice(0, 40);
    if (b.brandColors && typeof b.brandColors === 'object') { const c = {}; for (const [k, v] of Object.entries(b.brandColors)) if (/^#[0-9a-f]{6}$/i.test(v)) c[str(k, 60)] = v; db.config.brandColors = c; }
    save(); broadcast({ type: 'config', config: publicConfig() });
    return send(res, 200, publicConfig());
  }

  if (p === '/api/tasks' && m === 'POST') {
    const b = await readBody(req);
    const now = Date.now();
    const t = cleanTask(b, { id: 't' + id(9), title: '', brand: '', desc: '', link: '', resultLink: '', due: '', dueTime: '', priority: 'normal', status: 'new', createdBy: a.user.id, createdAt: now, updatedAt: now, statusAt: now });
    if (!t.title) return send(res, 400, { error: 'Пустое название' });
    t.status = 'new';
    if (isHead(a) && typeof b.createdBy === 'string' && db.users[b.createdBy]) t.createdBy = b.createdBy;
    t.assignee = (typeof b.assignee === 'string' && assignable(b.assignee)) ? b.assignee : null;
    db.tasks[t.id] = t;
    addLog(t.id, { kind: 'event', text: 'Поставил(а) задачу', by: a.user.id, at: now });
    save(); broadcast({ type: 'task', task: t });
    return send(res, 201, t);
  }

  let mm = p.match(/^\/api\/tasks\/([A-Za-z0-9]+)$/);
  if (mm) {
    const t = db.tasks[mm[1]];
    if (!t) return send(res, 404, { error: 'Задача не найдена' });
    if (m === 'PATCH') {
      const b = await readBody(req);
      const contentKeys = ['title', 'brand', 'desc', 'link'];
      const touchesContent = contentKeys.some(k => k in b);
      const touchesPlan = ['due', 'dueTime', 'priority'].some(k => k in b);
      if ('size' in b && !canExec(a, t)) return send(res, 403, { error: 'Размер ставит исполнитель' });
      if (touchesContent && !canManage(a, t)) return send(res, 403, { error: 'Это не ваша задача' });
      if (touchesPlan && !canEdit(a, t)) return send(res, 403, { error: 'Это не ваша задача' });
      if ('assignee' in b) {
        const to = b.assignee === null ? null : b.assignee;
        if (to !== null && !assignable(to)) return send(res, 400, { error: 'Это не дизайнер' });
        const selfTake = !t.assignee && to === a.user.id && a.user.role === 'designer';
        const requesterOk = t.createdBy === a.user.id && t.status === 'new';
        if (!isHead(a) && !selfTake && !requesterOk) return send(res, 403, { error: 'Переназначать может руководитель' });
      }
      if (touchesContent && (t.status === 'review' || t.status === 'done')) return send(res, 403, { error: 'На проверке задачу менять нельзя' });
      if ('status' in b) {
        const to = b.status;
        const okHead = isHead(a);
        const okExec = t.assignee === a.user.id && to !== 'done' && t.status !== 'done';
        const okRequester = t.createdBy === a.user.id && ((t.status === 'review' && to === 'done') || (t.status === 'done' && to === 'work'));
        if (!okHead && !okExec && !okRequester) return send(res, 403, { error: 'Нельзя сменить статус' });
      }
      if ('resultLink' in b && !canExec(a, t)) return send(res, 403, { error: 'Только исполнитель' });
      if ('createdBy' in b && !isHead(a)) return send(res, 403, { error: 'Только руководитель' });
      const before = t.status;
      const next = cleanTask(b, t);
      if (isHead(a) && typeof b.createdBy === 'string' && db.users[b.createdBy]) next.createdBy = b.createdBy;
      if ('assignee' in b) next.assignee = b.assignee === null ? null : b.assignee;
      const now = Date.now();
      next.updatedAt = now;
      if (next.status !== before) {
        const spent = Math.max(0, now - (t.statusAt || t.createdAt || now));
        const st = Object.assign({ rounds: 0, reviewMs: 0, workMs: 0, reschedules: 0 }, t.stats || {});
        if (before === 'review') st.reviewMs += spent;
        if (before === 'work') st.workMs += spent;
        if (before === 'review' && next.status === 'work') st.rounds += 1;
        if (next.status === 'review' && !st.firstReviewAt) st.firstReviewAt = now;
        if (next.status === 'done') {
          const [y, mo, d] = (next.due || '').split('-').map(Number);
          if (y) { const [hh, mm] = (/^\d{2}:\d{2}$/.test(next.dueTime || '') ? next.dueTime : '23:59').split(':').map(Number); st.onTime = now <= new Date(y, mo - 1, d, hh, mm).getTime(); } else st.onTime = null;
        }
        next.stats = st;
        next.statusAt = now; if (next.status === 'done') next.doneAt = now;
      }
      if (('due' in b || 'dueTime' in b) && (next.due !== t.due || next.dueTime !== t.dueTime) && t.due) {
        next.stats = Object.assign({ rounds: 0, reviewMs: 0, workMs: 0, reschedules: 0 }, next.stats || t.stats || {});
        next.stats.reschedules += 1;
      }
      db.tasks[t.id] = next;
      save(); broadcast({ type: 'task', task: next });
      return send(res, 200, next);
    }
    if (m === 'DELETE') {
      if (!canManage(a, t)) return send(res, 403, { error: 'Это не ваша задача' });
      if (t.status === 'review' || t.status === 'done') return send(res, 403, { error: 'Задачу на проверке удалить нельзя' });
      delete db.tasks[t.id]; delete db.logs[t.id];
      save(); broadcast({ type: 'task-del', id: t.id });
      return send(res, 200, {});
    }
  }

  mm = p.match(/^\/api\/tasks\/([A-Za-z0-9]+)\/log$/);
  if (mm) {
    const t = db.tasks[mm[1]];
    if (!t) return send(res, 404, { error: 'Задача не найдена' });
    if (m === 'GET') return send(res, 200, db.logs[t.id] || []);
    if (m === 'POST') {
      const b = await readBody(req);
      const kind = ['comment', 'event', 'return'].includes(b.kind) ? b.kind : 'comment';
      const text = str(b.text, 3000);
      if (!text) return send(res, 400, { error: 'Пустой комментарий' });
      const entry = { kind, text, by: a.user.id, at: Date.now() };
      if (typeof b.replyTo === 'string' && (db.logs[t.id] || []).some(x => x.id === b.replyTo)) entry.replyTo = b.replyTo;
      const e = addLog(t.id, entry);
      save();
      return send(res, 201, e);
    }
  }
  return send(res, 404, { error: 'Нет такого адреса' });
}

// ---------- static ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(data);
  });
}

migrate();
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Ошибка сервера' : (e.message || 'Ошибка') });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Планер слушает http://127.0.0.1:${PORT}  (код команды: ${TEAM_CODE ? 'включён' : 'выключен'})`));
