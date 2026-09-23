import {
  FAMILIES, SENSITIVITIES, fingerprint, identifier, judgeInputHash,
  requireValue, text, validateDecision,
} from '../../../src/domain/shared/contracts.mjs';
import { visibleState } from './contracts.mjs';

const ACTIONS = ['INGEST', 'IGNORE', 'DEFER', 'ESCALATE'];

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function jsonCopy(input) {
  const seen = new Set();
  function visit(value, depth) {
    requireValue(depth <= 64, 'Policy artifact: JSON nesting exceeds 64');
    requireValue(value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value), 'Policy artifact: only JSON values are accepted');
    if (typeof value === 'number') requireValue(Number.isFinite(value), 'Policy artifact: non-finite JSON number');
    if (!value || typeof value !== 'object') return;
    requireValue(!seen.has(value), 'Policy artifact: cyclic input');
    requireValue(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'Policy artifact: only plain JSON objects are accepted');
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      requireValue(typeof key === 'string', 'Policy artifact: symbol keys are not JSON');
      visit(value[key], depth + 1);
    }
    seen.delete(value);
  }
  visit(input, 0);
  return JSON.parse(JSON.stringify(input));
}

export function validatePolicy(input) {
  const policy = structuredClone(input);
  requireValue(policy?.schema_version === 1, 'Unsupported policy schema_version');
  identifier(policy.policy_id, 'policy_id');
  identifier(policy.version, 'policy.version');
  requireValue(policy.nodes && typeof policy.nodes === 'object' && !Array.isArray(policy.nodes), 'Invalid policy nodes');
  const entries = Object.entries(policy.nodes);
  requireValue(entries.length > 0 && entries.length <= 32, 'Policy must have 1–32 nodes');
  const families = [];
  for (const [id, node] of entries) {
    identifier(id, 'node.id');
    requireValue(node && ['judge', 'end'].includes(node.type), 'Unsupported Phase 0 node type');
    if (node.type === 'end') {
      requireValue(node.next === undefined, 'End node cannot have an edge');
      continue;
    }
    requireValue(FAMILIES.includes(node.family), 'Unsupported decision family');
    families.push(node.family);
    text(node.question, 'node.question');
    requireValue(Number.isFinite(node.confidence_threshold) && node.confidence_threshold > 0.5 && node.confidence_threshold <= 1, 'Invalid confidence threshold');
    requireValue(Number.isInteger(node.timeout_ms) && node.timeout_ms > 0 && node.timeout_ms <= 60_000, 'Invalid judge timeout');
    if (typeof node.next !== 'string') {
      requireValue(node.next && ACTIONS.every(action => typeof node.next[action] === 'string')
        && Object.keys(node.next).length === ACTIONS.length, 'Conditional edges must cover all actions');
    }
  }
  requireValue(families.length === FAMILIES.length && new Set(families).size === FAMILIES.length, 'Policy must declare each Phase 0 family once');
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    requireValue(Object.hasOwn(policy.nodes, id), 'Policy edge references missing node');
    requireValue(!visiting.has(id), 'Policy must be acyclic');
    if (visited.has(id)) return;
    visiting.add(id);
    const node = policy.nodes[id];
    if (node.type !== 'end') {
      const edges = typeof node.next === 'string' ? [node.next] : Object.values(node.next);
      edges.forEach(visit);
    }
    visiting.delete(id);
    visited.add(id);
  }
  visit(policy.entry);
  requireValue(visited.size === entries.length, 'Policy has unreachable nodes');
  return policy;
}

/** Load the historical policy format for the Phase 0 research evaluator. */
export function loadPhaseZeroPolicyArtifact(input) {
  const policy = validatePolicy(jsonCopy(input));
  return freeze({ kind: 'phase_zero_policy', schema_version: 1, policy_id: policy.policy_id, version: policy.version,
    policy_hash: fingerprint(policy), policy,
  });
}

async function boundedEvaluate(judge, input, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => judge.evaluate(structuredClone(input), { signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error('Judge deadline exceeded');
          error.code = 'judge_timeout';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateEvent({ event, state, policy, judge }) {
  const policyHash = fingerprint(policy);
  const decisions = [];
  const candidates = [];
  let nodeId = policy.entry;
  while (policy.nodes[nodeId].type !== 'end') {
    const node = policy.nodes[nodeId];
    const stateRefs = visibleState(event, node.family, state);
    const input = { event, stateRefs, question: { family: node.family, text: node.question } };
    const started = performance.now();
    let result = null;
    let errorCode = null;
    try {
      const raw = await boundedEvaluate(judge, input, node.timeout_ms);
      try { result = validateDecision(raw, input); }
      catch { errorCode = 'invalid_decision'; }
    } catch (error) {
      errorCode = error.code === 'judge_timeout' ? 'judge_timeout' : 'judge_unavailable';
    }
    const action = errorCode ? 'DEFER'
      : result.confidence < node.confidence_threshold ? (event.impact === 'high' ? 'ESCALATE' : 'DEFER')
        : result.value.relevant ? 'INGEST' : 'IGNORE';
    const inputHash = judgeInputHash(input);
    const decision = {
      decision_id: fingerprint([event.tenant_id, event.project_id, event.event_id, policyHash, nodeId]),
      event_id: event.event_id, policy_id: policy.policy_id, policy_version: policy.version,
      policy_hash: policyHash, node_id: nodeId, family: node.family, input_hash: inputHash,
      input_refs: [event.payload_ref, ...stateRefs.map(item => item.source_ref)],
      action, result, error_code: errorCode, elapsed_ms: performance.now() - started,
    };
    decisions.push(decision);
    if (action === 'INGEST') {
      const relationType = node.family === 'acceptance_relevance' ? 'EVIDENCE_FOR' : 'RELEVANT_TO';
      // Every stateRef was visible to this decision, including unselected ones.
      const sensitivity = SENSITIVITIES[Math.max(...[event, ...stateRefs].map(item => SENSITIVITIES.indexOf(item.acl.sensitivity)))];
      candidates.push({
        candidate_id: fingerprint([decision.decision_id, 'candidate']),
        event_id: event.event_id, decision_id: decision.decision_id,
        family: node.family, state: 'candidate', confidence: result.confidence,
        source_refs: [event.source.ref, event.payload_ref, ...stateRefs.filter(item => result.value.target_ids.includes(item.id)).map(item => item.source_ref)],
        acl: { visibility: 'project', sensitivity },
        relations: result.value.target_ids.map(target_id => ({ type: relationType, target_id, confidence: result.confidence })),
      });
    }
    nodeId = typeof node.next === 'string' ? node.next : node.next[action];
  }
  return { decisions, candidates };
}
