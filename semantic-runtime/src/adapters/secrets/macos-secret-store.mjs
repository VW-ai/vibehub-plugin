import { spawn } from 'node:child_process';
import { mkdir, readFile, access, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const failure = code => Object.assign(new Error(`Secure store: ${code}`), { code });
const source = fileURLToPath(new URL('./keychain-helper.swift', import.meta.url));
const validRef = ref => typeof ref === 'string' && /^vhcred_[a-f0-9]{64}$/.test(ref);

function processCall(command, args, input, readSecret = false, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    // Minimal child environment: no inherited provider credentials or DYLD hooks.
    const child = spawn(command, args, { env: { PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR ?? '/tmp' },
      stdio: ['pipe', 'pipe', 'ignore', readSecret ? 'pipe' : 'ignore'] });
    const output = [], secret = []; let size = 0, secretSize = 0, invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 1024) { invalid = true; child.kill('SIGKILL'); } else output.push(chunk); });
    child.stdio[3]?.on('data', chunk => { secretSize += chunk.length; if (secretSize > 8192) { invalid = true; child.kill('SIGKILL'); } else secret.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(failure('secure_store_unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || invalid) { for (const chunk of secret) chunk.fill(0); reject(failure('secure_store_unavailable')); return; }
      resolve({ output: Buffer.concat(output).toString('utf8'), secret: Buffer.concat(secret) });
      for (const chunk of secret) chunk.fill(0);
    });
    child.stdin.end(input);
  });
}

export class MacOSSecretStore {
  #binary; #prepare;
  constructor({ buildDir = fileURLToPath(new URL('../../../.local/keychain/', import.meta.url)) } = {}) {
    this.#prepare = async () => {
      if (process.platform !== 'darwin') throw failure('secure_store_unsupported');
      const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0, 16);
      await mkdir(buildDir, { recursive: true, mode: 0o700 });
      const binary = join(buildDir, `keychain-${hash}`);
      try { await access(binary); }
      catch {
        await processCall('/usr/bin/swiftc', ['-O', source, '-o', binary, '-module-cache-path', join(buildDir, 'module-cache')], '', false, 60_000);
        await chmod(binary, 0o700);
      }
      return binary;
    };
  }
  async #call(operation, reference, secret) {
    if (!validRef(reference)) throw failure('invalid_credential_reference');
    if (operation === 'put' && (typeof secret !== 'string' || !secret.length || Buffer.byteLength(secret) > 8192 || /[\r\n\0]/.test(secret))) throw failure('invalid_credential');
    try {
      this.#binary ??= this.#prepare().catch(error => { this.#binary = undefined; throw error; });
      const result = await processCall(await this.#binary, [], JSON.stringify({ operation, reference, ...(secret === undefined ? {} : { secret }) }), operation === 'read');
      const response = JSON.parse(result.output);
      if (!['configured', 'missing'].includes(response.state)) { result.secret.fill(0); throw failure('secure_store_unavailable'); }
      return { state: response.state, secret: result.secret };
    } catch { throw failure('secure_store_unavailable'); }
  }
  async put(ref, secret) { const result = await this.#call('put', ref, secret); if (result.state !== 'configured') throw failure('secure_store_unavailable'); }
  async remove(ref) { await this.#call('remove', ref); }
  async status(ref) { const result = await this.#call('status', ref); return result.state; }
  async use(ref, operation) {
    if (typeof operation !== 'function') throw failure('invalid_operation');
    const result = await this.#call('read', ref);
    try {
      if (result.state === 'missing') throw failure('credential_missing');
      return await operation(result.secret.toString('utf8'));
    } catch (error) {
      throw failure(error?.code === 'credential_missing' ? 'credential_missing'
        : [401, 403].includes(error?.statusCode ?? error?.status) ? 'credential_rejected' : 'credential_operation_failed');
    } finally { result.secret.fill(0); }
  }
}
