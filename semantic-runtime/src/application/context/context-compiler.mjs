import { fingerprint, canonical } from '../../domain/shared/contracts.mjs';
import {
  CONTEXT_COMPILER_VERSION,
  CONTEXT_PACKAGE_LAYERS,
  contextPackageFailure,
  contextPackageId,
  validateContextPackage,
} from '../../domain/context/context-package.mjs';
import { LocalQueryEngine } from '../query/query-engine.mjs';
import { queryCopy, queryRequest } from '../query/query-contract.mjs';

const digest = value => `sha256:${fingerprint(value)}`;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const same = (left, right) => canonical(left) === canonical(right);
const check = (condition, code = 'context_compiler_invalid') => { if (!condition) throw contextPackageFailure(code); };
const fields = (value, required) => check(value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key)));
const integer = (value, low, high) => check(Number.isSafeInteger(value) && value >= low && value <= high);
const identifier = value => check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value));
const unique = values => [...new Map(values.map(value => [canonical(value), value])).values()];
const pointerKey = value => `pointer/${fingerprint(value)}`;
const itemTextKey = (layer, title, body) => `${layer}/${fingerprint([title.normalize('NFKC').toLowerCase(), body.normalize('NFKC').toLowerCase()])}`;
const semanticPriority = item => ({ canonical: 4, resolved: 3, validated: 2, candidate: 1 }[item.status] ?? 0);

export function contextCompilerRequest(input) {
  const value = queryCopy(input);
  fields(value, ['schema_version', 'query', 'compiler', 'window_profile', 'capabilities', 'budget', 'injection']);
  check(value.schema_version === 1); const query = queryRequest(value.query);
  fields(value.compiler, ['policy_id', 'policy_version']); identifier(value.compiler.policy_id); identifier(value.compiler.policy_version);
  fields(value.window_profile, ['profile_id', 'context_window_tokens', 'reserved_output_tokens']);
  identifier(value.window_profile.profile_id); integer(value.window_profile.context_window_tokens, 1, 1048576);
  integer(value.window_profile.reserved_output_tokens, 0, value.window_profile.context_window_tokens - 1);
  fields(value.capabilities, ['callbacks', 'hard_injection', 'markdown', 'source_links']);
  Object.values(value.capabilities).forEach(flag => check(typeof flag === 'boolean'));
  fields(value.budget, ['max_tokens']); integer(value.budget.max_tokens, 1, 1048576);
  check(value.budget.max_tokens <= value.window_profile.context_window_tokens - value.window_profile.reserved_output_tokens);
  fields(value.injection, ['requested_mode', 'reasons']); check(['silent', 'soft', 'hard'].includes(value.injection.requested_mode));
  check(Array.isArray(value.injection.reasons) && value.injection.reasons.length <= 16);
  value.injection.reasons.forEach(identifier);
  return queryCopy({ ...value, query, injection: { ...value.injection, reasons: [...value.injection.reasons].sort() } });
}

function normalizePages(pages) {
  check(Array.isArray(pages) && pages.length > 0 && pages.length <= 64, 'context_compiler_query_incomplete');
  const first = pages[0];
  const stableKeys = ['schema_version', 'request_digest', 'consumer', 'selection', 'shared', 'rank_trace', 'coverage', 'degradation'];
  check(first?.schema_version === 1 && typeof first.window_id === 'string' && Array.isArray(first.items));
  for (const page of pages) {
    check(page?.schema_version === 1 && page.window_id === first.window_id && Array.isArray(page.items));
    for (const key of stableKeys) check(same(page[key], first[key]), 'context_compiler_query_changed');
  }
  check(pages.at(-1).cursor === null, 'context_compiler_query_incomplete');
  const items = [], itemKeys = new Set();
  for (const page of pages) for (const item of page.items) {
    check(item && typeof item.key === 'string' && !itemKeys.has(item.key), 'context_compiler_query_changed');
    itemKeys.add(item.key); items.push(item);
  }
  const omissions = unique(pages.flatMap(page => page.omissions ?? []));
  const normalized = Object.fromEntries(stableKeys.map(key => [key, first[key]]));
  normalized.items = items; normalized.omissions = omissions;
  return { normalized, query_result_digest: digest(normalized) };
}

function textForRecord(document) {
  const record = document.record;
  if (document.kind === 'ticket') {
    const active = record.acceptance?.filter(entry => entry.state === 'active') ?? [];
    const lines = [record.context, record.outcome,
      ...active.map(entry => `${entry.acceptance_id}: ${entry.criterion}`), ...(record.constraints ?? [])];
    return { title: record.ticket_id ?? record.outcome, body: lines.filter(Boolean).join('\n') };
  }
  if (document.kind === 'room') return { title: record.room_id ?? record.description, body: [record.description, record.boundary].filter(Boolean).join('\n') };
  if (document.kind === 'ticket_evidence') return { title: record.evidence_id ?? record.summary, body: record.summary ?? '' };
  if (document.kind === 'ticket_outcome') return { title: record.outcome_id ?? record.summary, body: record.summary ?? '' };
  if (document.kind === 'context') {
    const authority = record.authority;
    const rules = authority ? [
      ...(authority.canonical ?? []).map(value => `Canonical: ${value}`),
      ...(authority.update_rules ?? []).map(value => `Update: ${value}`),
      ...(authority.validation ?? []).map(value => `Validate: ${value}`),
    ] : [];
    return { title: record.summary ?? record.context_id, body: [record.detail, ...rules].filter(Boolean).join('\n') };
  }
  return { title: record.summary ?? record.outcome ?? document.record_key, body: record.detail ?? record.context ?? '' };
}

function sharedLayer(document, query) {
  const related = document.exploration_id !== null && query.selection.scopes.some(scope => scope.layer === 'notice'
    && scope.exploration_id === document.exploration_id);
  if (related) return 'other_exploration_awareness';
  if (query.shared.mandatory_authority_keys.includes(document.key) || document.record?.type === 'authority') return 'governing_context';
  if (document.kind === 'ticket') return 'task_contract';
  if (['ticket_evidence', 'ticket_outcome'].includes(document.kind)) return 'evidence';
  if (document.kind === 'context' && ['decision', 'constraint', 'contract'].includes(document.record?.type)) return 'decisions_and_constraints';
  return 'governing_context';
}

function candidateLayer(unit) {
  if (unit.layer === 'notice') return 'other_exploration_awareness';
  if (unit.kind === 'conflict') return 'unresolved';
  const role = unit.item?.meaning?.role ?? unit.pointer?.role;
  if (['decision', 'constraint'].includes(role)) return 'decisions_and_constraints';
  if (role === 'evidence') return 'evidence';
  if (role === 'question') return 'unresolved';
  return 'working_state';
}

function sharedPointer(document) {
  return { key: pointerKey(['canonical', document.key]), kind: 'canonical_record', ref: document.ref,
    record_key: document.record_key, record_kind: document.kind, selection_role: document.role,
    exploration_id: document.exploration_id, event_ref: document.event_ref };
}

function candidatePointer(unit) {
  const compact = unit.pointer ?? {};
  return { key: pointerKey(['semantic', unit.key]), kind: unit.kind === 'conflict' ? 'semantic_conflict' : 'semantic_context',
    ref: unit.ref ?? null, exploration_id: unit.exploration_id, publication: unit.publication ?? null,
    sources: unit.item?.sources ?? compact.sources ?? null,
    transition: unit.item?.transition ?? compact.transition ?? null,
    source_reasons: unit.source_reasons ?? [] };
}

function semanticItem({ key, title, body, status, pointer_keys, mandatory = false, text_available = true, variants }) {
  return { key, title, body: mandatory ? body : null, text_state: mandatory ? 'materialized' : 'pointer', status,
    pointer_keys, ...(variants ? { variants } : {}), _body: body, _mandatory: mandatory, _text_available: text_available };
}

function classify(query) {
  const layers = new Map(CONTEXT_PACKAGE_LAYERS.map(id => [id, []]));
  const pointers = new Map();
  const omissions = [...query.omissions.map((entry, index) => ({ key: entry.key ?? entry.source_id ?? `query/${index}`,
    reason: entry.reason ?? 'query_omission', source: 'query' }))];
  const add = (layer, item, pointer) => {
    pointers.set(pointer.key, pointer); item.pointer_keys = unique([...item.pointer_keys, pointer.key]);
    const duplicate = layers.get(layer).find(existing => itemTextKey(layer, existing.title, existing._body) === itemTextKey(layer, item.title, item._body));
    if (duplicate && !item.variants && !duplicate.variants) {
      const retained = semanticPriority(item) > semanticPriority(duplicate) ? item : duplicate;
      const omitted = retained === item ? duplicate : item;
      const combinedPointers = unique([...duplicate.pointer_keys, ...item.pointer_keys]);
      if (retained === item) Object.assign(duplicate, item);
      duplicate.pointer_keys = combinedPointers;
      omissions.push({ key: omitted.key, reason: 'semantic_duplicate', source: 'compiler', duplicate_of: retained.key });
      return;
    }
    layers.get(layer).push(item);
  };
  for (const document of query.shared.documents) {
    const layer = sharedLayer(document, query), text = textForRecord(document), pointer = sharedPointer(document);
    const mandatory = layer === 'governing_context' && query.shared.mandatory_authority_keys.includes(document.key);
    add(layer, semanticItem({ key: document.key, ...text, status: 'canonical', pointer_keys: [pointer.key], mandatory }), pointer);
  }
  for (const unit of query.items) {
    const layer = candidateLayer(unit);
    if (unit.kind === 'conflict') {
      const pointer = candidatePointer(unit); pointers.set(pointer.key, pointer);
      const variants = unit.members.map(member => {
        const memberPointer = candidatePointer(member); pointers.set(memberPointer.key, memberPointer);
        return { key: member.key, title: member.item?.meaning?.summary ?? member.ref.entity_id,
          body: null, text_state: 'pointer', pointer_keys: [memberPointer.key], _body: member.item?.meaning?.detail ?? '',
          _text_available: member.item !== null };
      });
      layers.get(layer).push(semanticItem({ key: unit.key, title: `Unresolved alternatives (${variants.length})`, body: '',
        status: 'contested', pointer_keys: [pointer.key, ...variants.flatMap(variant => variant.pointer_keys)], mandatory: true, variants }));
      continue;
    }
    const pointer = candidatePointer(unit), text = unit.item?.meaning;
    add(layer, semanticItem({ key: unit.key, title: text?.summary ?? unit.ref.entity_id, body: text?.detail ?? '',
      status: unit.item?.assertion_status ?? unit.pointer?.assertion_status
        ?? unit.item?.projection?.status ?? unit.pointer?.projection?.status ?? 'unknown',
      pointer_keys: [pointer.key], text_available: unit.item !== null }), pointer);
  }
  for (const [layer, items] of layers) {
    if (layer === 'source_pointers') continue;
    for (const item of items) {
      if (!item._mandatory && item._text_available) omissions.push({ key: item.key, reason: 'text_budget', source: 'compiler' });
      for (const variant of item.variants ?? []) if (variant._text_available) {
        omissions.push({ key: variant.key, reason: 'text_budget', source: 'compiler' });
      }
    }
  }
  layers.set('source_pointers', [...pointers.values()].sort((left, right) => left.key.localeCompare(right.key)));
  return { layers, omissions };
}

function selectionPins(query) {
  const scopes = query.selection.scopes.map(scope => ({ layer: scope.layer, exploration_id: scope.exploration_id,
    generation_id: scope.generation_id, selected: scope.at, observed_head: scope.observed_head,
    update_available: !same(scope.at, scope.observed_head) || scope.commit_lag > 0,
    shared_base: scope.shared_base, catalog_pin: scope.catalog_pin, watermarks: scope.watermarks }));
  const materials = new Map(query.shared.origins.map(origin => [origin.exploration_id, origin.material]));
  return { source_fence: query.selection.source_fence, project: query.selection.project, scopes,
    shared_bases: scopes.map(scope => ({ exploration_id: scope.exploration_id, selected: scope.shared_base,
      status: materials.get(scope.exploration_id)?.status ?? 'unavailable',
      update_available: materials.get(scope.exploration_id)?.status === 'historical' })),
    lineage: query.selection.lineage };
}

function recommendation(request, classified, query) {
  const count = [...classified.layers.entries()].filter(([id]) => id !== 'source_pointers').reduce((sum, [, items]) => sum + items.length, 0);
  let mode = count ? request.injection.requested_mode : 'silent';
  const reasons = [...request.injection.reasons];
  const unsafe = classified.layers.get('unresolved').length > 0 || query.selection.freshness.status !== 'satisfied'
    || query.shared.current_project.status === 'unavailable';
  if (mode === 'hard' && (!request.capabilities.hard_injection || unsafe)) {
    mode = 'soft'; reasons.push(!request.capabilities.hard_injection ? 'host_hard_injection_unavailable' : 'hard_injection_requires_stable_context');
  }
  if (!count) reasons.push('no_context_available');
  return { mode, reasons: [...new Set(reasons)].sort(), executable: false };
}

function publicItem(item) {
  const { _body: _body, _mandatory: _mandatory, _text_available: _textAvailable, ...value } = item;
  if (value.variants) value.variants = value.variants.map(variant => {
    const { _body: _variantBody, _text_available: _variantTextAvailable, ...publicVariant } = variant; return publicVariant;
  });
  return value;
}

function packageDraft(request, query, queryResultDigest, classified) {
  return { schema_version: 1, kind: 'context_package', package_id: `sha256:${'0'.repeat(64)}`,
    query_result_digest: queryResultDigest, request_digest: query.request_digest, rank_digest: query.rank_trace.rank_digest,
    compiler: { compiler_version: CONTEXT_COMPILER_VERSION, ...request.compiler }, consumer: query.consumer,
    window_profile: request.window_profile, capabilities: request.capabilities,
    recommendation: recommendation(request, classified, query), pins: selectionPins(query),
    layers: CONTEXT_PACKAGE_LAYERS.map(id => ({ id, items: id === 'source_pointers'
      ? classified.layers.get(id) : classified.layers.get(id).map(publicItem) })),
    omissions: [...classified.omissions], usage: { accounting: 'utf8_bytes_upper_bound', max_tokens: request.budget.max_tokens, used_tokens: request.budget.max_tokens } };
}

function fits(value) { return bytes(value) <= value.usage.max_tokens; }

export function compileContextPages(pages, rawRequest) {
  const request = contextCompilerRequest(rawRequest), { normalized: query, query_result_digest } = normalizePages(pages);
  check(query.request_digest === digest(request.query), 'context_compiler_query_changed');
  const classified = classify(query), draft = packageDraft(request, query, query_result_digest, classified);
  if (!fits(draft)) throw contextPackageFailure('context_package_budget_too_small');
  const publicLayers = new Map(draft.layers.map(layer => [layer.id, layer]));
  const candidates = CONTEXT_PACKAGE_LAYERS.slice(0, -1).flatMap(id => classified.layers.get(id)
    .filter(item => !item._mandatory && item._text_available).map(item => ({ layer: id, item })));
  for (const candidate of candidates) {
    const selected = publicLayers.get(candidate.layer).items.find(item => item.key === candidate.item.key);
    selected.body = candidate.item._body; selected.text_state = 'materialized';
    const index = draft.omissions.findIndex(omission => omission.key === candidate.item.key && omission.reason === 'text_budget');
    const [omission] = index < 0 ? [] : draft.omissions.splice(index, 1);
    if (!fits(draft)) {
      selected.body = null; selected.text_state = 'pointer';
      if (omission) draft.omissions.splice(index, 0, omission);
    }
  }
  for (const [layer, source] of classified.layers) for (const item of source) {
    if (!item.variants) continue;
    const selected = publicLayers.get(layer)?.items.find(value => value.key === item.key);
    if (!selected) continue;
    for (let index = 0; index < item.variants.length; index++) {
      if (!item.variants[index]._text_available) continue;
      selected.variants[index].body = item.variants[index]._body; selected.variants[index].text_state = 'materialized';
      const omissionIndex = draft.omissions.findIndex(omission => omission.key === item.variants[index].key && omission.reason === 'text_budget');
      const [omission] = omissionIndex < 0 ? [] : draft.omissions.splice(omissionIndex, 1);
      if (!fits(draft)) {
        selected.variants[index].body = null; selected.variants[index].text_state = 'pointer';
        if (omission) draft.omissions.splice(omissionIndex, 0, omission);
      }
    }
  }
  draft.package_id = contextPackageId(draft);
  for (let pass = 0; pass < 4; pass++) {
    const measured = bytes(draft); if (measured === draft.usage.used_tokens) break; draft.usage.used_tokens = measured;
  }
  check(draft.usage.used_tokens <= draft.usage.max_tokens, 'context_package_budget_too_small');
  return validateContextPackage(draft);
}

/** Retrieves one permission-checked Query window, then compiles an informational package. */
export class LocalContextCompiler {
  #query;
  constructor({ query_engine }) {
    check(query_engine instanceof LocalQueryEngine, 'context_compiler_query_binding_mismatch'); this.#query = query_engine;
  }
  async compile(context, input, options = {}) {
    const request = contextCompilerRequest(input), pages = [];
    let page = await this.#query.query(context, request.query, options); pages.push(page);
    while (page.cursor !== null) {
      check(pages.length < 64, 'context_compiler_query_incomplete');
      page = await this.#query.next(context, { cursor: page.cursor }, options); pages.push(page);
    }
    return compileContextPages(pages, request);
  }
}
