import { compilePolicyArtifact } from '../../../src/domain/decisions/policy-artifacts.mjs';
import { fingerprint } from '../../../src/domain/shared/contracts.mjs';
import { graph, event, assertion } from '../working-graph/scenario.mjs';

export function kernelFixture({ action = 'INGEST', parallel = false, attempts = 1, timeout = 100 } = {}) {
  const error_outputs = { error: 'error_ref' };
  const budget = { timeout_ms: timeout, max_attempts: attempts, max_tokens: 4, max_cost_microunits: 2 };
  const operations = [], nodes = {};
  function add(name, type, inputs, outputs, next, extra = {}) {
    const operation = { id: name, version: '1', type, implementation_hash: `sha256:${fingerprint(['synthetic-kernel', name])}`,
      inputs, outputs, error_outputs: type === 'action' ? {} : error_outputs, branches: Object.keys(next).sort(),
      branch_mode: extra.parallel ? 'parallel' : type === 'action' ? 'terminal' : 'exclusive',
      config_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] } };
    operations.push(operation);
    nodes[name] = { type, operation: { id: name, version: '1' }, inputs, outputs, config: {}, budget: { ...budget }, next,
      ...(type === 'action' ? { action: extra.action } : { on_error: { target: 'defer', ports: { error: 'error' } } }),
      ...(extra.join ? { join: extra.join } : {}) };
  }
  add('entry', 'deterministic', { event: 'event_ref', snapshot: 'snapshot_ref' }, { value: 'number' }, parallel
    ? { left: { target: 'left', ports: { value: 'value' } }, right: { target: 'right', ports: { value: 'value' } } }
    : { next: { target: 'retrieve', ports: { value: 'value' } } }, { parallel });
  if (parallel) {
    add('left', 'retrieve', { value: 'number' }, { value: 'number' }, { next: { target: 'aggregate', ports: { left: 'value' } } });
    add('right', 'retrieve', { value: 'number' }, { value: 'number' }, { next: { target: 'aggregate', ports: { right: 'value' } } });
    add('aggregate', 'aggregate', { left: 'number', right: 'number' }, { value: 'number' }, { next: { target: 'guard', ports: { value: 'value' } } },
      { join: { name: 'signals', mode: 'all', fork: 'entry' } });
  } else {
    add('retrieve', 'retrieve', { value: 'number' }, { value: 'number' }, { next: { target: 'aggregate', ports: { value: 'value' } } });
    add('aggregate', 'aggregate', { value: 'number' }, { value: 'number' }, { next: { target: 'guard', ports: { value: 'value' } } });
  }
  add('guard', 'guard', { value: 'number' }, {}, { allow: { target: 'finish', ports: {} }, deny: { target: 'ignore', ports: {} } });
  add('finish', 'action', {}, {}, {}, { action });
  add('ignore', 'action', {}, {}, {}, { action: 'IGNORE' });
  add('defer', 'action', { error: 'error_ref' }, {}, {}, { action: 'DEFER', join: { name: 'errors', mode: 'any' } });
  const definition = { schema_version: 2, policy_id: 'synthetic-kernel', version: '1', compatibility: { min_runtime_version: 1, max_runtime_version: 1 },
    rollback_predecessor: null, entry: 'entry', inputs: nodes.entry.inputs,
    limits: { max_nodes: 128, timeout_ms: 10000, max_attempts: 1280, max_tokens: 100000, max_cost_microunits: 1000000 }, nodes };
  const artifact = compilePolicyArtifact(definition, { operations });
  const handlers = artifact.operations.map(operation => ({ operation, execute: ({ node, node_id, inputs }) => {
    if (node.type === 'action') return { outputs: {}, command: node.action === 'INGEST' ? { action: 'INGEST', assertion: assertion() }
      : node.action === 'INJECT' ? { action: 'INJECT', recommendation: { mode: 'soft', refs: [] } }
        : { action: node.action, reason_code: 'synthetic' } };
    if (node.type === 'guard') return { outputs: {}, branch: 'allow' };
    const value = node_id === 'entry' ? 1 : node_id === 'aggregate' && parallel ? inputs.left + inputs.right : inputs.value + 1;
    return { outputs: { value }, ...(node_id === 'entry' && parallel ? {} : { branch: 'next' }) };
  } }));
  const state = graph();
  return { artifact, handlers, event: event(), snapshot: state.snapshots.at(-1), graph: state,
    run_id: 'synthetic-run', idempotency_key: 'synthetic-invocation', recorded_at: '2026-09-21T23:00:00.000Z' };
}
