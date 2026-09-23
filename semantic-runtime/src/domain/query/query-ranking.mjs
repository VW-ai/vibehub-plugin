import { canonical, fingerprint, compareText } from '../../core/contracts.mjs';
import { validateSemanticAddress } from '../graph/working-graph.mjs';
import { validateGraphCommitAddress2 } from '../graph/incremental-graph.mjs';
import { copyQueryFacts, CONTEXT_TEXT_VERSION } from './query-text.mjs';

export const CONTEXT_RANK_VERSION = 'context-rank-v1';
const fail = () => Object.assign(new Error('Query rank: query_invalid_request'), { code: 'query_invalid_request' });
const check = ok => { if (!ok) throw fail(); };
const hash = v => `sha256:${fingerprint(v)}`;
const same = (a, b) => canonical(a) === canonical(b);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v, required, optional = []) => check(object(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k)));
const list = (v, max) => check(Array.isArray(v) && v.length <= max);
const integer = (v, low = 0, high = Number.MAX_SAFE_INTEGER) => check(Number.isSafeInteger(v) && v >= low && v <= high);
const id = v => check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v));
const digest = v => check(typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v));
const exact = v => { validateSemanticAddress(v); check(v.kind === 'semantic_revision' && v.entity_kind === 'entity'); };
const sorted = refs => [...refs].sort((a, b) => compareText(canonical(a), canonical(b)));
const unique = refs => check(new Set(refs.map(canonical)).size === refs.length);
const pick = (v, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]]));

function textMatch(v, key) {
  fields(v, ['key', 'evaluated', 'hit', 'matched_distinct_terms', 'text_digest']);
  check(v.key === key && typeof v.evaluated === 'boolean'); digest(v.text_digest); integer(v.matched_distinct_terms, 0, 32);
  check(v.evaluated ? typeof v.hit === 'boolean' : v.hit === null);
  check(v.hit === true || v.matched_distinct_terms === 0); return v;
}
function selection(v, c) {
  const compact = Object.keys(v).length === 4;
  fields(v, compact ? ['at', 'observed_sequence', 'commit_lag', 'watermarks']
    : ['layer', 'exploration_id', 'generation_id', 'mode', 'at', 'origin_ref', 'shared_base', 'observed_head',
      'selected_sequence', 'observed_sequence', 'commit_lag', 'catalog_pin', 'watermarks']);
  validateGraphCommitAddress2(v.at);
  integer(v.observed_sequence); integer(v.commit_lag);
  check(v.at.generation_id === c.ref.generation_id && same(v.at.scope, c.ref.scope));
  if (!compact) {
    validateGraphCommitAddress2(v.observed_head); integer(v.selected_sequence);
    check(v.layer === c.layer && v.exploration_id === c.exploration_id && v.generation_id === c.ref.generation_id
      && ['current', 'as_of'].includes(v.mode) && v.selected_sequence === c.selected_sequence
      && v.observed_sequence - v.selected_sequence === v.commit_lag
      && (v.mode !== 'current' || same(v.at, v.observed_head) && v.commit_lag === 0)
      && v.observed_head.generation_id === c.ref.generation_id && same(v.observed_head.scope, c.ref.scope));
  } else check(v.observed_sequence - c.selected_sequence === v.commit_lag);
  return pick(v, ['at', 'observed_sequence', 'commit_lag', 'watermarks']);
}
function scope(v) {
  fields(v, ['status', 'verified_dimensions', 'dimensions']);
  check(['matched', 'uncertain', 'mismatch'].includes(v.status)); integer(v.verified_dimensions, 0, 3);
  list(v.dimensions, 3); check(v.dimensions.length === 3);
  for (const [i, d] of v.dimensions.entries()) {
    fields(d, ['dimension', 'status', 'filter_refs', 'support_refs']);
    check(d.dimension === ['tickets', 'rooms', 'repositories'][i]
      && ['not_requested', 'matched', 'any', 'uncertain', 'mismatch'].includes(d.status));
    list(d.filter_refs, 4); list(d.support_refs, 32);
    check(d.status === 'not_requested' ? d.filter_refs.length === 0 : d.filter_refs.length > 0);
    if (d.status === 'matched') check(d.support_refs.length > 0);
  }
  check(v.verified_dimensions === v.dimensions.filter(d => d.status === 'matched').length);
  check(v.status === (v.dimensions.some(d => d.status === 'mismatch') ? 'mismatch'
    : v.dimensions.some(d => d.status === 'uncertain') ? 'uncertain' : 'matched')); return v;
}
function group(v) {
  fields(v, ['key', 'exploration_id', 'layer', 'entity_id', 'at', 'member_keys', 'projected_refs', 'conflict_refs']);
  digest(v.key); id(v.exploration_id); check(['own', 'notice'].includes(v.layer)); validateGraphCommitAddress2(v.at);
  list(v.member_keys, 16); unique(v.member_keys); v.member_keys.forEach(digest);
  list(v.projected_refs, 16); unique(v.projected_refs); v.projected_refs.forEach(exact);
  list(v.conflict_refs, 32); // These are the actual Graph conflict addresses, not Context variants.
  check(v.projected_refs.every(ref => ref.entity_id === v.entity_id && ref.generation_id === v.at.generation_id && same(ref.scope, v.at.scope)));
  return { ...v, member_keys: [...v.member_keys].sort(), projected_refs: sorted(v.projected_refs), conflict_refs: sorted(v.conflict_refs) };
}
function candidate(c) {
  fields(c, ['key', 'ref', 'exploration_id', 'layer', 'item', 'source_reasons', 'conflict_group', 'publication',
    'selected_sequence', 'scope_match', 'text', 'group', 'selection']);
  digest(c.key); exact(c.ref); id(c.exploration_id); check(['own', 'notice'].includes(c.layer));
  if (c.conflict_group !== null) digest(c.conflict_group);
  check(c.key === hash([c.layer, c.exploration_id, c.ref])); integer(c.selected_sequence);
  fields(c.publication, ['origin_ref', 'graph_revision', 'sequence']); id(c.publication.origin_ref);
  validateGraphCommitAddress2(c.publication.graph_revision); integer(c.publication.sequence);
  check(c.publication.graph_revision.generation_id === c.ref.generation_id && same(c.publication.graph_revision.scope, c.ref.scope)
    && c.publication.sequence <= c.selected_sequence);
  list(c.source_reasons, 64); unique(c.source_reasons);
  for (const reason of c.source_reasons) { fields(reason, ['kind', 'source_id']); check(['exact', 'heads', 'lineage', 'conflict'].includes(reason.kind)); digest(reason.source_id); }
  const item = c.item;
  const compactItem = !Object.hasOwn(item, 'ref');
  fields(item, compactItem ? ['assertion_status', 'projection', 'historical_role', 'meaning', 'sources', 'transition']
    : ['ref', 'assertion_status', 'projection', 'historical_role', 'meaning', 'sources', 'publication', 'transition'], compactItem ? [] : ['applicability']);
  check((compactItem || same(item.ref, c.ref)) && ['candidate', 'validated', 'rejected', 'stale', 'superseded', 'contested', 'resolved'].includes(item.assertion_status));
  check(['head', 'competing', 'historical'].includes(item.historical_role));
  fields(item.meaning, ['role'], ['schema_version', 'kind', 'summary', 'detail', 'applicability', 'change']);
  check(['decision', 'constraint', 'observation', 'evidence', 'question'].includes(item.meaning.role));
  fields(item.projection, ['head', 'status', 'quarantined'], ['competing']);
  if (item.projection.head !== null) exact(item.projection.head);
  if (Object.hasOwn(item.projection, 'competing')) { list(item.projection.competing, 32); item.projection.competing.forEach(exact); }
  const value = { ...c, item: { ...pick(item, ['assertion_status', 'projection', 'historical_role', 'sources']),
    meaning: pick(item.meaning, ['role']),
    transition: { ...pick(item.transition, ['kind', 'structural_reason']), reason: pick(item.transition.reason, ['status']) } },
    source_reasons: sorted(c.source_reasons), scope_match: scope(c.scope_match), text: textMatch(c.text, c.key), selection: selection(c.selection, c) };
  value.item.projection = pick(item.projection, ['head', 'status', 'quarantined']);
  if (c.group === null) { check(c.conflict_group === null); value.group = null; }
  else {
    check(object(c.group));
    if (Object.keys(c.group).length === 1) {
      fields(c.group, ['key']); digest(c.group.key); check(c.group.key === c.conflict_group); value.group = { key: c.group.key };
    } else { value.group = group(c.group); check(value.group.key === c.conflict_group); }
  }
  return value;
}

const material = v => v === null ? null : pick(v, ['version', 'pin', 'status', 'configured_record_keys', 'selected_record_keys',
  'returned_record_keys', 'authority_record_keys', 'coverage', 'canonical_refs']);
function sharedFacts(v) {
  fields(v, ['current_project', 'origins', 'documents', 'mandatory_authority_keys', 'text_matches']);
  list(v.origins, 3); list(v.documents, 64); list(v.mandatory_authority_keys, 64); list(v.text_matches, 64);
  unique(v.documents.map(d => d.key)); unique(v.mandatory_authority_keys); unique(v.text_matches.map(t => t.key));
  const documents = v.documents.map(d => {
    fields(d, ['key', 'role', 'exploration_id', 'ref', 'record_key', 'kind', 'record', 'event_ref']);
    digest(d.key); check(['current_project', 'origin_base'].includes(d.role));
    check(d.role === 'current_project' ? d.exploration_id === null : typeof d.exploration_id === 'string');
    fields(d.ref, ['at', 'address', 'record_key']); validateGraphCommitAddress2(d.ref.at); exact(d.ref.address); id(d.record_key);
    check(d.record_key === d.ref.record_key && d.key === hash([d.role, d.exploration_id, d.ref]));
    return { ...d, record: pick(d.record, ['type', 'state']) };
  }).sort((a, b) => compareText(a.key, b.key));
  check(v.mandatory_authority_keys.every(key => documents.some(d => d.key === key && d.kind === 'context'
    && d.record.type === 'authority' && d.record.state === 'active')));
  check(v.text_matches.length === documents.length);
  return { current_project: material(v.current_project),
    origins: v.origins.map(o => ({ exploration_id: o.exploration_id, layer: o.layer, material: material(o.material) }))
      .sort((a, b) => compareText(a.exploration_id, b.exploration_id)), documents,
    mandatory_authority_keys: [...v.mandatory_authority_keys].sort(),
    text_matches: documents.map(d => textMatch(v.text_matches.find(t => t.key === d.key), d.key)) };
}
function judgeFacts(v) {
  if (v === null) return null;
  fields(v, ['target_refs', 'result']); list(v.target_refs, 8); unique(v.target_refs); v.target_refs.forEach(exact);
  const r = v.result; check(object(r)); list(r.target_refs, 8); unique(r.target_refs); r.target_refs.forEach(exact);
  check(r.target_refs.every(ref => v.target_refs.some(target => same(target, ref))));
  check(['decision', 'deferred', 'refused'].includes(r.status));
  check([null, 'positive', 'negative', 'uncertain'].includes(r.branch));
  if (r.decision !== null) {
    check(object(r.decision) && typeof r.decision.value?.relevant === 'boolean');
    check(Number.isFinite(r.decision.confidence) && r.decision.confidence >= 0 && r.decision.confidence <= 1);
    if (r.status === 'decision') check(r.branch === (r.decision.value.relevant ? 'positive' : 'negative'));
  } else check(r.status !== 'decision');
  if (r.branch === 'negative') check(r.target_refs.length === 0);
  // Runtime output is fixed and already bounded; select fields explicitly so
  // even extra adapter prose cannot enter a replay trace.
  const result = pick(r, ['schema_version', 'status', 'invocation_id', 'node_id', 'input_hash', 'result_digest', 'decision_schema',
    'selection', 'target_refs', 'branch', 'reason_code', 'attempts', 'usage', 'cache']);
  result.decision = r.decision === null ? null : { ...pick(r.decision, ['value', 'confidence', 'latency_ms', 'provider', 'model', 'reason_code']) };
  result.target_refs = sorted(result.target_refs); return { target_refs: sorted(v.target_refs), result };
}
function judgeSign(c, judge) {
  if (judge === null) return { raw: 0, reason: 'not_configured' };
  if (!judge.target_refs.some(ref => same(ref, c.ref))) return { raw: 0, reason: 'not_evaluated' };
  const r = judge.result;
  if (r.status !== 'decision') return { raw: 0, reason: r.status === 'deferred' ? 'uncertain' : 'unavailable' };
  if (r.branch === 'negative') return { raw: -1, reason: 'confident_negative' };
  return r.target_refs.some(ref => same(ref, c.ref)) ? { raw: 1, reason: 'confident_positive' } : { raw: 0, reason: 'positive_unselected' };
}
const bucket = distance => distance === 0 ? 4 : distance <= 3 ? 3 : distance <= 15 ? 2 : distance <= 63 ? 1 : 0;
const factor = (method, raw, weight, support_refs) => ({ method, raw, weight, contribution: raw * weight, support_refs });

/** Pure ordering of authorized facts. This helper cannot grant read authority. */
export function rankContextWindowV1(input) {
  const r = copyQueryFacts(input); fields(r, ['candidates', 'shared', 'seen_refs', 'judge']);
  list(r.candidates, 64); list(r.seen_refs, 32); unique(r.seen_refs); r.seen_refs.forEach(exact);
  const byKey = new Map();
  for (const c of r.candidates.map(candidate)) {
    const prior = byKey.get(c.key);
    if (prior) {
      check(same({ ...prior, source_reasons: [] }, { ...c, source_reasons: [] }));
      prior.source_reasons = sorted([...new Map([...prior.source_reasons, ...c.source_reasons].map(reason => [canonical(reason), reason])).values()]);
    } else byKey.set(c.key, c);
  }
  const candidates = [...byKey.values()].sort((a, b) => compareText(canonical(a.ref), canonical(b.ref)) || compareText(a.key, b.key));
  const shared = sharedFacts(r.shared), judge = judgeFacts(r.judge), seen_refs = sorted(r.seen_refs);
  const groups = new Map();
  for (const c of candidates) {
    if (c.group === null || Object.keys(c.group).length === 1) continue;
    if (groups.has(c.group.key)) check(same(groups.get(c.group.key), c.group)); else groups.set(c.group.key, c.group);
  }
  for (const g of groups.values()) {
    const members = candidates.filter(c => c.conflict_group === g.key);
    check(same(members.map(c => c.key).sort(), g.member_keys));
    check(g.projected_refs.every(ref => members.some(c => same(c.ref, ref))));
    check(members.every(c => c.exploration_id === g.exploration_id && c.layer === g.layer
      && c.ref.entity_id === g.entity_id && same(c.selection.at, g.at)));
  }
  for (const c of candidates) check(c.conflict_group === null || groups.has(c.conflict_group));
  const replayCandidates = candidates.map(c => c.conflict_group === null ? c : ({ ...c,
    group: c.key === groups.get(c.conflict_group).member_keys[0] ? groups.get(c.conflict_group) : { key: c.conflict_group } }));
  const firstText = new Map(), variants = [];
  for (const c of candidates) {
    const redundancyKey = canonical([c.exploration_id, c.text.text_digest]), previous = firstText.get(redundancyKey);
    if (!previous) firstText.set(redundancyKey, c.ref);
    const refs = [c.ref], sign = judgeSign(c, judge), factors = {
      exact: factor('explicit_exact_source', Number(c.source_reasons.some(s => s.kind === 'exact')), 100, refs),
      scope: factor('verified_requested_dimensions', c.scope_match.verified_dimensions, 20,
        c.scope_match.dimensions.filter(d => d.status === 'matched').flatMap(d => d.support_refs)),
      text: factor(c.text.evaluated ? 'context-text-v1' : 'text_not_evaluated', c.text.matched_distinct_terms, 10, refs),
      lineage: factor('authorized_one_hop', Number(c.source_reasons.some(s => s.kind === 'lineage')), 5, refs),
      freshness: factor('publication_commit_distance', bucket(c.selected_sequence - c.publication.sequence), 3, refs),
      novelty: factor('declared_seen_refs_absence', Number(!seen_refs.some(ref => same(ref, c.ref))), 2, refs),
      consequence: factor('role_heuristic', ['decision', 'constraint'].includes(c.item.meaning.role) ? 2 : 1, 1, refs),
      redundancy: factor('same_exploration_normalized_text', Number(Boolean(previous)), -2, previous ? [previous, c.ref] : refs),
      judge: { ...factor('captured_context_judge', sign.raw, 30, judge?.target_refs ?? []), reason: sign.reason },
      authority: factor('local_context_has_no_governing_authority', 0, 0, refs),
    };
    variants.push({ key: c.key, ref: c.ref, score: Object.values(factors).reduce((n, f) => n + f.contribution, 0), factors,
      freshness: { publication: c.publication, selected_sequence: c.selected_sequence, observed_sequence: c.selection.observed_sequence,
        commit_lag: c.selection.commit_lag, watermarks: c.selection.watermarks }, governing: false });
  }
  const units = [], emitted = new Set();
  for (const c of candidates) {
    const key = c.conflict_group ?? c.key; if (emitted.has(key)) continue; emitted.add(key);
    const members = c.conflict_group ? candidates.filter(member => member.conflict_group === key) : [c];
    if (members.every(member => member.scope_match.status === 'mismatch')) continue;
    units.push({ key, layer: c.layer, exploration_id: c.exploration_id, member_keys: members.map(member => member.key),
      score: Math.max(...members.map(member => variants.find(v => v.key === member.key).score)) });
  }
  const unitTie = unit => unit.member_keys.length > 1 || byKey.get(unit.member_keys[0]).conflict_group
    ? unit.key : canonical(byKey.get(unit.member_keys[0]).ref);
  units.sort((a, b) => (a.layer === 'own' ? 0 : 1) - (b.layer === 'own' ? 0 : 1)
    || compareText(a.exploration_id, b.exploration_id) || b.score - a.score || compareText(unitTie(a), unitTie(b)));
  const sharedTrace = shared.documents.map(d => ({ key: d.key, ref: d.ref,
    governing: shared.mandatory_authority_keys.includes(d.key),
    authority: { method: 'configured_active_canonical_authority', verified: shared.mandatory_authority_keys.includes(d.key), support_refs: [d.ref] },
    text: shared.text_matches.find(t => t.key === d.key) }));
  const trace = { version: CONTEXT_RANK_VERSION, text_version: CONTEXT_TEXT_VERSION,
    replay_input: { candidates: replayCandidates, shared, seen_refs, judge },
    variants, shared: sharedTrace, ordered_units: units };
  const rank_digest = hash(trace);
  // Bound the emitted replay/factor envelope as well as its input.
  check(Buffer.byteLength(JSON.stringify(trace)) <= 1048576);
  return freeze({ version: CONTEXT_RANK_VERSION, units, trace, rank_digest });
}
