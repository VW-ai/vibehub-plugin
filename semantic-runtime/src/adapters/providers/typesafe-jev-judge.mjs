import { TypeSafeClient, VERSION as TYPESAFE_SDK_VERSION } from '@typesafe-ai/sdk';
import { RELATIONAL_FAMILIES, minimizedJudgeState } from './judge-input.mjs';

const DEFAULT_MODEL = 'jev-latest';

function probability(answer, id) {
  if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)
    || answer.noul < 0 || answer.noul > 1) {
    throw new Error(`TypeSafe JEV returned an invalid noul answer for ${id}`);
  }
  return answer.noul;
}

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function telemetry(result) {
  const input = finiteOrNull(result.usage?.input_tokens);
  const output = finiteOrNull(result.usage?.output_tokens);
  return {
    final_provider: 'typesafe-ai',
    cost_usd: null,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input === null || output === null ? null : input + output,
  };
}

function defaultClient() {
  return new TypeSafeClient({
    logLevel: 'off',
    retry: { maxRetries: 0 },
  });
}

export class TypeSafeJevJudge {
  constructor({ client, clientFactory = defaultClient, model = DEFAULT_MODEL, maxTargets = 32 } = {}) {
    if (client !== undefined && typeof client?.systemOne !== 'function') throw new Error('TypeSafeJevJudge needs a TypeSafe client');
    if (typeof clientFactory !== 'function') throw new Error('TypeSafeJevJudge needs a client factory');
    if (!Number.isInteger(maxTargets) || maxTargets < 1) throw new Error('TypeSafeJevJudge maxTargets must be positive');
    this.client = client ?? clientFactory();
    this.model = model;
    this.maxTargets = maxTargets;
    this.descriptor = {
      provider: 'typesafe-direct',
      model,
      kind: 'live-evaluation',
      calibrated: false,
      api_version: 'v1/systemone',
      sdk_version: TYPESAFE_SDK_VERSION,
    };
  }

  requiresNetwork({ stateRefs, question }) {
    return !RELATIONAL_FAMILIES.has(question.family) || stateRefs.length > 0;
  }

  async evaluate({ event, stateRefs, question }, { signal } = {}) {
    const relational = RELATIONAL_FAMILIES.has(question.family);
    if (relational && stateRefs.length === 0) {
      return {
        value: { relevant: false, target_ids: [] }, confidence: 1, latency_ms: 0,
        provider: this.descriptor.provider, model: this.model, reason_code: 'no_visible_targets',
        telemetry: { final_provider: 'none', cost_usd: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    }
    if (stateRefs.length > this.maxTargets) throw new Error('TypeSafe JEV target budget exceeded');

    const questions = relational
      ? Object.fromEntries(stateRefs.map((item, index) => [
          `target_${index}`,
          {
            type: 'noul',
            instructions: `${question.text} Decide whether the event is semantically connected to candidate ${item.id} and this exact candidate should be attached.`,
          },
        ]))
      : { relevant: { type: 'noul', instructions: question.text } };
    const started = performance.now();
    const result = await this.client.systemOne({
      model: this.model,
      state: minimizedJudgeState(event, stateRefs),
      questions,
    }, {
      signal,
      retry: { maxRetries: 0 },
    });
    const latency_ms = performance.now() - started;

    let relevant;
    let confidence;
    let target_ids = [];
    if (relational) {
      const probabilities = stateRefs.map((item, index) => ({
        id: item.id,
        probability: probability(result.answers?.[`target_${index}`], `target_${index}`),
      }));
      target_ids = probabilities.filter(item => item.probability >= 0.5).map(item => item.id);
      const strongest = Math.max(...probabilities.map(item => item.probability));
      relevant = target_ids.length > 0;
      confidence = relevant ? strongest : 1 - strongest;
    } else {
      const positive = probability(result.answers?.relevant, 'relevant');
      relevant = positive >= 0.5;
      confidence = relevant ? positive : 1 - positive;
    }

    return {
      value: { relevant, target_ids }, confidence, latency_ms,
      provider: this.descriptor.provider,
      model: typeof result.model === 'string' ? result.model : this.model,
      reason_code: relevant ? 'jev_direct_positive' : 'jev_direct_negative',
      telemetry: telemetry(result),
    };
  }
}
