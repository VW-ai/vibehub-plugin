import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicyArtifact } from '../../src/domain/decisions/policy-artifacts.mjs';
import { JUDGE_NODE_OPERATION, CONTEXT_JUDGE_NODE_OPERATION } from '../../src/domain/judge/judge-node.mjs';
import { judgeConfiguration } from '../../src/application/judge/judge-contract.mjs';
import { runtimeFixture, judgeArtifact, judgeTransport } from '../support/judge-runtime-fixture.mjs';
import { rows } from '../support/exploration-fixture.mjs';

function artifact(descriptor = CONTEXT_JUDGE_NODE_OPERATION, { includeLegacy = false, family = 'context_relevance' } = {}) {
  const old = judgeArtifact(), definition = structuredClone(old.definition);
  definition.nodes.judge.operation = { id: descriptor.id, version: descriptor.version };
  definition.nodes.judge.config.family = family;
  return compilePolicyArtifact(definition, { operations: [descriptor,
    ...(includeLegacy ? [JUDGE_NODE_OPERATION] : []), ...old.operations.filter(op => op.type !== 'judge')] });
}

test('Context Judge descriptor preserves legacy identity and limits its own family', () => {
  assert.equal(JUDGE_NODE_OPERATION.implementation_hash, 'sha256:99685a1b170dbbe17befbec489d95dfb6be951b2b7b30d16a410cfa71baa943a');
  assert.notEqual(CONTEXT_JUDGE_NODE_OPERATION.implementation_hash, JUDGE_NODE_OPERATION.implementation_hash);
  assert.deepEqual(CONTEXT_JUDGE_NODE_OPERATION.inputs, JUDGE_NODE_OPERATION.inputs);
  assert.deepEqual(CONTEXT_JUDGE_NODE_OPERATION.outputs, JUDGE_NODE_OPERATION.outputs);
  assert.deepEqual(CONTEXT_JUDGE_NODE_OPERATION.config_schema.properties.family.enum, ['context_relevance']);
  assert.throws(() => artifact(CONTEXT_JUDGE_NODE_OPERATION, { family: 'acceptance_relevance' }));
});

test('actual configuration accepts either known descriptor or both, rejects compiled spoof and unknown Judge', async t => {
  const f = await runtimeFixture(t);
  for (const selected of [f.configuration.artifact, artifact(), artifact(CONTEXT_JUDGE_NODE_OPERATION, { includeLegacy: true })]) {
    assert.doesNotThrow(() => judgeConfiguration({ ...f.configuration, artifact: selected }));
  }
  const spoof = structuredClone(CONTEXT_JUDGE_NODE_OPERATION);
  spoof.implementation_hash = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => judgeConfiguration({ ...f.configuration, artifact: artifact(spoof) }));
  const unknown = { ...structuredClone(CONTEXT_JUDGE_NODE_OPERATION), id: 'uninstalled-context-judge' };
  assert.throws(() => judgeConfiguration({ ...f.configuration, artifact: artifact(unknown) }));
});

test('Context runtime construction is inert and method mismatch refuses before credentials or transport', async t => {
  const f = await runtimeFixture(t), calls = judgeTransport(t), before = rows(f);
  const typed = f.makeRuntime({ ...f.configuration, artifact: artifact() });
  assert.deepEqual(rows(f), before); assert.equal(f.secrets.calls, 0); assert.equal(calls.length, 0);
  const first = await typed.evaluate(f.context, f.request());
  const second = await f.runtime.evaluateContext(f.context, f.request());
  for (const result of [first, second]) {
    assert.equal(result.status, 'refused'); assert.equal(result.reason_code, 'unsupported_judge_node');
    assert.equal(result.decision, null); assert.deepEqual(result.target_refs, []);
  }
  assert.deepEqual(rows(f), before); assert.equal(f.secrets.calls, 0); assert.equal(calls.length, 0);
});
