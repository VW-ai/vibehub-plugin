import { TypeSafeClient } from '@typesafe-ai/sdk';
import { createGateway, experimental_evaluate as evaluate } from 'ai';
import { isProxy } from 'node:util/types';
import { TypeSafeJevJudge } from './typesafe-jev-judge.mjs';
import { JevJudge } from './jev-judge.mjs';
import { OpenRouterJevJudge } from './openrouter-jev-judge.mjs';
import { validateDecision } from '../../core/contracts.mjs';
import { graphInput, graphFields } from '../../application/graph/graph-inputs.mjs';
import { ProviderSettings, PROVIDER_MODELS, JUDGE_CAPABILITY } from './provider-settings.mjs';

// Internal composition only. The public runtime owns policy, deadline, attempts,
// reservation and the synchronous beforeSend proof; request JSON cannot supply it.
const errorResult = (code, transient = false, retry_after_ms = null) => ({ status: 'error', code, transient, retry_after_ms });
const own = (value, name) => value && typeof value === 'object' && !isProxy(value)
  ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const amount = n => Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
const category = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
function telemetry(value) {
  const input = count(value?.input_tokens), output = count(value?.output_tokens);
  return { final_provider: category(value?.final_provider), cost_usd: amount(value?.cost_usd),
    input_tokens: input, output_tokens: output,
    total_tokens: input === null || output === null ? null : count(input + output) };
}
function gatewayTelemetry(result) {
  const metadata = result.providerMetadata?.gateway;
  return telemetry({ final_provider: metadata?.routing?.finalProvider,
    cost_usd: metadata?.cost, input_tokens: result.usage?.inputTokens, output_tokens: result.usage?.outputTokens });
}
function retryAfter(headers) {
  // Only retain a numeric delay, never a header collection or provider text.
  const ms = headers.get('retry-after-ms'), seconds = headers.get('retry-after');
  const number = value => typeof value === 'string' && /^\d{1,12}(?:\.\d{1,3})?$/.test(value) ? Number(value) : null;
  const value = number(ms) ?? (number(seconds) === null ? null : number(seconds) * 1000);
  return value === null ? null : Math.min(1000, Math.ceil(value));
}
function providerFailure(error, observation, signal) {
  if (signal?.aborted || ['judge_aborted', 'judge_timeout'].includes(own(error, 'code'))) return errorResult('cancelled');
  const status = observation.status ?? own(error, 'statusCode') ?? own(error, 'status');
  if (status === 401 || status === 403) return errorResult('credential_rejected');
  if (status === 429) return errorResult('rate_limited', true, observation.retry_after_ms);
  if (Number.isInteger(status) && status >= 500 && status <= 599) return errorResult('provider_unavailable', true, observation.retry_after_ms);
  if (observation.ok || status === 400 || status === 422) return errorResult('invalid_decision');
  return errorResult('provider_unavailable');
}

export async function invokeJudgeProvider({ provider_settings, settings_project_id, route, input, signal, beforeSend }) {
  let selected;
  try {
    if (!(provider_settings instanceof ProviderSettings) || typeof beforeSend !== 'function'
      || (signal !== undefined && !(signal instanceof AbortSignal))) return errorResult('invalid_provider_configuration');
    route = graphInput(route); input = graphInput(input);
    graphFields(route, ['provider', 'model', 'capability']);
    if (!Object.hasOwn(PROVIDER_MODELS, route.provider) || route.model !== PROVIDER_MODELS[route.provider]
      || route.capability !== JUDGE_CAPABILITY) return errorResult('invalid_provider_configuration');
    selected = provider_settings.resolveRoute(settings_project_id, route.provider);
    if (selected.model !== route.model || selected.capability !== route.capability) return errorResult('invalid_provider_configuration');
  } catch { return errorResult('invalid_provider_configuration'); }
  if (signal?.aborted) return errorResult('cancelled');

  let trustedError, trustedFailed = false;
  const checkSend = () => {
    try {
      if (beforeSend() !== undefined) throw Object.assign(new Error('Judge proof must be synchronous'), { code: 'invalid_provider_configuration' });
    } catch (error) { trustedError = error; trustedFailed = true; throw error; }
  };
  let result;
  try {
    result = await provider_settings.useCredential(settings_project_id, route.provider, async apiKey => {
      // Invalid secure-store output must never reach an SDK's environment fallback.
      if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 8192 || /[\r\n\0]/.test(apiKey)) return errorResult('credential_missing');
      if (signal?.aborted) return errorResult('cancelled');
      const observation = { status: null, ok: false, retry_after_ms: null };
      let sends = 0, observedTelemetry = null;
      const send = async (url, options) => {
        // No SDK layer may silently retry even if its defaults change later.
        if (++sends !== 1 || signal?.aborted) throw new Error('Judge dispatch stopped');
        // SDK authorization/preprocessing may await after evaluate starts. Recheck
        // the same read-only proof at the final transport boundary as well.
        checkSend();
        if (signal?.aborted) throw new Error('Judge dispatch stopped');
        const response = await globalThis.fetch(url, { ...options, redirect: 'error' });
        observation.status = response.status; observation.ok = response.ok;
        observation.retry_after_ms = retryAfter(response.headers);
        return response;
      };
      try {
        let judge;
        if (route.provider === 'typesafe') {
          const client = new TypeSafeClient({ apiKey, baseURL: 'https://api.typesafe.ai', defaultModel: route.model,
            logLevel: 'off', retry: { maxRetries: 0 }, timeout: selected.timeout_ms, fetch: send });
          judge = new TypeSafeJevJudge({ client, model: route.model });
        } else if (route.provider === 'vercel') {
          const model = createGateway({ apiKey, fetch: send }).evaluationModel(route.model);
          // The SDK logs provider warnings by default. They are untrusted text,
          // not telemetry; discard them before the SDK's warning logger sees them.
          const doEvaluate = model.doEvaluate.bind(model);
          model.doEvaluate = async options => ({ ...await doEvaluate(options), warnings: [] });
          judge = new JevJudge({ model: route.model, evaluateFn: async options => {
            const response = await evaluate({ ...options, model, maxRetries: 0 });
            observedTelemetry = gatewayTelemetry(response);
            return response;
          } });
        } else {
          judge = new OpenRouterJevJudge({ apiKey, model: route.model, timeoutMs: selected.timeout_ms, fetch: send });
        }
        try {
          // Deliberately synchronous: no await between proof and adapter dispatch.
          // Capture separately because ProviderSettings redacts callback throws.
          checkSend();
        } catch { return null; }
        if (signal?.aborted) return errorResult('cancelled');
        const raw = await judge.evaluate(input, { signal });
        if (signal?.aborted) return errorResult('cancelled');
        try {
          const decision = validateDecision(raw, input);
          const measured = observedTelemetry ?? telemetry(raw.telemetry);
          const success = { status: 'ok', decision, telemetry: measured };
          // A malicious response must not echo the credential through an otherwise
          // syntactically valid resolved model/provider field.
          if (JSON.stringify(success).includes(apiKey)) return errorResult('invalid_decision');
          return success;
        } catch { return errorResult('invalid_decision'); }
      } catch (error) { return providerFailure(error, observation, signal); }
    });
  } catch (error) {
    const code = own(error, 'code');
    result = errorResult(code === 'credential_missing' ? 'credential_missing'
      : code === 'credential_rejected' ? 'credential_rejected' : 'credential_unavailable');
  }
  if (trustedFailed) throw trustedError;
  return result;
}
