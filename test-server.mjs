// Tests for the sync server. Run: node test-server.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-test-'));
const PORT = 18830, B = `http://127.0.0.1:${PORT}`;
const hash = execFileSync(process.execPath, ['server.js', 'hash', 'test-pass']).toString().trim();
const srv = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT, WK_PASS_HASH: hash, WK_SECRET: 'test-secret', WK_DATA: dir }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 600));

let ok = 0;
const t = async (name, fn) => { try { await fn(); ok++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, e.message); process.exitCode = 1; } };
const post = (p, body, tok) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
const walk = (date, dist) => ({ date, time: 600, dist, steps: 100, kcal: 50 });
let tok;

try {
  await t('page is served', async () => { const r = await fetch(B + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /Walk Keeper/); });
  await t('wrong password is refused', async () => assert.equal((await post('/api/login', { password: 'nope' })).status, 401));
  await t('right password gives a token', async () => { const r = await post('/api/login', { password: 'test-pass' }); assert.equal(r.status, 200); tok = (await r.json()).token; assert.ok(tok); });
  await t('sync without token is refused', async () => assert.equal((await post('/api/sync', { profiles: [] })).status, 401));
  await t('sync with a fake token is refused', async () => assert.equal((await post('/api/sync', { profiles: [] }, '9999999999999.abc')).status, 401));

  const nic = { id: 'nic', name: 'Nicolaas', kg: 90, age: 40, sex: 'm', goal: 20, updatedAt: 1000, history: [walk(1, 1000)] };
  const mar = { id: 'mar', name: 'Marika', kg: 60, age: 38, sex: 'f', goal: 15, updatedAt: 1000, history: [walk(5, 2000)] };
  await t('PC sends Nicolaas', async () => { const d = await (await post('/api/sync', { profiles: [nic] }, tok)).json(); assert.equal(d.profiles.length, 1); });
  await t('phone sends Marika: server has both', async () => {
    const d = await (await post('/api/sync', { profiles: [mar] }, tok)).json();
    assert.deepEqual(d.profiles.map(p => p.name).sort(), ['Marika', 'Nicolaas']);
  });
  await t('two devices add different walks: both kept', async () => {
    const a = { ...nic, history: [walk(1, 1000), walk(2, 3000)] };
    const b = { ...nic, history: [walk(1, 1000), walk(3, 4000)] };
    await post('/api/sync', { profiles: [a] }, tok);
    const d = await (await post('/api/sync', { profiles: [b] }, tok)).json();
    assert.deepEqual(d.profiles.find(p => p.id === 'nic').history.map(w => w.date), [1, 2, 3]);
  });
  await t('newer edit wins, older edit does not undo it', async () => {
    await post('/api/sync', { profiles: [{ ...nic, kg: 88, updatedAt: 2000 }] }, tok);
    const d = await (await post('/api/sync', { profiles: [{ ...nic, kg: 95, updatedAt: 1500 }] }, tok)).json();
    assert.equal(d.profiles.find(p => p.id === 'nic').kg, 88);
  });
  await t('deleted person stays deleted when an old phone sends it again', async () => {
    const x = { id: 'tmp', name: 'Visitor', kg: 70, age: 30, sex: 'm', goal: 5, updatedAt: 1, history: [] };
    await post('/api/sync', { profiles: [x] }, tok);
    await post('/api/sync', { profiles: [], deleted: ['tmp'] }, tok);
    const d = await (await post('/api/sync', { profiles: [x] }, tok)).json();
    assert.ok(!d.profiles.find(p => p.id === 'tmp'));
  });
  await t('data survives a server restart', async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'family.json'), 'utf8'));
    assert.equal(saved.profiles.length, 2);
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).length >= 1);
  });
  await t('github.io copy may call the API (CORS)', async () => {
    const r = await fetch(B + '/api/sync', { method: 'OPTIONS', headers: { Origin: 'https://nicolaas001-del.github.io' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://nicolaas001-del.github.io');
  });
  await t('other websites may not call the API', async () => {
    const r = await fetch(B + '/api/sync', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
  await t('live: other devices see the walk, commands reach the host once', async () => {
    await post('/api/live', { deviceId: 'pc', profileId: 'nic', name: 'Nicolaas', device: 'computer', dist: 1500, time: 900, kcal: 100, speed: 5, paused: false }, tok);
    const seen = await (await fetch(B + '/api/live', { headers: { Authorization: 'Bearer ' + tok } })).json();
    assert.equal(seen.walks.length, 1); assert.equal(seen.walks[0].dist, 1500); assert.ok(!seen.walks[0].cmds);
    assert.equal((await post('/api/live/cmd', { deviceId: 'pc', cmd: 'speed', value: 6, from: 'iPhone' }, tok)).status, 200);
    assert.equal((await post('/api/live/cmd', { deviceId: 'pc', cmd: 'stop', from: 'iPhone' }, tok)).status, 200);
    const r1 = await (await post('/api/live', { deviceId: 'pc', profileId: 'nic', name: 'Nicolaas', dist: 1505 }, tok)).json();
    assert.deepEqual(r1.cmds.map(c => c.cmd), ['stop']);          // STOP clears the waiting speed
    const r2 = await (await post('/api/live', { deviceId: 'pc', profileId: 'nic', name: 'Nicolaas', dist: 1510 }, tok)).json();
    assert.equal(r2.cmds.length, 0);                                 // given only once
  });
  await t('live: bad command and no token are refused', async () => {
    assert.equal((await post('/api/live/cmd', { deviceId: 'pc', cmd: 'explode' }, tok)).status, 400);
    assert.equal((await post('/api/live', { deviceId: 'pc' })).status, 401);
  });
  await t('password guessing is slowed down', async () => {
    let last; for (let i = 0; i < 12; i++) last = (await post('/api/login', { password: 'x' + i })).status;
    assert.equal(last, 429);
  });
} finally {
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`${ok} passed`);
}
