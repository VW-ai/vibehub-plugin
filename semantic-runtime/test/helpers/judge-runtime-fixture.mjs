import { join } from 'node:path';
import { fingerprint } from '../../src/core/contracts.mjs';
import { compilePolicyArtifact } from '../../src/domain/decisions/policy-artifacts.mjs';
import { JUDGE_NODE_OPERATION } from '../../src/domain/judge/judge-node.mjs';
import { LocalJudgeRuntime } from '../../src/application/judge/judge-runtime.mjs';
import { ProviderSettings, PROVIDER_MODELS, JUDGE_CAPABILITY } from '../../src/adapters/providers/provider-settings.mjs';
import { judgeFixture } from './judge-fixture.mjs';

export const judgeRoute = provider => ({ provider, model: PROVIDER_MODELS[provider], capability: JUDGE_CAPABILITY });
export function judgeArtifact({ family = 'context_relevance', question_text = 'Does the selected event relate to this exact candidate?',
  threshold = 0.8, impact = 'normal', timeout_ms = 5000, max_attempts = 3, max_tokens = 256, max_cost_microunits = 10000 } = {}) {
  const sink = { id: 'judge-test-terminal', version: '1', type: 'action', implementation_hash: `sha256:${fingerprint('judge-test-terminal-v1')}`,
    inputs: {}, outputs: {}, error_outputs: {}, branches: [], branch_mode: 'terminal',
    config_schema: { type: 'object', additionalProperties: false, required: [], properties: {} } };
  const edge = { target: 'done', ports: {} };
  const budget = { timeout_ms, max_attempts, max_tokens, max_cost_microunits };
  return compilePolicyArtifact({ schema_version: 2, policy_id: 'selected-judge-fixture', version: '1',
    compatibility: { min_runtime_version: 1, max_runtime_version: 1 }, rollback_predecessor: null,
    entry: 'judge', inputs: JUDGE_NODE_OPERATION.inputs,
    limits: { max_nodes: 2, timeout_ms: timeout_ms * max_attempts + 1, max_attempts: max_attempts + 1,
      max_tokens: max_tokens * max_attempts, max_cost_microunits: max_cost_microunits * max_attempts },
    nodes: { judge: { type: 'judge', operation: { id: JUDGE_NODE_OPERATION.id, version: JUDGE_NODE_OPERATION.version },
      inputs: JUDGE_NODE_OPERATION.inputs, outputs: JUDGE_NODE_OPERATION.outputs, budget,
      config: { family, question_id: `question-${family}`, question_version: '1', question_text, confidence_threshold: threshold, impact },
      next: { positive: edge, negative: edge, uncertain: edge }, on_error: edge },
    done: { type: 'action', operation: { id: sink.id, version: sink.version }, inputs: {}, outputs: {},
      budget: { timeout_ms: 1, max_attempts: 1, max_tokens: 0, max_cost_microunits: 0 }, config: {}, next: {}, action: 'DEFER',
      join: { name: 'single-judge-outcome', mode: 'any' } } } }, { operations: [JUDGE_NODE_OPERATION, sink] });
}

export async function runtimeFixture(t, { family = 'context_relevance', provider = 'typesafe', fallbacks = [],
  max_attempts = 3, timeout_ms = 5000, canonical = false, ...artifactOptions } = {}) {
  const f = judgeFixture(t, { canonical, target_kind: family === 'acceptance_relevance' ? 'acceptance' : 'context' });
  const secrets = { values: new Map(), calls: 0, beforeUse: null,
    async put(ref, key) { this.values.set(ref, key); }, async remove(ref) { this.values.delete(ref); },
    async status(ref) { return this.values.has(ref) ? 'configured' : 'missing'; },
    async use(ref, callback) { this.calls++; if (this.beforeUse) await this.beforeUse();
      if (!this.values.has(ref)) throw Object.assign(new Error('synthetic credential missing'), { code: 'credential_missing' });
      return callback(this.values.get(ref)); } };
  const providerSettings = new ProviderSettings({ filePath: join(f.root, 'judge-settings.sqlite'), secretStore: secrets });
  t.after(() => providerSettings.close());
  await providerSettings.configure(f.configuration.settings_project_id, { primary: judgeRoute(provider), fallbacks: fallbacks.map(judgeRoute), max_attempts, timeout_ms });
  for (const name of [provider, ...fallbacks]) await providerSettings.replaceCredential(f.configuration.settings_project_id, name, `synthetic-fixture-${name}-credential`);
  f.configuration.artifact = judgeArtifact({ family, max_attempts, timeout_ms, ...artifactOptions });
  f.providerSettings = providerSettings; f.secrets = secrets;
  f.makeRuntime = (configuration = f.configuration) => new LocalJudgeRuntime({ store: f.store, authority: f.authority,
    provider_settings: providerSettings, canonical_reader: f.config, configuration });
  f.runtime = f.makeRuntime();
  const request = f.request;
  f.request = extra => request({ ...(!['acceptance_relevance', 'context_relevance'].includes(family) ? { target_refs: [] } : {}), ...extra });
  f.bridgeInputs = (r = f.request()) => {
    const node = f.configuration.artifact.definition.nodes.judge;
    const p = f.inputs().prepare(f.context, r, { family, question: { family, text: node.config.question_text } });
    return { event: p.event_ref, selection: p.selection_ref };
  };
  return f;
}

export const judgeJSON = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
export function judgeResponse(provider, body, { probability = 0.95, tokens = 15, cost = 0.0001 } = {}) {
  const answers = Object.fromEntries(Object.keys(body.questions).map(key => [key,
    provider === 'vercel' ? { type: 'boolean', probability } : { type: 'noul', noul: probability }]));
  return judgeJSON(provider === 'vercel' ? { answers, usage: { inputTokens: tokens, outputTokens: 0 },
    providerMetadata: { gateway: { routing: { finalProvider: 'typesafe-ai' }, cost } } }
    : { answers, model: PROVIDER_MODELS[provider], provider: 'TypeSafe', usage: { input_tokens: tokens, output_tokens: 0, cost } });
}
export function judgeTransport(t, handler = ({ provider, body }) => judgeResponse(provider, body)) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const provider = url.includes('api.typesafe.ai') ? 'typesafe' : url.includes('ai-gateway.vercel.sh') ? 'vercel' : 'openrouter';
    const call = { provider, body: JSON.parse(options.body), signal: options.signal, ordinal: calls.length + 1 };
    calls.push(call); return handler(call);
  });
  return calls;
}
