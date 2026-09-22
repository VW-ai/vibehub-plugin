import { canonical, fingerprint, timestamp } from './contracts.mjs';
import { compilePolicyArtifact } from './policy-artifacts.mjs';
import { validateNormalizedEvent, eventObservationKey } from './event-provenance.mjs';
import { validateGraphRevision, validateGraphRevisionAddress, graphRevisionAddress, validateWorkingGraph,
  applyGraphAssertion, validateSemanticAddress, canonicalArtifactAddress, SEMANTIC_RELATIONS } from './working-graph.mjs';
import { auditCorrelationId, normalizeAuditEnvelope } from './observability-contract.mjs';

export const POLICY_KERNEL_VERSION = 1;
const ACTIONS = ['INGEST', 'IGNORE', 'INJECT', 'DEFER', 'ESCALATE'];
const ERROR_CODES = ['handler_error', 'invalid_output', 'node_deadline', 'run_deadline', 'cancelled', 'peer_failed',
  'node_visit_budget', 'attempt_budget', 'retrieval_budget', 'output_budget', 'token_budget', 'cost_budget'];
const hash = value => `sha256:${fingerprint(value)}`;
const same = (a, b) => canonical(a) === canonical(b);
const ensure = (condition, code) => { if (!condition) throw new Error(`Policy kernel: ${code}`); };
const id = value => ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value), 'invalid_identifier');
const digest = value => ensure(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'invalid_digest');
const integer = (value, min = 0, max = 1_000_000_000) => ensure(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_limit');
const fields = (value, required, optional = []) => {
  ensure(value && !Array.isArray(value) && typeof value === 'object', 'object_required');
  ensure(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'invalid_fields');
};
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
// Inspect descriptors before reading: untrusted wire values must not execute getters.
function copy(value, maxBytes = 16_000_000) {
  let count = 0;
  const stack = new Set();
  function visit(v, depth) {
    ensure(++count <= 200_000 && depth <= 64, 'json_bound');
    ensure(v === null || ['string', 'boolean', 'number', 'object'].includes(typeof v), 'json_required');
    if (typeof v === 'number') ensure(Number.isFinite(v), 'finite_number_required');
    if (!v || typeof v !== 'object') return;
    ensure(!stack.has(v), 'cyclic_json');
    ensure(Array.isArray(v) || [null, Object.prototype].includes(Object.getPrototypeOf(v)), 'plain_json_required');
    stack.add(v);
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      ensure(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key), 'unsafe_key');
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      ensure(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'accessor_or_hidden_field');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(v)) ensure(Object.keys(v).length === v.length, 'sparse_array');
    stack.delete(v);
  }
  visit(value, 0);
  const encoded = canonical(value);
  ensure(new TextEncoder().encode(encoded).length <= maxBytes, 'json_bound');
  return JSON.parse(encoded);
}
const immutable = value => freeze(copy(value));
const scoped = (value, snapshot) => ensure(same(value.scope, snapshot.scope) && value.generation_id === snapshot.generation_id, 'scope_or_generation_mismatch');

function eventRef(event) { return { kind: 'event_ref', observation_key: eventObservationKey(event), event_digest: hash(event) }; }
function refList(refs, snapshot) {
  ensure(Array.isArray(refs) && refs.length <= 512, 'invalid_refs');
  for (const ref of refs) { validateSemanticAddress(ref); ensure(ref.kind === 'semantic_revision', 'exact_revision_required'); scoped(ref, snapshot); }
  ensure(new Set(refs.map(canonical)).size === refs.length, 'duplicate_refs');
}
function ports(values, signature, context) {
  fields(values, Object.keys(signature));
  for (const [key, type] of Object.entries(signature)) {
    const value = values[key];
    if (['boolean', 'number', 'string'].includes(type)) { ensure(typeof value === type, 'port_type'); continue; }
    if (type === 'event_ref') { ensure(same(value, context.event_ref), 'event_pin_mismatch'); continue; }
    if (type === 'snapshot_ref') { validateGraphRevisionAddress(value); ensure(same(value, context.expected_graph), 'snapshot_pin_mismatch'); continue; }
    if (type === 'signal_ref') { fields(value, ['kind', 'digest']); ensure(value.kind === type, 'port_type'); digest(value.digest); continue; }
    if (type === 'candidates_ref') { fields(value, ['kind', 'refs']); ensure(value.kind === type, 'port_type'); refList(value.refs, context.snapshot); continue; }
    if (type === 'error_ref') { fields(value, ['kind', 'code', 'node_id']); ensure(value.kind === type && ERROR_CODES.includes(value.code), 'port_type'); id(value.node_id); continue; }
    ensure(false, 'unsupported_job_ref');
  }
}

/** Strict command payloads describe derived state or recommendations, never canonical writes. */
function payload(value, snapshot) {
  ensure(value && ACTIONS.includes(value.action), 'invalid_action');
  if (value.action === 'INGEST') {
    fields(value, ['action', 'assertion']);
    ensure(value.assertion?.status === 'candidate', 'ingest_requires_candidate');
    const a = value.assertion;
    fields(a, ['schema_version', 'assertion_id', 'entity_kind', 'entity_id', 'base_revision', 'parents', 'execution_id', 'status', 'content', 'events', 'canonical_refs'], ['access_revisions']);
    ensure(a.schema_version === 1 && ['entity', 'relation'].includes(a.entity_kind), 'invalid_assertion');
    [a.assertion_id, a.entity_id, a.execution_id].forEach(id);
    if (a.base_revision !== null) { refList([a.base_revision], snapshot); ensure(a.base_revision.entity_id === a.entity_id && a.base_revision.entity_kind === a.entity_kind, 'invalid_base'); }
    refList(a.parents, snapshot); ensure(a.parents.length <= 128, 'assertion_bound');
    ensure(Array.isArray(a.events) && a.events.length <= 128 && Array.isArray(a.canonical_refs) && a.canonical_refs.length <= 32, 'assertion_bound');
    const checkEvent = event => { validateNormalizedEvent(event); ensure(event.partition.tenant_id === snapshot.scope.tenant_id && event.partition.project_id === snapshot.scope.project_id, 'event_scope'); };
    const endpoint = ref => {
      if (ref?.kind === 'canonical_artifact') { checkEvent(ref.event); ensure(same(canonicalArtifactAddress(ref.event), ref), 'invalid_canonical_ref'); }
      else refList([ref], snapshot);
    };
    a.events.forEach(checkEvent); a.canonical_refs.forEach(ref => { ensure(ref?.kind === 'canonical_artifact', 'invalid_canonical_ref'); endpoint(ref); });
    if (a.access_revisions !== undefined) { ensure(Array.isArray(a.access_revisions) && a.access_revisions.length <= 128, 'assertion_bound'); a.access_revisions.forEach(digest); ensure(new Set(a.access_revisions).size === a.access_revisions.length, 'duplicate_access_revision'); }
    if (a.entity_kind === 'entity') { fields(a.content, ['semantic_type', 'data']); id(a.content.semantic_type); }
    else { fields(a.content, ['relation_type', 'from', 'to', 'data']); ensure(SEMANTIC_RELATIONS.includes(a.content.relation_type), 'invalid_relation'); endpoint(a.content.from); endpoint(a.content.to); }
    ensure(a.content.data && typeof a.content.data === 'object' && !Array.isArray(a.content.data), 'invalid_content');
  } else if (value.action === 'INJECT') {
    fields(value, ['action', 'recommendation']); fields(value.recommendation, ['mode', 'refs']);
    ensure(['silent', 'soft'].includes(value.recommendation.mode), 'recommendation_only'); refList(value.recommendation.refs, snapshot);
  } else {
    fields(value, ['action', 'reason_code']);
    ensure(typeof value.reason_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.reason_code), 'invalid_reason_code');
  }
}
function policyRef(artifact) { return { policy_id: artifact.policy_id, version: artifact.version, content_hash: artifact.content_hash, executable_hash: artifact.executable_hash }; }
function actionAudit(command) {
  const { scope, policy, run_id, node_id, event, recorded_at } = command;
  const correlation = {};
  for (const [key, value] of Object.entries({ tenant_id: scope.tenant_id, project_id: scope.project_id,
    event_id: event.event_id, policy_run_id: run_id, node_id })) correlation[key] = auditCorrelationId(key, scope.tenant_id, value);
  correlation.policy_revision = policy.content_hash;
  const action = command.payload.action;
  const failureReason = { node_deadline: 'deadline_exceeded', run_deadline: 'deadline_exceeded', cancelled: 'cancelled',
    invalid_output: 'invalid_input', handler_error: 'invalid_input', token_budget: 'token_budget_exhausted',
    cost_budget: 'call_budget_exhausted', retrieval_budget: 'call_budget_exhausted', output_budget: 'call_budget_exhausted',
    attempt_budget: 'retry_exhausted', node_visit_budget: 'call_budget_exhausted' }[command.payload.reason_code];
  return normalizeAuditEnvelope({ schema_version: 1, stream_id: correlation.policy_run_id, sequence: 1, previous_digest: null,
    audit_id: `c_${fingerprint([scope, run_id, node_id, policy])}`, recorded_at, subject: 'policy_run',
    status: action === 'IGNORE' ? 'ignored' : ['DEFER', 'ESCALATE'].includes(action) ? 'deferred' : 'succeeded',
    reason_code: failureReason ?? { INGEST: 'candidate_written', IGNORE: 'mechanical_ignore', INJECT: 'completed', DEFER: 'completed', ESCALATE: 'completed' }[action],
    correlation, measurements: {} });
}
function makeCommand(context, node_id, actionPayload) {
  const command = { schema_version: 1, kind: 'policy_action_command', scope: context.snapshot.scope,
    generation_id: context.snapshot.generation_id, idempotency_key: context.idempotency_key, run_id: context.run_id,
    node_id, policy: policyRef(context.artifact), event: context.event, expected_graph: context.expected_graph,
    recorded_at: context.recorded_at, payload: actionPayload };
  return immutable({ ...command, payload_digest: hash(command) });
}

export function validatePolicyActionCommand(input) {
  const command = copy(input);
  fields(command, ['schema_version', 'kind', 'scope', 'generation_id', 'idempotency_key', 'run_id', 'node_id', 'policy',
    'event', 'expected_graph', 'recorded_at', 'payload', 'payload_digest']);
  ensure(command.schema_version === 1 && command.kind === 'policy_action_command', 'unsupported_command');
  for (const key of ['generation_id', 'idempotency_key', 'run_id', 'node_id']) id(command[key]);
  fields(command.policy, ['policy_id', 'version', 'content_hash', 'executable_hash']);
  id(command.policy.policy_id); id(command.policy.version); digest(command.policy.content_hash); digest(command.policy.executable_hash);
  validateNormalizedEvent(command.event); validateGraphRevisionAddress(command.expected_graph); scoped(command.expected_graph, command);
  ensure(command.event.partition.tenant_id === command.scope.tenant_id && command.event.partition.project_id === command.scope.project_id, 'event_scope');
  ensure(timestamp(command.recorded_at, 'recorded_at') === command.recorded_at, 'noncanonical_timestamp'); payload(command.payload, command);
  const { payload_digest, ...body } = command; ensure(payload_digest === hash(body), 'command_digest_mismatch');
  return immutable(command);
}

/** Atomic, volatile reference port. Durable stores implement the same commit boundary. */
export function createInMemoryPolicyTransactionPort({ graph, beforeCommit = null } = {}) {
  validateWorkingGraph(graph);
  let state = immutable({ graph, receipts: [], commands: [], audits: [], outbox: [] });
  let tail = Promise.resolve();
  return Object.freeze({
    inspect: () => immutable(state),
    lookup(input) {
      const ref = copy(input); fields(ref, ['scope', 'generation_id', 'idempotency_key', 'payload_digest']);
      id(ref.idempotency_key); digest(ref.payload_digest); scoped(ref, state.graph.snapshots.at(-1));
      const receipt = state.receipts.find(r => r.idempotency_key === ref.idempotency_key);
      return immutable(!receipt ? { status: 'not_found', receipt: null } : receipt.payload_digest === ref.payload_digest
        ? { status: 'committed', receipt } : { status: 'idempotency_conflict', receipt: null });
    },
    commit(input, { signal, isCurrent = () => true } = {}) {
      const command = validatePolicyActionCommand(input);
      const operation = async () => {
        scoped(command, state.graph.snapshots.at(-1));
        const previous = state.receipts.find(r => r.idempotency_key === command.idempotency_key);
        if (previous) return immutable(previous.payload_digest === command.payload_digest
          ? { status: 'committed', receipt: previous }
          : { status: 'idempotency_conflict', receipt: null });
        if (signal?.aborted || !isCurrent()) return immutable({ status: 'cancelled', receipt: null });
        if (!same(command.expected_graph, graphRevisionAddress(state.graph))) return immutable({ status: 'graph_revision_mismatch', receipt: null });
        let nextGraph = state.graph;
        if (command.payload.action === 'INGEST') {
          const result = applyGraphAssertion(nextGraph, { expected_graph: command.expected_graph, assertion: command.payload.assertion });
          ensure(result.status === 'applied', 'unexpected_graph_result'); nextGraph = result.state;
        }
        const audit = actionAudit(command);
        const receipt = { schema_version: 1, kind: 'policy_action_receipt', idempotency_key: command.idempotency_key,
          payload_digest: command.payload_digest, action: command.payload.action, expected_graph: command.expected_graph,
          graph_revision: graphRevisionAddress(nextGraph), audit_digest: hash(audit) };
        const outbox = ['INJECT', 'DEFER', 'ESCALATE'].includes(command.payload.action)
          ? [{ schema_version: 1, kind: { INJECT: 'context_recommendation', DEFER: 'policy_deferred', ESCALATE: 'policy_escalation' }[command.payload.action],
            command_digest: command.payload_digest, scope: command.scope, generation_id: command.generation_id }] : [];
        const candidate = immutable({ graph: nextGraph, receipts: [...state.receipts, receipt], commands: [...state.commands, command],
          audits: [...state.audits, audit], outbox: [...state.outbox, ...outbox] });
        // Fault injection/adapter I/O happens before the linearization point.
        if (beforeCommit) {
          let cancel;
          const cancelled = new Promise(resolve => { cancel = () => resolve('cancelled'); signal?.addEventListener('abort', cancel, { once: true }); });
          try {
            if (await Promise.race([Promise.resolve().then(async () => { await beforeCommit(command); return null; }), cancelled]) === 'cancelled') return immutable({ status: 'cancelled', receipt: null });
          } finally { signal?.removeEventListener('abort', cancel); }
        }
        if (signal?.aborted || !isCurrent()) return immutable({ status: 'cancelled', receipt: null });
        state = candidate; // Graph/history/projection, command, receipt, audit and outbox publish together.
        return immutable({ status: 'committed', receipt });
      };
      const pending = tail.then(operation).catch(() => immutable({ status: 'not_committed', reason_code: 'storage_unavailable', receipt: null }));
      tail = pending.then(() => {}); return pending;
    },
  });
}

/** Execute only the non-model/non-Worker schema-2 subset against immutable inputs. */
export async function executePolicyRun(options) {
  const { handlers, transaction, signal, clock = { now: () => performance.now(), setTimeout, clearTimeout } } = options;
  ensure(transaction && typeof transaction.commit === 'function', 'transaction_port_required');
  const artifact = copy(options.artifact);
  ensure(same(artifact, compilePolicyArtifact(artifact.definition, { operations: artifact.operations })), 'invalid_artifact');
  ensure(artifact.compatibility.min_runtime_version <= 1 && artifact.compatibility.max_runtime_version >= 1, 'incompatible_artifact');
  ensure(Object.values(artifact.definition.nodes).every(n => !['judge', 'worker'].includes(n.type)), 'unsupported_judge_or_worker');
  const context = { artifact: immutable(artifact), event: immutable(options.event), snapshot: immutable(options.snapshot),
    run_id: options.run_id, idempotency_key: options.idempotency_key, recorded_at: options.recorded_at };
  validateNormalizedEvent(context.event); validateGraphRevision(context.snapshot); id(context.run_id); id(context.idempotency_key);
  context.recorded_at = timestamp(context.recorded_at, 'recorded_at'); context.expected_graph = graphRevisionAddress(context.snapshot); context.event_ref = eventRef(context.event);
  ensure(context.event.partition.tenant_id === context.snapshot.scope.tenant_id && context.event.partition.project_id === context.snapshot.scope.project_id, 'event_scope');
  const installed = new Map();
  ensure(Array.isArray(handlers), 'handlers_required');
  for (const handler of handlers) {
    const operation = copy(handler.operation), key = canonical([operation.id, operation.version]);
    ensure(typeof handler.execute === 'function' && !installed.has(key), 'invalid_handler'); installed.set(key, { operation, execute: handler.execute });
  }
  for (const operation of artifact.operations) ensure(same(installed.get(canonical([operation.id, operation.version]))?.operation ?? null, operation), 'handler_identity_mismatch');
  const definition = artifact.definition, nodes = definition.nodes;
  const limits = { timeout_ms: definition.limits.timeout_ms, max_node_visits: definition.limits.max_nodes,
    max_attempts: definition.limits.max_attempts, max_retrievals: 64, max_output_bytes: 1_000_000,
    max_tokens: definition.limits.max_tokens, max_cost_microunits: definition.limits.max_cost_microunits, ...copy(options.limits ?? {}) };
  fields(limits, ['timeout_ms', 'max_node_visits', 'max_attempts', 'max_retrievals', 'max_output_bytes', 'max_tokens', 'max_cost_microunits']);
  Object.entries(limits).forEach(([key, value]) => integer(value, key === 'timeout_ms' ? 1 : 0));
  for (const key of ['timeout_ms', 'max_attempts', 'max_tokens', 'max_cost_microunits']) ensure(limits[key] <= definition.limits[key], 'limit_exceeds_artifact');
  ensure(limits.max_node_visits <= definition.limits.max_nodes, 'limit_exceeds_artifact');
  const initial = immutable(options.inputs ?? Object.fromEntries(Object.entries(definition.inputs).map(([name, type]) =>
    [name, type === 'event_ref' ? context.event_ref : type === 'snapshot_ref' ? context.expected_graph : null])));
  ports(initial, definition.inputs, context);
  const usage = { node_visits: 0, attempts: 0, retrievals: 0, output_bytes: 0, tokens: 0, cost_microunits: 0 };
  const trace = [], started = clock.now(), deadline = started + limits.timeout_ms;
  const controller = new AbortController();
  let terminal = false;
  const externalAbort = () => controller.abort('cancelled');
  signal?.addEventListener('abort', externalAbort, { once: true }); if (signal?.aborted) externalAbort();
  const runTimer = clock.setTimeout(() => controller.abort('run_deadline'), limits.timeout_ms);
  const active = () => !terminal && !controller.signal.aborted && clock.now() < deadline;
  const stopCode = () => signal?.aborted ? 'cancelled' : controller.signal.reason === 'peer_failed' ? 'peer_failed' : 'run_deadline';
  const charge = (name, amount, cap, code) => { if (usage[name] + amount > cap) return code; usage[name] += amount; return null; };
  async function attempt(idValue, node, input, number) {
    if (!active()) return { error: stopCode() };
    const budget = node.budget;
    const exhausted = charge('attempts', 1, limits.max_attempts, 'attempt_budget')
      || (node.type === 'retrieve' && charge('retrievals', 1, limits.max_retrievals, 'retrieval_budget'))
      || charge('tokens', budget.max_tokens, limits.max_tokens, 'token_budget')
      || charge('cost_microunits', budget.max_cost_microunits, limits.max_cost_microunits, 'cost_budget');
    if (exhausted) return { error: exhausted };
    const operation = installed.get(canonical([node.operation.id, node.operation.version]));
    const attemptController = new AbortController();
    const attemptDeadline = Math.min(deadline, clock.now() + budget.timeout_ms);
    let timer, abortListener;
    const interrupted = new Promise(resolve => {
      abortListener = () => { attemptController.abort(controller.signal.reason); resolve({ error: stopCode() }); };
      controller.signal.addEventListener('abort', abortListener, { once: true });
      timer = clock.setTimeout(() => { attemptController.abort('node_deadline'); resolve({ error: 'node_deadline' }); }, budget.timeout_ms);
    });
    let result;
    try {
      const execution = Promise.resolve().then(() => {
        if (!active() || attemptController.signal.aborted) throw new Error('cancelled');
        return operation.execute({ node: immutable(node), node_id: idValue, inputs: input,
        event: context.event, snapshot: context.snapshot, signal: attemptController.signal, attempt: number,
        fence: `${context.run_id}/${idValue}/${number}`, deadline_ms: attemptDeadline }); })
        .then(value => ({ value }), () => ({ error: 'handler_error' }));
      result = await Promise.race([execution, interrupted]);
      if (!active()) result = { error: stopCode() };
      else if (clock.now() >= attemptDeadline) result = { error: 'node_deadline' };
      if (result.value !== undefined) {
        try {
          const value = copy(result.value);
          fields(value, ['outputs'], ['branch', 'usage', 'command', 'error']);
          if (value.usage !== undefined) { fields(value.usage, ['tokens', 'cost_microunits']); integer(value.usage.tokens); integer(value.usage.cost_microunits);
            ensure(value.usage.tokens <= budget.max_tokens && value.usage.cost_microunits <= budget.max_cost_microunits, 'attempt_usage_exceeded'); }
          if (value.error) {
            fields(value.error, ['code', 'retryable']); ensure(value.error.code === 'handler_error' && typeof value.error.retryable === 'boolean', 'invalid_error');
            ensure(value.command === undefined && value.branch === undefined, 'error_has_success'); ports(value.outputs, operation.operation.error_outputs, context);
          } else {
            ports(value.outputs, node.outputs, context);
            if (node.type === 'action') { ensure(value.branch === undefined && value.command?.action === node.action, 'invalid_action_output'); payload(value.command, context.snapshot); }
            else { ensure(value.command === undefined, 'non_action_command');
              ensure(operation.operation.branch_mode === 'parallel' ? value.branch === undefined : operation.operation.branches.includes(value.branch), 'invalid_branch'); }
          }
          const bytes = new TextEncoder().encode(canonical(value)).length;
          result = value.error ? { error: value.error.code, retryable: value.error.retryable, outputs: value.outputs, output_bytes: bytes } : { value: immutable(value), output_bytes: bytes };
        } catch { result = { error: 'invalid_output' }; }
      } else if (!result.error) result = { error: 'invalid_output' };
    } finally {
      clock.clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener); attemptController.abort('attempt_finished');
    }
    return result;
  }
  const order = new Map(artifact.topological_order.map((name, position) => [name, position]));
  const route = (edge, outputs) => Object.fromEntries(Object.entries(edge.ports).map(([name, from]) => [name, outputs[from]]));
  async function traverse() {
    let ready = [{ node_id: definition.entry, inputs: initial, attempt: 1, branch: null }];
    const joins = new Map();
    const visited = new Set();
    while (ready.length) {
      ready.sort((a, b) => order.get(a.node_id) - order.get(b.node_id));
      const current = ready; ready = [];
      // Dispatch a deterministic frontier together; completion order cannot route
      // a branch, consume output budget, or select the whole-run error winner.
      const pending = current.map(token => {
        const node = nodes[token.node_id];
        ports(token.inputs, node.inputs, context);
        if (token.attempt === 1) {
          ensure(!visited.has(token.node_id), 'duplicate_node_arrival'); visited.add(token.node_id);
          const error = charge('node_visits', 1, limits.max_node_visits, 'node_visit_budget');
          if (error) return Promise.resolve({ error });
        }
        return attempt(token.node_id, node, immutable(token.inputs), token.attempt);
      });
      for (let index = 0; index < current.length; index++) {
        const token = current[index], node = nodes[token.node_id];
        let result = await pending[index];
        if (!active()) result = { error: stopCode() };
        if (result.output_bytes) {
          const code = charge('output_bytes', result.output_bytes, limits.max_output_bytes, 'output_budget');
          if (code) result = { error: code };
        }
        trace.push({ node_id: token.node_id, attempt: token.attempt, status: result.error ? 'error' : 'succeeded',
          ...(result.error ? { code: result.error } : { outputs_digest: hash(result.value.outputs), branch: result.value.branch ?? null }) });
        if (result.error) {
          if (result.retryable && token.attempt < node.budget.max_attempts && active()) {
            ready.push({ ...token, attempt: token.attempt + 1 }); continue;
          }
          controller.abort('peer_failed');
          await Promise.all(pending); // Race wrappers settle on abort; late handlers are fenced.
          return { error: { node_id: token.node_id, code: result.error, inputs: token.inputs, ...(result.outputs ? { outputs: result.outputs } : {}) } };
        }
        if (node.type === 'action') return { node_id: token.node_id, payload: result.value.command };
        const operation = installed.get(canonical([node.operation.id, node.operation.version])).operation;
        const branches = operation.branch_mode === 'parallel' ? Object.keys(node.next).sort() : [result.value.branch];
        for (const name of branches) {
          const edge = node.next[name], target = nodes[edge.target], inputs = route(edge, result.value.outputs);
          const branch = operation.branch_mode === 'parallel' ? { fork: token.node_id, name } : token.branch;
          if (target.join?.mode === 'all') {
            ensure(branch?.fork === target.join.fork, 'invalid_join_arrival');
            const arrivals = joins.get(edge.target) ?? new Map();
            ensure(!arrivals.has(branch.name), 'duplicate_join_arrival'); arrivals.set(branch.name, inputs); joins.set(edge.target, arrivals);
            if (arrivals.size === Object.keys(nodes[branch.fork].next).length) {
              const merged = {};
              for (const key of [...arrivals.keys()].sort()) for (const [port, value] of Object.entries(arrivals.get(key))) {
                ensure(!Object.hasOwn(merged, port), 'duplicate_join_writer'); merged[port] = value;
              }
              ports(merged, target.inputs, context);
              ready.push({ node_id: edge.target, inputs: merged, attempt: 1, branch: null });
            }
          } else ready.push({ node_id: edge.target, inputs, attempt: 1, branch });
        }
      }
    }
    throw new Error('Policy kernel: stranded_join');
  }
  let outcome;
  try {
    let candidate = await traverse();
    if (candidate.error) {
      const error = candidate.error;
      if (['cancelled', 'run_deadline'].includes(error.code) || signal?.aborted || clock.now() >= deadline) {
        outcome = { status: 'deferred', action: 'DEFER', reason_code: signal?.aborted ? 'cancelled' : error.code, receipt: null };
      } else {
        const source = nodes[error.node_id], edge = source.on_error;
        if (edge) {
          const op = installed.get(canonical([source.operation.id, source.operation.version])).operation;
          const outputs = error.outputs ?? Object.fromEntries(Object.entries(op.error_outputs).map(([name, type]) => [name,
            type === 'error_ref' ? { kind: 'error_ref', code: error.code, node_id: error.node_id } : error.inputs[name]]));
          try { ports(outputs, op.error_outputs, context); ports(route(edge, outputs), nodes[edge.target].inputs, context);
            candidate = { node_id: edge.target, payload: { action: nodes[edge.target].action, reason_code: error.code } };
            trace.push({ node_id: edge.target, attempt: 0, status: 'system_terminal', code: error.code });
          } catch { outcome = { status: 'failed', action: 'DEFER', reason_code: 'error_ports_unavailable', receipt: null }; }
        } else outcome = { status: 'failed', action: 'DEFER', reason_code: error.code, receipt: null };
      }
    }
    if (!outcome) {
      const command = validatePolicyActionCommand(makeCommand(context, candidate.node_id, candidate.payload));
      const command_ref = { scope: command.scope, generation_id: command.generation_id, idempotency_key: command.idempotency_key, payload_digest: command.payload_digest };
      const unconfirmed = () => ({ status: 'indeterminate', action: candidate.payload.action, reason_code: 'commit_unconfirmed', receipt: null, command_ref });
      // An error edge has cancelled peer work, but its one system-generated terminal
      // command may commit before the original run deadline. External cancellation wins.
      const commitController = new AbortController();
      const cancelCommit = () => commitController.abort('cancelled');
      signal?.addEventListener('abort', cancelCommit, { once: true });
      if (signal?.aborted) cancelCommit();
      const remaining = Math.max(0, deadline - clock.now());
      let commitTimer;
      const timeout = new Promise(resolve => { commitTimer = clock.setTimeout(() => { commitController.abort('run_deadline');
        resolve({ status: 'commit_unknown', receipt: null }); }, remaining); });
      let cancelledListener;
      const cancelled = new Promise(resolve => {
        cancelledListener = () => resolve({ status: 'commit_unknown', receipt: null });
        commitController.signal.addEventListener('abort', cancelledListener, { once: true });
        if (commitController.signal.aborted) cancelledListener();
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => transaction.commit(command, { signal: commitController.signal,
          isCurrent: () => !terminal && !commitController.signal.aborted && clock.now() < deadline })), timeout, cancelled]);
        if (result.status === 'committed') {
          const receipt = copy(result.receipt);
          fields(receipt, ['schema_version', 'kind', 'idempotency_key', 'payload_digest', 'action', 'expected_graph', 'graph_revision', 'audit_digest']);
          ensure(receipt.schema_version === 1 && receipt.kind === 'policy_action_receipt' && receipt.payload_digest === command.payload_digest
            && receipt.idempotency_key === command.idempotency_key && receipt.action === candidate.payload.action && same(receipt.expected_graph, command.expected_graph), 'invalid_receipt');
          validateGraphRevisionAddress(receipt.graph_revision); scoped(receipt.graph_revision, command); digest(receipt.audit_digest);
          outcome = { status: 'committed', action: candidate.payload.action, reason_code: candidate.payload.reason_code ?? 'completed', receipt: result.receipt }; }
        else if (result.status === 'not_committed') outcome = { status: 'failed', action: 'DEFER', reason_code: 'storage_unavailable', receipt: null };
        else if (['idempotency_conflict', 'cancelled', 'graph_revision_mismatch'].includes(result.status))
          outcome = { status: result.status === 'idempotency_conflict' ? 'failed' : 'deferred', action: 'DEFER', reason_code: result.status, receipt: null };
        else outcome = unconfirmed();
      } catch { outcome = unconfirmed(); }
      finally { clock.clearTimeout(commitTimer); signal?.removeEventListener('abort', cancelCommit); commitController.signal.removeEventListener('abort', cancelledListener); commitController.abort('run_finished'); }
    }
  } finally {
    terminal = true; controller.abort('run_finished'); clock.clearTimeout(runTimer); signal?.removeEventListener('abort', externalAbort);
  }
  trace.sort((a, b) => order.get(a.node_id) - order.get(b.node_id) || a.attempt - b.attempt);
  return immutable({ ...outcome, trace, trace_digest: hash(trace), usage, limits, input_digest: hash({ event: context.event_ref, snapshot: context.expected_graph, inputs: initial, policy: policyRef(artifact), limits }) });
}
