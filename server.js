// Walk Keeper sync server. No npm packages: Node 24 only.
// Serves the app (index.html) and keeps the family's people and walks in one JSON file.
//
// Settings (environment, see /srv/walkkeeper/.env on the server):
//   PORT, HOST           where to listen (default 127.0.0.1:8830)
//   WK_PASS_HASH         scrypt hash of the family password: "salt:hash" in hex (make with: node server.js hash <password>)
//   WK_SECRET            random text that signs the login tokens
//   WK_DATA              data folder (default ./data)
//   WK_ORIGINS           extra web addresses that may call the API (comma list)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

if (process.argv[2] === 'hash') {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(process.argv[3] || '', salt, 32);
  console.log(`${salt.toString('hex')}:${h.toString('hex')}`);
  process.exit(0);
}

const PORT = +process.env.PORT || 8830;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.WK_DATA || path.join(__dirname, 'data');
const SECRET = process.env.WK_SECRET || '';
const PASS_HASH = process.env.WK_PASS_HASH || '';
const ORIGINS = new Set(['https://nicolaas001-del.github.io',
  ...(process.env.WK_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
const FILE = path.join(DATA, 'family.json');
const TOKEN_DAYS = 400;
const MAX_BODY = 20 * 1024 * 1024;

if (!SECRET || !PASS_HASH) { console.error('WK_SECRET and WK_PASS_HASH must be set'); process.exit(1); }
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });

// ---------- data ----------
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return { profiles: [], deleted: [], rev: 0 }; }
}
let data = load();
function store() {
  data.rev = (data.rev || 0) + 1;
  data.savedAt = Date.now();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);                                 // all or nothing
  // One backup per day, keep the last 30.
  const day = new Date().toISOString().slice(0, 10);
  const b = path.join(DATA, 'backups', `family-${day}.json`);
  try {
    fs.copyFileSync(FILE, b);
    const all = fs.readdirSync(path.join(DATA, 'backups')).filter(f => f.startsWith('family-')).sort();
    for (const f of all.slice(0, -30)) fs.unlinkSync(path.join(DATA, 'backups', f));
  } catch (e) { console.error('backup failed', e.message); }
}

// Merge what a phone sends with what the server has. Nothing is lost:
// - people: matched by id; the newest edit (updatedAt) wins for name, weight, etc.
// - walks: all walks of both sides, matched by their start time
// - deleted people: stay deleted on every device
const PERSON_FIELDS = ['name', 'kg', 'age', 'sex', 'goal'];
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
function cleanWalk(w) {
  if (!w || typeof w !== 'object' || !isFinite(w.date)) return null;
  const out = { date: num(w.date, 0), time: num(w.time, 0), dist: num(w.dist, 0), steps: num(w.steps, 0), kcal: num(w.kcal, 0) };
  if (Array.isArray(w.samples)) out.samples = w.samples.slice(0, 20000)
    .filter(s => s && isFinite(s.t)).map(s => ({ t: num(s.t, 0), d: num(s.d, 0), hr: num(s.hr, 0) }));
  return out;
}
function merge(cur, inc) {
  const deleted = new Set([...(cur.deleted || []), ...((inc.deleted || []).filter(x => typeof x === 'string'))]);
  const byId = new Map();
  for (const p of cur.profiles || []) byId.set(p.id, p);
  for (const p of inc.profiles || []) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 60) continue;
    const old = byId.get(p.id);
    const fresh = { id: p.id, updatedAt: num(p.updatedAt, 0), history: [] };
    for (const k of PERSON_FIELDS) fresh[k] = p[k];
    fresh.name = String(fresh.name || 'Walker').slice(0, 40);
    fresh.kg = num(+fresh.kg, 80); fresh.age = num(+fresh.age, 40); fresh.goal = num(+fresh.goal, 10);
    fresh.sex = fresh.sex === 'f' ? 'f' : 'm';
    let next;
    if (!old) next = fresh;
    else {
      next = (fresh.updatedAt > num(old.updatedAt, 0)) ? { ...fresh } : { ...old };
      next.history = old.history || [];
    }
    const walks = new Map((next.history || []).map(w => [w.date, w]));
    for (const w of p.history || []) {
      const c = cleanWalk(w);
      if (!c) continue;
      const have = walks.get(c.date);
      if (!have || (!have.samples && c.samples)) walks.set(c.date, c);
    }
    next.history = [...walks.values()].sort((a, b) => a.date - b.date);
    byId.set(p.id, next);
  }
  const profiles = [...byId.values()].filter(p => !deleted.has(p.id));
  return { profiles, deleted: [...deleted].slice(-500), rev: cur.rev || 0 };
}

// Live walks: kept in memory only (a restart just shows them again 1 s later).
const live = new Map();                 // deviceId -> { profileId, name, device, time, dist, kcal, speed, hr, paused, connected, at, cmds }
const LIVE_TTL = 15000;
const LIVE_FIELDS = ['profileId', 'name', 'device', 'time', 'dist', 'kcal', 'speed', 'hr', 'paused', 'connected', 'pausedSpeed'];

// ---------- login ----------
function checkPassword(pw) {
  const [salt, hash] = PASS_HASH.split(':');
  const h = crypto.scryptSync(String(pw || ''), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken() {
  const exp = String(Date.now() + TOKEN_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}
function tokenOk(req) {
  const m = /^Bearer (\d+)\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (!m || +m[1] < Date.now()) return false;
  const want = Buffer.from(sign(m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// Slow down password guessing: 10 tries per 15 minutes per address.
const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 15 * 60e3);
  tries.set(ip, t);
  return t.length >= 10;
}

// ---------- web ----------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { reject(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const cors = origin && ORIGINS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
    : {};
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (tooMany(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' }, undefined, cors);
      const body = await readBody(req);
      if (!checkPassword(body.password)) {
        tries.get(ip).push(Date.now());
        return send(res, 401, { error: 'Wrong password.' }, undefined, cors);
      }
      return send(res, 200, { token: makeToken() }, undefined, cors);
    }

    if (url.pathname === '/api/sync') {
      if (!tokenOk(req)) return send(res, 401, { error: 'Please log in again.' }, undefined, cors);
      if (req.method === 'GET') return send(res, 200, data, undefined, cors);
      if (req.method === 'POST') {
        const body = await readBody(req);
        const before = JSON.stringify([data.profiles, data.deleted]);
        const next = merge(data, body);
        if (JSON.stringify([next.profiles, next.deleted]) !== before) { data = next; store(); }
        return send(res, 200, data, undefined, cors);
      }
    }

    // ---------- live walks ----------
    // The device that is connected to the treadmill (the "host") sends its numbers
    // every second, and gets back the commands other devices sent for it.
    // Other devices read the live walks, and can send STOP, pause, resume or a speed.
    if (url.pathname.startsWith('/api/live')) {
      if (!tokenOk(req)) return send(res, 401, { error: 'Please log in again.' }, undefined, cors);
      const now = Date.now();
      for (const [k, v] of live) if (now - v.at > LIVE_TTL) live.delete(k);
      if (url.pathname === '/api/live' && req.method === 'GET') {
        return send(res, 200, { now, walks: [...live.values()].map(({ cmds, ...w }) => w) }, undefined, cors);
      }
      if (url.pathname === '/api/live' && req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.deviceId !== 'string' || !b.deviceId || b.deviceId.length > 60) return send(res, 400, { error: 'deviceId' }, undefined, cors);
        const old = live.get(b.deviceId);
        if (b.end) { live.delete(b.deviceId); return send(res, 200, { cmds: [] }, undefined, cors); }
        const w = { deviceId: b.deviceId, at: now, cmds: [] };
        for (const k of LIVE_FIELDS) w[k] = typeof b[k] === 'number' || typeof b[k] === 'boolean' ? b[k] : String(b[k] ?? '').slice(0, 40);
        const cmds = old ? old.cmds : [];
        live.set(b.deviceId, w);
        return send(res, 200, { cmds }, undefined, cors);
      }
      if (url.pathname === '/api/live/cmd' && req.method === 'POST') {
        const b = await readBody(req);
        const w = live.get(b.deviceId);
        if (!w) return send(res, 404, { error: 'This walk is not live any more.' }, undefined, cors);
        if (!['stop', 'pause', 'resume', 'speed'].includes(b.cmd)) return send(res, 400, { error: 'cmd' }, undefined, cors);
        if (b.cmd === 'stop') w.cmds = [];                 // STOP wins over anything still waiting
        w.cmds.push({ id: crypto.randomUUID(), cmd: b.cmd, value: +b.value || 0, from: String(b.from || '').slice(0, 20), at: now });
        w.cmds = w.cmds.slice(-5);
        return send(res, 200, { ok: true }, undefined, cors);
      }
    }

    if (url.pathname === '/api/health') return send(res, 200, { ok: true, rev: data.rev || 0 });

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(req.method, url.pathname, e.message);
    send(res, 400, { error: 'Bad request' }, undefined, cors);
  }
});
server.listen(PORT, HOST, () => console.log(`Walk Keeper on http://${HOST}:${PORT}`));
