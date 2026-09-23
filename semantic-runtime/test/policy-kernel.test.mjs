import test from 'node:test';
import assert from 'node:assert/strict';
import { executePolicyRun, createInMemoryPolicyTransactionPort, validatePolicyActionCommand } from '../src/domain/decisions/policy-kernel.mjs';
import { compilePolicyArtifact } from '../src/domain/decisions/policy-artifacts.mjs';
import { fingerprint } from '../src/core/contracts.mjs';
import { normalizeAuditEnvelope } from '../src/domain/decisions/observability-contract.mjs';
import { kernelFixture } from './fixtures/policy-kernel/scenario.mjs';

const clone = value => structuredClone(value);
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function replace(fixture, name, implementation) {
  const handler = fixture.handlers.find(h => h.operation.id === name), previous = handler.execute;
  handler.execute = input => implementation(input, previous);
}
async function run(fixture = kernelFixture(), options = {}) {
  const transaction = options.transaction ?? createInMemoryPolicyTransactionPort({ graph: fixture.graph });
  return { result: await executePolicyRun({ ...fixture, ...options, transaction }), transaction };
}
function emptyEffects(transaction, original) {
  const state = transaction.inspect(); assert.deepEqual(state.graph, original);
  for (const field of ['commands', 'receipts', 'audits', 'outbox']) assert.deepEqual(state[field], []);
}

test('typed deterministic, retrieve, aggregate, guard and Action run against frozen inputs', async () => {
  const fixture = kernelFixture();
  replace(fixture, 'retrieve', (ctx, previous) => {
    assert.ok(Object.isFrozen(ctx.inputs)); assert.ok(Object.isFrozen(ctx.snapshot)); assert.ok(Object.isFrozen(ctx.event));
    assert.equal(ctx.transaction, undefined); assert.match(ctx.fence, /retrieve\/1$/); return previous(ctx);
  });
  const { result, transaction } = await run(fixture);
  assert.equal(result.status, 'committed'); assert.equal(result.action, 'INGEST');
  assert.deepEqual(result.trace.map(r => r.node_id), ['entry', 'retrieve', 'aggregate', 'guard', 'finish']);
  assert.equal(result.usage.node_visits, 5); assert.equal(result.usage.retrievals, 1);
  assert.equal(transaction.inspect().graph.snapshots.length, 2);
  assert.ok(Object.isFrozen(result.receipt)); assert.ok(Object.isFrozen(transaction.inspect().commands[0]));
});

test('all-join input, trace and budget accounting ignore reverse branch completion', async () => {
  const results = [];
  for (const reverse of [false, true]) {
    const fixture = kernelFixture({ parallel: true });
    for (const [name, ms] of [['left', reverse ? 2 : 15], ['right', reverse ? 15 : 2]]) replace(fixture, name, async (ctx, previous) => { await delay(ms); return previous(ctx); });
    replace(fixture, 'aggregate', (ctx, previous) => { assert.deepEqual(ctx.inputs, { left: 2, right: 2 }); return previous(ctx); });
    results.push((await run(fixture)).result);
  }
  assert.deepEqual(results[0], results[1]);
});

test('simultaneous branch failures choose deterministic error edge and one terminal command', async () => {
  const results = [];
  for (const reverse of [false, true]) {
    const fixture = kernelFixture({ parallel: true });
    for (const [name, ms] of [['left', reverse ? 2 : 15], ['right', reverse ? 15 : 2]]) replace(fixture, name, async () => { await delay(ms); throw new Error('private backend detail'); });
    const { result, transaction } = await run(fixture); results.push(result);
    assert.equal(result.action, 'DEFER'); assert.equal(transaction.inspect().commands.length, 1);
    assert.equal(transaction.inspect().outbox.length, 1); assert.equal(result.trace.some(t => t.node_id === 'aggregate'), false);
    assert.equal(JSON.stringify(result).includes('private backend detail'), false);
  }
  assert.deepEqual(results[0], results[1]);
});

test('retryable concurrent branches reserve remaining attempt and token budgets in deterministic order', async () => {
  const results = [];
  for (const reverse of [false, true]) {
    const fixture = kernelFixture({ parallel: true, attempts: 2 });
    for (const [name, ms] of [['left', reverse ? 2 : 15], ['right', reverse ? 15 : 2]]) replace(fixture, name, async (ctx, previous) => {
      await delay(ms);
      return ctx.attempt === 1 ? { outputs: { error: { kind: 'error_ref', node_id: ctx.node_id, code: 'handler_error' } }, error: { code: 'handler_error', retryable: true } } : previous(ctx);
    });
    results.push((await run(fixture, { limits: { max_attempts: 4, max_tokens: 16 } })).result);
  }
  assert.equal(results[0].action, 'DEFER'); assert.equal(results[0].usage.attempts, 4);
  assert.deepEqual(results[0], results[1]);
});

test('failed guard uses its declared deny route with no candidate write', async () => {
  const fixture = kernelFixture(); replace(fixture, 'guard', () => ({ outputs: {}, branch: 'deny' }));
  const { result, transaction } = await run(fixture);
  assert.equal(result.action, 'IGNORE'); assert.deepEqual(transaction.inspect().graph, fixture.graph);
  assert.equal(result.trace.some(t => t.node_id === 'finish'), false);
});

for (const [name, output] of [
  ['wrong typed port', { outputs: { value: 'wrong' }, branch: 'next' }],
  ['unknown branch', { outputs: { value: 2 }, branch: 'missing' }],
  ['hidden write command', { outputs: { value: 2 }, branch: 'next', command: { action: 'IGNORE', reason_code: 'no' } }],
  ['reported usage beyond reservation', { outputs: { value: 2 }, branch: 'next', usage: { tokens: 5, cost_microunits: 2 } }],
]) test(`invalid handler output: ${name}`, async () => {
  const fixture = kernelFixture(); replace(fixture, 'retrieve', () => output);
  const { result, transaction } = await run(fixture);
  assert.equal(result.action, 'DEFER'); assert.equal(result.reason_code, 'invalid_output');
  assert.deepEqual(transaction.inspect().graph, fixture.graph); assert.equal(transaction.inspect().receipts.length, 1);
});

test('late retrieval resolution cannot join, retry, commit, or change the returned trace', async () => {
  const fixture = kernelFixture({ parallel: true, timeout: 10 }), late = gate(); let observedSignal;
  replace(fixture, 'right', async (ctx, previous) => { observedSignal = ctx.signal; await late.promise; return previous(ctx); });
  const { result, transaction } = await run(fixture);
  assert.equal(result.reason_code, 'node_deadline'); assert.ok(observedSignal.aborted);
  const before = transaction.inspect(), trace = clone(result.trace);
  late.resolve(); await delay(2); assert.deepEqual(transaction.inspect(), before); assert.deepEqual(result.trace, trace);
});

test('a join handler failure cannot publish an earlier branch effect', async () => {
  const fixture = kernelFixture({ parallel: true }); replace(fixture, 'aggregate', () => { throw new Error('failed'); });
  const { result, transaction } = await run(fixture);
  assert.equal(result.action, 'DEFER'); assert.equal(result.reason_code, 'handler_error');
  assert.deepEqual(transaction.inspect().graph, fixture.graph); assert.equal(transaction.inspect().commands.length, 1);
});

for (const [name, limits, reason] of [
  ['node visits', { max_node_visits: 1 }, 'node_visit_budget'],
  ['attempts', { max_attempts: 1 }, 'attempt_budget'],
  ['retrievals', { max_retrievals: 0 }, 'retrieval_budget'],
  ['outputs', { max_output_bytes: 1 }, 'output_budget'],
  ['tokens', { max_tokens: 3 }, 'token_budget'],
  ['cost proxy', { max_cost_microunits: 1 }, 'cost_budget'],
]) test(`run budget: ${name}`, async () => {
  const fixture = kernelFixture(); const { result, transaction } = await run(fixture, { limits });
  assert.equal(result.action, 'DEFER'); assert.equal(result.reason_code, reason); assert.deepEqual(transaction.inspect().graph, fixture.graph);
});

test('explicit retries consume original budgets, stop at the finite attempt ceiling', async () => {
  const fixture = kernelFixture({ attempts: 3 }); let calls = 0;
  replace(fixture, 'retrieve', ({ node_id }) => { calls++; return { outputs: { error: { kind: 'error_ref', node_id, code: 'handler_error' } }, error: { code: 'handler_error', retryable: true } }; });
  const { result } = await run(fixture);
  assert.equal(calls, 3); assert.equal(result.usage.attempts, 4); assert.equal(result.usage.tokens, 16);
  assert.equal(result.usage.retrievals, 3); assert.equal(result.action, 'DEFER');
});

test('total deadline returns intrinsic DEFER without receipt and fences hanging handlers', async () => {
  const fixture = kernelFixture(), late = gate(); let handlerSignal;
  replace(fixture, 'retrieve', async (ctx, previous) => { handlerSignal = ctx.signal; await late.promise; return previous(ctx); });
  const { result, transaction } = await run(fixture, { limits: { timeout_ms: 15 } });
  assert.equal(result.status, 'deferred'); assert.equal(result.reason_code, 'run_deadline'); assert.equal(result.receipt, null);
  assert.ok(handlerSignal.aborted); emptyEffects(transaction, fixture.graph); late.resolve(); await delay(2); emptyEffects(transaction, fixture.graph);
});

test('elapsed synchronous handler result is refused even though JS execution cannot be preempted', async () => {
  const fixture = kernelFixture({ timeout: 10 }); let now = 0;
  replace(fixture, 'entry', (ctx, previous) => { now += 11; return previous(ctx); });
  const { result } = await run(fixture, { clock: { now: () => now, setTimeout, clearTimeout } });
  assert.equal(result.action, 'DEFER'); assert.equal(result.reason_code, 'node_deadline');
});

test('cancellation before invocation and during a hanging retrieval leaves no effects', async () => {
  for (const during of [false, true]) {
    const fixture = kernelFixture(), controller = new AbortController(), entered = gate(), late = gate();
    replace(fixture, 'retrieve', async (ctx, previous) => { entered.resolve(); await late.promise; return previous(ctx); });
    if (!during) controller.abort();
    const pending = run(fixture, { signal: controller.signal });
    if (during) { await entered.promise; controller.abort(); }
    const { result, transaction } = await pending;
    assert.equal(result.reason_code, 'cancelled'); emptyEffects(transaction, fixture.graph); late.resolve(); await delay(1); emptyEffects(transaction, fixture.graph);
  }
});

test('cancellation during a hung precommit returns promptly, releases the queue and fences the abandoned commit', async () => {
  const fixture = kernelFixture(), entered = gate(), late = gate(), controller = new AbortController(); let count = 0;
  const transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph, beforeCommit: async () => { if (++count === 1) { entered.resolve(); await late.promise; } } });
  const pending = run(fixture, { transaction, signal: controller.signal }); await entered.promise; controller.abort();
  const result = await Promise.race([pending, delay(50).then(() => { throw new Error('cancellation was not prompt'); })]);
  assert.equal(result.result.status, 'indeterminate'); assert.equal(transaction.lookup(result.result.command_ref).status, 'not_found'); emptyEffects(transaction, fixture.graph);
  const recovered = await run(fixture, { transaction }); assert.equal(recovered.result.status, 'committed');
  late.resolve(); await delay(2); assert.equal(transaction.inspect().receipts.length, 1);
});

test('precommit crash atomically preserves Graph, audit, receipt and outbox', async () => {
  const fixture = kernelFixture({ action: 'ESCALATE' });
  const transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph, beforeCommit: () => { throw new Error('sensitive store failure'); } });
  const { result } = await run(fixture, { transaction });
  assert.equal(result.status, 'failed'); assert.equal(result.reason_code, 'storage_unavailable'); emptyEffects(transaction, fixture.graph);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('commit followed by cancellation or lost acknowledgement reports uncertainty with exact receipt reconciliation', async () => {
  for (const fault of ['cancel', 'throw', 'hang']) {
    const fixture = kernelFixture(), controller = new AbortController();
    // The fault belongs after commit, regardless of host CPU contention.
    let now = 0, nextTimer = 0; const timers = new Map();
    const clock = {
      now: () => now,
      setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, at: now + ms }); return id; },
      clearTimeout: id => timers.delete(id),
    };
    const base = createInMemoryPolicyTransactionPort({ graph: fixture.graph });
    const transaction = { commit: async (command, options) => {
      const receipt = await base.commit(command, options);
      assert.equal(receipt.status, 'committed');
      if (fault === 'cancel') controller.abort();
      if (fault === 'throw') throw new Error('lost acknowledgement');
      if (fault === 'hang') {
        now = 101;
        for (const [id, timer] of [...timers]) if (timers.has(id) && timer.at <= now) {
          timers.delete(id); timer.callback();
        }
        return new Promise(() => {});
      }
      return receipt;
    } };
    const { result } = await run(fixture, { transaction, signal: controller.signal, clock, limits: { timeout_ms: 100 } });
    assert.equal(result.status, 'indeterminate'); assert.equal(result.reason_code, 'commit_unconfirmed');
    assert.equal(result.action, 'INGEST'); assert.equal(result.receipt, null);
    const reconciled = base.lookup(result.command_ref); assert.equal(reconciled.status, 'committed');
    const retry = await run(fixture, { transaction: base, clock }); assert.deepEqual(retry.result.receipt, reconciled.receipt);
    assert.equal(base.inspect().commands.length, 1);
  }
});

test('all five Action payloads have atomic receipt/audit and only recommendation/defer/escalate outbox intents', async () => {
  for (const action of ['INGEST', 'IGNORE', 'INJECT', 'DEFER', 'ESCALATE']) {
    const fixture = kernelFixture({ action }); const { result, transaction } = await run(fixture);
    assert.equal(result.action, action); const state = transaction.inspect();
    assert.equal(state.commands.length, 1); assert.equal(state.audits.length, 1); assert.equal(state.receipts.length, 1);
    assert.equal(state.outbox.length, ['INJECT', 'DEFER', 'ESCALATE'].includes(action) ? 1 : 0);
    assert.equal(state.graph.snapshots.length, action === 'INGEST' ? 2 : 1);
    assert.deepEqual(normalizeAuditEnvelope(state.audits[0]), state.audits[0]);
    assert.equal(state.audits[0].correlation.policy_revision, fixture.artifact.content_hash);
    assert.match(state.audits[0].correlation.event_id, /^c_/);
    assert.equal(state.audits[0].event, undefined); assert.equal(state.audits[0].generation_id, undefined);
  }
});

test('duplicate invocation returns the identical receipt before stale Graph CAS; changed command rejects', async () => {
  const fixture = kernelFixture(); const { result, transaction } = await run(fixture);
  const duplicate = await run(fixture, { transaction }); assert.deepEqual(duplicate.result.receipt, result.receipt);
  const changed = kernelFixture(); replace(changed, 'finish', (ctx, previous) => { const output = previous(ctx); output.command.assertion.content.data.text = 'changed'; return output; });
  const conflict = await run(changed, { transaction }); assert.equal(conflict.result.reason_code, 'idempotency_conflict');
  assert.equal(transaction.inspect().commands.length, 1);
});

test('equivalent ISO timestamps normalize before command identity and wire commands require the canonical form', async () => {
  const fixture = kernelFixture();
  const { result, transaction } = await run(fixture, { recorded_at: '2026-09-21T23:00:00Z' });
  assert.equal(result.status, 'committed');
  assert.equal(transaction.inspect().commands[0].recorded_at, fixture.recorded_at);
  const duplicate = await run(fixture, { transaction }); assert.deepEqual(duplicate.result.receipt, result.receipt);
  const command = clone(transaction.inspect().commands[0]); command.recorded_at = '2026-09-21T23:00:00Z'; delete command.payload_digest;
  command.payload_digest = `sha256:${fingerprint(command)}`;
  assert.throws(() => validatePolicyActionCommand(command), /noncanonical_timestamp/);
});

test('concurrent graph mutation rejects stale command with zero extra audit or outbox', async () => {
  const fixture = kernelFixture(), transaction = createInMemoryPolicyTransactionPort({ graph: fixture.graph });
  const first = await run(fixture, { transaction }); assert.equal(first.result.status, 'committed');
  const state = transaction.inspect();
  const second = await run({ ...fixture, run_id: 'second-run', idempotency_key: 'second-invocation' }, { transaction });
  assert.equal(second.result.reason_code, 'graph_revision_mismatch'); assert.equal(second.result.receipt, null); assert.deepEqual(transaction.inspect(), state);
});

test('strict command validator rejects rehashed malformed assertions, scope, canonical writes and schema extensions', async () => {
  const { transaction } = await run(); const command = transaction.inspect().commands[0];
  for (const mutate of [c => { c.payload.assertion = { status: 'candidate' }; }, c => { c.payload.assertion.status = 'validated'; },
    c => { c.payload.assertion.canonical_write = true; }, c => { c.expected_graph.generation_id = 'other'; },
    c => { c.policy.version = ''; }, c => { c.payload = { action: 'INJECT', recommendation: { mode: 'hard', refs: [] } }; }]) {
    const changed = clone(command); mutate(changed); delete changed.payload_digest; changed.payload_digest = `sha256:${fingerprint(changed)}`;
    assert.throws(() => validatePolicyActionCommand(changed));
  }
  assert.deepEqual(validatePolicyActionCommand(command), command);
});

test('forged artifact, installed descriptor/hash mismatch and unsupported Worker/Judge are rejected before execution', async () => {
  const invalid = kernelFixture(); invalid.artifact = clone(invalid.artifact); invalid.artifact.content_hash = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(run(invalid), /invalid_artifact/);
  const mismatch = kernelFixture(); mismatch.handlers[0].operation = { ...mismatch.handlers[0].operation, implementation_hash: `sha256:${'0'.repeat(64)}` };
  await assert.rejects(run(mismatch), /handler_identity_mismatch/);
  for (const type of ['worker', 'judge']) {
    const fixture = kernelFixture(), definition = clone(fixture.artifact.definition), operations = clone(fixture.artifact.operations);
    definition.nodes.retrieve.type = type; operations.find(o => o.id === 'retrieve').type = type;
    fixture.artifact = compilePolicyArtifact(definition, { operations });
    await assert.rejects(run(fixture), /unsupported_judge_or_worker/);
  }
});

test('wire getters are refused without invocation and no thrown source text reaches trace', async () => {
  const fixture = kernelFixture(); let reads = 0;
  const accessor = { outputs: { value: 1 }, branch: 'next' }; Object.defineProperty(accessor, 'private', { enumerable: true, get() { reads++; return 'secret'; } });
  replace(fixture, 'retrieve', () => accessor);
  const { result } = await run(fixture); assert.equal(reads, 0); assert.equal(result.reason_code, 'invalid_output');
  const bad = kernelFixture(); Object.defineProperty(bad, 'event', { value: accessor });
  await assert.rejects(run(bad), /accessor_or_hidden_field/); assert.equal(reads, 0);
});
