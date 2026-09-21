import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, chmodSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  GitProvenance, createGitCommit, validateGitCommit, createGitCommitObservation,
  correlateGitCommitObservations, createRefMovement, validateRefMovement, assessGitClaimAfterMovement,
  normalizeRawEvent, sourceObjectKey,
} from '../src/index.mjs';
import { historyFixture, temporaryGitRepository } from './fixtures/git-provenance/repository.mjs';

const json = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const repository = format => ({ tenant_id: 'acme', repository_id: 'api', object_format: format ?? 'sha1' });
const adapter = (fixture, format) => new GitProvenance({ repository_path: fixture.repository_path, repository: repository(format) });
const object = oid => ({ kind: 'git_commit', ...repository(oid.length === 64 ? 'sha256' : 'sha1'), oid });
const ref = { ...repository(), name: 'refs/heads/main' };
const names = record => record.changed_paths.map(diff => diff.changes.map(change => Buffer.from(change.path_base64, 'base64').toString('utf8')));
function metadataSnapshot(repositoryPath) {
  return readdirSync(join(repositoryPath, '.git'), { recursive: true }).sort().map(path => {
    const absolute = join(repositoryPath, '.git', path);
    return [path, statSync(absolute).isFile() ? readFileSync(absolute).toString('base64') : null];
  });
}
function normalized(commit, observer = json('git-provenance/observers.json')[0], type = 'GIT_COMMIT', supports = [commit.object]) {
  const raw = json('event-provenance/git-observation.json');
  raw.event_id = observer.event_id; raw.idempotency_key = observer.event_id; raw.source_native_event_id = observer.source_native_event_id;
  raw.partition.source_installation_id = observer.installation; raw.producer.producer_id = observer.producer_id;
  raw.identity = { repository_id: commit.object.repository_id }; raw.provenance.delivery = { channel: observer.channel, delivery_id: observer.event_id };
  raw.provenance.source_objects = supports.map(object => ({ object, acl: raw.acl, sensitivity: 'normal' }));
  raw.payload = commit.kind === 'git_commit_record'
    ? { kind: 'git_revision', object: commit.object, path: null, digest: commit.raw_commit_digest }
    : { kind: 'mutable_pointer', pointer_id: 'unresolved-commit', digest: null };
  if (type === 'GIT_REF_CHANGED') raw.payload = { kind: 'mutable_pointer', pointer_id: 'ref-main', digest: null };
  const mapping = json('event-provenance/mapping.json'); mapping.event_types[raw.source_event_type] = type;
  const result = normalizeRawEvent(raw, { catalog: json('identity/multi-source.json'), mapping });
  assert.equal(result.status, 'normalized'); return result.event;
}
function move(api, before, after, operation = 'update', eventId = 'movement-1', refName = ref.name) {
  const supports = [...new Set([before, after].filter(Boolean))].map(object);
  const pointer = { kind: 'unresolved_git_commit', object: supports[0] };
  const observer = { ...json('git-provenance/observers.json')[2], event_id: eventId };
  return api.readRefMovement({ ref: refName, before_oid: before, after_oid: after,
    reported_operation: operation, event: normalized(pointer, observer, 'GIT_REF_CHANGED', supports) });
}

for (const format of ['sha1', 'sha256']) test(`real ${format} root, ordered merge parents and explicit changed-path bases`, t => {
  const fixture = historyFixture(format); t.after(fixture.cleanup); const api = adapter(fixture, format);
  const root = api.readCommit(fixture.root); const merge = api.readCommit(fixture.merge); const advance = api.readCommit(fixture.advance);
  assert.equal(validateGitCommit(root), true); assert.deepEqual(root.parent_oids, []);
  assert.deepEqual(merge.parent_oids, [fixture.advance, fixture.topic]);
  assert.deepEqual(merge.changed_paths.map(diff => diff.base.oid), merge.parent_oids);
  assert.equal(root.changed_paths[0].base.kind, 'empty_tree');
  assert.equal(root.tree_oid, fixture.git('rev-parse', `${fixture.root}^{tree}`));
  assert.deepEqual(root.author, { name_base64: Buffer.from('Synthetic Author').toString('base64'),
    email_base64: Buffer.from('author@example.invalid').toString('base64'), timestamp_seconds: 1735767245, timezone: '+0530' });
  assert.equal(root.committer.timezone, '-0700'); assert.equal(root.committer.timestamp_seconds, 1735902306);
  assert.equal(Buffer.from(root.message_base64, 'base64').toString(), 'root\n');
  assert.deepEqual(names(merge), [['topic.txt'], ['a.txt', 'delete.txt', 'rename-new.txt', 'rename-old.txt']]);
  for (const name of ['-dash.txt', 'tab\tname.txt', 'line\nname.txt']) assert.ok(names(root)[0].includes(name));
  const changes = advance.changed_paths[0].changes;
  assert.equal(changes.find(item => Buffer.from(item.path_base64, 'base64').toString() === 'delete.txt').status, 'D');
  assert.equal(changes.find(item => Buffer.from(item.path_base64, 'base64').toString() === 'rename-old.txt').status, 'D');
  assert.equal(changes.find(item => Buffer.from(item.path_base64, 'base64').toString() === 'rename-new.txt').status, 'A');
  assert.ok(Object.isFrozen(root.changed_paths[0].changes[0]));
});

test('deterministic fixture creates identical immutable commits and metadata in independent directories', t => {
  const left = historyFixture(); const right = historyFixture(); t.after(left.cleanup); t.after(right.cleanup);
  for (const key of ['root', 'advance', 'topic', 'merge', 'before_rebase', 'after_rebase']) assert.equal(left[key], right[key]);
  assert.deepEqual(adapter(left).readCommit(left.merge), adapter(right).readCommit(right.merge));
});

test('create, fast-forward, merge advance, rewind, delete, unchanged and divergent movements retain exact endpoints', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const api = adapter(fixture);
  for (const [before, after, classification] of [[null, fixture.root, 'create'], [fixture.root, fixture.advance, 'fast-forward'],
    [fixture.topic, fixture.merge, 'fast-forward'], [fixture.merge, fixture.root, 'rewind'], [fixture.merge, null, 'delete'],
    [fixture.root, fixture.root, 'unchanged'], [fixture.advance, fixture.topic, 'force']]) {
    const { movement } = move(api, before, after);
    assert.equal(validateRefMovement(movement), true); assert.equal(movement.classification, classification);
    assert.equal(movement.before?.oid ?? null, before); assert.equal(movement.after?.oid ?? null, after);
    assert.equal(movement.reported_operation, 'update');
  }
  assert.equal(move(api, fixture.root, fixture.advance, 'force_push').movement.classification, 'fast-forward');
  assert.equal(move(api, fixture.advance, fixture.topic).movement.reported_operation, 'update');
  assert.equal(move(api, fixture.root, fixture.advance, 'update', 'tag-1', 'refs/tags/v1').movement.classification, 'fast-forward');
  assert.equal(move(api, fixture.root, fixture.advance, 'update', 'pr-1', 'refs/pull/1/head').movement.classification, 'fast-forward');
});

test('real rebase and local bare force push retain old commits and only stale claims about the changed ref head', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const api = adapter(fixture);
  const before = api.readCommit(fixture.before_rebase); const after = api.readCommit(fixture.after_rebase);
  assert.notEqual(before.object.oid, after.object.oid); assert.deepEqual(before.parent_oids, [fixture.root]); assert.deepEqual(after.parent_oids, [fixture.merge]);
  const remote = join(fixture.directory, 'remote.git');
  execFileSync('git', ['init', '--bare', '--template=', remote], { env: fixture.env, stdio: 'ignore' });
  fixture.git('push', remote, `${fixture.before_rebase}:refs/heads/review`);
  fixture.git('push', '--force', remote, `${fixture.after_rebase}:refs/heads/review`);
  const rebase = move(api, fixture.before_rebase, fixture.after_rebase, 'rebase', 'rebase-1', 'refs/heads/rewritten').movement;
  const force = move(api, fixture.before_rebase, fixture.after_rebase, 'force_push', 'force-1', 'refs/heads/review').movement;
  assert.equal(rebase.classification, 'force'); assert.equal(force.reported_operation, 'force_push'); assert.notEqual(rebase.movement_id, force.movement_id);
  const historical = { claim_id: 'history', basis: { kind: 'exact_commit', object: before.object } };
  const moving = { claim_id: 'head', basis: { kind: 'ref_head', ref: force.ref, object: before.object } };
  const beforeInput = JSON.stringify({ before, force, moving });
  assert.equal(assessGitClaimAfterMovement(moving, force).status, 'stale');
  assert.equal(assessGitClaimAfterMovement(historical, force).status, 'unaffected');
  assert.equal(assessGitClaimAfterMovement({ ...moving, basis: { ...moving.basis, ref: rebase.ref } }, force).status, 'unaffected');
  assert.equal(assessGitClaimAfterMovement({ ...moving, basis: { ...moving.basis, object: after.object } }, force).status, 'unaffected');
  assert.equal(JSON.stringify({ before, force, moving }), beforeInput); assert.deepEqual(api.readCommit(fixture.before_rebase), before);
  const observations = [before, after].map((commit, i) => createGitCommitObservation({ commit,
    event: normalized(commit, { ...json('git-provenance/observers.json')[i], event_id: `rebase-commit-${i}` }) }));
  assert.equal(correlateGitCommitObservations(observations).length, 2);
});

test('four synthetic normalized observer paths correlate one real commit with distinct scoped provenance', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const commit = adapter(fixture).readCommit(fixture.merge);
  const observations = json('git-provenance/observers.json').map(observer => createGitCommitObservation({ commit, event: normalized(commit, observer) }));
  const groups = correlateGitCommitObservations([...observations, observations[0]]);
  assert.equal(groups.length, 1); assert.equal(groups[0].object_key, sourceObjectKey(commit.object));
  assert.equal(groups[0].observation_refs.length, 4);
  assert.deepEqual(groups[0].observations.map(item => item.event.provenance.delivery.channel), ['local_git', 'fetch', 'push', 'pull_request']);
  assert.equal(new Set(groups[0].observations.map(item => item.observation_key)).size, 4);
  assert.ok(groups[0].observations.every(item => item.event.kind === 'normalized_event' && item.event.effective_access.allowed_principal_ids.includes('alice')));
  const changed = structuredClone(observations[0]); changed.event_digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => correlateGitCommitObservations([changed]), /pins mismatch/);
  const conflict = structuredClone(commit); conflict.message_base64 = Buffer.from('changed').toString('base64');
  assert.throws(() => correlateGitCommitObservations([observations[0], createGitCommitObservation({ commit: conflict,
    event: normalized(conflict, json('git-provenance/observers.json')[1]) })]), /content conflict/);
});

test('missing, shallow, garbage-collected and non-commit objects remain explicit unresolved pointers', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const api = adapter(fixture);
  const missing = api.readCommit('e'.repeat(40)); assert.equal(missing.kind, 'unresolved_git_commit');
  assert.equal(missing.reason, 'object_unavailable'); assert.equal(api.readCommit(fixture.git('rev-parse', `${fixture.root}^{tree}`)).reason, 'not_commit');
  const shallow = join(fixture.directory, 'shallow');
  execFileSync('git', ['clone', '--depth=1', '--branch=rewritten', '--no-local', `file://${fixture.repository_path}`, shallow], { env: fixture.env, stdio: 'ignore' });
  const shallowApi = new GitProvenance({ repository_path: shallow, repository: repository() });
  const shallowCommit = shallowApi.readCommit(fixture.after_rebase);
  assert.deepEqual(shallowCommit.parent_oids, [fixture.merge]); assert.equal(shallowCommit.changed_paths[0].reason, 'base_unavailable');
  assert.equal(shallowApi.readCommit(fixture.merge).kind, 'unresolved_git_commit');
  assert.equal(move(shallowApi, fixture.before_rebase, fixture.after_rebase).movement.classification, 'unknown');
  const before = api.readCommit(fixture.before_rebase); fixture.git('reflog', 'expire', '--expire=now', '--all'); fixture.git('gc', '--prune=now');
  const gone = api.readCommit(fixture.before_rebase); assert.equal(gone.kind, 'unresolved_git_commit');
  const first = createGitCommitObservation({ commit: before, event: normalized(before) });
  const later = createGitCommitObservation({ commit: gone, event: normalized(gone, json('git-provenance/observers.json')[1]) });
  const group = correlateGitCommitObservations([first, later])[0]; assert.equal(group.content.object.oid, before.object.oid);
  assert.equal(group.observations[1].commit.kind, 'unresolved_git_commit'); assert.equal(group.observations[0].commit.kind, 'git_commit_record');
});

test('bounded ancestry degrades to unknown rather than fabricating a complete graph', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const api = adapter(fixture);
  const ancestry = api.readAncestry({ oids: [fixture.merge], max_commits: 1 });
  assert.equal(ancestry.truncated, true); assert.equal(ancestry.commits.length, 1);
  const event = normalized({ kind: 'unresolved_git_commit', object: object(fixture.root) }, json('git-provenance/observers.json')[2],
    'GIT_REF_CHANGED', [object(fixture.root), object(fixture.merge)]);
  const movement = createRefMovement({ ref, before: object(fixture.root), after: object(fixture.merge), commits: ancestry.commits, reported_operation: 'update', event });
  assert.equal(movement.classification, 'unknown');
  assert.throws(() => api.readAncestry({ oids: [fixture.merge], max_commits: 0 }), /budget/);
});

test('path bytes survive invalid UTF-8 and Gitlink changes survive repository diff configuration', t => {
  const fixture = temporaryGitRepository(); t.after(fixture.cleanup); const api = adapter(fixture);
  fixture.write('a', 'one'); const root = fixture.commit('root'); const blob = fixture.git('rev-parse', `${root}:a`);
  const filename = Buffer.from([0x62, 0x69, 0x6e, 0x2d, 0xff]);
  const input = Buffer.concat([Buffer.from(`100644 ${blob}\t`), filename, Buffer.from(`\0`)]);
  execFileSync('git', ['-C', fixture.repository_path, 'update-index', '-z', '--index-info'], { input, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  fixture.git('update-index', '--add', '--cacheinfo', `160000,${root},vendor`);
  fixture.git('commit', '-m', 'raw-path-and-gitlink'); const head = fixture.git('rev-parse', 'HEAD');
  fixture.git('config', 'diff.ignoreSubmodules', 'all'); fixture.git('config', 'diff.relative', 'true');
  fixture.git('config', 'diff.orderFile', '/nonexistent/runtime-must-ignore-orderfile');
  const commit = api.readCommit(head); assert.equal(commit.kind, 'git_commit_record');
  assert.ok(commit.changed_paths[0].changes.some(change => change.path_base64 === filename.toString('base64')));
  const gitlink = commit.changed_paths[0].changes.find(change => Buffer.from(change.path_base64, 'base64').toString() === 'vendor');
  assert.equal(gitlink.new_mode, '160000'); assert.equal(gitlink.new_oid, root);
});

test('missing tree is an unresolved diff rather than an empty changed-path list', t => {
  const fixture = temporaryGitRepository(); t.after(fixture.cleanup);
  fixture.write('file', 'content'); const head = fixture.commit('root'); const api = adapter(fixture);
  const tree = api.readCommit(head).tree_oid;
  rmSync(join(fixture.repository_path, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
  const record = api.readCommit(head); assert.equal(record.kind, 'git_commit_record');
  assert.equal(record.changed_paths[0].status, 'unresolved'); assert.equal(record.changed_paths[0].reason, 'tree_unavailable');
});

test('partial-clone missing objects cannot trigger a local transport or write objects even when protocol.file.allow=always', t => {
  const source = temporaryGitRepository(); const target = temporaryGitRepository(); t.after(source.cleanup); t.after(target.cleanup);
  source.write('file', 'synthetic content'); const head = source.commit('root');
  target.git('config', 'extensions.partialClone', 'origin'); target.git('config', 'remote.origin.promisor', 'true');
  target.git('config', 'remote.origin.url', source.repository_path); target.git('config', 'protocol.file.allow', 'always');
  const snapshot = () => metadataSnapshot(target.repository_path);
  const before = snapshot(); const api = adapter(target);
  assert.equal(api.readCommit(head).kind, 'unresolved_git_commit');
  assert.equal(api.readAncestry({ oids: [head] }).unresolved[0].reason, 'object_unavailable');
  assert.deepEqual(snapshot(), before, 'read attempts must leave the entire repository metadata byte-identical');
  // Install only the commit body. Its referenced tree is still missing and must
  // not cause diff-tree to perform a promisor fetch either.
  const body = execFileSync('git', ['-C', source.repository_path, 'cat-file', 'commit', head], { env: source.env });
  const copied = execFileSync('git', ['-C', target.repository_path, 'hash-object', '-t', 'commit', '-w', '--stdin'], { env: target.env, input: body, encoding: 'utf8' }).trim();
  assert.equal(copied, head); const beforeDiff = snapshot(); const record = api.readCommit(head);
  assert.equal(record.kind, 'git_commit_record'); assert.equal(record.changed_paths[0].status, 'unresolved');
  assert.deepEqual(snapshot(), beforeDiff, 'missing tree reads must not populate objects or write fetch metadata');
  for (const [type, oid] of [['tree', source.git('rev-parse', `${head}^{tree}`)], ['blob', source.git('rev-parse', `${head}:file`)]]) {
    const bytes = execFileSync('git', ['-C', source.repository_path, 'cat-file', type, oid], { env: source.env });
    execFileSync('git', ['-C', target.repository_path, 'hash-object', '-t', type, '-w', '--stdin'], { env: target.env, input: bytes });
  }
  const beforeAvailable = snapshot(); assert.equal(api.readCommit(head).changed_paths[0].status, 'resolved');
  assert.deepEqual(snapshot(), beforeAvailable, 'locally available partial-clone objects must also remain read-only');
});

test('partial-clone missing objects cannot invoke a configured remote helper even with per-protocol allow', t => {
  const fixture = temporaryGitRepository(); t.after(fixture.cleanup);
  const marker = join(fixture.directory, 'helper-invoked'); const helper = join(fixture.directory, 'git-remote-runtimefixture');
  writeFileSync(helper, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected helper execution');\nprocess.exit(1);\n`);
  chmodSync(helper, 0o755);
  fixture.git('config', 'extensions.partialClone', 'origin'); fixture.git('config', 'remote.origin.promisor', 'true');
  fixture.git('config', 'remote.origin.url', 'runtimefixture::synthetic'); fixture.git('config', 'protocol.runtimefixture.allow', 'always');
  const before = metadataSnapshot(fixture.repository_path);
  const previousPath = process.env.PATH; process.env.PATH = `${fixture.directory}:${previousPath}`;
  try {
    const record = adapter(fixture).readCommit('a'.repeat(40)); assert.equal(record.kind, 'unresolved_git_commit');
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  assert.equal(existsSync(marker), false, 'transport helper must not be invoked');
  assert.deepEqual(metadataSnapshot(fixture.repository_path), before);
});

test('valid Git trees with over-budget path bytes preserve commit metadata with an unresolved diff', t => {
  const fixture = temporaryGitRepository(); t.after(fixture.cleanup);
  const git = (args, input) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', fixture.repository_path, ...args],
    { env: fixture.env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const blob = git(['hash-object', '-w', '--stdin'], 'synthetic');
  let tree = git(['mktree'], `100644 blob ${blob}\tleaf\n`);
  for (let i = 0; i < 21; i++) tree = git(['mktree'], `040000 tree ${tree}\t${'x'.repeat(200)}\n`);
  const oid = git(['commit-tree', tree], 'deep path\n'); const before = metadataSnapshot(fixture.repository_path);
  const record = adapter(fixture).readCommit(oid);
  assert.equal(record.kind, 'git_commit_record'); assert.equal(record.object.oid, oid); assert.equal(record.tree_oid, tree);
  assert.equal(record.changed_paths[0].status, 'unresolved'); assert.equal(record.changed_paths[0].reason, 'limit_exceeded');
  assert.deepEqual(record.changed_paths[0].changes, []); assert.deepEqual(metadataSnapshot(fixture.repository_path), before);
});

test('read adapter ignores replacement refs and ambient Git routing/config and leaves repository state unchanged', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const api = adapter(fixture);
  const original = api.readCommit(fixture.root); fixture.git('replace', fixture.root, fixture.advance);
  mkdirSync(join(fixture.repository_path, '.git', 'info'), { recursive: true });
  writeFileSync(join(fixture.repository_path, '.git', 'info', 'grafts'), `${fixture.root} ${fixture.advance}\n`);
  const before = fixture.git('show-ref'); const status = fixture.git('status', '--porcelain');
  const config = readFileSync(join(fixture.repository_path, '.git', 'config'));
  const ambient = process.env.GIT_DIR; process.env.GIT_DIR = '/this/must/not/be/read';
  try { assert.deepEqual(api.readCommit(fixture.root), original); } finally { if (ambient === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = ambient; }
  assert.equal(fixture.git('show-ref'), before); assert.equal(fixture.git('status', '--porcelain'), status);
  assert.deepEqual(readFileSync(join(fixture.repository_path, '.git', 'config')), config);
  assert.throws(() => api.readCommit('HEAD'), /full lowercase OID/); assert.throws(() => api.readCommit('--help'), /full lowercase OID/);
  assert.throws(() => new GitProvenance({ repository_path: '.', repository: repository() }), /absolute/);
  assert.throws(() => new GitProvenance({ repository_path: fixture.repository_path, repository: repository('sha256') }), /format mismatch/);
});

test('strict validators reject malformed content, altered pins, scope mismatch and accessors without evaluating them', t => {
  const fixture = historyFixture(); t.after(fixture.cleanup); const api = adapter(fixture); const record = api.readCommit(fixture.merge);
  const alterations = [v => delete v.tree_oid, v => v.parent_oids.reverse(), v => v.parent_oids.push(v.parent_oids[0]),
    v => v.changed_paths[0].base.oid = '0'.repeat(40), v => v.changed_paths[0].changes[0].path_base64 = '!!',
    v => v.changed_paths[0].status = 'unresolved', v => v.author.timestamp_seconds = NaN, v => v.extra = true];
  for (const alter of alterations) { const value = structuredClone(record); alter(value); assert.throws(() => validateGitCommit(value), TypeError); }
  let evaluated = false; const input = {}; Object.defineProperty(input, 'object', { enumerable: true, get() { evaluated = true; return record.object; } });
  assert.throws(() => createGitCommit(input), /data properties/); assert.equal(evaluated, false);
  assert.throws(() => createGitCommitObservation({ commit: record, event: { ...normalized(record), event_type: 'AGENT_MESSAGE' } }), TypeError);
  const movement = move(api, fixture.root, fixture.merge).movement;
  for (const alter of [v => v.classification = 'force', v => v.event_digest = `sha256:${'a'.repeat(64)}`, v => v.ref.repository_id = 'web']) {
    const value = structuredClone(movement); alter(value); assert.throws(() => validateRefMovement(value), TypeError);
  }
  assert.throws(() => createRefMovement({ ref, before: object(fixture.root), after: object(fixture.merge), commits: [], reported_operation: 'rebase',
    event: normalized(record) }), /scope\/type/);
});
