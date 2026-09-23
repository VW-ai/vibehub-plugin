import { DomainStore } from '../../adapters/sqlite/domain-store.mjs';
import { AccessAuthority } from '../../domain/identity/access-authority.mjs';
import { ProviderSettings, validateProviderConfig } from '../../adapters/providers/provider-settings.mjs';
import { JudgeInputs } from './judge-inputs.mjs';
import { invokeJudgeProvider } from '../../adapters/providers/judge-provider.mjs';
import { judgeConfiguration, judgeRequest, judgeCopy, judgeCheck, judgeFailure } from './judge-contract.mjs';
import { graphHash, graphEqual, graphFields, graphErrorCode } from '../graph/graph-inputs.mjs';
import { JUDGE_NODE_OPERATION, CONTEXT_JUDGE_NODE_OPERATION, JUDGE_DECISION_SCHEMA } from '../../domain/judge/judge-node.mjs';
import { validateDecision } from '../../domain/shared/contracts.mjs';
import { types } from 'node:util';

const BRIDGE = Symbol('selected JudgeNode invocation');
const CONTEXT_BRIDGE = Symbol('selected Context JudgeNode invocation');
const CACHE_BYTES = 8 * 1024 * 1024;
const bindings = new WeakMap();
/** Internal Query composition check. JSON/instanceof alone cannot claim this binding. */
export function assertJudgeRuntimeBinding(runtime, { store, authority, canonical_digest, scope }) {
  const bound = bindings.get(runtime);
  judgeCheck(bound && bound.store === store && bound.authority === authority
    && bound.canonical_digest === canonical_digest && graphEqual(bound.scope, scope), 'query_judge_binding_mismatch');
}
const codeOf = error => {
  const code = graphErrorCode(error);
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'judge_unavailable';
};
const stop = (signal, deadline) => { if (signal?.aborted) throw judgeFailure('cancelled'); if (performance.now() >= deadline) throw judgeFailure('judge_deadline'); };
const optionsSignal = options => {
  judgeCheck(options && typeof options === 'object' && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype
    && Reflect.ownKeys(options).every(key => key === 'signal')
    && Object.values(Object.getOwnPropertyDescriptors(options)).every(d => Object.hasOwn(d, 'value') && d.enumerable));
  const signal = options.signal;
  judgeCheck(signal === undefined || !types.isProxy(signal) && signal instanceof AbortSignal); return signal;
};
async function bounded(operation, signal, deadline) {
  stop(signal, deadline);
  let timer, abort;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      abort = () => reject(judgeFailure('cancelled')); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(judgeFailure('judge_deadline')), Math.max(1, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function outcome(request, fields) {
  const result = { schema_version: 1, status: 'refused', invocation_id: request.invocation_id, node_id: request.node_id,
    input_hash: null, decision_schema: JUDGE_DECISION_SCHEMA, selection: null, decision: null, target_refs: [],
    branch: null, recommendation: null, reason_code: 'judge_unavailable', attempts: [],
    usage: { reserved: { attempts: 0, tokens: 0, cost_microunits: 0 }, observed: { tokens: null, cost_microunits: null } }, cache: 'miss', ...fields };
  // Timing and the cache observation are measurements, not semantic identity.
  const semantic = { ...result }; delete semantic.cache;
  semantic.attempts = result.attempts.map(({ latency_ms, ...attempt }) => attempt);
  if (semantic.decision) { semantic.decision = { ...semantic.decision }; delete semantic.decision.latency_ms; }
  return judgeCopy({ ...result, result_digest: graphHash(semantic) });
}

/** One authenticated selected Judge invocation; no scheduler, durable dispatch or Graph write. */
export class LocalJudgeRuntime {
  #settings; #configuration; #inputs; #cache = new Map(); #cacheBytes = 0; #inflight = new Map();
  constructor({ store, authority, provider_settings, canonical_reader, configuration }) {
    try {
      judgeCheck(store instanceof DomainStore && authority instanceof AccessAuthority && provider_settings instanceof ProviderSettings);
      this.#configuration = judgeConfiguration(configuration); this.#settings = provider_settings;
      this.#inputs = new JudgeInputs({ store, authority, canonical_reader, configuration: this.#configuration });
      bindings.set(this, { store, authority, canonical_digest: this.#inputs.canonical_config_digest, scope: this.#configuration.scope });
    } catch { throw judgeFailure('invalid_judge_configuration'); }
  }
  evaluate(context, request, options = {}) { return this.#evaluate(context, request, optionsSignal(options), null, false); }
  evaluateContext(context, request, options = {}) { return this.#evaluate(context, request, optionsSignal(options), null, true); }
  [BRIDGE](context, request, { signal, inputs, deadline_ms }) {
    return this.#evaluate(context, request, signal, { inputs: judgeCopy(inputs), deadline_ms }, false);
  }
  [CONTEXT_BRIDGE](context, request, { signal, inputs, deadline_ms }) {
    return this.#evaluate(context, request, signal, { inputs: judgeCopy(inputs), deadline_ms }, true);
  }
  #node(request, typedContext) {
    const operation = typedContext ? CONTEXT_JUDGE_NODE_OPERATION : JUDGE_NODE_OPERATION;
    const node = this.#configuration.artifact.definition.nodes[request.node_id];
    judgeCheck(node?.type === 'judge' && node.operation.id === operation.id
      && node.operation.version === operation.version, 'unsupported_judge_node'); return node;
  }
  #config() {
    const config = this.#settings.getConfig(this.#configuration.settings_project_id);
    judgeCheck(config, 'project_not_configured'); return judgeCopy(validateProviderConfig(config));
  }
  #checkSettings(identity) { judgeCheck(graphHash(this.#config()) === identity, 'judge_settings_changed'); }
  #remember(key, entry) {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > CACHE_BYTES) return;
    while (this.#cache.size >= 128 || this.#cacheBytes + bytes > CACHE_BYTES) {
      const oldest = this.#cache.keys().next().value;
      this.#cacheBytes -= this.#cache.get(oldest).bytes; this.#cache.delete(oldest);
    }
    this.#cache.set(key, { ...entry, bytes }); this.#cacheBytes += bytes;
  }
  async #evaluate(context, input, signal, bridge, typedContext) {
    const started = performance.now();
    let request;
    try { request = judgeRequest(input); } catch { throw judgeFailure('invalid_judge_input'); }
    let key, requestHash, node, prepared, settings, settingsDigest, cached, controller, deadline = started;
    const attempts = [], usage = { reserved: { attempts: 0, tokens: 0, cost_microunits: 0 }, observed: { tokens: 0, cost_microunits: 0 } };
    const result = fields => outcome(request, { input_hash: prepared?.input_hash ?? null,
      selection: prepared ? { ...prepared.selection, settings_digest: settingsDigest ?? null,
        policy: { policy_id: this.#configuration.artifact.policy_id, version: this.#configuration.artifact.version,
          content_hash: this.#configuration.artifact.content_hash, executable_hash: this.#configuration.artifact.executable_hash },
        egress_policy_digest: graphHash(this.#configuration.egress_policy), decision_schema: JUDGE_DECISION_SCHEMA } : null,
      attempts, usage, ...fields });
    let ownsFlight = false;
    try {
      node = this.#node(request, typedContext);
      const grant = this.#inputs.grant(context);
      key = graphHash([grant.scope, grant.actor, grant.actor_kind, request.invocation_id]);
      requestHash = graphHash([typedContext ? 'runtime-context-v1' : 'judge-target-v1', node.operation, request]);
      const running = this.#inflight.get(key);
      if (running) return result({ reason_code: running === requestHash ? 'invocation_in_progress' : 'judge_invocation_conflict' });
      cached = this.#cache.get(key);
      if (cached && cached.request_hash !== requestHash) return result({ reason_code: 'judge_invocation_conflict' });
      judgeCheck(this.#inflight.size < 8, 'judge_concurrency_limit');
      this.#inflight.set(key, requestHash); ownsFlight = true;
      settings = this.#config(); settingsDigest = graphHash(settings);
      deadline = started + Math.min(this.#configuration.artifact.definition.limits.timeout_ms, node.budget.timeout_ms, settings.timeout_ms);
      if (bridge?.deadline_ms !== undefined) { judgeCheck(Number.isFinite(bridge.deadline_ms), 'invalid_judge_deadline'); deadline = Math.min(deadline, bridge.deadline_ms); }
      stop(signal, deadline);
      controller = new AbortController();
      const relay = () => controller.abort(); signal?.addEventListener('abort', relay, { once: true });
      // This listener is released below even on preparation/credential failures.
      controller.detach = () => signal?.removeEventListener('abort', relay);
      const inputOptions = { family: node.config.family, question: { family: node.config.family, text: node.config.question_text } };
      prepared = typedContext ? this.#inputs.prepareContext(context, request, inputOptions)
        : this.#inputs.prepare(context, request, inputOptions);
      stop(signal, deadline);
      if (bridge) {
        graphFields(bridge.inputs, ['event', 'selection']);
        judgeCheck(graphEqual(bridge.inputs.event, prepared.event_ref) && graphEqual(bridge.inputs.selection, prepared.selection_ref), 'judge_node_pin_mismatch');
      }
      const preparedIdentity = graphHash([prepared.input_hash, prepared.selection, settingsDigest]);
      const admit = (stage, provider) => {
        stop(controller.signal, deadline); this.#checkSettings(settingsDigest);
        this.#inputs.admit(context, prepared, { stage, provider });
        this.#checkSettings(settingsDigest); stop(controller.signal, deadline);
      };
      if (cached) {
        judgeCheck(cached.prepared_identity === preparedIdentity, 'judge_cache_stale');
        admit('result', cached.provider);
        this.#cache.delete(key); this.#cache.set(key, cached);
        return judgeCopy({ ...cached.result, cache: 'hit' });
      }
      const relational = ['acceptance_relevance', 'context_relevance'].includes(node.config.family);
      if (relational && prepared.input.stateRefs.length === 0) {
        admit('result', null);
        const decision = { value: { relevant: false, target_ids: [] }, confidence: 1, latency_ms: 0,
          provider: 'local', model: 'no-visible-targets', reason_code: 'no_visible_targets' };
        const completed = result({ status: 'decision', decision, branch: 'negative', reason_code: decision.reason_code });
        this.#remember(key, { request_hash: requestHash, prepared_identity: preparedIdentity, provider: null, result: completed });
        return completed;
      }
      const routes = [settings.primary, ...settings.fallbacks], limits = this.#configuration.artifact.definition.limits;
      const maxAttempts = Math.min(node.budget.max_attempts, limits.max_attempts, settings.max_attempts);
      let routeIndex = 0, terminalReason = 'judge_attempt_budget';
      for (let ordinal = 1; ordinal <= maxAttempts; ordinal++) {
        stop(controller.signal, deadline);
        const route = routes[routeIndex];
        judgeCheck(usage.reserved.tokens + node.budget.max_tokens <= limits.max_tokens, 'judge_token_budget');
        judgeCheck(usage.reserved.cost_microunits + node.budget.max_cost_microunits <= limits.max_cost_microunits, 'judge_cost_budget');
        usage.reserved.attempts++; usage.reserved.tokens += node.budget.max_tokens; usage.reserved.cost_microunits += node.budget.max_cost_microunits;
        admit('dispatch', route.provider);
        const attemptStarted = performance.now();
        const attempt = { ordinal, provider: route.provider, model: route.model, status: 'started', latency_ms: 0 };
        attempts.push(attempt);
        const priorObserved = { ...usage.observed };
        usage.observed.tokens = null; usage.observed.cost_microunits = null;
        let response;
        try {
          response = await bounded(() => invokeJudgeProvider({ provider_settings: this.#settings,
            settings_project_id: this.#configuration.settings_project_id, route, input: prepared.input, signal: controller.signal,
            beforeSend: () => admit('dispatch', route.provider) }), controller.signal, deadline);
          attempt.status = response.status === 'ok' ? 'completed' : response.code;
        } catch (error) {
          attempt.status = codeOf(error);
          // A timeout/abort cannot establish whether remote work was billed.
          usage.observed.tokens = null; usage.observed.cost_microunits = null;
          throw error;
        } finally { attempt.latency_ms = Math.round(performance.now() - attemptStarted); }
        stop(controller.signal, deadline);
        if (response.status === 'ok') {
          const decision = validateDecision(response.decision, prepared.input), telemetry = response.telemetry;
          const tokens = telemetry?.total_tokens ?? null;
          const cost = telemetry?.cost_usd === null || telemetry?.cost_usd === undefined ? null : Math.ceil(telemetry.cost_usd * 1_000_000);
          const totalTokens = tokens === null || priorObserved.tokens === null ? null : priorObserved.tokens + tokens;
          const totalCost = cost === null || priorObserved.cost_microunits === null ? null : priorObserved.cost_microunits + cost;
          usage.observed.tokens = Number.isSafeInteger(totalTokens) ? totalTokens : null;
          usage.observed.cost_microunits = Number.isSafeInteger(totalCost) ? totalCost : null;
          judgeCheck(tokens === null || tokens <= node.budget.max_tokens, 'judge_token_budget');
          judgeCheck(cost === null || Number.isSafeInteger(cost) && cost <= node.budget.max_cost_microunits, 'judge_cost_budget');
          admit('result', route.provider);
          const uncertain = decision.confidence < node.config.confidence_threshold;
          const refs = prepared.target_map.filter(target => decision.value.target_ids.includes(target.id)).map(target => target.ref);
          const completed = result({ status: uncertain ? 'deferred' : 'decision', decision, target_refs: refs,
            branch: uncertain ? 'uncertain' : decision.value.relevant ? 'positive' : 'negative',
            recommendation: uncertain ? node.config.impact === 'high' ? 'ESCALATE' : 'DEFER' : null,
            reason_code: uncertain ? 'low_confidence' : decision.reason_code });
          if (!uncertain) this.#remember(key, { request_hash: requestHash, prepared_identity: preparedIdentity, provider: route.provider, result: completed });
          return completed;
        }
        // A failed provider response does not prove that no work was billed.
        usage.observed.tokens = null; usage.observed.cost_microunits = null;
        terminalReason = response.code;
        if (!response.transient || ordinal === maxAttempts) break;
        const delay = Math.min(1000, Math.max(0, response.retry_after_ms ?? 100));
        await bounded(() => new Promise(resolve => setTimeout(resolve, delay)), controller.signal, deadline);
        if (routeIndex + 1 < routes.length) routeIndex++;
      }
      return result({ status: 'deferred', reason_code: terminalReason,
        recommendation: node.config.impact === 'high' ? 'ESCALATE' : 'DEFER' });
    } catch (error) {
      const code = codeOf(error);
      if (cached && key) { this.#cacheBytes -= cached.bytes; this.#cache.delete(key); }
      return result({ status: code === 'cancelled' ? 'cancelled' : ['judge_deadline', 'judge_token_budget', 'judge_cost_budget'].includes(code) ? 'deferred' : 'refused',
        reason_code: code, recommendation: node?.config.impact === 'high' ? 'ESCALATE' : 'DEFER' });
    } finally {
      controller?.detach?.(); controller?.abort();
      if (ownsFlight) this.#inflight.delete(key);
    }
  }
}

/** Typed single-node bridge. The full v1 Policy executor remains unchanged. */
async function executeSelectedJudgeNode(options, method) {
  judgeCheck(options && typeof options === 'object' && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype
    && Reflect.ownKeys(options).every(key => ['runtime', 'context', 'request', 'inputs', 'signal', 'deadline_ms'].includes(key))
    && Object.values(Object.getOwnPropertyDescriptors(options)).every(d => Object.hasOwn(d, 'value') && d.enumerable));
  const { runtime, context, request, inputs, signal, deadline_ms } = options;
  judgeCheck(!types.isProxy(runtime) && runtime instanceof LocalJudgeRuntime
    && (signal === undefined || !types.isProxy(signal) && signal instanceof AbortSignal));
  const result = await runtime[method](context, request, { signal, inputs, deadline_ms });
  const usage = { tokens: result.usage.reserved.tokens, cost_microunits: result.usage.reserved.cost_microunits };
  if (!result.decision || !result.branch) return judgeCopy({ outputs: { error: { kind: 'error_ref', code: 'handler_error', node_id: result.node_id } },
    error: { code: 'handler_error', retryable: false }, usage });
  return judgeCopy({ outputs: { relevant: result.decision.value.relevant, confidence: result.decision.confidence,
    targets: { kind: 'candidates_ref', refs: result.target_refs }, decision: { kind: 'signal_ref', digest: result.result_digest } },
    branch: result.branch, usage });
}

export function executeJudgeNode(options) { return executeSelectedJudgeNode(options, BRIDGE); }
export function executeContextJudgeNode(options) { return executeSelectedJudgeNode(options, CONTEXT_BRIDGE); }
