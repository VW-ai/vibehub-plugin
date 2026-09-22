import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';

const component = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const usage = `VibeHub local Runtime
  npm start -- [--port 4310] [--data-dir PATH]
  npm run app -- [--port 4310] [--data-dir PATH]
  npm run status -- [--port 4310]

Listens only on 127.0.0.1. --port 0 selects a free port.
Default data: semantic-runtime/.local/app, independent of the current directory.
Stop with Ctrl+C or SIGTERM; saved data is retained.
App pairing requires this terminal's approval: approve CODE.
No collection, plugin/Worker connection or model verification starts automatically.`;

try {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '4310' },
    'data-dir': { type: 'string' }, status: { type: 'boolean' }, help: { type: 'boolean' }, setup: { type: 'boolean' },
  } });
  if (values.help) console.log(usage);
  else {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13) || (major === 23 && minor < 4)) {
      throw new Error('Use Node 22.13+ (23.x requires 23.4+); Node 24 is the recommended local runtime.');
    }
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) {
      throw new Error('Use --port with an integer from 0 to 65535.');
    }
    const port = Number(values.port);
    if (values.status) {
      if (!port || values['data-dir'] || values.setup) throw new Error('Status needs the running port and does not accept --data-dir or --setup.');
      let ready;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
        const body = await response.json();
        ready = response.ok && body.service === 'vibehub-runtime' && body.status === 'ready';
      } catch { ready = false; }
      if (!ready) throw new Error('Local Runtime is unavailable or not ready. Start it with npm start and check the port.');
      console.log('VibeHub local Runtime is ready.');
    } else {
      // Load SQLite only when starting, so help/status remain usable if startup dependencies fail.
      const { startLocalRuntime } = await import('./service.mjs');
      const pairingAvailable = Boolean(values.setup && process.stdin.isTTY && process.stdout.isTTY);
      const app = await startLocalRuntime({ port, dataDir: values['data-dir'] ?? resolve(component, '.local/app'), setup: values.setup ?? false,
        pairing: { available: pairingAvailable, onPending: code => {
          console.log(`Browser pairing code: ${code}. Compare it with the page, then type: approve ${code}`);
        } } });
      let terminal;
      if (pairingAvailable) {
        terminal = createInterface({ input: process.stdin, output: process.stdout });
        terminal.on('line', line => {
          if (line === 'revoke') { app.pairing.revoke(); console.log('Browser pairing revoked.'); return; }
          if (/^approve [A-F0-9]{8}$/.test(line) && app.pairing.approve(line.slice(8))) console.log('Browser pairing approved.');
          else console.log('No matching pending request. Use the exact approve CODE shown here, or revoke.');
        });
        terminal.on('close', () => app.pairing.disable());
      } else if (values.setup) console.log('Pairing unavailable without an attached interactive terminal. Restart npm run app in a terminal.');
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        try { await app.close(); console.log('Local Runtime stopped. Saved data retained.'); }
        catch { console.error('Could not finish local Runtime shutdown. Saved files were not removed.'); process.exitCode = 1; }
        finally { terminal?.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      terminal?.on('SIGINT', stop);
      app.closed.then(() => { terminal?.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); });
      // Advertise readiness only after immediate signals can close the service.
      console.log(`VibeHub local Runtime: ${app.url}`);
      console.log(`Local data: ${app.dataDir}`);
      console.log(values.setup ? 'Connected setup only; plugins, Workers and model verification are not connected. Press Ctrl+C to stop.'
        : 'Bootstrap only; collection and models are inactive. Press Ctrl+C to stop.');
    }
  }
} catch (error) {
  console.error(error.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
    ? 'Node SQLite is unavailable. Use Node 22.13+ or Node 24 and retry.' : error.message);
  process.exitCode = 1;
}
