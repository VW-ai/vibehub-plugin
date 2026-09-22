import { FAMILIES, SENSITIVITIES, canonical } from '../core/contracts.mjs';
import { compilePolicyArtifact } from '../core/policy-artifacts.mjs';
import { JUDGE_NODE_OPERATION, CONTEXT_JUDGE_NODE_OPERATION } from '../core/judge-node.mjs';
import { validateGraphCommitAddress2 } from '../core/incremental-graph.mjs';
import { validateSemanticAddress } from '../core/working-graph.mjs';
import { PROVIDER_MODELS } from './provider-settings.mjs';
import { graphInput, graphFields, graphId, graphHash, graphEqual, graphUint } from './graph-inputs.mjs';

export const judgeFailure = code => Object.assign(new Error(`Local Judge: ${code}`), { code });
export const judgeCheck = (condition, code = 'invalid_judge_input') => { if (!condition) throw judgeFailure(code); };
export const freezeJudge = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeJudge); Object.freeze(value); } return value; };
export const judgeCopy = value => freezeJudge(graphInput(value));
const providers = list => {
  judgeCheck(Array.isArray(list) && list.length <= 3 && new Set(list).size === list.length
    && list.every(item => Object.hasOwn(PROVIDER_MODELS, item)));
};
const positiveVersion = n => judgeCheck(n === null || Number.isSafeInteger(n) && n > 0);
const lexical = (a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0;
export function judgeConfiguration(value) {
  const config = graphInput(value);
  graphFields(config, ['schema_version', 'scope', 'settings_project_id', 'artifact', 'egress_policy']);
  judgeCheck(config.schema_version === 1); graphFields(config.scope, ['tenant_id', 'project_id']); Object.values(config.scope).forEach(graphId);
  judgeCheck(typeof config.settings_project_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.settings_project_id));
  const artifact = compilePolicyArtifact(config.artifact.definition, { operations: config.artifact.operations });
  judgeCheck(graphEqual(artifact, config.artifact));
  const descriptors = [JUDGE_NODE_OPERATION, CONTEXT_JUDGE_NODE_OPERATION];
  const installed = artifact.operations.filter(op => op.type === 'judge');
  judgeCheck(installed.length > 0);
  for (const operation of installed) {
    const descriptor = descriptors.find(op => op.id === operation.id && op.version === operation.version);
    judgeCheck(descriptor);
    // Compilation canonicalizes operation enum/required order.
    const expected = graphInput(descriptor);
    expected.config_schema.required.sort();
    for (const property of Object.values(expected.config_schema.properties)) if (property.enum) property.enum.sort(lexical);
    judgeCheck(graphEqual(operation, expected));
  }
  judgeCheck(artifact.compatibility.min_runtime_version <= 1 && artifact.compatibility.max_runtime_version >= 1);
  for (const node of Object.values(artifact.definition.nodes).filter(n => n.type === 'judge')) {
    graphId(node.config.question_id); graphId(node.config.question_version);
    judgeCheck(FAMILIES.includes(node.config.family) && node.config.question_text.trim().length > 0 && Buffer.byteLength(node.config.question_text) <= 4096);
  }
  const policy = config.egress_policy;
  graphFields(policy, ['policy_id', 'revision', 'max_sensitivity', 'allowed_providers', 'sources']);
  graphId(policy.policy_id); graphId(policy.revision); judgeCheck(SENSITIVITIES.includes(policy.max_sensitivity)); providers(policy.allowed_providers);
  judgeCheck(Array.isArray(policy.sources) && policy.sources.length <= 32 && new Set(policy.sources.map(s => s.registration_id)).size === policy.sources.length);
  for (const source of policy.sources) {
    graphFields(source, ['registration_id', 'local_only', 'allowed_providers', 'text_policy']); graphId(source.registration_id);
    judgeCheck(typeof source.local_only === 'boolean' && ['selected-fields', 'deny'].includes(source.text_policy)); providers(source.allowed_providers);
  }
  return judgeCopy(config);
}
export function judgeRequest(value) {
  const request = graphInput(value);
  graphFields(request, ['invocation_id', 'node_id', 'epoch', 'execution', 'exploration_id', 'execution_workspace_id', 'expected_binding_version',
    'expected_catalog_version', 'expected_project_selection_version', 'at', 'event_id', 'target_refs', 'expected_source_fence']);
  for (const key of ['invocation_id', 'node_id', 'exploration_id', 'execution_workspace_id', 'event_id']) graphId(request[key]);
  graphUint(request.epoch); graphUint(request.expected_source_fence);
  graphFields(request.execution, ['repository_id', 'checkout_id', 'worktree_id']); Object.values(request.execution).forEach(graphId);
  for (const key of ['expected_binding_version', 'expected_catalog_version', 'expected_project_selection_version']) positiveVersion(request[key]);
  judgeCheck(request.expected_binding_version !== null && request.expected_catalog_version !== null);
  validateGraphCommitAddress2(request.at);
  judgeCheck(Array.isArray(request.target_refs) && request.target_refs.length <= 32 && new Set(request.target_refs.map(graphHash)).size === request.target_refs.length);
  for (const ref of request.target_refs) { validateSemanticAddress(ref); judgeCheck(ref.kind === 'semantic_revision' && graphEqual(ref.scope, request.at.scope) && ref.generation_id === request.at.generation_id); }
  request.target_refs.sort(lexical);
  return judgeCopy(request);
}
