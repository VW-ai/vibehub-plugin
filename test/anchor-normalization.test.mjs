import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, room, run, tempRepo, writeRoom } from './helpers.mjs';

function fixture(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, 'project', 'init').status, 0);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs/a.md'), '# One\nfirst\n# Two\nsecond\n');
  return repo;
}
function put(repo, id, anchor) {
  return run(repo, 'room', 'put', room(id, { anchors: [anchor] }), ['--room', id]);
}

for (const [a, b] of [
  ['./docs', 'docs'], ['docs/', 'docs'], ['docs//./', './docs/'],
  ['./docs/a.md#one', 'docs/a.md#one'], ['docs', './docs/a.md#one'],
]) test(`normalised overlap ${a} / ${b} is rejected at write and validation, both orders`, () => {
  for (const [first, second] of [[a, b], [b, a]]) {
    const repo = fixture('anchor-collision');
    assert.equal(put(repo, 'first', first).status, 0);
    const rejected = put(repo, 'second', second);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /claim overlapping territory/);
    writeRoom(repo, 'second', room('second', { anchors: [second] }));
    const validated = run(repo, 'project', 'validate');
    assert.notEqual(validated.status, 0);
    assert.match(validated.stdout, /claim overlapping territory/);
  }
});

for (const anchor of ['.', './', '././', '#', '/', '///', '#one', '.#one',
  '../docs', 'docs/../docs', '/docs', 'C:/docs', 'docs\\a.md',
  '.vibehub', './.vibehub/tickets', '.vibehub/rooms/a/room.yaml#one',
  'docs/.vibehub/a.md', '.git', 'docs/.git/config']) {
  test(`invalid anchor ${anchor} fails at write and cannot hide in a hand-written Room`, () => {
    const repo = fixture('anchor-invalid');
    assert.equal(put(repo, 'docs', 'docs').status, 0);
    assert.notEqual(put(repo, 'invalid', anchor).status, 0);
    writeRoom(repo, 'invalid', room('invalid', { anchors: [anchor] }));
    for (const [domain, op] of [['project', 'validate'], ['context', 'coverage'], ['room', 'drift']]) {
      const result = run(repo, domain, op);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stdout, /anchors\[0\]/);
    }
  });
}

test('normalised prefixes and segment anchors reach canonical source IDs without merging disjoint segments', () => {
  const repo = fixture('anchor-coverage');
  assert.equal(put(repo, 'one', './docs//a.md#one').status, 0);
  assert.equal(put(repo, 'two', 'docs/./a.md#two').status, 0);
  const data = run(repo, 'context', 'coverage').envelope.data;
  assert.equal(data.segments_total, 2);
  assert.deepEqual(data.rooms.flatMap(r => r.files.flatMap(f => f.uncovered)).sort(), ['docs/a.md#one', 'docs/a.md#two']);
  assert.deepEqual(data.rooms.flatMap(r => r.unresolved_anchors), []);
  const prefixRepo = fixture('anchor-prefix');
  assert.equal(put(prefixRepo, 'docs', './docs//./').status, 0);
  assert.equal(run(prefixRepo, 'context', 'coverage').envelope.data.rooms[0].files[0].path, 'docs/a.md');
});

test('wider prefixes exclude nested VibeHub internals but retain similarly named source directories', () => {
  const repo = fixture('anchor-internals');
  for (const dir of ['.vibehub', '.git', '.vibehub-notes']) {
    mkdirSync(join(repo, 'docs', dir), { recursive: true });
    writeFileSync(join(repo, 'docs', dir, 'a.md'), '# Internal\ntext\n');
  }
  assert.equal(put(repo, 'docs', './docs').status, 0);
  const coverage = run(repo, 'context', 'coverage');
  assert.equal(coverage.status, 0, coverage.stdout);
  assert.deepEqual(coverage.envelope.data.rooms[0].files.map(f => f.path), ['docs/.vibehub-notes/a.md', 'docs/a.md']);
});

test('the complete checked-in Room set still validates', () => {
  const result = run(root, 'project', 'validate');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.envelope.data.valid, true);
  assert.equal(result.envelope.data.rooms, 6);
});

test('anchors below a symlink cannot absorb aliased VibeHub internal documents', () => {
  const repo = fixture('anchor-symlink');
  mkdirSync(join(repo, '.vibehub', 'evidence', 'probe'), { recursive: true });
  writeFileSync(join(repo, '.vibehub', 'evidence', 'probe', 'notes.md'), '# Internal\nnot source\n');
  symlinkSync(join(repo, '.vibehub', 'evidence'), join(repo, 'alias'));
  for (const anchor of ['alias/probe', 'alias/probe/notes.md', 'alias/probe/notes.md#internal']) {
    assert.equal(put(repo, 'alias', anchor).status, 0);
    const result = run(repo, 'context', 'coverage');
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.envelope.data.rooms[0].files, []);
    if (anchor.includes('#')) assert.deepEqual(result.envelope.data.rooms[0].unresolved_anchors, [anchor]);
  }
});

test('normalised anchors stamp canonical units and changing spelling alone preserves alignment', () => {
  for (const [alias, canonical, expectedKeys] of [
    ['./docs//.', 'docs', ['docs/a.md']],
    ['./docs/./a.md#one', 'docs/a.md#one', ['docs/a.md#one']],
  ]) {
    const repo = fixture('anchor-alignment');
    function git(...args) { execFileSync('git', ['-C', repo, ...args]); }
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Anchor Test');
    assert.equal(put(repo, 'docs', alias).status, 0);
    git('add', '.'); git('commit', '-qm', 'Source and Room');
    const aligned = run(repo, 'room', 'align', undefined, ['--room', 'docs']);
    assert.equal(aligned.status, 0, aligned.stdout);
    const path = join(repo, '.vibehub/rooms/docs/room.yaml');
    const document = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(document.alignment.anchor_hashes.map(item => item.path), expectedKeys);
    const before = run(repo, 'room', 'drift').envelope;
    document.anchors = [canonical];
    assert.equal(run(repo, 'room', 'put', document, ['--room', 'docs']).status, 0);
    assert.deepEqual(run(repo, 'room', 'drift').envelope, before);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).alignment, document.alignment);
  }
});
