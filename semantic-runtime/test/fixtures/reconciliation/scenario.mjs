// Synthetic reference executor only. Expected labels never enter a Job/model input.
import { readFileSync } from 'node:fs';
import { scenario as workerScenario, running, result as workerResult, resign } from '../worker-protocol/scenario.mjs';
import { graph, assertion, apply, event } from '../working-graph/scenario.mjs';
import { graphRevisionAddress } from '../../../src/domain/graph/working-graph.mjs';
import { compilePolicyArtifact } from '../../../src/domain/decisions/policy-artifacts.mjs';
import { RECONCILIATION_CONFIG_SCHEMA, reconciliationPolicyConfig, createReconciliationInput, encodeReconciliationProposal } from '../../../src/domain/work/reconciliation.mjs';
const clone = v => structuredClone(v);
const corpus = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
export const caseIds = Object.freeze(corpus.cases.map(c => c.id));
export function scenario(caseId = 'equivalent') {
  const selected = corpus.cases.find(c => c.id === caseId);
  if (!selected) throw new TypeError('Unknown recorded reconciliation case');
  const request = clone(selected.request);
  const fixture = workerScenario();
  const sources = [event(), event('web')];
  const first = apply(graph(), assertion('left', { content: { semantic_type: 'constraint', data: selected.claims[0] }, events: [sources[0]] }));
  const second = apply(first.state, assertion('right', { entity_id: selected.conflict ? 'context-a' : 'context-b', content: { semantic_type: 'constraint', data: selected.claims[1] }, execution_id: 'attempt-b', events: [sources[1]] }));
  const raw = JSON.parse(readFileSync(new URL('../policy-artifacts/ingress.json', import.meta.url), 'utf8'));
  raw.operations.find(x => x.id === 'submit').config_schema = clone(RECONCILIATION_CONFIG_SCHEMA);
  raw.definition.nodes.submit.config = clone(reconciliationPolicyConfig(request));
  const policy_artifact = compilePolicyArtifact(raw.definition, { operations: raw.operations });
  const policy = Object.fromEntries(['policy_id', 'version', 'content_hash', 'executable_hash'].map(k => [k, policy_artifact[k]]));
  fixture.job.trigger.policy = policy; fixture.job.continuation.policy = clone(policy);
  fixture.job.inputs = { graph_revision: graphRevisionAddress(second.state), revisions: [first.revision, second.revision], source_events: sources, watermarks: clone(second.state.snapshots.at(-1).watermarks) };
  fixture.job.capability_ceiling.sensitivity_ceiling = 'restricted';
  fixture.admission.current_graph = second.state; fixture.admission.policy_artifact = policy_artifact;
  fixture.admission.authorization.capabilities = clone(fixture.job.capability_ceiling);
  const input = createReconciliationInput(fixture.job, fixture.admission, request);
  return { ...fixture, request, input, case_id: caseId };
}
/** A recorded answer bound mechanically to the exact synthetic input. No reasoning. */
export function recordedProposal(fixture) {
  const { input } = fixture;
  const recording = corpus.cases.find(c => c.id === fixture.case_id).recording;
  return { schema_version: 1, ...Object.fromEntries(['bundle', 'request_digest', 'job_id', 'job_digest', 'scope', 'graph_revision', 'parents', 'citations', 'retained_claims'].map(k => [k, clone(input[k])])),
    authority: 'proposal_only', issue: input.request.issue, status: recording.status,
    resolution: { kind: recording.resolution_kind, scope_mode: 'per_parent' }, explanation: recording.explanation };
}
export function resultEnvelope(fixture = scenario()) {
  const state = running(fixture);
  const proposal = recordedProposal(fixture);
  const encoded = encodeReconciliationProposal(proposal, fixture.input);
  const result = workerResult(fixture, state);
  result.artifacts = [{ schema_version: 1, scope: clone(fixture.job.scope), artifact_id: 'reconciliation-proposal', revision: '1', digest: encoded.digest, kind: 'proposal', source_event_indexes: [0, 1] }];
  result.findings[0].source_event_indexes = [0, 1]; result.findings[0].artifact_indexes = [0];
  return { state, proposal, envelope: { job: fixture.job, result: resign(result), request: fixture.request, artifact_index: 0, artifact_json: encoded.artifact_json } };
}
