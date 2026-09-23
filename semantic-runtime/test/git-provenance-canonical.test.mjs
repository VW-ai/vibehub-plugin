import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, lstatSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { GitProvenance, GIT_SELECTED_READ_LIMITS as L } from '../src/adapters/git/git-provenance.mjs';
import { temporaryGitRepository, historyFixture } from './fixtures/git-provenance/repository.mjs';

const digest = b => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const repository = format => ({ tenant_id: 'synthetic', repository_id: 'selected', object_format: format });
const adapter = (f, format = 'sha1') => new GitProvenance({ repository_path: f.repository_path, repository: repository(format), object_directory: realpathSync(join(f.repository_path, '.git', 'objects')) });
function fixture(t, format = 'sha1') { const f = temporaryGitRepository(format); t.after(f.cleanup); return f; }
function object(f, type, raw, format = 'sha1', forceOid) {
  const body = Buffer.concat([Buffer.from(`${type} ${raw.length}\0`), raw]), oid = forceOid ?? createHash(format).update(body).digest('hex');
  const dir = join(f.repository_path, '.git', 'objects', oid.slice(0, 2)); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, oid.slice(2)), deflateSync(body)); return oid;
}
function commit(f, tree, parents = [], format = 'sha1') {
  return object(f, 'commit', Buffer.from(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author Synthetic <synthetic@example.invalid> 1000 +0000\ncommitter Synthetic <synthetic@example.invalid> 1000 +0000\n\nselected fixture\n`), format);
}
const treeEntry = (name, oid, mode = '100644') => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
function metadata(f) {
  const root = join(f.repository_path, '.git'); return readdirSync(root, { recursive: true }).sort().map(p => {
    const path = join(root, p), stat = lstatSync(path); return [p, stat.isFile() ? digest(readFileSync(path)) : stat.isSymbolicLink() ? 'symlink' : 'directory'];
  });
}
for (const format of ['sha1', 'sha256']) test(`selected ${format} raw commit/tree/blob hashes, exact bytes and shared cache`, t => {
  const f = fixture(t, format); mkdirSync(join(f.repository_path, 'records')); f.write('records/context.yaml', '{"kind":"context"}\n'); const oid = f.commit('selected');
  const api = adapter(f, format), result = api.readFileAtCommit({ commit_oid: oid, path: 'records/context.yaml' });
  assert.equal(result.status, 'resolved'); assert.equal(result.bytes.toString(), '{"kind":"context"}\n'); assert.equal(result.content_digest, digest(result.bytes));
  assert.equal(result.entry.oid, f.git('rev-parse', `${oid}:records/context.yaml`)); assert.equal(result.entry.size, result.bytes.length);
  assert.equal(result.raw_commit_digest, digest(execFileSync('git', ['cat-file', 'commit', oid], { cwd: f.repository_path, env: f.env })));
  assert.equal(result.tree_chain.length, 2); assert.equal(result.tree_oid, result.tree_chain[0].oid);
  for (const tree of result.tree_chain) assert.equal(tree.digest, digest(execFileSync('git', ['cat-file', 'tree', tree.oid], { cwd: f.repository_path, env: f.env })));
  const before = api.metrics(); assert.equal(before.commands, 12); assert.equal(before.blobs_read, 1);
  result.bytes.fill(0); result.tree_chain[0].oid = 'bad'; const repeated = api.readFileAtCommit({ commit_oid: oid, path: 'records/context.yaml' });
  assert.equal(repeated.bytes.toString(), '{"kind":"context"}\n'); assert.deepEqual(api.metrics(), before);
  const entry = api.readEntryAtCommit({ commit_oid: oid, path: 'records/context.yaml' }); assert.equal(entry.status, 'resolved'); assert.equal(entry.bytes, null); assert.equal(entry.content_digest, null);
  assert.equal(new GitProvenance({ repository_path: f.repository_path, repository: repository(format) }).readFileAtCommit({ commit_oid: oid, path: 'records/context.yaml' }).status, 'resolved');
});

test('1000 unrelated files add no selected object reads, commands, or recursive source scan', t => {
  const f = fixture(t); mkdirSync(join(f.repository_path, 'selected')); f.write('selected/record.json', '{}\n'); const first = f.commit('small');
  const left = adapter(f); assert.equal(left.readFileAtCommit({ commit_oid: first, path: 'selected/record.json' }).status, 'resolved');
  mkdirSync(join(f.repository_path, 'unrelated')); for (let n = 0; n < 1000; n++) f.write(`unrelated/file-${n}`, `unrelated ${n}`); const next = f.commit('wide');
  const right = adapter(f); assert.equal(right.readFileAtCommit({ commit_oid: next, path: 'selected/record.json' }).status, 'resolved');
  assert.equal(right.metrics().commands, left.metrics().commands); assert.equal(right.metrics().blobs_read, 1); assert.equal(right.metrics().trees_read, 2); assert.equal(right.metrics().selected_paths, 1);
});

test('verified absence is distinct from missing commit/tree/blob and unsupported link/directory entries', t => {
  const f = fixture(t); f.write('regular.json', '{}'); const first = f.commit('initial'); symlinkSync('regular.json', join(f.repository_path, 'symlink'));
  f.git('add', 'symlink'); f.git('update-index', '--add', '--cacheinfo', `160000,${first},gitlink`); f.git('commit', '-m', 'links'); const oid = f.git('rev-parse', 'HEAD'), api = adapter(f);
  for (const path of ['gone.json', 'regular.json/child']) { const absent = api.readFileAtCommit({ commit_oid: oid, path }); assert.equal(absent.status, 'absent'); assert(absent.raw_commit_digest); assert.equal(absent.entry, null); assert.equal(absent.bytes, null); }
  for (const path of ['symlink', 'symlink/child', 'gitlink']) assert.equal(api.readFileAtCommit({ commit_oid: oid, path }).status, 'unsupported');
  assert.equal(api.readFileAtCommit({ commit_oid: 'f'.repeat(40), path: 'regular.json' }).status, 'unavailable');
  const missing = 'e'.repeat(40), missingTree = commit(f, missing), noTree = adapter(f).readFileAtCommit({ commit_oid: missingTree, path: 'record.json' });
  assert.equal(noTree.status, 'unavailable'); assert(noTree.raw_commit_digest); assert.deepEqual(noTree.tree_chain, []);
  const tree = object(f, 'tree', treeEntry('record.json', missing)), noBlobCommit = commit(f, tree);
  for (const method of ['readFileAtCommit', 'readEntryAtCommit']) { const noBlob = adapter(f)[method]({ commit_oid: noBlobCommit, path: 'record.json' }); assert.equal(noBlob.status, 'unavailable'); assert.equal(noBlob.entry.oid, missing); }
  const directoryTree = object(f, 'tree', treeEntry('dir', tree, '40000')), directoryCommit = commit(f, directoryTree);
  assert.equal(adapter(f).readEntryAtCommit({ commit_oid: directoryCommit, path: 'dir' }).status, 'unsupported');
});

test('raw hash mismatch, compressed corruption and malformed tree cannot masquerade as absent', t => {
  const f = fixture(t); const blob = object(f, 'blob', Buffer.from('{}')), tree = object(f, 'tree', treeEntry('record.json', blob)), oid = commit(f, tree);
  object(f, 'blob', Buffer.from('[]'), 'sha1', blob); const bad = adapter(f).readFileAtCommit({ commit_oid: oid, path: 'record.json' });
  assert.equal(bad.status, 'unsupported'); assert.equal(bad.reason, 'object_hash_mismatch'); assert.equal(bad.bytes, null);
  writeFileSync(join(f.repository_path, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), Buffer.from('broken compressed object'));
  assert.equal(adapter(f).readFileAtCommit({ commit_oid: oid, path: 'record.json' }).status, 'unavailable');
  const duplicate = object(f, 'tree', Buffer.concat([treeEntry('same', tree), treeEntry('same', tree)])), malformed = commit(f, duplicate);
  assert.equal(adapter(f).readFileAtCommit({ commit_oid: malformed, path: 'missing' }).status, 'unsupported');
});

test('large artifact availability reads metadata only; record and aggregate caps never truncate', t => {
  const f = fixture(t); f.write('huge.js', 'x'.repeat(2 * 1024 * 1024)); const text = 'r'.repeat(L.record_bytes);
  for (let i = 0; i < 5; i++) f.write(`record-${i}.json`, text); const oid = f.commit('large artifacts'); const api = adapter(f);
  const entry = api.readEntryAtCommit({ commit_oid: oid, path: 'huge.js' }); assert.equal(entry.status, 'resolved'); assert.equal(entry.entry.size, 2 * 1024 * 1024); assert.equal(api.metrics().blobs_read, 0);
  const tooLarge = api.readFileAtCommit({ commit_oid: oid, path: 'huge.js' }); assert.equal(tooLarge.reason, 'limit_exceeded'); assert.equal(tooLarge.bytes, null); assert.equal(api.metrics().blobs_read, 0);
  for (let i = 0; i < 4; i++) assert.equal(api.readFileAtCommit({ commit_oid: oid, path: `record-${i}.json` }).status, 'resolved');
  assert.equal(api.readFileAtCommit({ commit_oid: oid, path: 'record-4.json' }).reason, 'limit_exceeded');
  assert.equal(api.metrics().record_bytes, L.total_record_bytes); assert.equal(api.metrics().blobs_read, 1); // Same content cached; each selected record counts against response budget.
});

test('tree/raw aggregate and selected-path budgets are shared across the whole instance', t => {
  const f = fixture(t), blob = object(f, 'blob', Buffer.from('{}'));
  const tree = object(f, 'tree', Buffer.concat(Array.from({ length: 23000 }, (_, i) => treeEntry(`entry-${String(i).padStart(8, '0')}`, blob))));
  const tooWide = commit(f, object(f, 'tree', Buffer.concat([treeEntry('record.json', blob), Buffer.alloc(L.tree_bytes)])));
  assert.equal(adapter(f).readFileAtCommit({ commit_oid: tooWide, path: 'record.json' }).reason, 'limit_exceeded');
  const api = adapter(f); for (let i = 0; i < 5; i++) {
    const uniqueTree = object(f, 'tree', Buffer.concat([treeEntry(`a${i}`, blob), readRawTree(f, tree)])), oid = commit(f, uniqueTree);
    const result = api.readEntryAtCommit({ commit_oid: oid, path: `a${i}` }); assert.equal(result.status, i < 4 ? 'resolved' : 'unsupported');
    if (i === 4) assert.equal(result.reason, 'limit_exceeded');
  }
  assert(api.metrics().raw_object_bytes <= L.raw_object_bytes);
  f.write('file', '{}'); const oid = f.commit('paths'), paths = adapter(f);
  for (let i = 0; i < 32; i++) assert.equal(paths.readEntryAtCommit({ commit_oid: oid, path: `absent-${i}` }).status, 'absent');
  assert.equal(paths.readEntryAtCommit({ commit_oid: oid, path: 'too-many' }).reason, 'limit_exceeded');
  assert.equal(paths.metrics().selected_paths, 32);
});
function readRawTree(f, oid) { return execFileSync('git', ['cat-file', 'tree', oid], { cwd: f.repository_path, env: f.env, maxBuffer: L.tree_bytes }); }

test('ancestor proof uses verified raw commit links without parent diffs and denies unknown history', t => {
  const f = historyFixture(); t.after(f.cleanup); const api = adapter(f);
  assert.equal(api.proveDescendant({ ancestor_oid: f.root, descendant_oid: f.root }).status, 'same');
  assert.equal(api.proveDescendant({ ancestor_oid: f.root, descendant_oid: f.merge }).status, 'descendant');
  assert.equal(api.proveDescendant({ ancestor_oid: f.merge, descendant_oid: f.root }).status, 'not_descendant');
  assert.equal(api.proveDescendant({ ancestor_oid: f.topic, descendant_oid: f.advance }).status, 'not_descendant');
  assert.equal(api.metrics().trees_read, 0); assert.equal(api.metrics().blobs_read, 0);
  const broken = commit(f, 'c'.repeat(40), ['e'.repeat(40)]); assert.equal(api.proveDescendant({ ancestor_oid: f.root, descendant_oid: broken }).status, 'unavailable');
  let chain = f.root; for (let i = 0; i < 50; i++) chain = commit(f, 'c'.repeat(40), [chain]);
  const bounded = adapter(f); assert.equal(bounded.proveDescendant({ ancestor_oid: f.root, descendant_oid: chain }).reason, 'limit_exceeded'); assert.equal(bounded.metrics().commands, 128);
  assert.equal(bounded.readEntryAtCommit({ commit_oid: f.root, path: 'a.txt' }).reason, 'limit_exceeded');
  const retainedOnly = 'd'.repeat(40), current = commit(f, 'c'.repeat(40), [retainedOnly]), noAncestorExpansion = adapter(f);
  assert.equal(noAncestorExpansion.proveDescendant({ ancestor_oid: retainedOnly, descendant_oid: current }).status, 'descendant');
  assert.equal(noAncestorExpansion.metrics().commits_read, 1);
});

test('packed/GC objects stay read-only, and trusted entry never loads hostile source config/helpers', t => {
  const f = fixture(t); f.write('record.json', '{}'); const oid = f.commit('source'); f.git('gc', '--prune=now');
  const marker = join(f.directory, 'helper-marker'), fifo = join(f.directory, 'blocked-include'); execFileSync('mkfifo', [fifo]);
  writeFileSync(join(f.repository_path, '.git', 'config'), `[core]\nrepositoryformatversion=0\nfsmonitor = touch ${marker}\n[include]\npath=${fifo}\n[extensions]\npartialclone=evil\n[remote "evil"]\npromisor=true\nurl=ext::touch ${marker}\n[protocol "ext"]\nallow=always\n`);
  const before = metadata(f), api = adapter(f), read = api.readFileAtCommit({ commit_oid: oid, path: 'record.json' }); assert.equal(read.status, 'resolved');
  assert.equal(api.readFileAtCommit({ commit_oid: 'f'.repeat(40), path: 'record.json' }).status, 'unavailable'); assert.deepEqual(metadata(f), before);
  assert.equal(readdirSync(f.directory).includes('helper-marker'), false);
  // GC a deliberately unreachable selected commit under restored synthetic config, never a user source.
  writeFileSync(join(f.repository_path, '.git', 'config'), '[core]\nrepositoryformatversion=0\n');
  const orphan = commit(f, object(f, 'tree', treeEntry('gone.json', object(f, 'blob', Buffer.from('orphan')))));
  assert.equal(adapter(f).readFileAtCommit({ commit_oid: orphan, path: 'gone.json' }).status, 'resolved'); f.git('prune', '--expire=now');
  assert.equal(adapter(f).readFileAtCommit({ commit_oid: orphan, path: 'gone.json' }).status, 'unavailable'); assert.equal(read.bytes.toString(), '{}');
});

test('unsafe object-store indirection and inert-invalid requests fail without selected I/O', t => {
  const f = fixture(t); f.write('record.json', '{}'); const oid = f.commit('source'), api = adapter(f); let traps = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
  assert.throws(() => api.readFileAtCommit(proxy)); assert.throws(() => api.proveDescendant(proxy));
  assert.throws(() => api.readFileAtCommit({ commit_oid: proxy, path: 'record.json' }));
  assert.throws(() => api.readFileAtCommit({ get commit_oid() { traps++; return oid; }, path: 'record.json' }));
  for (const path of ['/absolute', '../escape', 'a//b', 'x\0y', 'a\\b', Array(17).fill('a').join('/'), '\ud800']) assert.throws(() => api.readFileAtCommit({ commit_oid: oid, path }));
  assert.equal(traps, 0); assert.equal(api.metrics().commands, 0);
  const objects = join(f.repository_path, '.git', 'objects'); mkdirSync(join(objects, 'info'), { recursive: true }); writeFileSync(join(objects, 'info', 'alternates'), '/outside\n');
  assert.throws(() => adapter(f), { reason: 'unsupported_object_store' }); rmSync(join(objects, 'info', 'alternates'));
  assert.equal(api.readEntryAtCommit({ commit_oid: oid, path: 'record.json' }).status, 'resolved');
  const blob = f.git('rev-parse', `${oid}:record.json`), loose = join(objects, blob.slice(0, 2), blob.slice(2)), outside = join(f.directory, 'outside-object');
  writeFileSync(outside, readFileSync(loose)); rmSync(loose); symlinkSync(outside, loose);
  assert.equal(adapter(f).readFileAtCommit({ commit_oid: oid, path: 'record.json' }).reason, 'unsupported_object_store');
  assert.equal(api.readFileAtCommit({ commit_oid: oid, path: 'record.json' }).reason, 'unsupported_object_store');
});

test('trusted commit guard fences cached results and denied intermediate ancestry without reopening anchor', t => {
  const f = fixture(t); f.write('record.json', '{}'); const anchor = f.commit('anchor'); f.write('record.json', '[]'); const middle = f.commit('middle'); f.write('record.json', 'null'); const tip = f.commit('tip');
  const construct = authorize_commit => new GitProvenance({ repository_path: f.repository_path, repository: repository('sha1'),
    object_directory: realpathSync(join(f.repository_path, '.git', 'objects')), authorize_commit });
  let allowed = false; const api = construct(() => allowed);
  const denied = api.readFileAtCommit({ commit_oid: tip, path: 'record.json' }); assert.equal(denied.reason, 'access_denied'); assert.equal(api.metrics().commands, 0);
  allowed = true; assert.equal(api.readFileAtCommit({ commit_oid: tip, path: 'record.json' }).bytes.toString(), 'null'); const count = api.metrics().commands;
  allowed = false; const cached = api.readFileAtCommit({ commit_oid: tip, path: 'record.json' }); assert.equal(cached.reason, 'access_denied'); assert.equal(cached.bytes, null); assert.deepEqual(cached.tree_chain, []); assert.equal(api.metrics().commands, count);
  let afterBlob; afterBlob = construct(() => afterBlob.metrics().blobs_read === 0); const lastGate = afterBlob.readFileAtCommit({ commit_oid: tip, path: 'record.json' });
  assert.equal(lastGate.reason, 'access_denied'); assert.equal(lastGate.content_digest, null); assert.equal(lastGate.entry, null);
  const guarded = []; const ancestry = construct(o => { guarded.push(o.oid); return o.oid !== middle && o.oid !== anchor; });
  assert.equal(ancestry.proveDescendant({ ancestor_oid: anchor, descendant_oid: tip }).reason, 'access_denied'); assert(!guarded.includes(anchor)); assert.equal(ancestry.metrics().commits_read, 1);
  const direct = construct(o => o.oid !== middle); assert.equal(direct.proveDescendant({ ancestor_oid: middle, descendant_oid: tip }).status, 'descendant');
  const asyncGuard = construct(() => Promise.resolve(true)); assert.equal(asyncGuard.readFileAtCommit({ commit_oid: tip, path: 'record.json' }).reason, 'access_denied'); assert.equal(asyncGuard.metrics().commands, 0);
});

test('raw selected commit and tree hash mismatches never provide absence proof', t => {
  const f = fixture(t), blob = object(f, 'blob', Buffer.from('{}')), originalTree = object(f, 'tree', treeEntry('record.json', blob)), oid = commit(f, originalTree);
  object(f, 'tree', treeEntry('different.json', blob), 'sha1', originalTree);
  const treeMismatch = adapter(f).readFileAtCommit({ commit_oid: oid, path: 'record.json' }); assert.equal(treeMismatch.reason, 'object_hash_mismatch'); assert.notEqual(treeMismatch.status, 'absent');
  const raw = execFileSync('git', ['cat-file', 'commit', oid], { cwd: f.repository_path, env: f.env }); object(f, 'commit', Buffer.concat([raw, Buffer.from('changed')]), 'sha1', oid);
  const commitMismatch = adapter(f).readFileAtCommit({ commit_oid: oid, path: 'record.json' }); assert.equal(commitMismatch.reason, 'object_hash_mismatch'); assert.equal(commitMismatch.raw_commit_digest, null);
});

test('injected cumulative Git-I/O clock exhaustion denies even the final completed subprocess', t => {
  const f = fixture(t); f.write('record.json', '{}'); const oid = f.commit('clock fixture'), before = metadata(f);
  // Actual Git is used; only elapsed time is injected in an isolated child to avoid a 30-second sleep.
  const script = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { performance } from 'node:perf_hooks';
    const original = cp.execFileSync, options = []; let elapsed = 0;
    cp.execFileSync = (...args) => { options.push({timeout:args[2].timeout,killSignal:args[2].killSignal}); return original(...args); };
    syncBuiltinESMExports(); Object.defineProperty(performance, 'now', {value:() => (elapsed += 6001)});
    const { GitProvenance } = await import(${JSON.stringify(new URL('../src/adapters/git/git-provenance.mjs', import.meta.url).href)});
    const api = new GitProvenance(${JSON.stringify({ repository_path: f.repository_path, repository: repository('sha1'), object_directory: realpathSync(join(f.repository_path, '.git', 'objects')) })});
    const result = api.readFileAtCommit({commit_oid:${JSON.stringify(oid)},path:'record.json'});
    assert.equal(result.reason, 'limit_exceeded'); assert.equal(result.bytes, null); assert.equal(api.metrics().commands, 5);
    assert(options.every(o => o.timeout <= 10000 && o.killSignal === 'SIGKILL')); assert(options.at(-1).timeout < 6000);
    process.stdout.write('bounded');
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' }), 'bounded');
  assert.deepEqual(metadata(f), before);
});
