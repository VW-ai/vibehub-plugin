import { join } from 'node:path';
import { fingerprint } from '../../src/core/contracts.mjs';
import { compilePolicyArtifact } from '../../src/core/policy-artifacts.mjs';
import { CONTEXT_JUDGE_NODE_OPERATION, JUDGE_NODE_OPERATION } from '../../src/core/judge-node.mjs';
import { LocalJudgeRuntime } from '../../src/local/judge-runtime.mjs';
import { JudgeInputs } from '../../src/local/judge-inputs.mjs';
import { ProviderSettings } from '../../src/local/provider-settings.mjs';
import { fixture, publish, head, CONTEXT_ACTIONS, register, capture, SCOPE } from './context-fixture.mjs';
import { JUDGE_ACTIONS } from './judge-fixture.mjs';
import { bind, pin } from './exploration-fixture.mjs';
import { judgeRoute } from './judge-runtime-fixture.mjs';

export const CONTEXT_JUDGE_ACTIONS = [...new Set([...JUDGE_ACTIONS, ...CONTEXT_ACTIONS])];
export function contextJudgeArtifact({ legacy = false, question_text = 'Does this event change or directly relate to this existing context?',
  threshold = 0.8, impact = 'normal', timeout_ms = 5000, max_attempts = 3, max_tokens = 256, max_cost_microunits = 10000 } = {}) {
  const sink = { id: 'context-judge-test-terminal', version: '1', type: 'action', implementation_hash: `sha256:${fingerprint('context-judge-test-terminal-v1')}`,
    inputs: {}, outputs: {}, error_outputs: {}, branches: [], branch_mode: 'terminal',
    config_schema: { type: 'object', additionalProperties: false, required: [], properties: {} } };
  const edge = { target: 'done', ports: {} }, budget = { timeout_ms, max_attempts, max_tokens, max_cost_microunits };
  const node = operation => ({ type: 'judge', operation: { id: operation.id, version: operation.version }, inputs: operation.inputs,
    outputs: operation.outputs, budget, config: { family: 'context_relevance', question_id: 'context-question', question_version: '1',
      question_text, confidence_threshold: threshold, impact }, next: { positive: edge, negative: edge, uncertain: edge }, on_error: edge });
  const nodes = { judge: node(CONTEXT_JUDGE_NODE_OPERATION), done: { type: 'action', operation: { id: sink.id, version: sink.version },
    inputs: {}, outputs: {}, budget: { timeout_ms: 1, max_attempts: 1, max_tokens: 0, max_cost_microunits: 0 }, config: {}, next: {},
    action: 'DEFER', join: { name: 'context-result', mode: 'any' } } };
  const operations = [CONTEXT_JUDGE_NODE_OPERATION, sink];
  if (legacy) {
    const chooser = { id: 'context-judge-test-selection', version: '1', type: 'deterministic', implementation_hash: `sha256:${fingerprint('context-judge-test-selection-v1')}`,
      inputs: JUDGE_NODE_OPERATION.inputs, outputs: JUDGE_NODE_OPERATION.inputs, error_outputs: {}, branches: ['context', 'legacy'],
      branch_mode: 'exclusive', config_schema: { type: 'object', additionalProperties: false, required: [], properties: {} } };
    nodes.legacy = node(JUDGE_NODE_OPERATION);
    nodes.choose = { type: 'deterministic', operation: { id: chooser.id, version: chooser.version }, inputs: chooser.inputs, outputs: chooser.outputs,
      budget: { timeout_ms: 1, max_attempts: 1, max_tokens: 0, max_cost_microunits: 0 }, config: {},
      next: { context: { target: 'judge', ports: { event: 'event', selection: 'selection' } }, legacy: { target: 'legacy', ports: { event: 'event', selection: 'selection' } } }, on_error: edge };
    operations.push(JUDGE_NODE_OPERATION, chooser);
  }
  return compilePolicyArtifact({ schema_version: 2, policy_id: 'typed-context-judge-fixture', version: '1',
    compatibility: { min_runtime_version: 1, max_runtime_version: 1 }, rollback_predecessor: null, entry: legacy ? 'choose' : 'judge',
    inputs: CONTEXT_JUDGE_NODE_OPERATION.inputs, limits: { max_nodes: legacy ? 4 : 2, timeout_ms: timeout_ms * max_attempts * (legacy ? 2 : 1) + 2,
      max_attempts: max_attempts * (legacy ? 2 : 1) + 2, max_tokens: max_tokens * max_attempts * (legacy ? 2 : 1),
      max_cost_microunits: max_cost_microunits * max_attempts * (legacy ? 2 : 1) }, nodes }, { operations });
}

export async function contextJudgeFixture(t, { provider = 'typesafe', fallbacks = [], canonical = false, max_attempts = 3,
  timeout_ms = 5000, values, ...artifactOptions } = {}) {
  const f = fixture(t, { canonical, ...(values ? { values } : {}) });
  Object.assign(f, f.issue({ actions: CONTEXT_JUDGE_ACTIONS }));
  if (canonical) f.a = bind(f, { key: 'context-judge-shared-origin', shared_base: pin(f.canonical, []) });
  f.binding = f.a;
  f.supportSource = register(f, { partition: 'typed-context-support' });
  f.supportEvent = capture(f, f.supportSource, { text: 'Synthetic captured decision support.', key: 'typed-context-support', objectId: 'typed-context-support' });
  f.targetResult = publish(f, 'typed-context-target', { events: [f.supportEvent], typed: { role: 'decision',
    summary: 'Use PostgreSQL as the durable primary store.', detail: 'Persist durable project records in PostgreSQL.' } });
  f.target = f.targetResult.revision; f.judgeEvent = f.event;
  f.configuration = { schema_version: 1, scope: SCOPE, settings_project_id: 'synthetic-context-judge-settings',
    artifact: contextJudgeArtifact({ max_attempts, timeout_ms, ...artifactOptions }),
    egress_policy: { policy_id: 'synthetic-context-selected-fields', revision: 'v1', max_sensitivity: 'INTERNAL',
      allowed_providers: ['typesafe', 'vercel', 'openrouter'], sources: [f.source, f.supportSource, ...(canonical ? [f.canonicalSource] : [])]
        .map(source => ({ registration_id: source.registration_id, local_only: false,
          allowed_providers: ['typesafe', 'vercel', 'openrouter'], text_policy: 'selected-fields' })) } };
  const secrets = { values: new Map(), calls: 0, beforeUse: null,
    async put(ref, key) { this.values.set(ref, key); }, async remove(ref) { this.values.delete(ref); },
    async status(ref) { return this.values.has(ref) ? 'configured' : 'missing'; },
    async use(ref, callback) { this.calls++; if (this.beforeUse) await this.beforeUse();
      if (!this.values.has(ref)) throw Object.assign(new Error('Synthetic credential missing'), { code: 'credential_missing' });
      return callback(this.values.get(ref)); } };
  const settings = new ProviderSettings({ filePath: join(f.root, 'context-judge-settings.sqlite'), secretStore: secrets });
  t.after(() => settings.close());
  await settings.configure(f.configuration.settings_project_id, { primary: judgeRoute(provider), fallbacks: fallbacks.map(judgeRoute), max_attempts, timeout_ms });
  for (const route of [provider, ...fallbacks]) await settings.replaceCredential(f.configuration.settings_project_id, route, `synthetic-context-${route}-credential`);
  f.providerSettings = settings; f.secrets = secrets;
  f.makeRuntime = (configuration = f.configuration) => new LocalJudgeRuntime({ store: f.store, authority: f.authority,
    provider_settings: settings, canonical_reader: f.config, configuration });
  f.runtime = f.makeRuntime();
  f.request = (extra = {}) => ({ invocation_id: 'typed-context-invocation', node_id: 'judge', epoch: f.epoch,
    execution: f.binding === f.b ? f.executionB : f.execution, exploration_id: f.binding.exploration_id,
    execution_workspace_id: f.binding.execution_workspace_id, expected_binding_version: f.binding.binding_version,
    expected_catalog_version: f.registry.get(f.context).version, expected_project_selection_version: null,
    at: head(f, f.binding), event_id: f.judgeEvent.event_id, target_refs: [f.target], expected_source_fence: f.feed.head(f.context).sequence, ...extra });
  f.inputs = (configuration = f.configuration) => new JudgeInputs({ store: f.store, authority: f.authority,
    canonical_reader: f.config, configuration });
  f.bridgeInputs = (request = f.request()) => {
    const node = f.configuration.artifact.definition.nodes.judge;
    const p = f.inputs().prepareContext(f.context, request, { family: 'context_relevance', question: { family: 'context_relevance', text: node.config.question_text } });
    return { event: p.event_ref, selection: p.selection_ref };
  };
  return f;
}
export { judgeRoute, judgeTransport, judgeResponse, judgeJSON } from './judge-runtime-fixture.mjs';
export { publish, head, register, capture, rows, adoption, contextRequest, canonicalRefs, gitCodeRef, SCOPE } from './context-fixture.mjs';
