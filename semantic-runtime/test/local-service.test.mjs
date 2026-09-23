import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { startLocalRuntime } from '../src/app/local/service.mjs';

const cli = fileURLToPath(new URL('../src/app/local/cli.mjs', import.meta.url));
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vh-local-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function command(args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const done = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveDone({ code, signal, output, errors }));
  });
  return { child, done, output: () => output };
}
async function launch(t, dir, port = 0) {
  const run = command(['--port', String(port), '--data-dir', dir], tmpdir());
  t.after(async () => { if (run.child.exitCode === null) run.child.kill('SIGKILL'); await run.done; });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('Local startup timed out')), 10_000);
    const inspect = () => {
      const match = run.output().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolveUrl(match[0]); }
    };
    run.child.stdout.on('data', inspect);
    run.done.then(result => { clearTimeout(timer); reject(new Error(`Exited before ready: ${result.errors}`)); }, reject);
    inspect();
  });
  return { ...run, url };
}
async function response(url, headers) {
  return new Promise((resolveResponse, reject) => {
    const req = request(url, { headers }, res => {
      let body = '';
      res.on('data', data => { body += data; });
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('local HTTP surface is bounded and restart preserves bootstrap and unrelated data', async t => {
  const dir = temporary(t);
  writeFileSync(join(dir, 'keep.txt'), 'existing user data');
  const app = await startLocalRuntime({ dataDir: dir, port: 0 });
  t.after(() => app.close());
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await (await fetch(app.url + '/healthz')).json(), { service: 'vibehub-runtime', status: 'alive' });
  const ready = await fetch(app.url + '/readyz');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).profile, 'bootstrap');
  const page = await fetch(app.url);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /语义采集尚未启用/);
  assert.equal((await fetch(app.url + '/keep.txt')).status, 404);
  assert.equal((await fetch(app.url + '/events', { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await response(app.url, { Host: 'attacker.example' })).status, 403);
  const denied = await response(app.url + '/readyz', { Origin: 'https://attacker.example' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal((await response(app.url, { Origin: app.url })).status, 200);
  await Promise.all([app.close(), app.close()]);
  const db = new DatabaseSync(join(dir, 'bootstrap.sqlite'));
  const created = db.prepare('SELECT created_at FROM bootstrap').get().created_at;
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  db.close();
  const again = await startLocalRuntime({ dataDir: dir, port: 0 });
  await again.close();
  const reopened = new DatabaseSync(join(dir, 'bootstrap.sqlite'));
  assert.equal(reopened.prepare('SELECT created_at FROM bootstrap').get().created_at, created);
  reopened.close();
  assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'existing user data');
});

test('foreign/corrupt database and invalid storage fail without replacing existing files', async t => {
  const dir = temporary(t), path = join(dir, 'bootstrap.sqlite');
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep me');");
  db.close();
  await assert.rejects(startLocalRuntime({ dataDir: dir, port: 0 }), /Existing files were not removed/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare('SELECT value FROM unrelated').get().value, 'keep me');
  assert.equal(check.prepare('PRAGMA application_id').get().application_id, 0);
  check.close();
  const corrupt = temporary(t);
  writeFileSync(join(corrupt, 'bootstrap.sqlite'), 'not a database');
  await assert.rejects(startLocalRuntime({ dataDir: corrupt, port: 0 }), /Local storage could not open/);
  assert.equal(readFileSync(join(corrupt, 'bootstrap.sqlite'), 'utf8'), 'not a database');
  const blocker = join(dir, 'file-not-directory'); writeFileSync(blocker, 'untouched');
  await assert.rejects(startLocalRuntime({ dataDir: blocker, port: 0 }), /writable/);
  assert.equal(readFileSync(blocker, 'utf8'), 'untouched');
});

test('readiness reports a damaged store separately from process liveness', async t => {
  const dir = temporary(t);
  const app = await startLocalRuntime({ dataDir: dir, port: 0 });
  t.after(() => app.close());
  const db = new DatabaseSync(join(dir, 'bootstrap.sqlite'));
  db.exec('DELETE FROM bootstrap'); db.close();
  assert.equal((await fetch(app.url + '/healthz')).status, 200);
  const result = await fetch(app.url + '/readyz');
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error, 'Local storage unavailable');
});

test('CLI stops on both signals, restarts outside repo and diagnoses port/storage failure', { timeout: 20_000 }, async t => {
  const dir = temporary(t);
  const run = await launch(t, dir);
  const port = new URL(run.url).port;
  const status = await command(['--status', '--port', port], tmpdir()).done;
  assert.equal(status.code, 0, status.errors);
  const conflict = await command(['--port', port, '--data-dir', join(dir, 'other')], tmpdir()).done;
  assert.equal(conflict.code, 1); assert.match(conflict.errors, /Port already in use/);
  run.child.kill('SIGTERM');
  const stopped = await run.done;
  assert.equal(stopped.code, 0, stopped.errors); assert.match(stopped.output, /Saved data retained/);
  const offline = await command(['--status', '--port', port], tmpdir()).done;
  assert.equal(offline.code, 1); assert.match(offline.errors, /unavailable or not ready/);
  const resumed = await launch(t, dir, Number(port));
  resumed.child.kill('SIGINT'); assert.equal((await resumed.done).code, 0);
  const invalid = await command(['--host', '0.0.0.0'], tmpdir()).done;
  assert.equal(invalid.code, 1); assert.match(invalid.errors, /Unknown option/);
  const badPort = await command(['--port', '-1'], tmpdir()).done;
  assert.equal(badPort.code, 1);
  const noDirectory = join(dir, 'not-dir'); writeFileSync(noDirectory, 'preserve');
  const unavailable = await command(['--data-dir', noDirectory], tmpdir()).done;
  assert.equal(unavailable.code, 1); assert.match(unavailable.errors, /Local storage could not open/);
});

test('invalid configuration is rejected before allocating storage', async () => {
  await assert.rejects(startLocalRuntime(), /explicit dataDir/);
  await assert.rejects(startLocalRuntime({ dataDir: resolve('/not-created'), port: 65536 }), /integer/);
});
