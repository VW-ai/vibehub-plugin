import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../src/adapters/auth/local-credential-authority.mjs';
import { scopedReference, accessDiagnostic } from '../src/domain/identity/service-access.mjs';
import { startLocalRuntime } from '../src/app/local/service.mjs';

const scope = { tenant_id: 'tenant', project_id: 'project' };
const grant = { principal_id: 'developer', kind: 'human', scope,
  actions: ['session:read', 'source:read', 'model:dispatch'], ttl_ms: 1000 };
const policy = (boundary = 'http', changes = {}) => ({ scope, audience: LOCAL_AUDIENCE,
  kinds: ['human', 'host-adapter', 'service'], action: 'session:read', boundary,
  reference: scopedReference(boundary, scope, 'item'), ...changes });

test('credentials enforce expiry/revocation/restart and authenticated contexts cannot be fabricated or mutated', () => {
  let now = 100;
  const auth = new LocalCredentialAuthority({ now: () => now });
  const issued = auth.issue(grant);
  assert.match(issued.credential, /^vh_local_[A-Za-z0-9_-]{43}$/);
  const accepted = auth.authorize(issued.credential, policy());
  assert.equal(accepted.allowed, true);
  assert.deepEqual(accepted.context, {});
  const inspected = auth.inspect(accepted.context); inspected.project_id = 'other';
  assert.equal(auth.inspect(accepted.context).project_id, scope.project_id);
  assert.equal(auth.inspect({ ...accepted.context }), null);
  assert.equal(new LocalCredentialAuthority().authorize(issued.credential, policy()).allowed, false);
  now = 1100;
  assert.equal(auth.inspect(accepted.context), null);
  assert.equal(auth.authorize(issued.credential, policy()).allowed, false);
  const next = auth.issue(grant), context = auth.authorize(next.credential, policy()).context;
  assert.equal(auth.revoke(next.credential_id), true);
  assert.equal(auth.inspect(context), null);
  assert.equal(auth.revoke(next.credential_id), false);
  assert.throws(() => auth.issue({ ...grant, ttl_ms: 3_600_001 }), /expiry/);
  assert.throws(() => auth.issue({ ...grant, actions: ['*'] }), /Invalid/);
  const last = auth.issue(grant); auth.close();
  assert.equal(auth.authorize(last.credential, policy()).allowed, false);
});

test('all four scoped adapter boundaries reject confused-deputy, scope, audience, action and kind mismatches', () => {
  const auth = new LocalCredentialAuthority();
  for (const kind of ['human', 'host-adapter', 'service', 'connector', 'worker']) {
    const { credential } = auth.issue({ ...grant, kind });
    assert.equal(auth.authorize(credential, policy('http', { kinds: [kind] })).allowed, true);
    assert.equal(auth.authorize(credential, policy('http', { kinds: [] })).allowed, false);
  }
  const { credential } = auth.issue(grant);
  for (const boundary of ['http', 'object', 'queue', 'subscription']) {
    assert.equal(auth.authorize(credential, policy(boundary)).allowed, true);
    for (const other of [{ tenant_id: 'other', project_id: 'project' }, { tenant_id: 'tenant', project_id: 'other' }]) {
      assert.equal(auth.authorize(credential, policy(boundary, { scope: other, reference: scopedReference(boundary, other, 'item') })).allowed, false);
      assert.equal(auth.authorize(credential, policy(boundary, { reference: scopedReference(boundary, other, 'item') })).allowed, false);
    }
    for (const change of [{ audience: 'another-service' }, { action: 'source:write' },
      { reference: { ...scopedReference(boundary, scope, 'item'), key: 'forged' } },
      { reference: { ...scopedReference(boundary, scope, 'item'), secret: 'canary' } }]) {
      assert.equal(auth.authorize(credential, policy(boundary, change)).allowed, false);
    }
  }
  assert.notEqual(scopedReference('object', { tenant_id: 'a/b', project_id: 'c' }, 'd').key,
    scopedReference('object', { tenant_id: 'a', project_id: 'b/c' }, 'd').key);
  assert.equal(auth.authorize('model-key', policy()).allowed, false);
});

function materializationInput() {
  return { scope, destination: { kind: 'provider', provider: 'typesafe' },
    tenant_policy: { max_sensitivity: 'CONFIDENTIAL', allowed_providers: ['typesafe'] },
    sources: [{ reference: scopedReference('object', scope, 'source'),
      acl: { revision: 'v7', allowed_principal_ids: ['developer'] }, sensitivity: 'INTERNAL',
      local_only: false, allowed_providers: ['typesafe'], text: 'untrusted source instructions' }] };
}
test('materialization requires every current source ACL, route and classification and yields pointers without source instructions', () => {
  const auth = new LocalCredentialAuthority(), issued = auth.issue(grant);
  const context = auth.authorize(issued.credential, policy()).context;
  const input = materializationInput(), allowed = auth.materialize(context, input);
  assert.equal(allowed.allowed, true); assert.equal(allowed.content_trust, 'untrusted');
  assert.equal(JSON.stringify(allowed).includes('untrusted source instructions'), false);
  const changed = mutate => { const value = materializationInput(); mutate(value); return auth.materialize(context, value); };
  for (const mutate of [
    x => { x.sources[0].acl = null; }, x => { x.sources[0].acl.allowed_principal_ids = []; },
    x => { x.sources[0].sensitivity = 'UNKNOWN'; }, x => { x.sources[0].sensitivity = 'RESTRICTED'; },
    x => { x.sources[0].local_only = true; }, x => { x.sources[0].allowed_providers = []; },
    x => { x.tenant_policy.allowed_providers = []; }, x => { x.sources = []; },
    x => { x.sources.push({ ...x.sources[0], acl: { revision: 'v8', allowed_principal_ids: ['other'] } }); },
    x => { x.sources[0].reference = scopedReference('object', { ...scope, project_id: 'other' }, 'source'); },
  ]) assert.equal(changed(mutate).allowed, false);
  assert.equal(changed(x => { x.sources[0].local_only = true; x.destination = { kind: 'local' }; }).allowed, true);
  assert.equal(auth.materialize({ ...context }, input).allowed, false);
  auth.revoke(issued.credential_id);
  assert.equal(auth.materialize(context, input).allowed, false);
});

test('new diagnostic boundary cannot serialize request headers, secrets, content or raw errors', () => {
  const secrets = ['Bearer fake-service-key', 'fake-model-key', 'fake-git-token', 'fake-connector-key', 'fake-deploy-key'];
  const raw = { allowed: false, reason: secrets[0], headers: { authorization: secrets[0] },
    body: secrets, error: new Error(secrets.join(':')), credentials: secrets };
  assert.deepEqual(accessDiagnostic(raw), { component: 'service-access', allowed: false, reason: 'invalid_request' });
  for (const secret of secrets) assert.equal(JSON.stringify(accessDiagnostic(raw)).includes(secret), false);
});

test('real local HTTP requires bearer and scope; denies browser cross-origin, duplicates, token URLs and minting', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = await startLocalRuntime({ dataDir: dir, port: 0 }); t.after(() => app.close());
  const issued = app.auth.issue(grant);
  const headers = { Authorization: `Bearer ${issued.credential}`, 'X-VibeHub-Tenant': scope.tenant_id, 'X-VibeHub-Project': scope.project_id };
  const get = extra => fetch(app.url + '/v1/session', { headers: { ...headers, ...extra } });
  const good = await get({}); assert.equal(good.status, 200);
  const body = await good.json(); assert.equal(body.principal_id, 'developer'); assert.equal(JSON.stringify(body).includes(issued.credential), false);
  assert.equal((await get({ Authorization: 'Bearer forged' })).status, 401);
  assert.equal((await get({ 'X-VibeHub-Project': 'other' })).status, 403);
  assert.equal((await get({ Origin: 'https://other.example' })).status, 403);
  assert.equal((await fetch(app.url + '/v1/session')).status, 400);
  assert.equal((await fetch(app.url + '/v1/session?token=' + issued.credential)).status, 404);
  assert.equal((await fetch(app.url + '/v1/session', { method: 'POST' })).status, 405);
  const duplicate = await new Promise((resolve, reject) => {
    const req = request(app.url + '/v1/session', { headers: { ...headers, Authorization: [headers.Authorization, headers.Authorization] } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(duplicate, 401);
  app.auth.revoke(issued.credential_id); assert.equal((await get({})).status, 401);
  const another = app.auth.issue(grant);
  await app.close();
  const stored = readFileSync(join(dir, 'bootstrap.sqlite'));
  assert.equal(stored.includes(Buffer.from(another.credential)), false);
  const resumed = await startLocalRuntime({ dataDir: dir, port: 0 });
  assert.equal(resumed.auth.authorize(another.credential, policy()).allowed, false);
  await resumed.close();
});
