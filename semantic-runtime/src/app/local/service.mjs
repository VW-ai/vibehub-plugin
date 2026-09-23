import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';
import { LocalCredentialAuthority } from '../../adapters/auth/local-credential-authority.mjs';
import { authorizeLocalRequest } from './http/authorize-local-request.mjs';
import { scopedReference, accessDiagnostic } from '../../domain/identity/service-access.mjs';
import { AppSessions } from './app-session.mjs';
import { createSetupHandler } from './setup-http.mjs';

const APPLICATION_ID = 0x56484253; // VHBS: bootstrap store, separate from replay/domain databases.
const SERVICE = 'vibehub-runtime';
export const DEFAULT_PORT = 4310;

function openStorage(dataDir) {
  let db;
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(join(dataDir, 'bootstrap.sqlite'));
    db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE;');
    const application = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const empty = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n === 0;
    if (!(application === APPLICATION_ID && version === 1)
      && !(application === 0 && version === 0 && empty)) {
      throw new Error('Unsupported store');
    }
    db.exec(`CREATE TABLE IF NOT EXISTS bootstrap (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), created_at TEXT NOT NULL
    ) STRICT;`);
    db.prepare('INSERT OR IGNORE INTO bootstrap VALUES (1, ?)').run(new Date().toISOString());
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1; COMMIT;`);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    return db;
  } catch {
    db?.close(); // Closing also rolls back an unfinished initialization transaction.
    throw new Error('Local storage could not open. Check --data-dir is writable and bootstrap.sqlite belongs to this Runtime. Existing files were not removed.');
  }
}

export function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Use --port with an integer from 0 to 65535 (0 selects a free port).');
  }
  return port;
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VibeHub · Local Runtime</title>
<style>body{font:17px/1.7 system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:24px;color:#202726;background:#fafbf8}small{color:#52635b}h1{font-size:34px;letter-spacing:-1px}aside{border-left:3px solid #548568;padding:4px 20px;margin:30px 0}code{font-size:14px}</style>
<small>VibeHub / 本地服务</small><h1>本地服务已启动</h1>
<p>这是本地 App 的启动入口，目前可检查服务与存储是否正常。</p>
<aside>项目接入、模型配置和语义采集尚未启用。当前没有采集会话，也没有调用模型。</aside>
<p>关闭页面不会停止服务。在启动它的终端按 <code>Ctrl+C</code> 退出；已保存的数据会保留。</p>
</html>`;

/** Local status and authenticated identity boundary; no source/model execution. */
export async function startLocalRuntime({ dataDir, port = DEFAULT_PORT, setup = false,
  pairing = {}, secretStore, now = () => Date.now() } = {}) {
  validatePort(port);
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('An explicit dataDir is required.');
  if (typeof setup !== 'boolean' || typeof now !== 'function' || !pairing || typeof pairing !== 'object'
    || pairing.available !== undefined && typeof pairing.available !== 'boolean'
    || pairing.onPending !== undefined && typeof pairing.onPending !== 'function') throw new Error('Invalid local setup options.');
  const storagePath = resolve(dataDir);
  const db = openStorage(storagePath);
  const auth = new LocalCredentialAuthority({ now });
  let controller, setupCodes, sessions, setupHandler;
  if (setup) {
    try {
      const { LocalAppSetup, SETUP_ERROR_CODES } = await import('./app-setup.mjs');
      controller = new LocalAppSetup({ dataDir: storagePath, authority: auth, secretStore, now });
      setupCodes = SETUP_ERROR_CODES;
    } catch { auth.close(); db.close(); throw new Error('Local App setup storage could not open. Existing files were not removed.'); }
  }
  let origin;
  let closing;
  let finishClosed;
  const closed = new Promise(resolveClosed => { finishClosed = resolveClosed; });
  const server = createServer((request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (setup && (request.url === '/' || request.url.startsWith('/setup/') || request.url.startsWith('/v1/setup/'))) {
      void setupHandler(request, response); return;
    }
    // No CORS. Reject rebinding and cross-origin browser requests even for this read-only surface.
    if (request.headers.host !== new URL(origin).host
      || (request.headers.origin && request.headers.origin !== origin)) {
      send(403, { error: 'Local origin required' }); return;
    }
    if (request.method !== 'GET') { send(405, { error: 'GET required' }); return; }
    if (request.url === '/v1/session') {
      try {
        const scope = { tenant_id: request.headers['x-vibehub-tenant'], project_id: request.headers['x-vibehub-project'] };
        const decision = authorizeLocalRequest(auth, request, {
          scope, audience: LOCAL_AUDIENCE, action: 'session:read', kinds: ['human', 'host-adapter', 'service'],
          boundary: 'http', reference: scopedReference('http', scope, 'session'),
        });
        if (!decision.allowed) { send(decision.reason === 'unauthenticated' ? 401 : 403, accessDiagnostic(decision)); return; }
        const principal = auth.inspect(decision.context);
        send(200, { principal_id: principal.principal_id, kind: principal.kind,
          tenant_id: principal.tenant_id, project_id: principal.project_id, expires_at: principal.expires_at });
      } catch { send(400, { error: 'Invalid authentication scope' }); }
      return;
    }
    if (request.url === '/healthz') { send(200, { service: SERVICE, status: 'alive' }); return; }
    if (request.url !== '/' && request.url !== '/readyz') { send(404, { error: 'Not found' }); return; }
    try {
      if (db.prepare('SELECT singleton FROM bootstrap WHERE singleton = 1').get()?.singleton !== 1) {
        throw new Error('Missing bootstrap state');
      }
      if (request.url === '/') send(200, PAGE, 'text/html; charset=utf-8');
      else send(200, { service: SERVICE, status: 'ready', storage: 'sqlite', profile: setup ? 'setup' : 'bootstrap',
        ...(setup ? { app: 'ready', plugins: 'not_connected', workers: 'not_connected', models: 'unverified' } : {}) });
    } catch {
      send(503, { service: SERVICE, status: 'not_ready', error: 'Local storage unavailable' });
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        origin = `http://127.0.0.1:${server.address().port}`;
        if (setup) {
          sessions = new AppSessions({ origin, available: pairing.available ?? false, onPending: pairing.onPending, now });
          setupHandler = createSetupHandler({ controller, sessions, origin, stop: close, safeCodes: setupCodes });
        }
        resolveListen();
      });
    });
  } catch (error) {
    sessions?.close(); await controller?.close();
    auth.close();
    db.close();
    if (error.code === 'EADDRINUSE') throw new Error('Port already in use. Choose --port 0 or another local port.');
    throw new Error('Could not bind the local listener. Allow loopback networking and retry.');
  }
  function close() {
    if (!closing) {
      // Revoke synchronously: queued/in-flight owner guards fail before awaiting I/O.
      sessions?.close(); auth.close();
      const controllerClosed = Promise.resolve(controller?.close());
      closing = Promise.all([controllerClosed, new Promise((resolveClose, reject) => {
        server.close(error => { if (error) reject(error); else resolveClose(); }); server.closeAllConnections();
      })]).finally(() => { try { db.close(); } finally { finishClosed(); } });
    }
    return closing;
  }
  return { url: origin, dataDir: storagePath, auth, close, closed,
    ...(setup ? { pairing: Object.freeze({ approve: code => sessions.approve(code), revoke: () => sessions.revoke(), disable: () => sessions.disable() }) } : {}) };
}
