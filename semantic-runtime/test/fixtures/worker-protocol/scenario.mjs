// Deliberately synthetic fixture; no credentials, private traces or provider I/O.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { catalog, graph, assertion, apply } from '../working-graph/scenario.mjs';
import { graphRevisionAddress } from '../../../src/core/working-graph.mjs';
import { compilePolicyArtifact } from '../../../src/core/policy-artifacts.mjs';
import { WORKER_OUTPUT_SCHEMA, workerResultDigest, createWorkerJobState, transitionWorkerJob } from '../../../src/core/worker-protocol.mjs';
const clone = x => structuredClone(x);
const stable = v => JSON.stringify(Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))])) : v);
const hash = v => `sha256:${createHash('sha256').update(stable(v)).digest('hex')}`;
export const unknownUsage = () => ({ account_usage: { status: 'unknown', remaining_percent: null, observed_at: null }, consumption: { basis: 'unknown', input_tokens: null, output_tokens: null, usage_proxy_units: null }, estimated_cost: { status: 'unknown', currency: null, microunits: null } });
export function scenario({ conflict = false } = {}) {
  const first = apply(graph(), assertion());
  const latest = conflict ? apply(first.state, assertion('competing', { content: { semantic_type: 'constraint', data: { text: 'API becomes v2' } } })) : first;
  const current_graph = latest.state;
  const raw = JSON.parse(readFileSync(new URL('../policy-artifacts/ingress.json', import.meta.url), 'utf8'));
  const policy_artifact = compilePolicyArtifact(raw.definition, { operations: raw.operations });
  const policy = { policy_id: policy_artifact.policy_id, version: policy_artifact.version, content_hash: policy_artifact.content_hash, executable_hash: policy_artifact.executable_hash };
  const descriptor = policy_artifact.operations.find(x => x.id === 'submit');
  const capability_ceiling = { allowed_principal_ids: ['alice'], allowed_operations: ['read_context', 'propose_candidate', 'propose_resolution'], allowed_provider_ids: ['synthetic'], allowed_localities: ['local'], sensitivity_ceiling: 'sensitive' };
  const job = {
    schema_version: 1, job_id: 'job-a', scope: clone(current_graph.scope), worker_type: 'semantic-reconciliation',
    trigger: { policy_run_id: 'policy-run-a', policy, node_id: 'submit', operation: { id: descriptor.id, version: descriptor.version, implementation_hash: descriptor.implementation_hash } },
    continuation: { policy: clone(policy), node_id: 'ingest' },
    inputs: { graph_revision: graphRevisionAddress(current_graph), revisions: conflict ? [first.revision, latest.revision] : [first.revision], source_events: [first.state.snapshots.at(-1).revisions[0].provenance.events[0]], watermarks: clone(current_graph.snapshots.at(-1).watermarks) },
    capability_ceiling, output_schema: clone(WORKER_OUTPUT_SCHEMA), created_at_ms: 1000, deadline_ms: 10000, retry: { max_attempts: 2, lease_ms: 1000 }, idempotency_key: 'dispatch-a',
  };
  const admission = { catalog: catalog(), current_graph, policy_artifact, authorization: { schema_version: 1, scope: clone(job.scope), authorization_revision: 'auth-1', revoked: false, capabilities: clone(capability_ceiling) }, worker: { scope: clone(job.scope), worker_id: 'worker-a', principal_id: 'alice', provider_id: 'synthetic', model_id: 'fixture-v1', locality: 'local' } };
  return { job, admission };
}
export function context(fixture, now_ms, role = 'runtime', actor_id) {
  return { now_ms, actor: { scope: clone(fixture.job.scope), role, actor_id: actor_id ?? (role === 'runtime' ? 'scheduler-a' : fixture.admission.worker.worker_id) }, admission: fixture.admission };
}
export function running(fixture = scenario(), { claim_at = 1000, start_at = 1010, attempt_id = 'attempt-1' } = {}) {
  let state = createWorkerJobState(fixture.job);
  state = transitionWorkerJob(state, { type: 'claim', expected_revision: state.revision, attempt_id }, context(fixture, claim_at)).state;
  const started = transitionWorkerJob(state, { type: 'start', expected_revision: state.revision, attempt_id, fencing_token: state.attempts.at(-1).fencing_token }, context(fixture, start_at, 'worker'));
  if (started.status !== 'applied') throw new Error(started.reason);
  return started.state;
}
export function result(fixture, state, overrides = {}) {
  const a = state.attempts.at(-1);
  const value = { schema_version: 1, result_id: `result-${a.attempt_id}`, scope: clone(fixture.job.scope), job_id: fixture.job.job_id, job_digest: state.job_digest,
    attempt_id: a.attempt_id, fencing_token: a.fencing_token, trigger: clone(fixture.job.trigger), consumed_inputs: clone(fixture.job.inputs), output_schema: clone(fixture.job.output_schema), status: 'succeeded',
    findings: [{ finding_id: 'finding-a', operation: 'propose_resolution', summary: 'Compare the explicitly pinned assertions; preserve unresolved alternatives.', confidence: 0.7, input_revision_indexes: fixture.job.inputs.revisions.map((_, i) => i), source_event_indexes: [0], artifact_indexes: [] }], artifacts: [],
    provenance: { authority: 'proposal_only', input_revision_indexes: fixture.job.inputs.revisions.map((_, i) => i), source_event_indexes: fixture.job.inputs.source_events.map((_, i) => i) }, executor: clone(a.worker), usage: unknownUsage(), timings: { started_at_ms: a.started_at_ms, finished_at_ms: a.started_at_ms + 100, duration_ms: 100 }, failure: null, ...overrides };
  return resign(value);
}
export function resign(value) { const { result_digest: ignored, ...body } = clone(value); return { ...body, result_digest: workerResultDigest(body) }; }
export function rehashState(state) { const { state_digest: ignored, ...body } = clone(state); return { ...body, state_digest: hash(body) }; }
