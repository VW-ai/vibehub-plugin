import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GitProvenance, createGitCommitObservation, correlateGitCommitObservations,
  normalizeRawEvent, sourceObjectKey, eventObservationKey, verifyEventPayload,
  createSourceCursor, acceptSourceEvent, completeSourceEvent, projectFreshness,
  assessGitClaimAfterMovement,
} from '../../src/index.mjs';

const fixture = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const options = {
  catalog: fixture('../fixtures/identity/multi-source.json'),
  mapping: fixture('../fixtures/event-provenance/mapping.json'),
};

function repositoryFixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'runtime-public-git-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, LANG: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Synthetic Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    GIT_AUTHOR_DATE: '2026-09-21T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-21T10:00:00Z',
  };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
      cwd: path, env, maxBuffer: 2 * 1024 * 1024, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    return result.stdout;
  };
  git('init', '--object-format=sha1', '--initial-branch=main');
  writeFileSync(join(path, 'context.txt'), 'original context\n');
  git('add', '--', 'context.txt'); git('commit', '-m', 'root');
  const before = git('rev-parse', 'HEAD').toString().trim();
  writeFileSync(join(path, 'context.txt'), 'revised context\n');
  git('add', '--', 'context.txt'); git('commit', '-m', 'revision');
  const after = git('rev-parse', 'HEAD').toString().trim();
  const bytes = git('cat-file', 'commit', after);
  return { path, before, after, bytes,
    payloadDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

test('public Git provenance feeds normalized source cursors without conflating commit and observation identity', t => {
  const repo = repositoryFixture(t);
  const adapter = new GitProvenance({ repository_path: repo.path,
    repository: { tenant_id: 'acme', repository_id: 'api', object_format: 'sha1' } });
  const root = adapter.readCommit(repo.before);
  const commit = adapter.readCommit(repo.after);
  assert.equal(root.kind, 'git_commit_record');
  assert.deepEqual(root.parent_oids, []);
  assert.deepEqual(commit.parent_oids, [repo.before]);
  assert.equal(commit.raw_commit_digest, repo.payloadDigest);
  const events = ['local_git', 'fetch', 'push', 'pull_request'].map((channel, index) => {
    const raw = fixture('../fixtures/event-provenance/git-observation.json');
    raw.event_id = `git-${channel}`; raw.idempotency_key = `retry-${channel}`;
    raw.source_native_event_id = `native-${channel}`;
    raw.producer.sequence = index;
    raw.provenance.delivery = { channel, delivery_id: `delivery-${channel}` };
    raw.payload = { kind: 'git_revision', object: commit.object, path: null, digest: commit.raw_commit_digest };
    raw.provenance.source_objects[0].object = commit.object;
    return normalizeRawEvent(raw, options).event;
  });
  const observations = events.map(event => createGitCommitObservation({ commit, event }));
  const groups = correlateGitCommitObservations([...observations, observations[0]]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].observation_refs.length, 4);
  assert.equal(groups[0].object_key, sourceObjectKey(commit.object));
  assert.equal(new Set(events.map(eventObservationKey)).size, 4);
  assert.equal(verifyEventPayload(events[0].payload, repo.bytes), true);
  assert.throws(() => verifyEventPayload(events[0].payload, Buffer.from('substituted content')));

  const source = { partition: events[0].partition,
    producer: { producer_id: events[0].producer.producer_id, epoch: events[0].producer.epoch } };
  let cursor = createSourceCursor({ ...source, start_sequence: 0 });
  for (const event of events) {
    cursor = acceptSourceEvent(cursor, event).state;
    cursor = completeSourceEvent(cursor, { event_id: event.event_id, completed_parents: [] });
  }
  assert.equal(cursor.completed_through, 3);
  assert.equal(projectFreshness({ scope: { tenant_id: 'acme', project_id: 'product' }, cursors: [cursor],
    requirements: [{ source, target_sequence: 3 }] }).status, 'caught-up');

  const refRaw = fixture('../fixtures/event-provenance/git-observation.json');
  refRaw.event_id = 'ref-movement'; refRaw.idempotency_key = 'retry-ref-movement';
  refRaw.source_event_type = 'git.ref.changed'; refRaw.producer.sequence = 4;
  refRaw.payload = { kind: 'mutable_pointer', pointer_id: 'refs/heads/main', digest: null };
  const support = refRaw.provenance.source_objects[0];
  refRaw.provenance.source_objects = [root, commit].map(record => ({ ...support, object: record.object }));
  const mapping = { ...options.mapping, event_types: {
    ...options.mapping.event_types, 'git.ref.changed': 'GIT_REF_CHANGED',
  } };
  const event = normalizeRawEvent(refRaw, { ...options, mapping }).event;
  const { movement, unresolved, truncated } = adapter.readRefMovement({ ref: 'refs/heads/main',
    before_oid: repo.before, after_oid: repo.after, reported_operation: 'update', event });
  assert.equal(movement.classification, 'fast-forward');
  assert.deepEqual(unresolved, []); assert.equal(truncated, false);
  assert.equal(assessGitClaimAfterMovement({ claim_id: 'moving-claim',
    basis: { kind: 'ref_head', ref: movement.ref, object: root.object } }, movement).status, 'stale');
  assert.equal(assessGitClaimAfterMovement({ claim_id: 'historical-claim',
    basis: { kind: 'exact_commit', object: root.object } }, movement).status, 'unaffected');
  assert.deepEqual(adapter.readCommit(repo.before), root);
  assert.notEqual(sourceObjectKey(commit.object), sourceObjectKey({ ...commit.object, repository_id: 'api-fork' }));
});
