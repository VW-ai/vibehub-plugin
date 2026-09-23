import { readFileSync } from 'node:fs';

const MAX_BODY = 32768;
const failure = code => Object.assign(new Error(`Local setup: ${code}`), { code });
const actions = new Set(['projects.list', 'folder.inspect', 'folder.initialize', 'projects.enroll', 'projects.retry',
  'project.read', 'project.refresh', 'project.activation', 'provider.configure', 'provider.replace', 'provider.remove']);
const transportCodes = new Set(['setup_unauthorized', 'pairing_unavailable', 'pairing_busy', 'invalid_setup_request',
  'request_too_large', 'request_timeout', 'setup_unavailable', 'method_not_allowed', 'not_found', 'local_origin_required']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/setup/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/setup/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, required) {
  if (!plain(value) || Object.keys(value).length !== required.length || !required.every(k => Object.hasOwn(value, k))) throw failure('invalid_setup_request');
}
function jsonBound(value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > 4096 || depth > 16) throw failure('request_too_large');
  if (value && typeof value === 'object') for (const child of Object.values(value)) jsonBound(child, depth + 1, budget);
}
function body(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
    || request.headers['content-encoding'] !== undefined) throw failure('invalid_setup_request');
  if (request.headers['content-length'] !== undefined && (!/^\d+$/.test(request.headers['content-length'])
    || Number(request.headers['content-length']) > MAX_BODY)) throw failure('request_too_large');
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], settled = false;
    const timer = setTimeout(() => finish(failure('request_timeout')), 5000); timer.unref();
    function finish(error, value) {
      if (settled) return;
      settled = true; clearTimeout(timer); chunks = [];
      if (error) { request.resume(); reject(error); } else resolve(value);
    }
    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY) finish(failure('request_too_large')); else chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value = JSON.parse(text);
        jsonBound(value); finish(null, value);
      } catch (error) { finish(failure(error?.code === 'request_too_large' ? 'request_too_large' : 'invalid_setup_request')); }
    });
    request.once('aborted', () => finish(failure('invalid_setup_request')));
    request.once('error', () => finish(failure('invalid_setup_request')));
  });
}

/** Allowlisted transport only. Pair approval remains in the launcher's memory/TTY. */
export function createSetupHandler({ controller, sessions, origin, stop, safeCodes = [] }) {
  const codes = new Set([...transportCodes, ...safeCodes]);
  return async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8', cookie) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ...(cookie ? { 'Set-Cookie': cookie } : {}) });
      response.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host || request.headers.origin !== undefined && request.headers.origin !== origin
        || request.headers['sec-fetch-site'] !== undefined && !['none', 'same-origin'].includes(request.headers['sec-fetch-site'])) throw failure('local_origin_required');
      if (request.method === 'GET' && assets.has(request.url)) {
        const [file, type] = assets.get(request.url);
        send(200, readFileSync(new URL(`./ui/${file}`, import.meta.url), 'utf8'), type); return;
      }
      if (request.url === '/v1/setup/session') {
        if (request.method !== 'GET') throw failure('method_not_allowed');
        const result = sessions.status(request.headers.cookie, origin); send(200, result.data, undefined, result.cookie); return;
      }
      if (!['/v1/setup/pair', '/v1/setup/action', '/v1/setup/stop'].includes(request.url)) throw failure('not_found');
      if (request.method !== 'POST') throw failure('method_not_allowed');
      if (request.headers.origin !== origin || request.headers['x-vibehub-setup'] !== '1') throw failure('local_origin_required');
      // Authenticate private work before parsing a path, config or credential body.
      const assertOwner = request.url === '/v1/setup/pair' ? null : sessions.owner(request.headers.cookie, origin);
      const value = await body(request);
      if (request.url === '/v1/setup/pair') {
        fields(value, []); const result = sessions.begin(request.headers.cookie, origin);
        send(200, result.data, undefined, result.cookie); return;
      }
      assertOwner();
      if (request.url === '/v1/setup/stop') {
        fields(value, []);
        // Fence every captured owner closure before the response or async close.
        sessions.close();
        let stopping = false;
        const stopOnce = () => {
          if (stopping) return;
          stopping = true; Promise.resolve().then(stop).catch(() => {});
        };
        // An accepted Stop survives a lost reply; finish lets a healthy reply flush.
        response.once('finish', stopOnce); response.once('close', stopOnce);
        send(200, { ok: true });
        if (response.destroyed || response.writableFinished) stopOnce();
        return;
      }
      fields(value, ['action', 'input']);
      if (!actions.has(value.action) || !plain(value.input)) throw failure('invalid_setup_request');
      const data = await controller.execute(value.action, value.input, assertOwner);
      assertOwner(); send(200, { ok: true, data });
    } catch (error) {
      request.resume();
      const code = codes.has(error?.code) ? error.code : 'setup_unavailable';
      const status = code === 'setup_unauthorized' ? 401 : code === 'local_origin_required' ? 403
        : code === 'method_not_allowed' ? 405 : code === 'not_found' ? 404 : code === 'request_too_large' ? 413
          : code === 'request_timeout' ? 408 : ['pairing_busy', 'pairing_unavailable', 'cas_conflict'].includes(code) ? 409
            : code === 'setup_unavailable' ? 503 : 400;
      send(status, { ok: false, error: { code } });
    }
  };
}
