import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterVibeHub, parseStartFlags, personalStoreFromConfig, reusableDashboard } from '../skills/vibehub-core/scripts/vh-start.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vibehub-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('entering VibeHub opens the built-in home before repository initialization', async (t) => {
  const repoRoot = fixture(t), opened = [];
  const session = await enterVibeHub({ repoRoot, openUrl: (url) => opened.push(url) });
  t.after(() => session.handle.close());
  assert.equal(session.reused, false);
  assert.deepEqual(opened, [session.url]);
  assert.ok(session.url.includes('/dashboard#'));
  const response = await fetch(`${session.origin}/api/dashboard`, { headers: { Authorization: `Bearer ${session.handle.token}` } });
  const home = await response.json();
  assert.equal(home.ok, true);
  assert.deepEqual(home.data.roots, [repoRoot]);
  assert.deepEqual(home.data.projects, []);
});

test('a known live dashboard is reused without another browser tab or host', async (t) => {
  const repoRoot = fixture(t), opened = [];
  const first = await enterVibeHub({ repoRoot, openUrl: (url) => opened.push(url) });
  t.after(() => first.handle.close());
  const again = await enterVibeHub({ repoRoot, reuseUrl: first.url, openUrl: (url) => opened.push(url) });
  assert.equal(again.reused, true);
  assert.equal(again.handle, null);
  assert.equal(again.url, first.url);
  assert.equal(opened.length, 1);
});

test('an expired session is replaced and can still be suppressed by the host', async (t) => {
  const repoRoot = fixture(t), opened = [];
  const old = await enterVibeHub({ repoRoot, open: false });
  await old.handle.close();
  const replacement = await enterVibeHub({ repoRoot, reuseUrl: old.url, open: false, openUrl: (url) => opened.push(url) });
  t.after(() => replacement.handle.close());
  assert.equal(replacement.reused, false);
  assert.notEqual(replacement.url, old.url);
  assert.deepEqual(opened, []);
});

test('reuse requires the requested source scope and the exact capability', async (t) => {
  const repoRoot = fixture(t), other = fixture(t);
  const session = await enterVibeHub({ repoRoot, open: false });
  t.after(() => session.handle.close());
  assert.equal(await reusableDashboard(session.url, { repoRoot: other }), null);
  assert.equal(await reusableDashboard(session.url, { repoRoot, roots: [other] }), null);
  assert.equal(await reusableDashboard(session.url, { repoRoot, personalStore: other }), null);
  const wrongToken = session.url.replace(/#[a-f0-9]+$/, `#${'0'.repeat(64)}`);
  assert.equal(await reusableDashboard(wrongToken, { repoRoot }), null);
  for (const url of ['https://example.com/dashboard#secret', 'http://127.0.0.1:1/#bad', 'file:///tmp/dashboard', 'http://user:pass@127.0.0.1:1/#' + 'a'.repeat(64)]) {
    assert.equal(await reusableDashboard(url, { repoRoot }), null);
  }
});

test('personal goals use the existing configuration pointer without creating settings', (t) => {
  const root = fixture(t), config = join(root, 'config.yaml');
  assert.deepEqual(personalStoreFromConfig(config), { path: null, warning: null });
  writeFileSync(config, JSON.stringify({ kind: 'personal_hub_config', data_root: root }));
  assert.deepEqual(personalStoreFromConfig(config), { path: root, warning: null });
  writeFileSync(config, 'broken');
  assert.equal(personalStoreFromConfig(config).path, null);
  assert.match(personalStoreFromConfig(config).warning, /not connected/);
});

test('session entry accepts selected roots and a live URL without requiring a dashboard mode', () => {
  const flags = parseStartFlags(['--repo', '/tmp/current', '--root', '/tmp/projects', '--reuse-url', 'http://127.0.0.1:1234/#token', '--no-open', '--json']);
  assert.equal(flags.repo, '/tmp/current');
  assert.deepEqual(flags.roots, ['/tmp/projects']);
  assert.equal(flags.open, false);
  assert.equal(flags.json, true);
  assert.throws(() => parseStartFlags(['--reuse-url']), /requires/);
});

test('every user-facing Skill enters the same dashboard contract; internal agents do not', () => {
  const root = new URL('../skills/', import.meta.url);
  const graph = JSON.parse(readFileSync(new URL('vibehub-core/contracts/skill-graph.json', root), 'utf8'));
  for (const skill of graph.skills) {
    const source = readFileSync(new URL(`${skill.name}/SKILL.md`, root), 'utf8');
    if (skill.entry === 'user') {
      assert.match(source, /contracts\/session-entry\.md/, `${skill.name} has no automatic dashboard entry`);
      assert.match(source, /Subagents reuse the parent's entry/);
    } else assert.doesNotMatch(source, /## Automatic dashboard entry/);
  }
  const lifecycle = JSON.parse(readFileSync(new URL('vibehub-review/references/ticket-lifecycle.json', root), 'utf8'));
  assert.equal(lifecycle.resource_policy.on_user_entry, 'open-unified-dashboard');
  assert.equal(lifecycle.resource_policy.entry_failure, 'continue-in-conversation');
});
