import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { AppSessions } from '../src/local/app-session.mjs';
import { createSetupHandler } from '../src/local/setup-http.mjs';
import { startLocalRuntime } from '../src/local/service.mjs';

const cookie = response => response.headers['set-cookie']?.[0].split(';')[0];
function call(url, { method = 'GET', headers = {}, value, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let data;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.on('error', reject); req.end(raw ?? (value === undefined ? undefined : JSON.stringify(value)));
  });
}
function headers(origin, ownerCookie) {
  return { Origin: origin, 'X-VibeHub-Setup': '1', 'Content-Type': 'application/json', ...(ownerCookie ? { Cookie: ownerCookie } : {}) };
}
async function fixture(t, options = {}) {
  const clock = { now: 1000 }, notices = [], calls = [], owners = [];
  const controller = { async execute(action, input, assertOwner) { owners.push(assertOwner()); calls.push({ action, input }); return { selected: true }; } };
  let handler, stopped = false;
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessions = new AppSessions({ origin, available: options.available ?? true, now: () => clock.now, onPending: code => notices.push(code) });
  handler = createSetupHandler({ controller, sessions, origin, stop: () => { stopped = true; }, safeCodes: ['cas_conflict'] });
  t.after(async () => { sessions.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  const f = { origin, sessions, controller, clock, notices, calls, owners, stopped: () => stopped,
    post(path, value, token, extra = {}) { return call(origin + path, { method: 'POST', headers: { ...headers(origin, token), ...extra }, value }); },
    async pair() {
      const pending = await this.post('/v1/setup/pair', {}); assert.equal(pending.status, 200);
      assert.equal(sessions.approve(pending.data.code), true);
      const active = await call(origin + '/v1/setup/session', { headers: { Cookie: cookie(pending) } });
      assert.equal(active.data.state, 'paired'); return cookie(active);
    },
  }; return f;
}

test('pairing code is not authority; exact unexpired TTY hook approval exchanges one pending token', async t => {
  const f = await fixture(t);
  assert.deepEqual((await call(f.origin + '/v1/setup/session')).data, { state: 'unpaired', pairing_available: true });
  const pending = await f.post('/v1/setup/pair', {}), pendingCookie = cookie(pending);
  assert.equal(pending.data.state, 'pending'); assert.match(pending.data.code, /^[A-F0-9]{8}$/);
  assert.deepEqual(f.notices, [pending.data.code]); assert.match(pending.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/v1\/setup$/);
  assert.doesNotMatch(pending.headers['set-cookie'][0], /Max-Age|Expires/i);
  assert(!pending.text.includes(pendingCookie.split('=')[1]));
  const action = { action: 'projects.list', input: {} };
  assert.equal((await f.post('/v1/setup/action', action, pendingCookie)).status, 401);
  assert.equal((await f.post('/v1/setup/pair', {})).data.error.code, 'pairing_busy');
  assert.equal((await f.post('/v1/setup/approve', { code: pending.data.code })).status, 404);
  assert.equal((await f.post('/v1/setup/pair', { code: pending.data.code })).data.error.code, 'invalid_setup_request');
  const wrongCode = `${pending.data.code[0] === 'A' ? 'B' : 'A'}${pending.data.code.slice(1)}`;
  assert.equal(f.sessions.approve(wrongCode), false); assert.equal(f.sessions.approve(` ${pending.data.code}`), false);
  assert.equal(f.sessions.approve(pending.data.code), true); assert.equal(f.sessions.approve(pending.data.code), false);
  const active = await call(f.origin + '/v1/setup/session', { headers: { Cookie: pendingCookie } }), ownerCookie = cookie(active);
  assert.equal(active.data.state, 'paired'); assert(ownerCookie && ownerCookie !== pendingCookie);
  assert.match(active.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/v1\/setup$/);
  assert.doesNotMatch(active.headers['set-cookie'][0], /Max-Age|Expires/i); assert(!active.text.includes(ownerCookie.split('=')[1]));
  assert.equal((await f.post('/v1/setup/action', action, pendingCookie)).status, 401);
  assert.equal((await f.post('/v1/setup/action', action, ownerCookie)).status, 200);
  assert.equal((await f.post('/v1/setup/action', action, ownerCookie)).status, 200);
  assert.equal(f.owners[0], f.owners[1]); assert(Object.isFrozen(f.owners[0]));
  assert.equal(f.owners[0].expires_at, f.clock.now + 3600000);
  assert(!active.text.includes('expires_at'));
  assert.equal(f.calls.length, 2);
});

test('pending expiration, noninteractive launch and closed terminal never grant an owner', async t => {
  const f = await fixture(t), pending = await f.post('/v1/setup/pair', {});
  f.clock.now += 120000;
  assert.equal(f.sessions.approve(pending.data.code), false);
  assert.equal((await call(f.origin + '/v1/setup/session', { headers: { Cookie: cookie(pending) } })).data.state, 'unpaired');
  const other = await f.post('/v1/setup/pair', {}); assert.notEqual(other.data.code, pending.data.code);
  f.sessions.disable(); assert.equal(f.sessions.approve(other.data.code), false);
  assert.equal((await f.post('/v1/setup/pair', {}, cookie(other))).data.error.code, 'pairing_unavailable');
  const inactive = await fixture(t, { available: false });
  assert.equal((await inactive.post('/v1/setup/pair', {})).data.error.code, 'pairing_unavailable');
  assert.equal(inactive.notices.length, 0); assert.equal(inactive.sessions.approve('ABCD1234'), false);
});

test('session revocation, expiry, duplicate cookies and foreign instance cookies reject before controller work', async t => {
  const f = await fixture(t), owner = await f.pair(), second = await fixture(t);
  assert.notEqual(f.sessions.cookieName, second.sessions.cookieName);
  for (const bad of [undefined, `${f.sessions.cookieName}=wrong`, `${owner}; ${owner}`]) {
    assert.equal((await f.post('/v1/setup/action', { action: 'folder.inspect', input: { folder: '/never-inspected' } }, bad)).status, 401);
  }
  assert.equal((await second.post('/v1/setup/action', { action: 'projects.list', input: {} }, owner)).status, 401);
  const guard = f.sessions.owner(owner, f.origin); assert.throws(() => f.sessions.owner(owner, second.origin), { code: 'setup_unauthorized' });
  f.sessions.revoke(); assert.throws(guard, { code: 'setup_unauthorized' });
  assert.equal((await f.post('/v1/setup/action', { action: 'projects.list', input: {} }, owner)).status, 401);
  const renewed = await f.pair(), expired = f.sessions.owner(renewed, f.origin); f.clock.now += 3600000;
  assert.throws(expired, { code: 'setup_unauthorized' });
  assert.equal((await f.post('/v1/setup/action', { action: 'projects.list', input: {} }, renewed)).status, 401);
  assert.equal(f.calls.length + second.calls.length, 0);
});

test('exact Host/Origin/fetch metadata, methods, custom header and bounded typed JSON prevent side effects', async t => {
  const f = await fixture(t), owner = await f.pair(), valid = { action: 'projects.list', input: {} };
  const cases = [
    { Host: 'attacker.example' }, { Origin: 'http://127.0.0.1:1' }, { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-VibeHub-Setup': '0' },
  ];
  for (const extra of cases) assert.equal((await f.post('/v1/setup/action', valid, owner, extra)).status, 403);
  const noOrigin = headers(f.origin, owner); delete noOrigin.Origin;
  assert.equal((await call(f.origin + '/v1/setup/action', { method: 'POST', headers: noOrigin, value: valid })).status, 403);
  for (const method of ['GET', 'PUT', 'OPTIONS']) assert.equal((await call(f.origin + '/v1/setup/action', { method, headers: headers(f.origin, owner) })).status, 405);
  for (const value of [{ ...valid, tenant_id: 'other' }, { ...valid, credential: 'supplied' }, { action: 'store.sql', input: {} }, { action: 'projects.list', input: [] }, []]) {
    assert.equal((await f.post('/v1/setup/action', value, owner)).data.error.code, 'invalid_setup_request');
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=latin1']) {
    assert.equal((await f.post('/v1/setup/action', valid, owner, { 'Content-Type': type })).data.error.code, 'invalid_setup_request');
  }
  assert.equal((await f.post('/v1/setup/action', valid, owner, { 'Content-Encoding': 'gzip' })).status, 400);
  for (const raw of ['{', Buffer.from([0xff]), '{"action":"projects.list","input":' + '['.repeat(18) + '0' + ']'.repeat(18) + '}']) {
    const result = await call(f.origin + '/v1/setup/action', { method: 'POST', headers: headers(f.origin, owner), raw });
    assert([400, 413].includes(result.status));
  }
  assert.equal((await call(f.origin + '/v1/setup/action', { method: 'POST', headers: headers(f.origin, owner), raw: 'X'.repeat(32769) })).status, 413);
  assert.equal(f.calls.length, 0);
  assert.equal((await call(f.origin + '/v1/setup/session', { headers: { Cookie: owner } })).status, 200);
});

test('unknown controller errors and response failures never reveal private body/code/stack; stale async owners fail', async t => {
  const f = await fixture(t), owner = await f.pair(), canary = 'PRIVATE_SYNTHETIC_CANARY';
  f.controller.execute = async () => { throw Object.assign(new Error(canary), { code: canary }); };
  const failed = await f.post('/v1/setup/action', { action: 'provider.replace', input: { secret: canary } }, owner);
  assert.equal(failed.data.error.code, 'setup_unavailable'); assert(!failed.text.includes(canary));
  f.controller.execute = async () => { throw Object.assign(new Error(canary), { code: 'cas_conflict' }); };
  assert.equal((await f.post('/v1/setup/action', { action: 'projects.list', input: {} }, owner)).status, 409);
  f.controller.execute = async (_action, _input, guard) => { guard(); f.sessions.revoke(); return { secret: canary }; };
  const expired = await f.post('/v1/setup/action', { action: 'projects.list', input: {} }, owner);
  assert.equal(expired.status, 401); assert(!expired.text.includes(canary));
});

test('authenticated stop revokes captured owner closures immediately and no public path mints credentials', async t => {
  const f = await fixture(t), owner = await f.pair(), guard = f.sessions.owner(owner, f.origin);
  assert.equal((await f.post('/v1/setup/stop', {})).status, 401);
  assert.equal((await f.post('/v1/setup/stop', { token: 'invalid' }, owner)).status, 400);
  assert.equal(f.stopped(), false);
  const stopped = await f.post('/v1/setup/stop', {}, owner);
  assert.deepEqual(stopped.data, { ok: true }); assert.equal(f.stopped(), true);
  assert.throws(guard, { code: 'setup_unauthorized' });
  assert.equal((await f.post('/v1/setup/action', { action: 'projects.list', input: {} }, owner)).status, 401);
});

test('accepted Stop closes exactly once when its response is already lost or closes before finish', async () => {
  const origin = 'http://127.0.0.1:4310';
  for (const alreadyDestroyed of [true, false]) {
    const sessions = new AppSessions({ origin, available: true });
    const pending = sessions.begin(undefined, origin); sessions.approve(pending.data.code);
    const active = sessions.status(pending.cookie.split(';')[0], origin), owner = active.cookie.split(';')[0];
    const guard = sessions.owner(owner, origin);
    let stopped = 0;
    const handler = createSetupHandler({ sessions, origin, controller: { execute() { assert.fail('no action'); } },
      stop: () => { stopped++; } });
    const request = Readable.from([Buffer.from('{}')]);
    Object.assign(request, { method: 'POST', url: '/v1/setup/stop', headers: {
      host: new URL(origin).host, origin, cookie: owner, 'x-vibehub-setup': '1', 'content-type': 'application/json',
    } });
    const response = new EventEmitter();
    Object.assign(response, { destroyed: alreadyDestroyed, writableEnded: false,
      writeHead(status) { assert.equal(status, 200); },
      end() { this.destroyed = true; this.emit('close'); },
    });
    await handler(request, response); await Promise.resolve();
    assert.equal(stopped, 1); assert.throws(guard, { code: 'setup_unauthorized' });
    response.emit('finish'); response.emit('close'); await Promise.resolve();
    assert.equal(stopped, 1);
  }
});

test('setup integrates real controller readiness and typed authenticated actions while restart invalidates pairing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-setup-http-')), notices = [], secretStore = {
    async put() {}, async remove() {}, async status() { return { state: 'missing' }; }, async use() { assert.fail('never read credentials'); },
  };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startLocalRuntime({ dataDir: dir, port: 0, setup: true, secretStore,
    pairing: { available: true, onPending: code => notices.push(code) } });
  t.after(() => app.close());
  assert.equal((await call(app.url + '/readyz')).data.profile, 'setup');
  for (const path of ['/', '/setup/app.mjs', '/setup/style.css']) {
    const asset = await call(app.url + path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'no-store');
    assert.match(asset.headers['content-security-policy'], /script-src 'self'/);
    assert(!asset.headers['access-control-allow-origin']);
  }
  assert.equal((await call(app.url + '/setup/../../../package.json')).status, 404);
  const pending = await call(app.url + '/v1/setup/pair', { method: 'POST', headers: headers(app.url), value: {} });
  assert.equal(app.pairing.approve(notices[0]), true);
  const active = await call(app.url + '/v1/setup/session', { headers: { Cookie: cookie(pending) } }), owner = cookie(active);
  const invoke = input => call(app.url + '/v1/setup/action', { method: 'POST', headers: headers(app.url, owner), value: input });
  const list = await invoke({ action: 'projects.list', input: {} }); assert.equal(list.status, 200); assert.deepEqual(list.data.data.projects, []);
  const denied = await invoke({ action: 'projects.list', input: { project_id: 'arbitrary' } }); assert.equal(denied.status, 400);
  const wrong = await invoke({ action: 'project.read', input: { project_id: 'arbitrary' } }); assert.equal(wrong.status, 400);
  const stopped = await call(app.url + '/v1/setup/stop', { method: 'POST', headers: headers(app.url, owner), value: {} });
  assert.deepEqual(stopped.data, { ok: true }); await app.closed;
  const restarted = await startLocalRuntime({ dataDir: dir, port: 0, setup: true, secretStore }); t.after(() => restarted.close());
  const stale = await call(restarted.url + '/v1/setup/action', { method: 'POST', headers: headers(restarted.url, owner), value: { action: 'projects.list', input: {} } });
  assert.equal(stale.status, 401);
  assert.equal((await call(restarted.url + '/v1/setup/session')).data.pairing_available, false);
});

test('noninteractive setup CLI visibly refuses pairing and ignores approval text on stdin', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-setup-cli-'));
  const child = spawn(process.execPath, [new URL('../src/local/cli.mjs', import.meta.url).pathname, '--setup', '--port', '0', '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await done; rmSync(dir, { recursive: true, force: true }); });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('setup startup deadline')), 10000);
    child.stdout.on('data', () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match && output.includes('Pairing unavailable')) { clearTimeout(timer); resolve(match[0]); } });
    done.then(() => { clearTimeout(timer); reject(new Error('setup exited before ready')); });
  });
  child.stdin.write('approve ABCD1234\n');
  assert.equal((await call(origin + '/v1/setup/pair', { method: 'POST', headers: headers(origin), value: {} })).data.error.code, 'pairing_unavailable');
  child.kill('SIGTERM'); assert.equal((await done).code, 0); assert.match(output, /Saved data retained/);
  assert(!errors.includes('credential'));
  const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts;
  assert.equal(scripts.app, 'node src/local/cli.mjs --setup');
});
