import { randomUUID } from 'node:crypto';
import { QueryInputs } from './query-inputs.mjs';
import { queryRequest, queryCopy, queryCheck, queryFailure, querySignal } from './query-contract.mjs';
import { graphFields, graphHash, graphEqual, graphErrorCode } from '../graph/graph-inputs.mjs';
import { LocalJudgeRuntime, assertJudgeRuntimeBinding } from '../judge/judge-runtime.mjs';
import { matchContextTextV1 } from '../../domain/query/query-text.mjs';
import { rankContextWindowV1 } from '../../domain/query/query-ranking.mjs';

const evaluateContext = LocalJudgeRuntime.prototype.evaluateContext;
const stop = signal => { if (signal?.aborted) throw queryFailure('query_cancelled'); };
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const sameActor = (a, b) => graphEqual(a, b);
const codeOf = error => {
  const code = graphErrorCode(error);
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'query_unavailable';
};
const canonicalText = record => {
  if (record.kind === 'room') return [record.description, record.boundary];
  if (record.kind === 'ticket') return [record.outcome];
  return [record.summary, record.detail].filter(value => typeof value === 'string');
};
const lineagePointers = lineage => lineage === null ? null : { ...lineage,
  links: lineage.links.map(({ item, ...link }) => ({ ...link, ...(item ? { item_ref: item.ref } : {}) })) };

function candidateUnit(candidate, score) {
  return { kind: 'context', key: candidate.key, layer: candidate.layer, exploration_id: candidate.exploration_id,
    ref: candidate.ref, item: candidate.item, source_reasons: candidate.source_reasons, scope_match: candidate.scope_match,
    publication: candidate.publication, rank: { score, trace_key: candidate.key }, text_omitted: false };
}
function pointer(unit) {
  if (unit.kind === 'conflict') return { ...unit, members: unit.members.map(pointer), text_omitted: true };
  const { meaning, transition, projection, ...metadata } = unit.item;
  return { ...unit, item: null, pointer: { ...metadata,
    projection: { head: projection.head, status: projection.status, quarantined: projection.quarantined },
    role: meaning.role, change: meaning.change.kind,
    transition: { kind: transition.kind, ...(transition.structural_reason ? { structural_reason: transition.structural_reason } : {}) } }, text_omitted: true };
}
function textDocuments(prepared) {
  return [...prepared.candidates.map(c => ({ key: c.key, fields: [c.item.meaning.summary, c.item.meaning.detail] })),
    ...prepared.shared.documents.map(d => ({ key: d.key, fields: canonicalText(d.record) }))];
}
function rank(prepared, request, text, judge) {
  const groups = new Map(prepared.conflict_groups.map(group => [group.key, group]));
  const selections = new Map(prepared.selection.scopes.map(s => [s.exploration_id, s]));
  const matches = new Map(text.matched.map(match => [match.key, match]));
  return rankContextWindowV1({ candidates: prepared.candidates.map(candidate => ({ ...candidate,
    text: matches.get(candidate.key), selection: selections.get(candidate.exploration_id),
    group: candidate.conflict_group === null ? null : candidate.key === groups.get(candidate.conflict_group).member_keys[0]
      ? groups.get(candidate.conflict_group) : { key: candidate.conflict_group } })),
    shared: { ...prepared.shared, text_matches: prepared.shared.documents.map(d => matches.get(d.key)) },
    seen_refs: request.seen_refs, judge });
}
function rankedUnits(prepared, ranked) {
  const candidates = new Map(prepared.candidates.map(c => [c.key, c]));
  const groups = new Map(prepared.conflict_groups.map(g => [g.key, g]));
  const scores = new Map(ranked.trace.variants.map(variant => [variant.key, variant.score]));
  return ranked.units.map(unit => {
    const members = unit.member_keys.map(key => candidateUnit(candidates.get(key), scores.get(key)));
    const group = groups.get(unit.key);
    return group ? { kind: 'conflict', key: unit.key, layer: unit.layer, exploration_id: unit.exploration_id,
      group, members, rank: { score: unit.score, trace_key: unit.key }, text_omitted: false } : members[0];
  });
}
function responseBase({ id, grant, request, prepared, text, ranked, evaluations, degradation }) {
  return { schema_version: 1, request_digest: prepared.request_digest, window_id: id,
    consumer: { ...grant, ...request.consumer }, selection: { ...prepared.selection, freshness: prepared.freshness,
      lineage: lineagePointers(prepared.lineage) },
    shared: { ...prepared.shared, text_matches: text.matched.filter(m => prepared.shared.documents.some(d => d.key === m.key)) },
    rank_trace: { ...ranked.trace, version: ranked.version, rank_digest: ranked.rank_digest },
    coverage: { ...prepared.coverage, text: text.coverage, embeddings: 'not_configured', judge: [...evaluations.values()] },
    degradation, omissions: prepared.omissions };
}

/** One bounded authorized retrieval window. No persistent index, Worker, or source mutation. */
export class LocalQueryEngine {
  #inputs; #store; #authority; #judge; #windows = new Map(); #bytes = 0;
  constructor({ store, authority, canonical_reader, judge_runtime = null }) {
    this.#inputs = new QueryInputs({ store, authority, canonical_reader });
    queryCheck(judge_runtime === null || judge_runtime instanceof LocalJudgeRuntime, 'query_judge_binding_mismatch');
    this.#store = store; this.#authority = authority; this.#judge = judge_runtime;
  }
  #binding(grant) {
    if (this.#judge !== null) assertJudgeRuntimeBinding(this.#judge, { store: this.#store, authority: this.#authority,
      canonical_digest: this.#inputs.config_digest, scope: grant.scope });
  }
  #remember(entry) {
    // Bound serialized retained material; this is not a JavaScript heap-size measurement.
    entry.bytes = bytes({ request: entry.request, prepared: entry.prepared, base: entry.base, units: entry.units });
    queryCheck(entry.bytes <= 8 * 1024 * 1024, 'query_capacity');
    while (this.#windows.size >= 16 || this.#bytes + entry.bytes > 8 * 1024 * 1024) {
      const key = this.#windows.keys().next().value; this.#bytes -= this.#windows.get(key).bytes; this.#windows.delete(key);
    }
    this.#windows.set(entry.id, entry); this.#bytes += entry.bytes;
  }
  #forget(entry) { if (this.#windows.delete(entry.id)) this.#bytes -= entry.bytes; }
  #page(entry, position, track = true) {
    const selected = entry.units.slice(position, position + entry.request.budget.max_results);
    const nextPosition = position + selected.length;
    const cursor = nextPosition < entry.units.length ? { window_id: entry.id, position: nextPosition } : null;
    const base = { ...entry.base, items: selected.map(pointer), omissions: [...entry.base.omissions], cursor };
    // Every exact source/status/conflict reference and shared Authority is accounted for first.
    for (const unit of base.items) base.omissions.push({ key: unit.key, reason: 'text_budget', text_omitted: true });
    queryCheck(bytes(base) <= entry.request.budget.token_budget, 'query_budget_too_small');
    for (let index = 0; index < selected.length; index++) {
      const next = { ...base, items: [...base.items], omissions: base.omissions.filter(o => o.key !== selected[index].key) };
      next.items[index] = selected[index];
      if (bytes(next) <= entry.request.budget.token_budget) { base.items = next.items; base.omissions = next.omissions; }
    }
    const result = queryCopy(base);
    if (track && cursor) entry.positions.add(nextPosition);
    return result;
  }
  #preflight(entry) {
    // A cursor is a promise that every remaining atomic unit can be returned
    // under the same budget. Prove all pointer-only pages before publishing
    // the first page or retaining a window.
    if (!entry.units.length) { this.#page(entry, 0, false); return; }
    for (let position = 0; position < entry.units.length; position += entry.request.budget.max_results) {
      this.#page(entry, position, false);
    }
  }
  async query(context, input, options = {}) {
    const signal = querySignal(options), request = queryRequest(input); stop(signal);
    const grant = this.#inputs.grant(context); this.#binding(grant);
    const prepared = this.#inputs.prepare(context, request); stop(signal);
    const text = matchContextTextV1({ documents: textDocuments(prepared), text: request.text });
    const baseline = rank(prepared, request, text, null);
    const id = randomUUID();
    const degradation = [{ code: 'embeddings_not_configured' }, ...(text.degradation ? [text.degradation] : [])];
    const evaluations = new Map(prepared.candidates.map(c => [c.key, { ref: c.ref, status: 'not_evaluated', reason: 'not_requested' }]));
    // Prove that the mandatory local pointer envelope fits before spending an
    // optional provider call. The final Judge-shaped response is preflighted
    // again below because it can only be larger.
    this.#preflight({ id, request, base: responseBase({ id, grant, request, prepared, text, ranked: baseline,
      evaluations, degradation }), units: rankedUnits(prepared, baseline) });
    let judge = null;
    if (request.judge !== null) {
      const byKey = new Map(prepared.candidates.map(c => [c.key, c]));
      const ordered = baseline.units.flatMap(unit => unit.member_keys.map(key => byKey.get(key)));
      const targets = [];
      for (const candidate of ordered) {
        const item = candidate.item;
        const reason = candidate.layer !== 'own' ? 'related_notice' : request.own.mode !== 'current' ? 'historical_selection'
          : candidate.conflict_group !== null || item.projection.competing.length ? 'contested'
            : item.historical_role !== 'head' || !graphEqual(candidate.ref, item.projection.head) ? 'historical_revision'
              : item.projection.quarantined || !['candidate', 'validated', 'resolved'].includes(item.assertion_status)
                || !['candidate', 'validated', 'resolved'].includes(item.projection.status) ? 'ineligible_lifecycle'
                : Buffer.byteLength(`${item.meaning.role}\n${item.meaning.summary}\n\n${item.meaning.detail}`) > 4096 ? 'target_text_capacity'
                  : targets.length >= 8 ? 'target_limit' : this.#judge === null ? 'judge_not_configured' : null;
        evaluations.set(candidate.key, { ref: candidate.ref, status: 'not_evaluated', reason: reason ?? 'pending' });
        if (reason === null) targets.push(candidate);
      }
      if (this.#judge === null) degradation.push({ code: 'judge_not_configured' });
      else if (targets.length) {
        this.#inputs.assertCurrent(context, prepared); stop(signal);
        let result;
        try {
          result = await evaluateContext.call(this.#judge, context, { ...request.judge,
            invocation_id: `query/${graphHash([request.request_id, request]).slice(7)}`, exploration_id: request.own.exploration_id,
            expected_project_selection_version: request.expected_project_selection_version, at: request.own.at,
            target_refs: targets.map(c => c.ref), expected_source_fence: request.expected_source_fence }, { signal });
        } catch (error) { degradation.push({ code: 'judge_unavailable', reason: codeOf(error) }); }
        stop(signal);
        // The same exact local proof gates a fallback as well as a positive model result.
        this.#inputs.assertCurrent(context, prepared);
        if (result) {
          judge = { target_refs: targets.map(c => c.ref), result };
          if (result.status !== 'decision') degradation.push({ code: 'judge_unavailable', reason: result.reason_code });
        }
        for (const candidate of targets) evaluations.set(candidate.key, { ref: candidate.ref,
          status: result?.status === 'decision' ? 'evaluated' : 'not_evaluated', reason: result?.reason_code ?? 'judge_unavailable' });
      }
    }
    const ranked = judge ? rank(prepared, request, text, judge) : baseline;
    const units = rankedUnits(prepared, ranked);
    const base = responseBase({ id, grant, request, prepared, text, ranked, evaluations, degradation });
    const entry = { id, context, grant, request, prepared, base, units, positions: new Set() };
    this.#inputs.assertCurrent(context, prepared); stop(signal);
    this.#preflight(entry);
    const result = this.#page(entry, 0);
    this.#inputs.assertCurrent(context, prepared); stop(signal);
    this.#remember(entry); return result;
  }
  async next(context, input, options = {}) {
    const signal = querySignal(options); stop(signal);
    const value = queryCopy(input); graphFields(value, ['cursor']); graphFields(value.cursor, ['window_id', 'position']);
    queryCheck(typeof value.cursor.window_id === 'string' && value.cursor.window_id.length <= 80
      && Number.isSafeInteger(value.cursor.position) && value.cursor.position >= 1, 'query_cursor_expired');
    const grant = this.#inputs.grant(context), entry = this.#windows.get(value.cursor.window_id);
    queryCheck(entry && entry.context === context && sameActor(entry.grant, grant) && entry.positions.has(value.cursor.position), 'query_cursor_expired');
    try {
      this.#inputs.assertCurrent(context, entry.prepared); stop(signal);
      const result = this.#page(entry, value.cursor.position);
      this.#inputs.assertCurrent(context, entry.prepared); stop(signal); return result;
    } catch (error) { this.#forget(entry); throw error; }
  }
}
