import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fingerprint, judgeInputHash } from '../../../src/domain/shared/contracts.mjs';
import { evaluateEvent, loadPhaseZeroPolicyArtifact } from '../src/policy.mjs';
import { event, target, decision } from './support.mjs';

test('Phase 0 loading preserves exact policy hash, four recorded judge inputs, results and candidate IDs', async () => {
  const policy = JSON.parse(readFileSync(new URL('../policies/phase0.json', import.meta.url), 'utf8'));
  const loaded = loadPhaseZeroPolicyArtifact(policy);
  assert.deepEqual(loaded.policy, policy); assert.equal(loaded.policy_hash, fingerprint(policy));
  const ledgers = [];
  const execute = async value => {
    const calls = [];
    const judge = { evaluate(input) { calls.push(structuredClone(input)); return decision(); } };
    const result = await evaluateEvent({ event: event(), state: [target()], policy: value, judge });
    ledgers.push(calls);
    return result;
  };
  const before = await execute(policy); const after = await execute(loaded.policy);
  assert.equal(ledgers[0].length, 4); assert.deepEqual(ledgers[0], ledgers[1]);
  assert.deepEqual(ledgers[0].map(judgeInputHash), ledgers[1].map(judgeInputHash));
  const omitTiming = result => ({ ...result, decisions: result.decisions.map(({ elapsed_ms, ...item }) => item) });
  assert.deepEqual(omitTiming(before), omitTiming(after));
  assert.throws(() => { loaded.policy.nodes.acceptance.question = 'mutated'; }, TypeError);
  assert.throws(() => loadPhaseZeroPolicyArtifact({ schema_version: 2 }), /Unsupported policy schema_version/);
});
