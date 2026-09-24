import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SetupClient, ROUTES, providerConfig, credentialLabel, errorMessage, mainMarkup } from '../../src/app/local/ui/app.mjs';

const capabilities = { secure_store: 'macos-keychain', plugins: 'not_connected', workers: 'not_connected', models: 'unverified' };
const entry = id => ({ project_id: id, name: `Project ${id}`, folder: `/synthetic/${id}`, state: 'ready', error: null });
function detail(id, version = null) {
  return { project: entry(id), capabilities, git: { version: 1, value: { checkouts: [{ checkout_id: `checkout-${id}`, selected_path: `/synthetic/${id}`, state: 'active',
    worktrees: [{ path: `/synthetic/${id}`, branch: 'refs/heads/main', state: 'active', head: 'abc123' }], refs: [{ name: 'refs/heads/main', state: 'active' }, { name: 'refs/heads/exploration', state: 'active' }] }] } },
  activation: { version, state: { enabled: false, epoch: 0, disabled_since: null, last_gap: null } },
  providers: { config: null, statuses: Object.fromEntries(Object.keys(ROUTES).map(p => [p, { state: 'missing' }])), verified: false } };
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(t, options = {}) {
  const requests = [], observations = [];
  let handle = options.handle, clears = 0;
  const client = new SetupClient({ clearSecret: () => { clears++; options.onClear?.(); }, onChange: state => observations.push(structuredClone(state)),
    fetchImpl: async (url, init) => {
      const call = { url, init, ...(init.body ? JSON.parse(init.body) : {}) }; requests.push(call);
      const result = await handle?.(call); if (result !== undefined) return result;
      if (url === '/v1/setup/session') return response({ state: 'paired', pairing_available: true });
      if (call.action === 'projects.list') return response({ ok: true, data: { projects: options.projects ?? [entry('A'), entry('B')], capabilities } });
      if (call.action === 'project.read') return response({ ok: true, data: detail(call.input.project_id) });
      if (url === '/v1/setup/stop') return response({ ok: true });
      return response({ ok: true, data: {} });
    } });
  t.after(() => client.dispose());
  return { client, requests, observations, get clears() { return clears; }, set handle(fn) { handle = fn; } };
}

test('UI transport uses only authenticated local action envelope and exact supported provider routes', async t => {
  const h = harness(t); await h.client.connect();
  assert.equal(h.client.state.selectedProjectId, 'A');
  await h.client.saveConfig({ timeout_ms: 8000, max_attempts: 2, fallbacks: ['vercel'] });
  const call = h.requests.find(r => r.action === 'provider.configure');
  assert.deepEqual(call.input, { project_id: 'A', config: { primary: { provider: 'typesafe', model: 'jev-latest', capability: 'semantic-judge-v0' },
    fallbacks: [{ provider: 'vercel', model: 'typesafe-ai/jev', capability: 'semantic-judge-v0' }], timeout_ms: 8000, max_attempts: 2 } });
  for (const r of h.requests) {
    assert.equal(r.init.credentials, 'same-origin'); assert.equal(r.init.cache, 'no-store');
    assert.match(r.url, /^\/v1\/setup\/(session|action)$/);
    if (r.init.body) assert.deepEqual(r.init.headers, { 'Content-Type': 'application/json', 'X-VibeHub-Setup': '1' });
  }
  for (const bad of ['constructor', 'arbitrary', 'https://other.invalid']) assert.throws(() => providerConfig(bad, { timeout_ms: 1000, max_attempts: 1 }));
  for (const values of [{ timeout_ms: 99, max_attempts: 1 }, { timeout_ms: 1000, max_attempts: 4 }, { timeout_ms: 1000, max_attempts: 1, fallbacks: ['typesafe'] }, { timeout_ms: 1000, max_attempts: 1, fallbacks: ['vercel', 'vercel'] }]) assert.throws(() => providerConfig('typesafe', values));
});

test('late Project A read cannot replace selected Project B or its provider configuration', async t => {
  const h = harness(t); await h.client.connect(); const late = deferred();
  h.handle = call => call.action === 'project.read' && call.input.project_id === 'A' ? late.promise : undefined;
  const a = h.client.selectProject('A'); await h.client.selectProject('B');
  const old = detail('A'); old.providers.config = providerConfig('vercel', { timeout_ms: 500, max_attempts: 3 });
  late.resolve(response({ ok: true, data: old })); await a;
  assert.equal(h.client.state.selectedProjectId, 'B'); assert.equal(h.client.state.project.project.project_id, 'B');
  assert.equal(h.client.state.provider, 'typesafe'); assert.doesNotMatch(mainMarkup(h.client.state), /Project A/);
});

test('key attempt clears input before dispatch and stale success cannot appear in another Project', async t => {
  let field = '', clearedBeforeDispatch = false; const late = deferred();
  const h = harness(t, { onClear: () => { field = ''; } }); await h.client.connect();
  h.handle = call => {
    if (call.action === 'provider.replace') { clearedBeforeDispatch = field === ''; return late.promise; }
  };
  field = 'synthetic-key-only'; const write = h.client.replaceSecret(field);
  assert.equal(field, ''); assert.equal(clearedBeforeDispatch, true);
  assert.equal(h.requests.at(-1).input.project_id, 'A');
  assert.doesNotMatch(JSON.stringify(h.client.state), /synthetic-key-only/);
  await h.client.selectProject('B'); late.resolve(response({ ok: true, data: { state: 'configured' } })); await write;
  assert.equal(h.client.state.project.project.project_id, 'B'); assert.equal(h.client.state.notice, null);
  assert.equal(h.client.state.project.providers.statuses.typesafe.state, 'missing');
  field = 'another-synthetic-value'; h.client.chooseProvider('vercel'); assert.equal(field, '');
  assert.doesNotMatch(mainMarkup(h.client.state), /synthetic-key-only|another-synthetic-value|value="[^\"]*" type="password"/);
});

test('expired authority clears private view immediately and never keeps mutation controls active', async t => {
  const h = harness(t); await h.client.connect();
  h.handle = call => call.action === 'project.activation' ? response({ ok: false, error: { code: 'setup_unauthorized', message: 'untrusted-response-canary' } }, 401) : undefined;
  await h.client.setEnabled();
  assert.equal(h.client.state.project, null); assert.deepEqual(h.client.state.projects, []);
  assert.equal(h.observations.at(-1).session.state, 'unpaired');
  assert.match(mainMarkup(h.client.state), /Pair this browser/); assert.doesNotMatch(mainMarkup(h.client.state), /Project A|Disable project|Enable project/);
  const count = h.requests.length; await h.client.setEnabled(); await h.client.replaceSecret('synthetic'); assert.equal(h.requests.length, count);
  assert.doesNotMatch(h.client.state.error, /untrusted-response-canary/);
});

test('offline result clears private data, exposes recovery, and never retries uncertain mutations', async t => {
  const h = harness(t); await h.client.connect();
  h.handle = call => { if (call.action === 'provider.remove') throw new Error('private-network-message'); };
  await h.client.removeSecret();
  assert.equal(h.client.state.connection, 'offline'); assert.equal(h.observations.at(-1).connection, 'offline');
  assert.equal(h.client.state.project, null); assert.match(mainMarkup(h.client.state), /npm run app/);
  assert.doesNotMatch(h.client.state.error, /private-network-message/);
  await h.client.removeSecret(); assert.equal(h.requests.filter(r => r.action === 'provider.remove').length, 1);
  const reconnect = deferred(); h.handle = call => call.url === '/v1/setup/session' ? reconnect.promise : undefined;
  const pending = h.client.connect(); const count = h.requests.length;
  await h.client.replaceSecret('synthetic'); await h.client.stop(); assert.equal(h.requests.length, count);
  reconnect.resolve(response({ state: 'paired', pairing_available: true })); await pending; assert.equal(h.client.state.connection, 'online');
});

test('CAS conflict requires explicit reload; provider switching cannot bypass that fence', async t => {
  const h = harness(t); await h.client.connect();
  h.handle = call => call.action === 'project.activation' ? response({ ok: false, error: { code: 'cas_conflict' } }, 409) : undefined;
  await h.client.setEnabled(); assert.equal(h.client.state.needsReload, true);
  h.client.chooseProvider('vercel'); await h.client.setEnabled();
  assert.equal(h.requests.filter(r => r.action === 'project.activation').length, 1);
  h.handle = call => call.action === 'project.read' ? response({ ok: true, data: detail('A', 7) }) : undefined;
  await h.client.reloadProject(); assert.equal(h.client.state.needsReload, false);
  await h.client.setEnabled();
  assert.equal(h.requests.filter(r => r.action === 'project.activation').at(-1).input.expectedVersion, 7);
});

test('non-Git inspect, explicit initialize, and explicit enroll remain separate; edited path invalidates preview', async t => {
  const h = harness(t, { projects: [] }); await h.client.connect();
  h.handle = call => {
    if (call.action === 'folder.inspect') return response({ ok: true, data: { preview_id: 'preview1', inspection: { status: 'not_git', selected_path: call.input.folder } } });
    if (call.action === 'folder.initialize') return response({ ok: true, data: { preview_id: 'preview2', inspection: { status: 'git', selected_path: '/synthetic/new', worktrees: [] } } });
    if (call.action === 'projects.enroll') return response({ ok: true, data: { project_id: 'B', reused: false } });
    if (call.action === 'projects.list') return response({ ok: true, data: { projects: [entry('B')], capabilities } });
  };
  await h.client.inspect('/synthetic/new'); assert.equal(h.client.state.preview.inspection.status, 'not_git');
  assert.equal(h.requests.filter(r => r.action === 'folder.initialize').length, 0);
  await h.client.initialize(); assert.equal(h.client.state.preview.inspection.status, 'git');
  assert.equal(h.requests.filter(r => r.action === 'projects.enroll').length, 0);
  h.client.editFolder('/synthetic/changed'); assert.equal(h.client.state.preview, null);
  await h.client.enroll('New'); assert.equal(h.requests.filter(r => r.action === 'projects.enroll').length, 0);
  await h.client.inspect('/synthetic/new'); await h.client.initialize(); await h.client.enroll('New');
  assert.deepEqual(h.requests.find(r => r.action === 'projects.enroll').input, { preview_id: 'preview2', name: 'New' });
  assert.equal(h.client.state.selectedProjectId, 'B');
  assert.equal(h.requests.filter(r => r.action === 'project.activation').length, 0);
});

test('render escapes project/path/ref content and honestly separates configured provider from disconnected Workers', async t => {
  const h = harness(t); await h.client.connect();
  h.client.state.project.project.name = '<img src=x onerror=alert(1)>';
  h.client.state.project.project.folder = '/synthetic/"<script>canary</script>';
  h.client.state.project.git.value.checkouts[0].refs[1].name = 'refs/heads/<script>unsafe</script>';
  h.client.state.project.providers.statuses.typesafe.state = 'configured';
  const html = mainMarkup(h.client.state);
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;img/);
  assert.match(html, /Key configured · unverified/); assert.match(html, /Not connected/); assert.match(html, /No collection|does not inspect logins/);
  assert.match(html, /no checkout/); assert.match(html, /Re-enabling never imports missed conversations/);
  assert.match(html, /type="password"/); assert.doesNotMatch(html, /(?:localhost|127\.0\.0\.1).*token/);
  assert.equal(credentialLabel('error'), 'Secure store unavailable'); assert.doesNotMatch(errorMessage('untrusted-canary'), /untrusted-canary/);
});

test('unsupported secure store leaves project controls available but forbids credential dispatch', async t => {
  const h = harness(t); await h.client.connect(); h.client.state.capabilities = { ...capabilities, secure_store: 'unsupported' };
  const html = mainMarkup(h.client.state); assert.match(html, /not supported on this platform/);
  assert.match(html, /id="api-key"[^>]*disabled/); assert.match(html, /data-action="activation" class="primary">Enable project/);
  const count = h.requests.length; await h.client.replaceSecret('synthetic'); await h.client.removeSecret(); assert.equal(h.requests.length, count);
});

test('pairing is launch-terminal approval, stop forgets all private view and offers restart', async t => {
  const h = harness(t); h.handle = call => call.url === '/v1/setup/session' ? response({ state: 'unpaired', pairing_available: true })
    : call.url === '/v1/setup/pair' ? response({ state: 'pending', code: 'TEST-CODE', pairing_available: true }) : undefined;
  await h.client.connect(); await h.client.pair(); assert.match(mainMarkup(h.client.state), /approve TEST-CODE/);
  assert.equal(h.requests.filter(r => r.action).length, 0);
  h.handle = undefined; await h.client.connect(); h.client.state.notice = 'Git inventory refreshed.'; await h.client.stop();
  assert.equal(h.client.state.connection, 'stopped'); assert.equal(h.client.state.selectedProjectId, null); assert.equal(h.client.state.project, null);
  assert.equal(h.client.state.notice, null);
  assert.match(mainMarkup(h.client.state), /Your work continues/); assert.deepEqual(JSON.parse(h.requests.at(-1).init.body), {});
});

test('native Keychain deadlines include helper compilation and serial status checks without slow tests', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return new AbortController().signal; });
  const h = harness(t); await h.client.connect();
  assert.deepEqual(deadlines, [30000, 30000, 95000]); deadlines.length = 0;
  await h.client.replaceSecret('synthetic-test-key'); assert.deepEqual(deadlines, [75000, 95000]); deadlines.length = 0;
  await h.client.removeSecret(); assert.deepEqual(deadlines, [75000, 95000]); deadlines.length = 0;
  await h.client.setEnabled(); assert.deepEqual(deadlines, [30000, 95000]);
});

test('a failed enrollment can be recovered from the saved Project list without a duplicate attempt', async t => {
  const h = harness(t, { projects: [] }); await h.client.connect();
  h.client.state.preview = { preview_id: 'consumed-preview', inspection: { status: 'git' } };
  h.handle = call => call.action === 'projects.enroll' ? response({ ok: false, error: { code: 'enrollment_incomplete' } }, 409)
    : call.action === 'projects.list' ? response({ ok: true, data: { projects: [{ ...entry('A'), state: 'error' }], capabilities } })
    : call.action === 'project.read' ? response({ ok: true, data: { ...detail('A'), project: { ...entry('A'), state: 'error' } } }) : undefined;
  await h.client.enroll('New'); assert.match(h.client.state.error, /saved enrollment/);
  await h.client.reloadProjects(); assert.equal(h.client.state.selectedProjectId, 'A');
  assert.match(mainMarkup(h.client.state), /Retry saved enrollment/);
  await h.client.retry(); assert.equal(h.requests.filter(r => r.action === 'projects.enroll').length, 1);
  assert.deepEqual(h.requests.find(r => r.action === 'projects.retry').input, { project_id: 'A' });
});

test('setup assets are local, keyboard-accessible and contain no browser credential persistence or network dependencies', () => {
  const base = new URL('../../src/app/local/ui/', import.meta.url), html = readFileSync(new URL('index.html', base), 'utf8');
  const js = readFileSync(new URL('app.mjs', base), 'utf8'), css = readFileSync(new URL('style.css', base), 'utf8');
  assert.match(html, /href="#main"/); assert.match(html, /<dialog[^>]*aria-labelledby="stop-title"/);
  assert.match(html, /src="\/setup\/app.mjs"/); assert.match(html, /href="\/setup\/style.css"/);
  assert.doesNotMatch(html, /<script(?! type="module" src=)|https?:\/\//);
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie|console\.|api_key.*value=/);
  assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /@import|url\(/);
});
