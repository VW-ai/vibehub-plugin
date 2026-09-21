import { experimental_evaluate as evaluate } from 'ai';
import { RELATIONAL_FAMILIES, minimizedJudgeState } from './judge-input.mjs';
const DEFAULT_MODEL = 'typesafe-ai/jev';

function probability(answer, id) {
  if (answer?.type !== 'boolean' || !Number.isFinite(answer.probability)
    || answer.probability < 0 || answer.probability > 1) {
    throw new Error(`JEV returned an invalid boolean answer for ${id}`);
  }
  return answer.probability;
}

export class JevJudge {
  constructor({ evaluateFn = evaluate, model = DEFAULT_MODEL, maxTargets = 32, zeroDataRetention = false } = {}) {
    if (typeof evaluateFn !== 'function') throw new Error('JevJudge needs an evaluate function');
    if (!Number.isInteger(maxTargets) || maxTargets < 1) throw new Error('JevJudge maxTargets must be positive');
    this.evaluateFn = evaluateFn;
    this.model = model;
    this.maxTargets = maxTargets;
    this.zeroDataRetention = zeroDataRetention;
    this.descriptor = {
      provider: 'vercel-ai-gateway',
      model,
      kind: 'live-evaluation',
      calibrated: false,
      zero_data_retention: zeroDataRetention,
    };
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
      };
    }
    if (stateRefs.length > this.maxTargets) throw new Error('JEV target budget exceeded');

    const questions = relational
      ? Object.fromEntries(stateRefs.map((item, index) => [
          `target_${index}`,
          {
            type: 'boolean',
            instructions: `${question.text} Decide whether the event is semantically connected to candidate ${item.id} and this exact candidate should be attached.`,
          },
        ]))
      : {
          relevant: {
            type: 'boolean',
            instructions: question.text,
          },
        };
    const started = performance.now();
    const result = await this.evaluateFn({
      model: this.model,
      state: minimizedJudgeState(event, stateRefs),
      questions,
      maxRetries: 0,
      abortSignal: signal,
      providerOptions: {
        gateway: {
          only: ['typesafe-ai'],
          ...(this.zeroDataRetention ? { zeroDataRetention: true } : {}),
        },
      },
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
      value: { relevant, target_ids },
      confidence,
      latency_ms,
      provider: this.descriptor.provider,
      model: this.model,
      reason_code: relevant ? 'jev_positive' : 'jev_negative',
    };
  }
}
