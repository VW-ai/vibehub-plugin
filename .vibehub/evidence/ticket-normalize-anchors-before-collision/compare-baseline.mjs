// Run from the repository root. Baseline code and current code inspect the same
// frozen scratch checkout, so edits to anchored implementation files cannot
// masquerade as changes in the meaning of anchors. No writes to the real repo.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const repo = resolve(process.argv[2] || '.');
const baseline = 'c192a4705fa09a174a86197bc99a1022c950502b';
const scratch = mkdtempSync(join(tmpdir(), 'vh-anchor-parity-'));
const frozen = join(scratch, 'repo');
execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', repo, frozen]);
function git(...args) { return execFileSync('git', ['-C', frozen, ...args], { encoding: 'utf8' }).trim(); }
git('checkout', '--quiet', '--detach', baseline);
const currentDir = join(scratch, 'current');
cpSync(join(repo, 'skills/vibehub-core'), currentDir, { recursive: true });
const oldTool = join(frozen, 'skills/vibehub-core/scripts/vh.mjs');
const newTool = join(currentDir, 'scripts/vh.mjs');
function run(tool, ...args) { return JSON.parse(execFileSync(process.execPath, [tool, ...args, '--repo', frozen], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 })); }
for (const args of [['project', 'validate'], ['room', 'drift'], ['context', 'coverage']]) {
  assert.deepEqual(run(newTool, ...args), run(oldTool, ...args));
  console.log(`${args.join(' ')}: identical on all checked-in Rooms`);
}
const rooms = JSON.parse(execFileSync('git', ['-C', repo, 'show', `${baseline}:.vibehub/rooms/knowledge/room.yaml`], { encoding: 'utf8' }));
assert.ok(rooms.anchors.length);
const list = git('ls-files', '.vibehub/rooms/**/room.yaml').split('\n');
for (const path of list) {
  const roomPath = path.slice('.vibehub/rooms/'.length, -'/room.yaml'.length);
  const before = readFileSync(join(frozen, path), 'utf8');
  run(oldTool, 'room', 'align', '--room', roomPath);
  const oldStamp = JSON.parse(readFileSync(join(frozen, path), 'utf8')).alignment;
  writeFileSync(join(frozen, path), before);
  run(newTool, 'room', 'align', '--room', roomPath);
  const newStamp = JSON.parse(readFileSync(join(frozen, path), 'utf8')).alignment;
  // checked_at is wall time, not alignment semantics.
  delete oldStamp.checked_at; delete newStamp.checked_at;
  assert.deepEqual(newStamp, oldStamp);
  writeFileSync(join(frozen, path), before);
  console.log(`room align ${roomPath}: identical commit and anchor hashes`);
}
console.log(`baseline ${baseline}; ${list.length} Rooms; checked_at excluded only from freshly minted alignment stamps`);
