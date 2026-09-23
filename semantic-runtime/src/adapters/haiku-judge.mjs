import { Output, generateText, jsonSchema } from 'ai';
import { RELATIONAL_FAMILIES, minimizedJudgeState } from './providers/judge-input.mjs';

export const HAIKU_GATEWAY_MODEL = 'anthropic/claude-haiku-4.5';
export const HAIKU_CLI_MODEL = 'claude-haiku-4-5-20251001';
export const HAIKU_PROMPT_VERSION = 'peel-semantic-probabilities-v1';
export const HAIKU_SCHEMA_VERSION = 'ordered-probabilities-v1';

function probability(value, index) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Haiku returned an invalid probability at index ${index}`);
  }
  return value;
}

export function probabilityOutputSchema(count) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['probabilities'],
    properties: {
      probabilities: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
  };
}

function routeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : 'unknown';
}

function finiteOrNull(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function telemetry(result) {
  const gateway = result.providerMetadata?.gateway;
  return {
    final_provider: routeName(gateway?.routing?.finalProvider),
    cost_usd: finiteOrNull(gateway?.cost),
    input_tokens: finiteOrNull(result.usage?.inputTokens),
    output_tokens: finiteOrNull(result.usage?.outputTokens),
    total_tokens: finiteOrNull(result.usage?.totalTokens),
  };
}

export function probabilityPrompt(state, question, count) {
  const slots = state.candidates.length
    ? state.candidates.map((candidate, index) => ({
        index,
        instruction: `${question.text} Decide whether the event is semantically connected to this exact candidate and should be attached.`,
        candidate,
      }))
    : [{ index: 0, instruction: question.text }];
  return JSON.stringify({
    contract: HAIKU_PROMPT_VERSION,
    task: 'Return the probability that each ordered instruction is true. Use only the supplied event and candidates. Do not add facts or use future information.',
    family: question.family,
    state,
    slots,
    required_probability_count: count,
  });
}

export function mapProbabilities(values, { relational, stateRefs, count }) {
  if (!Array.isArray(values) || values.length !== count) {
    throw new Error('Haiku returned an invalid probability vector');
  }
  const probabilities = values.map(probability);
  if (relational) {
    const target_ids = stateRefs.filter((_, index) => probabilities[index] >= 0.5).map(item => item.id);
    const strongest = Math.max(...probabilities);
    const relevant = target_ids.length > 0;
    return { relevant, target_ids, confidence: relevant ? strongest : 1 - strongest };
  }
  const relevant = probabilities[0] >= 0.5;
  return { relevant, target_ids: [], confidence: relevant ? probabilities[0] : 1 - probabilities[0] };
}

export class HaikuJudge {
  constructor({ generateTextFn = generateText, model = HAIKU_GATEWAY_MODEL, maxTargets = 32, zeroDataRetention = false } = {}) {
    if (typeof generateTextFn !== 'function') throw new Error('HaikuJudge needs a generateText function');
    if (!Number.isInteger(maxTargets) || maxTargets < 1) throw new Error('HaikuJudge maxTargets must be positive');
    this.generateTextFn = generateTextFn;
    this.model = model;
    this.maxTargets = maxTargets;
    this.zeroDataRetention = zeroDataRetention;
    this.descriptor = {
      provider: 'vercel-ai-gateway',
      model,
      kind: 'live-structured-evaluation',
      calibrated: false,
      prompt_version: HAIKU_PROMPT_VERSION,
      schema_version: HAIKU_SCHEMA_VERSION,
      routing: 'gateway-latency',
      zero_data_retention: zeroDataRetention,
    };
    this.semanticDescriptor = this.descriptor;
  }

  requiresNetwork({ stateRefs, question }) {
    return !RELATIONAL_FAMILIES.has(question.family) || stateRefs.length > 0;
  }

  async evaluate({ event, stateRefs, question }, { signal } = {}) {
    const relational = RELATIONAL_FAMILIES.has(question.family);
    if (relational && stateRefs.length === 0) {
      return {
        value: { relevant: false, target_ids: [] },
        confidence: 1,
        latency_ms: 0,
        provider: this.descriptor.provider,
        model: this.model,
        reason_code: 'no_visible_targets',
        telemetry: { final_provider: 'none', cost_usd: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    }
    if (stateRefs.length > this.maxTargets) throw new Error('Haiku target budget exceeded');

    const state = minimizedJudgeState(event, stateRefs);
    const count = relational ? stateRefs.length : 1;
    const started = performance.now();
    const result = await this.generateTextFn({
      model: this.model,
      instructions: 'You are a bounded semantic classifier. Return only the schema requested by the caller. Probabilities are estimates, not canonical truth.',
      prompt: probabilityPrompt(state, question, count),
      output: Output.object({
        name: 'semantic_probabilities',
        description: 'Ordered probabilities that the supplied semantic instructions are true.',
        schema: jsonSchema(probabilityOutputSchema(count)),
      }),
      temperature: 0,
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: signal,
      providerOptions: {
        gateway: {
          sort: 'latency',
          ...(this.zeroDataRetention ? { zeroDataRetention: true } : {}),
        },
      },
    });
    const latency_ms = performance.now() - started;
    const { relevant, target_ids, confidence } = mapProbabilities(result.output?.probabilities, { relational, stateRefs, count });
    return {
      value: { relevant, target_ids },
      confidence,
      latency_ms,
      provider: this.descriptor.provider,
      model: this.model,
      reason_code: relevant ? 'haiku_positive' : 'haiku_negative',
      telemetry: telemetry(result),
    };
  }
}
