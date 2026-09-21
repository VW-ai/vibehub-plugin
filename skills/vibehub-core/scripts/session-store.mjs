import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SESSION_STATES = ['ready', 'running', 'waiting_tool', 'waiting_human', 'paused', 'completed', 'failed', 'cancelled'];
export const TERMINAL_SESSION_STATES = new Set(['completed', 'failed', 'cancelled']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIVE_STATES = new Set(['running', 'waiting_tool', 'waiting_human']);
const RECORD_KEYS = ['schema_version','kind','session_id','ticket_id','agent_id','agent_name','provider','host_session_id','operation','source','state','revision','started_at','last_reported_at','last_activity_at','expires_at','ended_at','freshness_ms','message'];
const error = (code, message) => Object.assign(new Error(message), { code });
const digest = (token) => createHash('sha256').update(token).digest('hex');
const iso = (now) => new Date(now).toISOString();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function strict(input, keys) {
  if (!object(input)) throw error('invalid_session', 'Session input must be an object');
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw error('invalid_session', `Unknown session field: ${key}`);
}

// --git-path is worktree-specific, unlike --git-common-dir. No global discovery.
export function sessionDirectory(repo) {
  try {
    const path = execFileSync('git', ['-C', resolve(repo), 'rev-parse', '--git-path', 'vibehub-runtime/sessions'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    return resolve(repo, path);
  } catch { return null; }
}

function regularDirectory(path, create = false) {
  if (create) mkdirSync(path, {recursive:true,mode:0o700});
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw error('invalid_session_store', 'Session storage must be a local directory');
}

export function validateSession(record) {
  strict(record, RECORD_KEYS);
  if (RECORD_KEYS.some(key => !(key in record))) throw error('invalid_session', 'Session record is incomplete');
  if (record.schema_version !== 1 || record.kind !== 'agent_session') throw error('invalid_session', 'Unsupported session schema');
  for (const key of ['session_id','ticket_id']) if (!text(record[key]) || !ID.test(record[key])) throw error('invalid_session', `Invalid ${key}`);
  for (const key of ['agent_id','agent_name','provider']) if (!text(record[key])) throw error('invalid_session', `Invalid ${key}`);
  if (record.host_session_id !== null && !text(record.host_session_id)) throw error('invalid_session', 'Invalid host_session_id');
  if (!['execute','closeout','plan'].includes(record.operation)) throw error('invalid_session', 'Invalid operation');
  if (!['agent_report','process'].includes(record.source)) throw error('invalid_session', 'Invalid source');
  if (!SESSION_STATES.includes(record.state)) throw error('invalid_session', 'Invalid state');
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw error('invalid_session', 'Invalid revision');
  if (!Number.isInteger(record.freshness_ms) || record.freshness_ms < 1000 || record.freshness_ms > 300000) throw error('invalid_session', 'freshness_ms must be 1000..300000');
  if (record.message !== null && !text(record.message, 1000)) throw error('invalid_session', 'Invalid message');
  for (const key of ['started_at','last_reported_at','last_activity_at','expires_at']) {
    if (typeof record[key] !== 'string' || !Number.isFinite(Date.parse(record[key])) || iso(Date.parse(record[key])) !== record[key]) throw error('invalid_session', `Invalid ${key}`);
  }
  const start = Date.parse(record.started_at), report = Date.parse(record.last_reported_at), activity = Date.parse(record.last_activity_at);
  if (start > activity || activity > report || Date.parse(record.expires_at) !== report + record.freshness_ms) throw error('invalid_session', 'Invalid session timestamp ordering');
  if (TERMINAL_SESSION_STATES.has(record.state)) {
    if (record.ended_at !== record.last_reported_at) throw error('invalid_session', 'Terminal state must have an end timestamp');
  } else if (record.ended_at !== null) throw error('invalid_session', 'Active state cannot have an end timestamp');
  return record;
}

function readEnvelope(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw error('invalid_session_store', 'Session record must be a regular file');
  const envelope = JSON.parse(readFileSync(path,'utf8'));
  strict(envelope, ['session','token_hash','process_owner_hash']);
  validateSession(envelope.session);
  if (!/^[0-9a-f]{64}$/.test(envelope.token_hash)) throw error('invalid_session_store','Invalid session writer credential');
  if (envelope.session.source === 'process' ? !/^[0-9a-f]{64}$/.test(envelope.process_owner_hash) : envelope.process_owner_hash !== undefined) throw error('invalid_session_store','Invalid process owner credential');
  if (!path.endsWith(`/${envelope.session.session_id}.json`)) throw error('invalid_session_store','Session filename does not match identity');
  return envelope;
}

function writeEnvelope(path, envelope, create = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  if (create) {
    writeFileSync(path, `${JSON.stringify(envelope)}\n`, {flag:'wx',mode:0o600});
    return;
  }
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, {flag:'wx',mode:0o600});
  try { renameSync(temporary,path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function startSession(repo, input, { now = Date.now(), source = 'agent_report' } = {}) {
  strict(input,['ticket_id','agent_id','agent_name','provider','host_session_id','operation','state','freshness_ms','message']);
  if (!text(input.ticket_id) || !ID.test(input.ticket_id)) throw error('invalid_session','A valid ticket_id is required');
  const ticketPath = join(repo,'.vibehub','tickets',`${input.ticket_id}.yaml`);
  if (!existsSync(ticketPath) || !lstatSync(ticketPath).isFile() || lstatSync(ticketPath).isSymbolicLink()) throw error('not_found','Ticket does not exist in this worktree');
  const ticket = JSON.parse(readFileSync(ticketPath,'utf8'));
  if (ticket.kind !== 'ticket' || ticket.ticket_id !== input.ticket_id) throw error('invalid_session','Ticket identity does not match');
  const directory = sessionDirectory(repo);
  if (!directory) throw error('git_required','Local sessions require a Git worktree');
  const session = {
    schema_version:1,kind:'agent_session',session_id:randomUUID(),ticket_id:input.ticket_id,
    agent_id:input.agent_id,agent_name:input.agent_name,provider:input.provider,host_session_id:input.host_session_id ?? null,
    operation:input.operation ?? 'execute',source,state:input.state ?? 'ready',revision:1,
    started_at:iso(now),last_reported_at:iso(now),last_activity_at:iso(now),expires_at:iso(now+(input.freshness_ms ?? 30000)),ended_at:null,
    freshness_ms:input.freshness_ms ?? 30000,message:input.message ?? null,
  };
  validateSession(session);
  regularDirectory(directory,true);
  const token = randomBytes(32).toString('hex');
  const processOwnerToken = source === 'process' ? randomBytes(32).toString('hex') : undefined;
  writeEnvelope(join(directory,`${session.session_id}.json`), {session,token_hash:digest(token),...(processOwnerToken ? {process_owner_hash:digest(processOwnerToken)} : {})},true);
  return {session,token,...(processOwnerToken ? {processOwnerToken} : {})};
}

export function updateSession(repo, input, { now = Date.now(), heartbeat = false, processOwnerToken } = {}) {
  strict(input, ['session_id','token','expected_revision','state','activity','message']);
  if (!text(input.session_id) || !ID.test(input.session_id)) throw error('invalid_session','Invalid session_id');
  if (typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)) throw error('session_unauthorized','Writer token required');
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw error('invalid_session','expected_revision is required');
  if (input.activity !== undefined && typeof input.activity !== 'boolean') throw error('invalid_session','activity must be boolean');
  if (heartbeat && (input.state !== undefined || input.activity !== undefined || input.message !== undefined)) throw error('invalid_session','Heartbeat cannot change state or activity');
  const directory=sessionDirectory(repo);
  if (!directory) throw error('git_required','Local sessions require a Git worktree');
  regularDirectory(directory);
  const path=join(directory,`${input.session_id}.json`), lock=`${path}.lock`;
  if (!existsSync(path)) throw error('not_found','Session not found in this worktree');
  try { mkdirSync(lock,{mode:0o700}); } catch (cause) { if (cause.code === 'EEXIST') throw error('session_busy','Another writer is updating this session'); throw cause; }
  try {
    const envelope=readEnvelope(path), previous=envelope.session;
    if (!timingSafeEqual(Buffer.from(digest(input.token),'hex'),Buffer.from(envelope.token_hash,'hex'))) throw error('session_unauthorized','Invalid session writer token');
    if (input.expected_revision !== previous.revision) throw error('session_conflict',`Session revision is ${previous.revision}; reread before updating`);
    if (TERMINAL_SESSION_STATES.has(previous.state)) throw error('invalid_transition','A finished session cannot be resumed; start a new session');
    if (now < Date.parse(previous.last_reported_at)) throw error('invalid_session','Clock moved backwards; cannot accept this report');
    const state=input.state ?? previous.state;
    if (previous.source === 'process' && TERMINAL_SESSION_STATES.has(state)) {
      if (typeof processOwnerToken !== 'string' || !/^[0-9a-f]{64}$/.test(processOwnerToken) || !timingSafeEqual(Buffer.from(digest(processOwnerToken),'hex'),Buffer.from(envelope.process_owner_hash,'hex'))) throw error('session_unauthorized','Only the foreground wrapper can finalize an observed process');
    }
    const next={...previous,state,revision:previous.revision+1,last_reported_at:iso(now),expires_at:iso(now+previous.freshness_ms),
      last_activity_at:input.activity === true || state !== previous.state ? iso(now) : previous.last_activity_at,
      ended_at:TERMINAL_SESSION_STATES.has(state) ? iso(now) : null,
      message:input.message === undefined ? previous.message : input.message};
    validateSession(next);
    writeEnvelope(path,{...envelope,session:next});
    return next;
  } finally { rmdirSync(lock); }
}

export function readSessions(repo, { now = Date.now() } = {}) {
  const directory=sessionDirectory(repo);
  if (!directory) return {availability:'unavailable',reason:'Local session reporting requires a Git worktree.',sessions:[],errors:[]};
  const sessions=[],errors=[];
  try {
    regularDirectory(directory);
    for (const entry of existsSync(directory) ? readdirSync(directory).filter(name=>name.endsWith('.json')).sort() : []) {
      try {
        const session=readEnvelope(join(directory,entry)).session;
        const terminal=TERMINAL_SESSION_STATES.has(session.state);
        const stale=!terminal && (Date.parse(session.expires_at) <= now || Date.parse(session.last_reported_at) > now);
        sessions.push({...session,effective_state:stale ? 'disconnected' : session.state,fresh:!terminal && !stale,
          ticket_exists:existsSync(join(repo,'.vibehub','tickets',`${session.ticket_id}.yaml`))});
      } catch { errors.push({file:entry,message:'Invalid session record; excluded from live presence.'}); }
    }
  } catch { return {availability:'unavailable',reason:'Local session records could not be read.',sessions:[],errors:[]}; }
  sessions.sort((a,b)=>b.last_reported_at.localeCompare(a.last_reported_at)||a.session_id.localeCompare(b.session_id));
  return {availability:'available',sessions,errors};
}

export function ticketSessionCapability(snapshot, ticketId) {
  const sessions=snapshot.sessions.filter(session=>session.ticket_id===ticketId);
  if (snapshot.availability !== 'available') return {availability:'unavailable',reason:snapshot.reason,sessions};
  const active=sessions.find(session=>session.fresh && LIVE_STATES.has(session.state) && ['execute','closeout'].includes(session.operation));
  return {availability:'available',sessions,summary:active ? {
    // This is scoped, fresh local reporting, not a remote identity attestation.
    trustedSource:active.source === 'process' ? 'local-process' : 'local-agent-report',
    ticketId,runId:active.session_id,operation:active.operation,state:active.state,
    observedAt:active.last_reported_at,expiresAt:active.expires_at,
  } : null};
}
