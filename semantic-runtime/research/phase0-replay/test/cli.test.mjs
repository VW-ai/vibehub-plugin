import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteCandidateStore } from '../adapters/sqlite-store.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('../fixtures/synthetic/', import.meta.url));
function temp(t) {
  const path = mkdtempSync(join(tmpdir(), 'semantic-cli-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function invoke(cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('CLI replays, audits, exports recorded inputs, and compares two policy versions from another cwd', t => {
  const cwd = temp(t);
  const scope = ['--tenant', 'demo', '--project', 'auth'];
  const input = ['--events', join(fixtures, 'events.jsonl'), '--state', join(fixtures, 'state.json'), '--labels', join(fixtures, 'labels.json'), '--dataset-kind', 'synthetic'];
  const first = invoke(cwd, ['replay', ...scope, ...input]);
  const audit = invoke(cwd, ['audit', ...scope, '--run', first.report.run_id]);
  assert.equal(audit.decisions.length, 20);
  const recordingPath = join(cwd, 'recordings.json');
  writeFileSync(recordingPath, JSON.stringify({ schema_version: 1, records: audit.decisions.map(({ input_hash, result }) => ({ input_hash, result })) }));
  const revised = JSON.parse(readFileSync(new URL('../policies/phase0.json', import.meta.url), 'utf8'));
  revised.version = '2';
  for (const node of Object.values(revised.nodes)) if (node.type === 'judge') node.confidence_threshold = 0.9;
  const policyPath = join(cwd, 'strict.json');
  writeFileSync(policyPath, JSON.stringify(revised));
  const second = invoke(cwd, ['replay', ...scope, ...input, '--policy', policyPath, '--judge', 'recorded', '--recordings', recordingPath]);
  assert.equal(second.report.actions.DEFER, 20);
  const comparison = invoke(cwd, ['compare', ...scope, '--left', first.report.run_id, '--right', second.report.run_id]);
  assert.equal(comparison.changed, 20);
});

test('CLI rejects unknown options and malformed JSON without leaking input payloads', t => {
  const cwd = temp(t);
  const events = join(cwd, 'broken.jsonl');
  writeFileSync(events, '{"secret":"do-not-print"');
  for (const args of [
    ['replay', '--tenant', 'demo', '--project', 'auth', '--unknown', 'value'],
    ['replay', '--tenant', 'demo', '--project', 'auth', '--events', events],
    ['replay', '--events', events],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('do-not-print'), false);
  }
});

test('candidate store refuses an unrelated SQLite database without changing it', t => {
  const path = join(temp(t), 'foreign.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'keep\');');
  db.close();
  const before = readFileSync(path);
  assert.throws(() => new SqliteCandidateStore(path), /Not a supported/);
  assert.deepEqual(readFileSync(path), before);
});
