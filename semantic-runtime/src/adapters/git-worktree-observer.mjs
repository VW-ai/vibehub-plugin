import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, stat, realpath, mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { GIT_SENSOR_LIMITS as L, sensorAssert as check, sensorError } from '../core/git-worktree-observation.mjs';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const physical = s => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const b64 = bytes => bytes.toString('base64');
const baseEnv = () => ({ PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1' });
const fixed = ['--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false', '-c', 'core.filemode=true', '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all'];
function parts(buf) { check(!buf.length || buf.at(-1) === 0, 'capture_failed'); return buf.length ? buf.subarray(0, -1).toString('latin1').split('\0').map(x => Buffer.from(x, 'latin1')) : []; }
function safePath(bytes) {
  check(bytes.length > 0 && bytes.length <= L.path_bytes && !bytes.includes(0) && bytes[0] !== 47, 'unsupported_profile');
  check(bytes.toString('latin1').split('/').every(x => x && x !== '.' && x !== '..' && !x.includes('\\')), 'unsupported_profile'); return bytes;
}
async function boundedFile(path, limit, optional = false) {
  let handle;
  try {
    // A source metadata FIFO must not wait for a writer before the type/deadline checks.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const s = await handle.stat({ bigint: true });
    check(s.isFile(), 'unsupported_profile'); check(s.size <= BigInt(limit), 'capture_limit'); const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    check(offset <= limit, 'capture_limit'); const after = await handle.stat({ bigint: true });
    check(s.size === after.size && s.mtimeNs === after.mtimeNs && s.ctimeNs === after.ctimeNs, 'unstable_capture'); return buffer.subarray(0, offset);
  } catch (e) { if (optional && e.code === 'ENOENT') return null; if (e.code === 'ELOOP') throw sensorError('unsupported_profile'); throw e; }
  finally { await handle?.close(); }
}
async function directory(path) { const s = await lstat(path, { bigint: true }); check(s.isDirectory() && !s.isSymbolicLink() && await realpath(path) === path, 'membership_gap'); return physical(s); }

/** Internal trusted adapter. onPhase is a test-only capability, never a client option. */
export async function observeGitWorktree({ checkout, worktree, guard, signal, onPhase }) {
  const started = performance.now(), deadline = started + L.sample_ms, metrics = { commands: 0, bytes: 0, duration_ms: 0, samples: 0 };
  let trackedPaths = [];
  async function checkTrackedPaths() {
    for (const path of trackedPaths) {
      gate(); let current = Buffer.from(worktree.path); const pieces = path.toString('latin1').split('/');
      for (let i = 0; i < pieces.length; i++) {
        current = Buffer.concat([current, Buffer.from('/'), Buffer.from(pieces[i], 'latin1')]);
        let entry; try { entry = await lstat(current); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break; throw e; }
        if (i < pieces.length - 1) check(entry.isDirectory() && !entry.isSymbolicLink(), 'unsupported_profile');
        else check(entry.mtimeMs >= 1000, 'unsupported_profile');
      }
    }
  }
  const gate = () => { check(!signal?.aborted, 'capture_cancelled'); check(performance.now() < deadline, 'capture_timeout'); guard(); };
  const phase = async name => { gate(); if (onPhase) await onPhase(name); gate(); };
  const run = async (args, { scratch, input, allowed = [0] } = {}) => {
    gate(); if (scratch && ['diff', 'check-attr', 'ls-files'].includes(args[0])) await checkTrackedPaths(); metrics.commands++;
    check(scratch, 'capture_failed'); // Every Git invocation uses only our configuration.
    const prefix = [`--git-dir=${scratch}`, `--work-tree=${worktree.path}`];
    const env = { ...baseEnv(), ...(scratch ? { HOME: scratch, XDG_CONFIG_HOME: scratch, GIT_DIR: scratch,
      GIT_WORK_TREE: worktree.path, GIT_INDEX_FILE: join(scratch, 'index'), GIT_OBJECT_DIRECTORY: join(checkout.common_dir, 'objects') } : {}) };
    const result = await new Promise((resolveResult, reject) => {
      let finished = false, total = 0, stdout = [], stderr = [], failure;
      const child = spawn('git', [...fixed, ...prefix, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stop = code => { if (!failure) failure = sensorError(code); child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('capture_timeout'), Math.max(1, Math.min(L.command_ms, deadline - performance.now())));
      const abort = () => stop('capture_cancelled'); signal?.addEventListener('abort', abort, { once: true });
      const accept = list => chunk => { total += chunk.length; metrics.bytes += chunk.length; if (total > L.command_bytes) stop('capture_limit'); else list.push(chunk); };
      child.stdout.on('data', accept(stdout)); child.stderr.on('data', accept(stderr));
      child.on('error', () => { failure = sensorError('capture_failed'); });
      child.on('close', status => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        const bytes = Buffer.concat(stdout); stdout = []; stderr = [];
        if (failure) reject(failure); else if (!allowed.includes(status)) reject(sensorError('capture_failed')); else resolveResult({ bytes, status }); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
    gate(); return result;
  };
  async function pins(scratch) {
    gate(); const common = await directory(checkout.common_dir), admin = await directory(worktree.git_dir), root = await directory(worktree.path);
    check(common === checkout.common_identity && admin === worktree.identity, 'membership_gap');
    const dotgit = join(worktree.path, '.git'), dotstat = await lstat(dotgit);
    if (dotstat.isDirectory()) check(await realpath(dotgit) === worktree.git_dir, 'membership_gap');
    else { const text = await boundedFile(dotgit, 8192); check(text && /^gitdir: [^\0\r\n]+\n?$/.test(text.toString()), 'membership_gap');
      check(await realpath(resolve(worktree.path, text.toString().slice(8).trim())) === worktree.git_dir, 'membership_gap'); }
    if (worktree.git_dir !== checkout.common_dir) {
      const link = await boundedFile(join(worktree.git_dir, 'commondir'), 8192); check(link && await realpath(resolve(worktree.git_dir, link.toString().trim())) === checkout.common_dir, 'membership_gap');
    }
    const configs = [], settings = new Map();
    for (const name of [join(checkout.common_dir, 'config'), join(worktree.git_dir, 'config.worktree')]) {
      const bytes = await boundedFile(name, 65536, true); configs.push(bytes ? hash(bytes) : null); if (!bytes) continue;
      // Parse the captured bytes from scratch with includes disabled. Never discover/load the source repo config.
      const copied = join(scratch, 'inspection-config'); await writeFile(copied, bytes);
      const config = (await run(['config', '--file', copied, '--no-includes', '--null', '--list'], { scratch })).bytes;
      for (const entry of parts(config)) { const text = entry.toString(), newline = text.indexOf('\n'), key = text.slice(0, newline < 0 ? text.length : newline).toLowerCase(), val = text.slice(newline + 1).toLowerCase();
        check(!/^include(?:if\.|\.)|^filter\.|^core\.attributesfile$|^core\.sparsecheckout|^extensions\.sparseindex$/.test(key), 'unsupported_profile');
        check(!(key === 'core.autocrlf' && !['false', 'no', '0'].includes(val)) && !['core.eol', 'core.checkroundtripencoding'].includes(key), 'unsupported_profile');
        check(!key.startsWith('extensions.') || ['extensions.objectformat', 'extensions.worktreeconfig', 'extensions.partialclone'].includes(key), 'unsupported_profile');
        if (name === join(checkout.common_dir, 'config')) settings.set(key, val);
      }
    }
    const format = settings.get('extensions.objectformat') ?? 'sha1';
    check(['sha1', 'sha256'].includes(format) && ['0', '1'].includes(settings.get('core.repositoryformatversion'))
      && (format !== 'sha256' || settings.get('core.repositoryformatversion') === '1'), 'unsupported_profile');
    const width = format === 'sha1' ? 40 : 64, parseOid = bytes => { const oid = bytes.toString().replace(/\n$/, '');
      check(new RegExp(`^[a-f0-9]{${width}}$`).test(oid), 'unsupported_profile'); return oid; };
    const headBytes = await boundedFile(join(worktree.git_dir, 'HEAD'), 8192); let branch = null, oid;
    if (headBytes.subarray(0, 5).toString() === 'ref: ') {
      branch = headBytes.subarray(5); if (branch.at(-1) === 10) branch = branch.subarray(0, -1); safePath(branch);
      check(branch.subarray(0, 11).toString() === 'refs/heads/' && ![...branch].some(b => b <= 32 || b === 127), 'unsupported_profile');
      let current = Buffer.from(checkout.common_dir), absent = false; const fragments = branch.toString('latin1').split('/');
      for (let i = 0; i < fragments.length - 1; i++) { current = Buffer.concat([current, Buffer.from('/'), Buffer.from(fragments[i], 'latin1')]);
        try { const s = await lstat(current); check(s.isDirectory() && !s.isSymbolicLink(), 'unsupported_profile'); }
        catch (e) { if (e.code === 'ENOENT') { absent = true; break; } throw e; } }
      const loose = absent ? null : await boundedFile(Buffer.concat([current, Buffer.from('/'), Buffer.from(fragments.at(-1), 'latin1')]), 8192, true);
      oid = loose ? parseOid(loose) : null;
      if (!loose) { const packed = await boundedFile(join(checkout.common_dir, 'packed-refs'), L.command_bytes, true);
        for (const line of (packed?.toString('latin1') ?? '').split('\n')) {
          if (!line || line.startsWith('#') || line.startsWith('^')) continue;
          const space = line.indexOf(' '); check(space === width, 'unsupported_profile');
          if (Buffer.from(line.slice(space + 1), 'latin1').equals(branch)) { check(oid === null, 'unsupported_profile'); oid = parseOid(Buffer.from(line.slice(0, space))); }
        }
      }
    } else oid = parseOid(headBytes);
    const index = await boundedFile(join(worktree.git_dir, 'index'), L.index_bytes, true);
    if (index) check(index.length >= 12 && index.subarray(0, 4).toString() === 'DIRC' && [2, 3, 4].includes(index.readUInt32BE(4)), 'unsupported_profile');
    const objectStat = await lstat(join(checkout.common_dir, 'objects')); check(objectStat.isDirectory() && !objectStat.isSymbolicLink(), 'unsupported_profile');
    for (const dir of [join(checkout.common_dir, 'info'), join(checkout.common_dir, 'objects', 'info')]) {
      try { const s = await lstat(dir); check(s.isDirectory() && !s.isSymbolicLink(), 'unsupported_profile'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    for (const path of [join(checkout.common_dir, 'info', 'attributes'), join(checkout.common_dir, 'objects', 'info', 'alternates')]) {
      const bytes = await boundedFile(path, 65536, true); check(bytes === null || bytes.length === 0, 'unsupported_profile'); }
    gate(); return { physical: { common, admin, worktree: root }, head: { state: oid === null ? 'unborn' : branch ? 'branch' : 'detached', object_format: format, oid, branch_base64: branch ? b64(branch) : null },
      index, signature: JSON.stringify({ common, admin, root, head: hash(headBytes), oid, format, index: index ? hash(index) : null, configs }) };
  }
  async function untrackedStat(path) {
    safePath(path); const fragments = path.toString('latin1').split('/'); let current = Buffer.from(worktree.path);
    for (let i = 0; i < fragments.length; i++) { current = Buffer.concat([current, Buffer.from('/'), Buffer.from(fragments[i], 'latin1')]); const s = await lstat(current);
      if (i < fragments.length - 1) check(s.isDirectory() && !s.isSymbolicLink(), 'unsupported_profile');
      else { check(s.isFile() || s.isSymbolicLink(), 'unsupported_profile'); return { path_base64: b64(path), kind: s.isSymbolicLink() ? 'symlink' : 'file', size: s.size, mode: s.mode }; } }
  }
  async function sample() {
    metrics.samples++; trackedPaths = []; let scratch;
    try {
      scratch = await mkdtemp(join(tmpdir(), 'vh-git-observe-')); await mkdir(join(scratch, 'objects')); await mkdir(join(scratch, 'refs')); await mkdir(join(scratch, 'info'));
      await writeFile(join(scratch, 'HEAD'), 'ref: refs/heads/bootstrap\n');
      await writeFile(join(scratch, 'config'), '[core]\nrepositoryformatversion=0\nbare=false\n');
      const before = await pins(scratch); await phase('after-index');
      await writeFile(join(scratch, 'HEAD'), before.head.oid ? before.head.oid + '\n' : 'ref: refs/heads/unborn\n');
      await writeFile(join(scratch, 'config'), `[core]\nrepositoryformatversion=${before.head.object_format === 'sha256' ? 1 : 0}\nbare=false\n${before.head.object_format === 'sha256' ? '[extensions]\nobjectformat=sha256\n' : ''}`);
      if (before.index) {
        await writeFile(join(scratch, 'index'), before.index);
        // Nonzero ancient index mtime forces Git racy-entry byte verification; copying with today's
        // timestamp can otherwise hide same-size edits whose cached stat still matches.
        await utimes(join(scratch, 'index'), 1, 1);
      }
      const shared = await run(['rev-parse', '--shared-index-path'], { scratch, allowed: [0, 128] });
      check(shared.status === 0 && shared.bytes.toString().trim() === '', 'unsupported_profile');
      if (before.head.oid) check((await run(['cat-file', '-t', before.head.oid], { scratch })).bytes.toString().trim() === 'commit', 'capture_failed');
      // A copied index may otherwise hide real edits through assume-unchanged/skip-worktree.
      for (const flag of parts((await run(['ls-files', '-v', '-f', '-z'], { scratch })).bytes)) {
        check(flag.length > 2 && flag[1] === 32 && flag[0] !== 83 && !(flag[0] >= 97 && flag[0] <= 122), 'unsupported_profile');
      }
      const entries = parts((await run(['ls-files', '--stage', '-z'], { scratch })).bytes), tracked = [], unmerged = [];
      for (const entry of entries) { const tab = entry.indexOf(9); check(tab > 0, 'capture_failed'); const m = /^(\d{6}) ([a-f0-9]+) ([0-3])$/.exec(entry.subarray(0, tab).toString()); check(m && m[1] !== '040000', 'unsupported_profile');
        const path = safePath(entry.subarray(tab + 1)); tracked.push(path); if (m[3] !== '0') unmerged.push({ path_base64: b64(path), mode: m[1], oid: m[2], stage: Number(m[3]) }); }
      trackedPaths = tracked; await checkTrackedPaths();
      const attrInput = Buffer.concat(tracked.flatMap(p => [p, Buffer.from([0])]));
      const attributes = async () => {
        const result = (await run(['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding', 'text', 'eol', 'ident'], { scratch, input: attrInput })).bytes;
        const tokens = parts(result); check(tokens.length % 3 === 0, 'capture_failed');
        for (let i = 2; i < tokens.length; i += 3) check(['unspecified', 'unset'].includes(tokens[i].toString()), 'unsupported_profile'); return hash(result);
      };
      const attrs = await attributes(); await phase('after-profile');
      const overrides = '* -filter -working-tree-encoding -text -ident\n'; await writeFile(join(scratch, 'info', 'attributes'), overrides);
      const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', '--no-color', '--no-relative', '--no-indent-heuristic', '--diff-algorithm=myers', '-O/dev/null'];
      async function plane(cached) {
        const prefix = ['diff', ...(cached ? ['--cached', '--ignore-submodules=none'] : ['--ignore-submodules=all']), ...diffFlags]; const raw = parts((await run([...prefix, '--raw', '-z', '--no-abbrev', '--'], { scratch })).bytes);
        check(raw.length % 2 === 0, 'capture_failed'); const changes = [];
        for (let i = 0; i < raw.length; i += 2) { const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMTU])$/.exec(raw[i].toString()); check(match, 'capture_failed');
          const path = safePath(raw[i + 1]); changes.push({ path_base64: b64(path), status: match[5], old_mode: match[1], new_mode: match[2], old_oid: /^0+$/.test(match[3]) ? null : match[3], new_oid: /^0+$/.test(match[4]) ? null : match[4], binary: 'unknown' }); }
        check(changes.length <= L.paths, 'capture_limit');
        const stats = parts((await run([...prefix, '--numstat', '-z', '--'], { scratch })).bytes);
        for (const entry of stats) { const first = entry.indexOf(9), second = entry.indexOf(9, first + 1); check(first > 0 && second > first, 'capture_failed');
          const match = changes.find(c => c.path_base64 === b64(entry.subarray(second + 1))); if (match) match.binary = entry.subarray(0, first).toString() === '-' ? 'yes' : 'no'; }
        const bytes = (await run([...prefix, '--patch', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--'], { scratch })).bytes;
        return { digest: hash(bytes), rename_detection: 'disabled', changes };
      }
      const staged = await plane(true), unstaged = await plane(false);
      // Repository .gitignore rules only; no global/info exclude files or submodule recursion.
      const paths = parts((await run(['ls-files', '--others', '--exclude-standard', '-z'], { scratch })).bytes);
      check(staged.changes.length + unstaged.changes.length + unmerged.length + paths.length <= L.paths, 'capture_limit');
      const untracked = []; for (const path of paths) { gate(); untracked.push(await untrackedStat(path)); }
      await phase('after-content'); await writeFile(join(scratch, 'info', 'attributes'), ''); check(await attributes() === attrs, 'unstable_capture');
      const after = await pins(scratch); check(before.signature === after.signature, 'unstable_capture'); await phase('after-pass');
      return { physical: before.physical, head: before.head, index_digest: before.index ? hash(before.index) : null, staged, unstaged, unmerged, untracked, submodule_worktrees: 'not_observed' };
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
  try {
    let prior;
    // Two complete equal observations establish only endpoint consistency. One extra pass may settle a detected edit.
    for (let attempt = 0; attempt < 3; attempt++) {
      let next; try { next = await sample(); } catch (e) { if (e.code !== 'unstable_capture' || attempt === 2) throw e; prior = undefined; continue; }
      if (prior && JSON.stringify(prior) === JSON.stringify(next)) { metrics.duration_ms = performance.now() - started; gate(); return { observation: next, metrics }; }
      prior = next;
    }
    throw sensorError('unstable_capture');
  } catch (e) { throw sensorError(['membership_gap', 'unsupported_profile', 'capture_limit', 'capture_timeout', 'capture_cancelled', 'unstable_capture', 'sensor_unauthorized', 'source_changed', 'project_disabled', 'stale_activation_epoch', 'source_access_denied'].includes(e?.code) ? e.code : 'capture_failed'); }
}
