// Synthetic adapter experiment only. No deployment entry, real identity issuer or model credentials.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createWorkerJobState, transitionWorkerJob } from '../../src/index.mjs';
import { authenticate } from './auth.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));
const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const error = (code, status = 409) => Object.assign(new Error(code), { status });
async function body(req) {
  let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 1048576) throw error('body_limit', 413); }
  try { return JSON.parse(data); } catch { throw error('invalid_json', 400); }
}
process.once('message', async config => {
  const pool = new pg.Pool({ host: config.socket, port: config.dbPort, user: 'spike_app', database: 'postgres', max: 8, connectionTimeoutMillis: 2000 });
  pool.on('error', () => { process.send?.({ type: 'database_error' }); });
  async function scoped(scope, identity, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='2s'");
      await client.query("SET LOCAL lock_timeout='1s'");
      await client.query("SELECT set_config('spike.tenant',$1,true),set_config('spike.project',$2,true)", [scope.tenant_id, scope.project_id]);
      const member = (await client.query('SELECT role FROM memberships WHERE subject=$1 AND tenant_id=$2 AND project_id=$3 AND active', [identity.sub, scope.tenant_id, scope.project_id])).rows[0];
      if (!member) throw error('forbidden', 403);
      const result = await fn(client, member.role);
      await client.query('COMMIT'); return result;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async function effect(client, scope, kind, entity, revision, payload = {}) {
    await client.query('INSERT INTO outbox(tenant_id,project_id,kind,entity_id,revision,payload) VALUES($1,$2,$3,$4,$5,$6)', [scope.tenant_id, scope.project_id, kind, entity, revision, payload]);
  }
  const server = createServer(async (req, res) => {
    let streaming = false;
    try {
      if (req.url === '/healthz') { await pool.query('SELECT 1'); return json(res, 200, { status: 'ready' }); }
      const url = new URL(req.url, 'http://localhost');
      const match = /^\/v1\/tenants\/([a-z0-9-]+)\/projects\/([a-z0-9-]+)\/(state|events|jobs|judge|project)(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
      if (!match) throw error('not_found', 404);
      const [, tenant_id, project_id, resource, action] = match, scope = { tenant_id, project_id };
      const identity = authenticate(req.headers.authorization, config.publicKey, scope);
      if (resource === 'judge' && req.method === 'POST') {
        await scoped(scope, identity, async () => null);
        // The destination is trusted harness configuration, never request input.
        // External work runs after the short authorization transaction has ended.
        try {
          const response = await fetch(config.judgeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 1, input_kind: 'synthetic', question: 'Does fixture A concern fixture B?' }), signal: AbortSignal.timeout(1000) });
          if (!response.ok) throw new Error('judge_unavailable');
          const reply = await response.json();
          if (JSON.stringify(Object.keys(reply).sort()) !== JSON.stringify(['relevant', 'schema_version']) || reply.schema_version !== 1 || typeof reply.relevant !== 'boolean') throw new Error('judge_unavailable');
          await scoped(scope, identity, async () => null);
          return json(res, 200, reply);
        } catch { throw error('judge_unavailable', 503); }
      }
      if (resource === 'events' && req.method === 'GET') {
        await scoped(scope, identity, async () => null);
        const cursorHeader = req.headers['last-event-id'] ?? '0';
        if (!/^\d{1,15}$/.test(cursorHeader)) throw error('invalid_cursor', 400);
        let cursor = Number(cursorHeader), closed = false, busy = false;
        streaming = true;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ready\n\n');
        const timer = setInterval(async () => {
          if (busy || closed) return; busy = true;
          try {
            authenticate(req.headers.authorization, config.publicKey, scope);
            const events = await scoped(scope, identity, async client => (await client.query('SELECT sequence,kind,entity_id,revision FROM outbox WHERE sequence>$1 ORDER BY sequence LIMIT 64', [cursor])).rows);
            for (const event of events) { if (closed) break; res.write(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); cursor = Number(event.sequence); }
          } catch { res.end(); }
          finally { busy = false; }
        }, 20);
        res.on('close', () => { closed = true; clearInterval(timer); });
        return;
      }
      const input = req.method === 'POST' ? await body(req) : null;
      const output = await scoped(scope, identity, async (client, role) => {
        if (resource === 'project' && req.method === 'DELETE') {
          if (role !== 'operator') throw error('forbidden',403);
          // RLS restricts every DELETE to the authorized tenant/project.
          const counts = {};
          for (const table of ['jobs','outbox','project_state','memberships']) counts[table] = (await client.query(`DELETE FROM ${table}`)).rowCount;
          return { deleted: counts };
        }
        if (resource === 'state' && req.method === 'GET') {
          const row = (await client.query('SELECT revision,value FROM project_state')).rows[0];
          if (!row) throw error('not_found', 404); return row;
        }
        if (resource === 'state' && req.method === 'POST') {
          if (role !== 'operator') throw error('forbidden',403);
          if (!Number.isSafeInteger(input.expected_revision) || !Number.isSafeInteger(input.value)) throw error('invalid_request', 400);
          const row = (await client.query('UPDATE project_state SET revision=revision+1,value=$1 WHERE revision=$2 RETURNING revision,value', [input.value, input.expected_revision])).rows[0];
          if (!row) throw error('revision_conflict');
          await effect(client, scope, 'state_changed', 'state', row.revision);
          // A controlled local proof point demonstrates rollback of state + outbox.
          if (input.synthetic_fail_before_commit === true) throw error('synthetic_rollback', 503);
          return row;
        }
        if (resource !== 'jobs' || role !== 'worker' || identity.sub !== fixture.admission.worker.worker_id || tenant_id !== fixture.job.scope.tenant_id || project_id !== fixture.job.scope.project_id) throw error('forbidden', 403);
        if (req.method === 'GET') { const row = (await client.query('SELECT state FROM jobs WHERE job_id=$1', [fixture.job.job_id])).rows[0]; if (!row) throw error('not_found',404); return row.state; }
        if (!action) {
          const job = structuredClone(fixture.job);
          job.created_at_ms = input.created_at_ms; job.deadline_ms = input.created_at_ms + 120000;
          job.retry = { max_attempts: 2, lease_ms: 1000 };
          const state = createWorkerJobState(job);
          const row = (await client.query('INSERT INTO jobs(tenant_id,project_id,job_id,idempotency_key,revision,status,state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,project_id,idempotency_key) DO NOTHING RETURNING job_id', [tenant_id, project_id, job.job_id, job.idempotency_key, state.revision, state.status, state])).rows[0];
          if (!row) {
            const old = (await client.query('SELECT state FROM jobs WHERE idempotency_key=$1', [job.idempotency_key])).rows[0];
            if (old.state.job_digest !== state.job_digest) throw error('job_identity_conflict');
            return { state: old.state, duplicate: true };
          }
          await effect(client, scope, 'job_queued', job.job_id, state.revision);
          return { state, duplicate: false };
        }
        const row = (await client.query(action === 'claim' ? "SELECT state FROM jobs WHERE status='queued' ORDER BY enqueued_at FOR UPDATE SKIP LOCKED LIMIT 1" : 'SELECT state FROM jobs WHERE job_id=$1 FOR UPDATE', action === 'claim' ? [] : [fixture.job.job_id])).rows[0];
        if (!row) throw error('no_eligible_job');
        const state = row.state, now_ms = Date.now();
        const command = { ...input, type: action, expected_revision: input.expected_revision ?? state.revision };
        const context = { now_ms, actor: { scope, role: ['claim', 'expire'].includes(action) ? 'runtime' : 'worker', actor_id: ['claim', 'expire'].includes(action) ? 'spike-scheduler' : identity.sub }, admission: fixture.admission };
        const next = transitionWorkerJob(state, command, context);
        if (next.status === 'rejected') throw error(next.reason);
        if (next.status === 'applied') {
          const updated = await client.query('UPDATE jobs SET revision=$1,status=$2,state=$3 WHERE job_id=$4 AND revision=$5 RETURNING revision', [next.state.revision, next.state.status, next.state, state.job.job_id, state.revision]);
          if (updated.rowCount !== 1) throw error('job_cas_conflict');
          for (const e of next.effects) await effect(client, scope, e.type, state.job.job_id, next.state.revision, e);
        }
        return next;
      });
      json(res, 200, output);
    } catch (e) {
      if (streaming || res.headersSent) return res.end();
      const known = ['unauthorized', 'forbidden'].includes(e.message);
      json(res, e.status ?? (known ? e.message === 'unauthorized' ? 401 : 403 : 500), { error: e.status || known ? e.message : 'internal_error' });
    }
  });
  await pool.query('SELECT 1');
  server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
  process.once('SIGTERM', () => { server.closeAllConnections(); server.close(async () => { await pool.end(); process.exit(0); }); });
});
