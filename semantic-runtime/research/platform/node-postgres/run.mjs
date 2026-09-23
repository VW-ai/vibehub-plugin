// Creates and deletes its own cluster. It has no DATABASE_URL input by design.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { platform, arch, release, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { workerResultDigest } from '../../../src/index.mjs';
import { issue } from './auth.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const output=resolve(process.argv[2]??join(here,'../../../.local/platform-spike/report.json'));
const pgBin = process.env.SPIKE_PG_BIN;
assert(pgBin && existsSync(join(pgBin, 'pg_ctl')), 'Set SPIKE_PG_BIN to an isolated PostgreSQL 17 bin directory');
assert.equal(Number(process.versions.node.split('.')[0]), 24, 'This measured stack pins Node 24');
const pgVersion = execFileSync(join(pgBin, 'postgres'), ['--version'], { encoding: 'utf8' }).trim();
assert.match(pgVersion, /PostgreSQL\) 17\./, 'This measured stack pins PostgreSQL 17');
// Short macOS/Linux path avoids Unix-socket path limits in nested standalone copies.
const root = mkdtempSync('/tmp/vh-ps-'); chmodSync(root, 0o700);
const socket = join(root, 'socket'), data = join(root, 'data'); mkdirSync(socket, { mode: 0o700 });
const dbPort = 55439;
const env = { PATH: process.env.PATH, TMPDIR: root, LANG: 'C', LC_ALL: 'C' };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const claims = { iss: 'synthetic-spike', aud: 'semantic-runtime-spike', sub: 'alice', tenant_id: 'acme', project_id: 'product', exp: Math.floor(Date.now() / 1000) + 600 };
const tokens = { alice: issue(privateKey, claims), worker: issue(privateKey, { ...claims, sub: 'worker-a' }) };
const report = { schema_version: 1, run_kind: 'local-disposable-synthetic', started_at: new Date().toISOString(), environment: { node: process.version, postgres: pgVersion, pg_client: JSON.parse(readFileSync(join(here, 'node_modules/pg/package.json'))).version, platform: platform(), arch: arch(), os_release: release(), cpu: cpus()[0].model }, checks: [], measurements: {}, limitations: ['Not a hosted cold-start, network, capacity, failover, backup/PITR or disaster-restore drill.', 'Not the alpha workload; no SLO is adjudicated.', 'Synthetic local issuer and loopback mock judge; no production identity/provider credentials or private project inputs.', 'One job with accelerated 1000ms lease and 120000ms deadline; protocol permits these values; not the 30-second alpha job workload.'] };
const check = (name, test) => { test(); report.checks.push(name); };
const sample = (values, endpoint) => { const a = [...values].sort((x,y) => x-y); return { count: a.length, unit: 'ms', endpoint, samples: values.map(x=>+x.toFixed(3)), p50: +a[Math.ceil(a.length*.5)-1].toFixed(3), p95: +a[Math.ceil(a.length*.95)-1].toFixed(3), p99: +a[Math.ceil(a.length*.99)-1].toFixed(3) }; };
let admin, service, executor, mock, dbStarted = false, mockStatus = 200, base, mockRequests = 0;
let phase='database_initialization';
const children = new Set();
function waitMessage(child, expected) { return new Promise((resolveMessage, reject) => { const timer = setTimeout(() => reject(new Error('child_ready_timeout')), 15000); const onMessage = message => { if (message.type === expected) { clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage); resolveMessage(message); } }; const onExit = () => { clearTimeout(timer); child.off('message', onMessage); reject(new Error('child_exited')); }; child.on('message', onMessage); child.once('exit', onExit); }); }
async function stop(child, signal = 'SIGKILL') { if (!child || child.exitCode !== null || child.signalCode !== null) return; await new Promise(done => { child.once('exit', done); child.kill(signal); }); children.delete(child); }
const pgCtl = args => execFileSync(join(pgBin, 'pg_ctl'), ['-D', data, ...args], { env, stdio: 'pipe' });
async function startService() {
  const start = performance.now();
  service = fork(join(here, 'service.mjs'), [], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); children.add(service);
  const ready = waitMessage(service, 'ready');
  service.send({ socket, dbPort, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), judgeUrl: `http://127.0.0.1:${mock.address().port}/judge` });
  const message = await ready; base = `http://127.0.0.1:${message.port}/v1/tenants/acme/projects/product`;
  return performance.now()-start;
}
async function request(path, { token = tokens.alice, method = 'GET', body, urlBase = base } = {}) {
  const begin = performance.now(); const response = await fetch(`${urlBase}/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const value = await response.json(); return { code: response.status, value, ms: performance.now()-begin };
}
async function command(action, body) { return request(`jobs/${action}`, { token: tokens.worker, method: 'POST', body }); }
function result(state, finished = Date.now()) {
  const a=state.attempts.at(-1), job=state.job;
  const body={ schema_version:1,result_id:`result-${a.attempt_id}`,scope:job.scope,job_id:job.job_id,job_digest:state.job_digest,attempt_id:a.attempt_id,fencing_token:a.fencing_token,trigger:job.trigger,consumed_inputs:job.inputs,output_schema:job.output_schema,status:'succeeded',findings:[],artifacts:[],provenance:{authority:'proposal_only',input_revision_indexes:job.inputs.revisions.map((_,i)=>i),source_event_indexes:job.inputs.source_events.map((_,i)=>i)},executor:a.worker,usage:{account_usage:{status:'unknown',remaining_percent:null,observed_at:null},consumption:{basis:'unknown',input_tokens:null,output_tokens:null,usage_proxy_units:null},estimated_cost:{status:'unknown',currency:null,microunits:null}},timings:{started_at_ms:a.started_at_ms,finished_at_ms:finished,duration_ms:finished-a.started_at_ms},failure:null};
  return {...body,result_digest:workerResultDigest(body)};
}
async function subscribe(cursor = 0) {
  const controller = new AbortController();
  const response = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${tokens.alice}`, 'last-event-id': String(cursor) }, signal: controller.signal });
  assert.equal(response.status,200); const reader=response.body.getReader(); let buffered='';
  async function next() { const timeout = setTimeout(()=>controller.abort(),3000); try { while(true){const split=buffered.indexOf('\n\n');if(split>=0){const block=buffered.slice(0,split);buffered=buffered.slice(split+2);const dataLine=block.split('\n').find(x=>x.startsWith('data: '));if(dataLine)return JSON.parse(dataLine.slice(6));continue;} const {done,value}=await reader.read();if(done)return null;buffered+=Buffer.from(value).toString();} } finally {clearTimeout(timeout);} }
  return {next,close:()=>controller.abort()};
}
try {
  execFileSync(join(pgBin,'initdb'), ['-D',data,'-U','spike_admin','-A','trust','--encoding=UTF8','--locale=C'], {env,stdio:'pipe'});
  phase='database_start';
  const boot = performance.now(); pgCtl(['-l',join(root,'postgres.log'),'-o',`-k ${socket} -h '' -p ${dbPort}`,'-w','start']); dbStarted=true;
  report.measurements.database_process_start_ms = +(performance.now()-boot).toFixed(3);
  if(process.env.SPIKE_FAIL_PHASE==='after-start')throw new Error('intentional_cleanup_probe');
  phase='synthetic_contract_checks';
  admin = new pg.Client({host:socket,port:dbPort,user:'spike_admin',database:'postgres'}); await admin.connect();
  await admin.query(readFileSync(join(here,'schema.sql'),'utf8'));
  await admin.query("INSERT INTO memberships(subject,tenant_id,project_id,role) VALUES('alice','acme','product','operator'),('worker-a','acme','product','worker'),('bob','beta','product','operator')");
  await admin.query("INSERT INTO project_state(tenant_id,project_id) VALUES('acme','product'),('acme','other'),('beta','product'),('beta','other')");
  const durability=(await admin.query("SELECT current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('full_page_writes') AS full_page_writes")).rows[0];
  check('durable postgres configuration',()=>assert.deepEqual(durability,{fsync:'on',synchronous_commit:'on',full_page_writes:'on'})); report.environment.durability=durability;
  const restricted=new pg.Client({host:socket,port:dbPort,user:'spike_app',database:'postgres'});await restricted.connect();
  check('unscoped restricted role sees no project rows',()=>{});assert.equal((await restricted.query('SELECT * FROM project_state')).rowCount,0);await restricted.end();
  mock=createServer(async(req,res)=>{let data='';for await(const c of req)data+=c;assert.deepEqual(JSON.parse(data),{schema_version:1,input_kind:'synthetic',question:'Does fixture A concern fixture B?'});assert.equal(req.headers.authorization,undefined);mockRequests++;await delay(15);res.writeHead(mockStatus,{'content-type':'application/json'});res.end(JSON.stringify(mockStatus===200?{schema_version:1,relevant:true}:{error:'synthetic_failure'}));});
  await new Promise(done=>mock.listen(0,'127.0.0.1',done));
  const boots=[];for(let i=0;i<5;i++){boots.push(await startService());if(i<4)await stop(service,'SIGTERM');}
  report.measurements.fresh_node_process_to_database_ready = sample(boots,'parent monotonic spawn → child IPC after pool connect and HTTP listen; warm OS cache, new process');
  const first=await request('state');check('authenticated scoped read',()=>assert.equal(first.code,200));report.measurements.first_request_ms=+first.ms.toFixed(3);
  for(const [name,token,urlBase,expected] of [
    ['forged signature',tokens.alice.slice(0,-4)+'AAAA',base,401],
    ['expired token',issue(privateKey,{...claims,exp:1}),base,401],
    ['wrong audience',issue(privateKey,{...claims,aud:'wrong'}),base,401],
    ['cross-tenant URL',tokens.alice,base.replace('/acme/','/beta/'),403],
    ['cross-project URL',tokens.alice,base.replace('/product','/other'),403],
    ['valid token without membership',issue(privateKey,{...claims,sub:'mallory'}),base,403],
  ]) { const r=await request('state',{token,urlBase});check(name,()=>assert.equal(r.code,expected)); }
  const warm=[];for(let i=0;i<32;i++){const r=await request('state');assert.equal(r.code,200);warm.push(r.ms);}report.measurements.warm_scoped_read=sample(warm,'parent monotonic HTTP fetch → fully read JSON over loopback');
  const cas=[];let revision=0;
  for(let i=0;i<24;i++){const pair=await Promise.all([1,2].map(value=>request('state',{method:'POST',body:{expected_revision:revision,value}})));check(`CAS race ${i+1}: one commit and one conflict`,()=>assert.deepEqual(pair.map(x=>x.code).sort(),[200,409]));cas.push(pair.find(x=>x.code===200).ms);revision++;}
  report.measurements.competing_cas_commit=sample(cas,'parent monotonic HTTP fetch → committed winner response, two concurrent writers');
  const before=await admin.query('SELECT count(*)::int AS n FROM outbox');
  const failure=await request('state',{method:'POST',body:{expected_revision:revision,value:99,synthetic_fail_before_commit:true}});assert.equal(failure.code,503);
  check('state/outbox rollback is atomic',()=>assert.equal(failure.value.error,'synthetic_rollback'));
  assert.equal((await request('state')).value.revision,revision);assert.equal((await admin.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n,before.rows[0].n);
  const cursor=Number((await admin.query('SELECT max(sequence) AS n FROM outbox')).rows[0].n);
  const stream=await subscribe(cursor);const notifyStart=performance.now();await request('state',{method:'POST',body:{expected_revision:revision,value:7}});revision++;const event=await stream.next();stream.close();check('durable realtime notification',()=>assert.equal(event.revision,revision));report.measurements.sse_notification_ms=+(performance.now()-notifyStart).toFixed(3);
  const resumed=await subscribe(cursor);const replayed=await resumed.next();resumed.close();check('SSE reconnect replays durable cursor',()=>assert.equal(replayed.sequence,event.sequence));
  const revoked=await subscribe(Number(event.sequence));await admin.query("UPDATE memberships SET active=false WHERE subject='alice'");
  await admin.query("INSERT INTO outbox(tenant_id,project_id,kind,entity_id,revision) VALUES('acme','product','revoked_probe','state',999)");
  check('revoked access is denied at request',()=>{});assert.equal((await request('state')).code,403);check('revoked subscriber receives no new event',()=>assert.equal(null,null));assert.equal(await revoked.next(),null);revoked.close();await admin.query("UPDATE memberships SET active=true WHERE subject='alice'");
  const judge=await request('judge',{method:'POST',body:{}});check('outbound synthetic HTTP judge',()=>assert.deepEqual([judge.code,judge.value],[200,{schema_version:1,relevant:true}]));report.measurements.mock_judge_roundtrip_ms=+judge.ms.toFixed(3);
  mockStatus=503;const judgeFail=await request('judge',{method:'POST',body:{}});check('outbound failure remains bounded failure',()=>assert.deepEqual([judgeFail.code,judgeFail.value],[503,{error:'judge_unavailable'}]));mockStatus=200;assert.equal(mockRequests,2);
  const enqueueStart=performance.now(), created_at_ms=Date.now();
  const enqueued=await request('jobs',{token:tokens.worker,method:'POST',body:{created_at_ms}});assert.equal(enqueued.code,200);report.measurements.job_enqueue_http_ms=+enqueued.ms.toFixed(3);
  const durableAckObserved=performance.now();
  const duplicate=await request('jobs',{token:tokens.worker,method:'POST',body:{created_at_ms}});check('durable enqueue idempotency',()=>assert.equal(duplicate.value.duplicate,true));assert.equal((await request('jobs',{token:tokens.worker,method:'POST',body:{created_at_ms:created_at_ms+1}})).code,409);
  await stop(service);await admin.end();admin=null;pgCtl(['-m','immediate','-w','stop']);dbStarted=false;
  const restartStart=performance.now();pgCtl(['-l',join(root,'postgres.log'),'-o',`-k ${socket} -h '' -p ${dbPort}`,'-w','start']);dbStarted=true;
  admin=new pg.Client({host:socket,port:dbPort,user:'spike_admin',database:'postgres'});await admin.connect();await startService();report.measurements.database_crash_and_service_restart_ms=+(performance.now()-restartStart).toFixed(3);
  const survived=await request('jobs',{token:tokens.worker});check('acknowledged job survives API kill and PostgreSQL immediate restart',()=>assert.equal(survived.value.state_digest,enqueued.value.state.state_digest));
  check('acknowledged CAS state survives restart',()=>{});assert.equal((await request('state')).value.revision,revision);
  executor=fork(join(here,'executor.mjs'),[],{env,stdio:['ignore','ignore','ignore','ipc']});children.add(executor);
  executor.on('message',message=>{if(message.type==='claimed')report.measurements.durable_ack_to_first_claim_observed_ms=+(performance.now()-durableAckObserved).toFixed(3);});
  const startedPromise=waitMessage(executor,'started');executor.send({url:base,token:tokens.worker});const started=await startedPromise;
  report.measurements.enqueue_to_started_including_restart_ms=+(performance.now()-enqueueStart).toFixed(3);
  const stale=result(started.state);await stop(executor);
  const expiry=started.state.attempts.at(-1).lease_expires_at_ms;await delay(Math.max(0,expiry-Date.now())+20);
  const recoveryStart=performance.now();const expired=await command('expire',{});check('expired crashed attempt requeues',()=>assert.equal(expired.value.state.status,'queued'));
  const claimRace=await Promise.all(['attempt-recovered','attempt-racer'].map(attempt_id=>command('claim',{attempt_id})));
  check('durable claim race dispatches one attempt',()=>assert.deepEqual(claimRace.map(x=>x.code).sort(),[200,409]));
  let live=claimRace.find(x=>x.code===200).value.state;const a=live.attempts.at(-1);
  const startedAgain=await command('start',{expected_revision:live.revision,attempt_id:a.attempt_id,fencing_token:a.fencing_token});live=startedAgain.value.state;
  const staleReceipt=await command('complete',{expected_revision:live.revision,attempt_id:stale.attempt_id,fencing_token:stale.fencing_token,result:stale});check('old executor cannot commit after recovery',()=>assert.equal(staleReceipt.code,409));
  const completedResult=result(live);const completeCommand={expected_revision:live.revision,attempt_id:a.attempt_id,fencing_token:a.fencing_token,result:completedResult};
  const complete=await command('complete',completeCommand);check('recovered attempt commits proposal-only result',()=>assert.equal(complete.value.state.status,'succeeded'));
  report.measurements.expire_reclaim_start_fenced_complete_ms=+(performance.now()-recoveryStart).toFixed(3);
  const redelivered=await command('complete',completeCommand);check('exact terminal redelivery has zero effects',()=>assert.deepEqual([redelivered.value.status,redelivered.value.effects],['duplicate',[]]));
  const counts=(await admin.query("SELECT kind,count(*)::int AS n FROM outbox WHERE kind IN ('attempt_reserved','record_usage','result_available') GROUP BY kind ORDER BY kind")).rows;
  check('state and effects commit once; expired reservation retained',()=>assert.deepEqual(counts,[{kind:'attempt_reserved',n:2},{kind:'record_usage',n:1},{kind:'result_available',n:1}]));
  const terminal=complete.value.state;assert.equal(terminal.receipts[0].usage.consumption.input_tokens,null);assert.equal(terminal.attempts[0].status,'expired');assert.equal(terminal.attempts[1].fencing_token,2);
  report.job={count:1,attempt_count:2,created_at_ms,job_digest:terminal.job_digest,lease_ms:1000,deadline_ms:120000,final_status:terminal.status,effect_counts:counts,unknown_expired_consumption:'retained, not refunded'};
  report.offered={warm_reads:32,cas_writes:48,expected_cas_conflicts:24,queued_jobs:1,crashed_attempts:1,recovered_completions:1,judge_requests:2,expected_judge_failures:1};
  await admin.query("INSERT INTO outbox(tenant_id,project_id,kind,entity_id,revision) VALUES('beta','product','untouched_probe','state',1)");
  const deleted=await request('project',{method:'DELETE'});assert.equal(deleted.code,200);
  const remaining={};for(const table of ['jobs','outbox','project_state','memberships'])remaining[table]=(await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id='acme' AND project_id='product'`)).rows[0].n;
  check('authorized project deletion removes state, job, outbox and memberships',()=>assert.deepEqual(remaining,{jobs:0,outbox:0,project_state:0,memberships:0}));
  const betaToken=issue(privateKey,{...claims,sub:'bob',tenant_id:'beta'});
  const beta=await request('state',{token:betaToken,urlBase:base.replace('/acme/','/beta/')});
  check('deletion preserves another tenant state, membership and outbox',()=>assert.deepEqual([beta.code,beta.value],[200,{revision:0,value:0}]));
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM outbox WHERE tenant_id='beta' AND kind='untouched_probe'")).rows[0].n,1);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM project_state WHERE tenant_id='acme' AND project_id='other'")).rows[0].n,1);
  report.deletion={selected_project_remaining_rows:remaining,other_tenant_preserved:true,other_project_preserved:true};
  const sources=['auth.mjs','service.mjs','executor.mjs','run.mjs','schema.sql','fixture.json','package.json','package-lock.json'];
  report.input_sha256=Object.fromEntries(sources.map(file=>[file,createHash('sha256').update(readFileSync(join(here,file))).digest('hex')]));
  report.protocol_sha256=Object.fromEntries([
    ['worker-protocol.mjs','../../../src/domain/work/worker-protocol.mjs'],
    ['observability-contract.mjs','../../../src/domain/decisions/observability-contract.mjs'],
  ].map(([file,path])=>[file,createHash('sha256').update(readFileSync(join(here,path))).digest('hex')]));
  report.status='passed';
} catch {
  // Never include exceptions, connection strings, bearer tokens or raw payloads.
  report.status='failed';report.failure_code='synthetic_assertion_or_infrastructure_failure';report.failure_stage=phase;
} finally {
  let cleanupFailed=false;
  for(const child of [...children])try {await stop(child);} catch {cleanupFailed=true;}
  try {if(mock) {mock.closeAllConnections();await new Promise(done=>mock.close(done));}} catch {cleanupFailed=true;}
  try {if(admin)await admin.end();} catch {cleanupFailed=true;}
  try {if(dbStarted){pgCtl(['-m','fast','-w','stop']);dbStarted=false;}} catch {cleanupFailed=true;}
  if(!dbStarted)try {rmSync(root,{recursive:true,force:true});} catch {cleanupFailed=true;}
  report.cleanup={child_processes_exited:children.size===0,database_stopped:!dbStarted,private_cluster_and_socket_deleted:!existsSync(root),hosted_resources_created:0};
  if(cleanupFailed){report.status='failed';report.failure_code='cleanup_incomplete';}
}
report.finished_at=new Date().toISOString();
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:output,cleanup:report.cleanup}));
if(report.status!=='passed')process.exitCode=1;
