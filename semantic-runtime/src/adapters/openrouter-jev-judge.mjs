import { experimental_evaluate as evaluate } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { FAMILIES, identifier } from '../core/contracts.mjs';
import { RELATIONAL_FAMILIES, minimizedJudgeState } from './judge-input.mjs';

export const OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';
const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function failure(error, signal, deadline) {
  const safe = new Error('OpenRouter evaluation failed; inspect the bounded error code and provider configuration.');
  safe.code = signal?.aborted ? 'judge_aborted' : deadline.aborted ? 'judge_timeout' : 'openrouter_request_failed';
  if (Number.isInteger(error?.statusCode)) safe.statusCode = error.statusCode;
  const retry = error?.responseHeaders?.['retry-after'];
  if (typeof retry === 'string' && /^\d{1,8}(?:\.\d{1,3})?$/.test(retry)) safe.responseHeaders = { 'retry-after': retry };
  return safe; // Do not retain raw SDK request/response bodies, headers, cause or credential-bearing errors.
}

export class OpenRouterJevJudge {
  constructor({ apiKey, fetch: fetchFn, model = OPENROUTER_JEV_MODEL, maxTargets = 32, timeoutMs = 30_000 } = {}) {
    identifier(model, 'OpenRouter model');
    if (!Number.isInteger(maxTargets) || maxTargets < 1) throw new Error('OpenRouter maxTargets must be positive');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid OpenRouter timeout');
    // Pass an actual model object: a string here would select AI SDK's default Gateway.
    this.evaluationModel = createOpenRouter({ apiKey, fetch: fetchFn }).evaluationModel(model);
    this.model = model;
    this.maxTargets = maxTargets;
    this.timeoutMs = timeoutMs;
    this.descriptor = {
      provider: 'openrouter', model, kind: 'live-evaluation', calibrated: false,
      api_version: 'alpha/decisions', sdk_version: '3.1.0',
    };
  }

  requiresNetwork({ stateRefs, question }) {
    return !RELATIONAL_FAMILIES.has(question.family) || stateRefs.length > 0;
  }

  async evaluate({ event, stateRefs, question }, { signal } = {}) {
    if (!FAMILIES.includes(question.family)) throw new Error('Unsupported semantic question family');
    if (!Array.isArray(stateRefs) || stateRefs.length > this.maxTargets) throw new Error('OpenRouter target budget exceeded');
    if (new Set(stateRefs.map(item => item.id)).size !== stateRefs.length) throw new Error('Duplicate OpenRouter target identity');
    if (signal?.aborted) { const error = new Error('Judge request aborted'); error.code = 'judge_aborted'; throw error; }
    const relational = RELATIONAL_FAMILIES.has(question.family);
    if (relational && stateRefs.length === 0) {
      return { value: { relevant: false, target_ids: [] }, confidence: 1, latency_ms: 0,
        provider: 'openrouter', model: this.model, reason_code: 'no_visible_targets',
        telemetry: { final_provider: 'none', cost_usd: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    }
    const questions = relational ? Object.fromEntries(stateRefs.map((item, index) => [`target_${index}`, {
      type: 'boolean', instructions: `${question.text} Decide whether the event is semantically connected to candidate ${item.id} and this exact candidate should be attached.`,
    }])) : { relevant: { type: 'boolean', instructions: question.text } };
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const started = performance.now();
    try {
      const result = await evaluate({
        model: this.evaluationModel, state: minimizedJudgeState(event, stateRefs), questions,
        maxRetries: 0, abortSignal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        providerOptions: { openrouter: { provider: { allow_fallbacks: false } } },
      });
      const keys = Object.keys(questions);
      if (Object.keys(result.answers).length !== keys.length) throw new Error('Unexpected answer identity');
      const probabilities = keys.map(key => {
        const answer = result.answers[key];
        if (answer?.type !== 'boolean' || !Number.isFinite(answer.probability)
          || answer.probability < 0 || answer.probability > 1) throw new Error('Invalid answer');
        return answer.probability;
      });
      const positive = Math.max(...probabilities);
      const relevant = positive >= 0.5;
      const resolvedModel = identifier(result.response.modelId, 'OpenRouter response model');
      const metadata = result.providerMetadata?.openrouter;
      const input = tokens(result.usage?.inputTokens), output = tokens(result.usage?.outputTokens);
      return {
        value: { relevant, target_ids: relational ? stateRefs.filter((_, i) => probabilities[i] >= 0.5).map(item => item.id) : [] },
        confidence: relevant ? positive : 1 - positive,
        latency_ms: performance.now() - started, provider: 'openrouter', model: resolvedModel,
        reason_code: relevant ? 'jev_openrouter_positive' : 'jev_openrouter_negative',
        telemetry: {
          final_provider: typeof metadata?.provider === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(metadata.provider) ? metadata.provider : 'unknown',
          cost_usd: numeric(metadata?.usage?.cost), input_tokens: input, output_tokens: output,
          total_tokens: input === null || output === null ? null : tokens(input + output),
        },
      };
    } catch (error) { throw failure(error, signal, deadline); }
  }
}
