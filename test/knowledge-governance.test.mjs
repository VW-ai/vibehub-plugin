import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const baseline = 'af131b5de868915ffef975cda0533eb1c30ea28e';
const segmentFingerprint = 'a8eedae6ddb8895b7330d729483d877992d63368f4d5b6e6c587ff6e61bb5622';
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));

function files(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const contexts = () => files('.vibehub/rooms')
  .filter(path => path.endsWith('.yaml') && !path.endsWith('/room.yaml')).map(read);

function retainedSegments(records) {
  const segments = new Set();
  for (const record of records) {
    for (const evidence of record.evidence) {
      const match = evidence.note.match(/^Source segment (docs\/[^;]+); lines (\d+)-(\d+)\./u);
      if (!match) continue;
      const path = match[1].slice(0, match[1].lastIndexOf('#'));
      assert.equal(evidence.ref, `commit:${baseline}:${path}`, 'section provenance must name its exact historical source');
      assert.ok(Number(match[2]) <= Number(match[3]));
      assert.ok(record.detail.length > 60, 'a citation needs a retained claim');
      assert.ok(evidence.note.length > match[0].length + 20, 'each section needs a finding or explained disposition');
      segments.add(match[1]);
    }
  }
  return [...segments].sort();
}

function assertRetention(records) {
  const segments = retainedSegments(records);
  assert.equal(segments.length, 171, 'a source section lost its Room provenance');
  assert.equal(new Set(segments.map(id => id.slice(0, id.lastIndexOf('#')))).size, 23);
  assert.equal(createHash('sha256').update(segments.join('\n')).digest('hex'), segmentFingerprint,
    'retention must match the original section set, not the now-empty docs directory');
  return segments;
}

test('all original prose sections remain traceable through curated Room Context', () => {
  assertRetention(contexts());
});

test('retention rejects a missing section even though no docs directory remains', () => {
  const records = contexts();
  const first = retainedSegments(records)[0];
  for (const record of records) {
    record.evidence = record.evidence.filter(item => !item.note.startsWith(`Source segment ${first};`));
  }
  assert.throws(() => assertRetention(records), /source section lost its Room provenance/u);
});

test('historical source commit resolves when full repository history is available', context => {
  const available = spawnSync('git', ['cat-file', '-e', `${baseline}^{commit}`], { cwd: root });
  if (available.status !== 0) {
    context.skip('Archive or shallow checkout: fetch the baseline af131b5de868915ffef975cda0533eb1c30ea28e to verify historical blobs; section retention still runs without Git.');
    return;
  }
  const paths = [...new Set(assertRetention(contexts()).map(id => id.slice(0, id.lastIndexOf('#'))))];
  const result = spawnSync('git', ['cat-file', '--batch-check=%(objecttype)'], {
    cwd: root, encoding: 'utf8', input: paths.map(path => `${baseline}:${path}`).join('\n') + '\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), paths.map(() => 'blob'));
});

test('current knowledge has no parallel docs tree or live reference to retired sources', () => {
  assert.equal(existsSync(join(root, 'docs')), false, 'put maintained prose in its owning Room');
  for (const path of files('.vibehub/tickets')) {
    if (!path.endsWith('.yaml')) continue;
    const ticket = read(path);
    if (ticket.status === 'done') continue;
    for (const ref of ticket.context_refs) assert.ok(!ref.ref.startsWith('docs/'), `${path}: ${ref.ref}`);
  }
  for (const path of files('.vibehub/rooms').filter(path => path.endsWith('/room.yaml'))) {
    assert.ok(read(path).anchors.every(anchor => !anchor.startsWith('docs/')), path);
  }
  const entrypoints = ['README.md', 'AGENTS.md', ...files('skills').filter(path => path.endsWith('.md'))];
  for (const path of entrypoints) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const [, href] of text.matchAll(/\]\(([^)]+)\)/gu)) {
      assert.ok(!/^(?:\.\/)?docs\//u.test(href), `${path}: retired document link ${href}`);
    }
  }
  for (const path of ['scripts/build-plugin-artifact.mjs', 'scripts/verify-plugin-artifact.mjs']) {
    assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /["']docs\//u, `${path}: retired artifact input`);
  }
});

test('moved historical images and executable proposals retain their exact bytes', () => {
  const moved = [...files('assets/screenshots').filter(path => /\.(?:png|jpg)$/u.test(path)), ...files('test/fixtures/ui-proposals')];
  assert.equal(moved.length, 24);
  const rows = moved.map(path => `${path}\0${createHash('sha256').update(readFileSync(join(root, path))).digest('hex')}`).sort();
  assert.equal(createHash('sha256').update(rows.join('\n')).digest('hex'), '2fb28e0f2769f3e8f03da45d9f348831b65f92c15745e3a14246d545abb1ec6c');
});
