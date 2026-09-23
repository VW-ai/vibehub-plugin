// Browser-only failure fixture. No native Keychain or model calls; never an App mode.
import { createInterface } from 'node:readline';
import { startLocalRuntime } from '../../../src/app/local/service.mjs';
const [dataDir, port] = process.argv.slice(2);
if (!dataDir || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use a disposable data directory and interactive terminal.');
const unavailable = () => { throw new Error('Synthetic secure-store failure'); };
const app = await startLocalRuntime({ dataDir, port: Number(port ?? 0), setup: true,
  secretStore: { put: unavailable, remove: unavailable, status: unavailable, use: unavailable },
  pairing: { available: true, onPending: code => console.log(`Synthetic fixture pairing: approve ${code}`) } });
console.log(`Synthetic secure-store failure fixture: ${app.url}`);
const terminal = createInterface({ input: process.stdin, output: process.stdout });
terminal.on('line', line => { if (/^approve [A-F0-9]{8}$/.test(line)) console.log(app.pairing.approve(line.slice(8)) ? 'Approved.' : 'No matching pending request.'); });
const stop = () => { void app.close(); };
terminal.on('close', () => app.pairing.disable()); terminal.on('SIGINT', stop);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
await app.closed;
terminal.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
