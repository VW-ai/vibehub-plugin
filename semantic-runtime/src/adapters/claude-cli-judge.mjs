import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  HAIKU_CLI_MODEL,
  HAIKU_PROMPT_VERSION,
  HAIKU_SCHEMA_VERSION,
  mapProbabilities,
  probabilityOutputSchema,
  probabilityPrompt,
} from './haiku-judge.mjs';
import { RELATIONAL_FAMILIES, minimizedJudgeState } from './judge-input.mjs';

const SYSTEM_PROMPT = 'You are a bounded semantic classifier. Return only the requested structured classification output. Probabilities are estimates, not canonical truth.';
const MAX_OUTPUT_BYTES = 1024 * 1024;

function boundedError(code, message, statusCode = null) {
  const error = new Error(message);
  error.code = code;
  if (statusCode !== null) error.statusCode = statusCode;
  return error;
}

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function cliTelemetry(envelope) {
  const usage = envelope.usage ?? {};
  const input = finiteOrNull(usage.input_tokens);
  const output = finiteOrNull(usage.output_tokens);
  return {
    final_provider: 'claude-cli',
    cost_usd: finiteOrNull(envelope.total_cost_usd),
    input_tokens: input,
    output_tokens: output,
    total_tokens: input === null || output === null ? null : input + output,
  };
}

function rateStatus(envelope) {
  return ['rate_limit', 'rate_limited', 'usage_limit'].includes(envelope?.subtype) ? 429 : null;
}

export function runClaudePrint({ model, schema, prompt, signal, spawnFn = spawn }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model', model,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--system-prompt', SYSTEM_PROMPT,
      '--tools', '',
      '--disable-slash-commands',
      '--safe-mode',
      '--no-session-persistence',
      '--permission-prompts', 'none',
      prompt,
    ];
    let child;
    try {
      child = spawnFn('claude', args, { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], signal });
    } catch {
      reject(boundedError('claude_cli_unavailable', 'Claude CLI could not start'));
      return;
    }
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill();
        reject(boundedError('claude_cli_output_limit', 'Claude CLI output exceeded its bound'));
      }
    });
    child.on('error', error => {
      if (error?.name === 'AbortError') reject(boundedError('judge_aborted', 'Judge request aborted'));
      else reject(boundedError('claude_cli_unavailable', 'Claude CLI request failed'));
    });
    child.on('close', exitCode => {
      let envelope;
      try { envelope = JSON.parse(stdout); }
      catch { reject(boundedError('claude_cli_invalid_json', 'Claude CLI returned invalid JSON')); return; }
      if (exitCode !== 0 || envelope?.is_error || envelope?.subtype !== 'success') {
        reject(boundedError('claude_cli_failed', 'Claude CLI classification failed', rateStatus(envelope)));
        return;
      }
      resolve(envelope);
    });
  });
}

export class ClaudeCliJudge {
  constructor({ runFn = runClaudePrint, model = HAIKU_CLI_MODEL, maxTargets = 32 } = {}) {
    if (typeof runFn !== 'function') throw new Error('ClaudeCliJudge needs a run function');
    if (!Number.isInteger(maxTargets) || maxTargets < 1) throw new Error('ClaudeCliJudge maxTargets must be positive');
    this.runFn = runFn;
    this.model = model;
    this.maxTargets = maxTargets;
    this.descriptor = {
      provider: 'claude-cli',
      model,
      kind: 'live-structured-evaluation',
      calibrated: false,
      prompt_version: HAIKU_PROMPT_VERSION,
      schema_version: HAIKU_SCHEMA_VERSION,
      transport_version: 'claude-code-print-json-v1',
      tools: false,
      session_persistence: false,
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
        value: { relevant: false, target_ids: [] }, confidence: 1, latency_ms: 0,
        provider: this.descriptor.provider, model: this.model, reason_code: 'no_visible_targets',
        telemetry: { final_provider: 'none', cost_usd: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    }
    if (stateRefs.length > this.maxTargets) throw new Error('Claude CLI target budget exceeded');
    const state = minimizedJudgeState(event, stateRefs);
    const count = relational ? stateRefs.length : 1;
    const started = performance.now();
    const envelope = await this.runFn({
      model: this.model,
      schema: probabilityOutputSchema(count),
      prompt: probabilityPrompt(state, question, count),
      signal,
    });
    const latency_ms = performance.now() - started;
    const { relevant, target_ids, confidence } = mapProbabilities(envelope.structured_output?.probabilities, { relational, stateRefs, count });
    return {
      value: { relevant, target_ids }, confidence, latency_ms,
      provider: this.descriptor.provider, model: this.model,
      reason_code: relevant ? 'haiku_cli_positive' : 'haiku_cli_negative',
      telemetry: cliTelemetry(envelope),
    };
  }
}
