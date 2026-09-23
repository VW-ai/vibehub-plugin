/**
 * Fixed internal exploration metadata/route port. Never owns an outer transaction.
 * Construction: new ExplorationInputs({ store, authority, config_digest }).
 * parse(kind, options), grant(context,{write,inspect,adopt}), prior(view,context,{kind,request}),
 * preflight(context,{kind,request}) -> instance-private physical-observation token;
 * bind(view,context,{request,observation,shared}) -> {route,created,generation_id,graph_request};
 * mutation(view,context,{request,observation,shared}) -> {route,graph_request};
 * adoption(view,context,{request,observation,shared,adoption}) -> {route};
 * assertUnchanged(view,context,route), retainOrigin(view,context,route,{previous_graph,next_graph,revision?});
 * finish(view,context,route,{result,graph_request}) -> {receipt,result};
 * getExploration/getBinding/projectSelection/setProjectSelection/list/receipt are metadata only.
 * `shared` is inert {source_fence,origin_base,project_selection:{version,pin}};
 * the fixed Graph facade verifies the actual private canonical proof separately.
 * Routes and observations are branded by this instance; JSON cannot create them.
 */
export const EXPLORATION_NAMESPACE = 'exploration-projection';
import { DomainStore } from '../adapters/sqlite/domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../domain/identity/access-authority.mjs';
import { GIT_ENROLLMENT_NAMESPACE } from './git-projects.mjs';
import { GraphInputs, graphInput, graphFields, graphHash, graphKey, graphEqual, graphId, graphUint, graphErrorCode } from './graph-inputs.mjs';
import { validateGraphCommitAddress2 } from '../core/incremental-graph.mjs';
import { validateSemanticAddress } from '../core/working-graph.mjs';
import { canonical } from '../core/contracts.mjs';
import { observeExplorationGit } from './exploration-physical.mjs';

const NS = EXPLORATION_NAMESPACE, GRAPH = 'working-graph';
export const EXPLORATION_ERROR_CODES = Object.freeze(['invalid_exploration_input', 'exploration_capacity', 'exploration_unauthorized',
  'exploration_unavailable', 'exploration_corrupt', 'unsupported_exploration_format', 'exploration_configuration_mismatch',
  'exploration_idempotency_conflict', 'exploration_binding_conflict', 'exploration_catalog_conflict', 'exploration_selection_conflict',
  'exploration_physical_changed', 'exploration_owned_generation', 'exploration_rebind_required', 'exploration_source_conflict']);
const fail = code => Object.assign(new Error(`Exploration: ${code}`), { code });
const check = (condition, code = 'invalid_exploration_input') => { if (!condition) throw fail(code); };
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const copy = value => frozen(graphInput(value));
const scopeOf = g => ({ tenant_id: g.tenant_id, project_id: g.project_id });
const version = n => check(n === null || Number.isSafeInteger(n) && n > 0);
const execShape = e => { graphFields(e, ['repository_id', 'checkout_id', 'worktree_id']); Object.values(e).forEach(graphId); };
const digest = value => check(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));
const exactAt = (ref, at) => {
  validateSemanticAddress(ref);
  check(ref.kind === 'semantic_revision' && ref.generation_id === at.generation_id && graphEqual(ref.scope, at.scope));
};
const normalizePin = pin => {
  if (pin !== null) { validateExplorationPin(pin); pin.record_keys.sort(); }
};
const samePin = (left, right) => {
  const a = graphInput(left), b = graphInput(right); normalizePin(a); normalizePin(b); return graphEqual(a, b);
};
const destinationOf = (kind, request) => kind === 'adopt' ? request.destination : request;
export function validateExplorationPin(pin) {
  graphFields(pin, ['at', 'address', 'record_keys']); validateGraphCommitAddress2(pin.at); validateSemanticAddress(pin.address);
  check(pin.address.kind === 'semantic_revision' && graphEqual(pin.address.scope, pin.at.scope) && pin.address.generation_id === pin.at.generation_id);
  check(Array.isArray(pin.record_keys) && pin.record_keys.length <= 16 && new Set(pin.record_keys).size === pin.record_keys.length);
  pin.record_keys.forEach(graphId); return true;
}
const bindingKey = execution => graphKey('binding-current', execution);
const commandKey = (g, id) => graphKey('operation', [scopeOf(g), g.principal_id, id]);
const ownerKey = (scope, generation) => graphKey('exploration-owner', [scope, generation]);
const ownerWitnessKey = (scope, generation) => graphKey('exploration-owner-witness', [scope, generation]);
const indexKey = n => `exploration-index/${String(n).padStart(20, '0')}`;
const numbered = (prefix, version) => `${prefix}${String(version).padStart(20, '0')}`;
const bindingPrefix = execution => `binding-version/${graphHash(execution).slice(7)}/`;
const selectionPrefix = 'project-selection-declaration/';
const lastRow = (view, prefix) => view.getSourceRange(NS, { lower: prefix, upper: `${prefix.slice(0, -1)}0`, order: 'desc', after: null, limit: 1 }).rows[0] ?? null;
const seal = value => ({ ...value, identity: graphHash(value) });
function verified(row, kind) {
  if (!row) return null;
  const value = graphInput(row.value), { identity, ...body } = value;
  check(row.kind === kind && graphHash(body) === identity, 'exploration_corrupt'); return value;
}
function selectedCatalog(row, execution) {
  check(row && row.value?.schema_version === 1 && Array.isArray(row.value.checkouts), 'exploration_unavailable');
  const checkout = row.value.checkouts.find(c => c.repository_id === execution.repository_id && c.checkout_id === execution.checkout_id);
  const worktree = checkout?.worktrees.find(w => w.worktree_id === execution.worktree_id);
  check(checkout?.state === 'active' && worktree?.state === 'active' && worktree.status === 'available', 'exploration_unavailable');
  const ref = worktree.branch && !worktree.unborn ? checkout.refs.find(r => r.name === worktree.branch && r.state === 'active') : null;
  check(!worktree.branch || worktree.unborn || ref, 'exploration_rebind_required');
  return { catalog_version: row.version, installation_id: row.value.installation_id, checkout, worktree, ref: ref ?? null };
}
const observedFrom = selected => ({ head: selected.worktree.head, ref_incarnation_id: selected.ref?.ref_incarnation_id ?? null,
  ref_name: selected.worktree.branch, detached: selected.worktree.detached, unborn: selected.worktree.unborn, assurance: 'observed' });
// A moving HEAD on the same registered branch does not silently replace the binding.
// It is a fresh observation for each write. Detached changes and first commits rebind.
const sameBinding = (binding, selected) => {
  const a = binding.observed_git, b = observedFrom(selected);
  return a.ref_incarnation_id === b.ref_incarnation_id && a.detached === b.detached && a.unborn === b.unborn
    && (!a.detached || a.head === b.head) && (!a.unborn || a.ref_name === b.ref_name);
};

/** Mandatory guard lookup, deliberately in working-graph even for legacy callers. */
export function readExplorationOwner(view, { scope, generation_id }) {
  graphFields(scope, ['tenant_id', 'project_id']); Object.values(scope).forEach(graphId); graphId(generation_id);
  const row = view.getSource(GRAPH, ownerKey(scope, generation_id));
  const witnessRow = view.getSource(GRAPH, ownerWitnessKey(scope, generation_id));
  check(Boolean(row) === Boolean(witnessRow), 'exploration_corrupt');
  const value = verified(row, 'exploration-generation-owner'); if (!value) return null;
  const witness = verified(witnessRow, 'exploration-generation-owner-witness');
  check(graphEqual(value, witness), 'exploration_corrupt');
  graphFields(value, ['schema_version', 'kind', 'scope', 'exploration_id', 'generation_id', 'config_digest', 'origin_ref', 'identity']);
  check(value.schema_version === 1 && value.kind === 'exploration-generation-owner' && graphEqual(value.scope, scope)
    && value.generation_id === generation_id, 'exploration_corrupt');
  graphId(value.exploration_id); graphId(value.origin_ref); digest(value.config_digest); return copy(value);
}

export class ExplorationInputs {
  #store; #authority; #config; #graphInputs; #observations = new WeakMap(); #routes = new WeakMap();
  constructor({ store, authority, config_digest }) {
    check(store instanceof DomainStore && authority instanceof AccessAuthority); digest(config_digest);
    this.#store = store; this.#authority = authority; this.#config = config_digest;
    this.#graphInputs = new GraphInputs({ store, authority });
  }
  grant(context, { write = false, inspect = false, adopt = false } = {}) {
    const g = this.#authority.inspect(context), actions = ['store:read', 'graph:read', 'ingress:read', 'source:invalidation:read', 'exploration:read'];
    if (write) actions.push('exploration:write', 'graph:write', 'store:write'); if (inspect) actions.push('project:inspect');
    if (adopt) actions.push('exploration:adopt', 'source:read');
    check(g && g.audience === LOCAL_AUDIENCE && actions.every(a => g.actions.includes(a)) && (!(write || adopt) || ['human', 'service'].includes(g.kind)), 'exploration_unauthorized'); return g;
  }
  parse(kind, options) {
    const input = graphInput(options);
    const shapes = {
      bind: ['epoch', 'idempotency_key', 'publisher_ref', 'execution', 'expected_catalog_version', 'expected_binding_version', 'exploration_id', 'shared_base'],
      mutate: ['epoch', 'idempotency_key', 'publisher_ref', 'execution_workspace_id', 'expected_binding_version', 'expected_catalog_version', 'expected_project_selection_version', 'expected_graph', 'expected_source_fence', 'operation', 'coverage'],
      adopt: ['epoch', 'idempotency_key', 'publisher_ref', 'expected_source_fence', 'source', 'destination', 'endpoint_map'],
      selection: ['epoch', 'idempotency_key', 'expected_version', 'pin']
    };
    check(Object.hasOwn(shapes, kind)); graphFields(input, shapes[kind]); graphUint(input.epoch); graphId(input.idempotency_key);
    if (kind !== 'selection') {
      graphId(input.publisher_ref);
      const destination = destinationOf(kind, input);
      if (kind === 'adopt') graphFields(destination, ['exploration_id', 'execution_workspace_id', 'expected_binding_version', 'expected_catalog_version',
        'expected_project_selection_version', 'expected_graph', 'shared_base']);
      version(destination.expected_catalog_version); check(destination.expected_catalog_version !== null); version(destination.expected_binding_version);
    }
    if (kind === 'bind') {
      execShape(input.execution); if (input.exploration_id !== null) { graphId(input.exploration_id); check(input.shared_base === null); }
      if (input.shared_base !== null) validateExplorationPin(input.shared_base);
    } else if (kind === 'mutate') {
      graphId(input.execution_workspace_id); check(input.expected_binding_version !== null); version(input.expected_project_selection_version);
      validateGraphCommitAddress2(input.expected_graph); graphUint(input.expected_source_fence);
      check(['assert', 'resolve'].includes(input.operation?.kind)); check(input.coverage === null || Array.isArray(input.coverage) && input.coverage.length <= 8);
    } else if (kind === 'adopt') {
      const source = input.source, destination = input.destination;
      graphFields(source, ['exploration_id', 'at', 'address', 'expected_head', 'shared_base']);
      [source.exploration_id, destination.exploration_id, destination.execution_workspace_id].forEach(graphId);
      check(source.exploration_id !== destination.exploration_id && destination.expected_binding_version !== null);
      version(destination.expected_project_selection_version); graphUint(input.expected_source_fence);
      [source.at, source.expected_head, destination.expected_graph].forEach(validateGraphCommitAddress2);
      check(source.at.generation_id === source.expected_head.generation_id && graphEqual(source.at.scope, source.expected_head.scope)
        && source.at.generation_id !== destination.expected_graph.generation_id && graphEqual(source.at.scope, destination.expected_graph.scope));
      exactAt(source.address, source.at); normalizePin(source.shared_base); normalizePin(destination.shared_base);
      for (const pin of [source.shared_base, destination.shared_base].filter(Boolean)) check(graphEqual(pin.at.scope, source.at.scope));
      check(Array.isArray(input.endpoint_map) && input.endpoint_map.length <= 2);
      check(source.address.entity_kind !== 'entity' || input.endpoint_map.length === 0);
      for (const mapping of input.endpoint_map) {
        graphFields(mapping, ['source', 'destination']); exactAt(mapping.source, source.at); exactAt(mapping.destination, destination.expected_graph);
        check(mapping.source.entity_kind === mapping.destination.entity_kind);
      }
      check(new Set(input.endpoint_map.map(mapping => graphHash(mapping.source))).size === input.endpoint_map.length
        && new Set(input.endpoint_map.map(mapping => graphHash(mapping.destination))).size === input.endpoint_map.length);
      input.endpoint_map.sort((a, b) => canonical(a.source) < canonical(b.source) ? -1 : canonical(a.source) > canonical(b.source) ? 1 : 0);
    } else { version(input.expected_version); validateExplorationPin(input.pin); }
    return copy(input);
  }
  #format(view, initialize = false) {
    const row = view.getRecord(NS, 'format');
    if (!row) {
      // Every owned source family sorts in this fixed ASCII range. No table scan.
      const retained = view.getSourceRange(NS, { lower: '0', upper: 'z', order: 'asc', after: null, limit: 1 });
      check(!retained.rows.length && !view.getRecord(NS, 'index-head') && !view.getRecord(NS, 'project-selection'), 'exploration_corrupt');
      if (initialize) view.compareAndSwap(NS, 'format', null, { schema_version: 1, kind: 'exploration_format', config_digest: this.#config }); return null;
    }
    check(row.value?.schema_version === 1 && row.value.kind === 'exploration_format', 'unsupported_exploration_format');
    graphFields(row.value, ['schema_version', 'kind', 'config_digest']);
    check(row.value.config_digest === this.#config, 'exploration_configuration_mismatch'); return row;
  }
  #binding(view, execution) {
    const row = view.getRecord(NS, bindingKey(execution)), latest = lastRow(view, bindingPrefix(execution));
    check(Boolean(row) === Boolean(latest), 'exploration_corrupt'); if (!row) return null;
    const witness = verified(latest, 'execution-workspace-version');
    graphFields(witness, ['schema_version', 'kind', 'execution', 'binding_version', 'execution_workspace_id', 'identity']);
    check(witness.schema_version === 1 && witness.kind === 'execution-workspace-version'
      && graphEqual(witness.execution, execution) && witness.binding_version === row.version
      && latest.id === numbered(bindingPrefix(execution), row.version)
      && witness.execution_workspace_id === row.value.execution_workspace_id, 'exploration_corrupt');
    graphFields(row.value, ['execution_workspace_id']); graphId(row.value.execution_workspace_id);
    const value = verified(view.getSource(NS, row.value.execution_workspace_id), 'execution-workspace');
    check(value && graphEqual(value.execution, execution), 'exploration_corrupt'); return { version: row.version, value };
  }
  #shared(view, context, shared, origin) {
    const s = graphInput(shared); graphFields(s, ['source_fence', 'origin_base', 'project_selection']); graphUint(s.source_fence);
    if (s.origin_base !== null) validateExplorationPin(s.origin_base);
    graphFields(s.project_selection, ['version', 'pin']); version(s.project_selection.version);
    if (s.project_selection.pin !== null) validateExplorationPin(s.project_selection.pin);
    const current = this.projectSelection(view, context);
    check(graphEqual(current, s.project_selection), 'exploration_selection_conflict');
    check(graphEqual(s.origin_base, origin), 'exploration_corrupt');
    const scope = scopeOf(this.grant(context, { write: true }));
    for (const p of [s.origin_base, s.project_selection.pin].filter(Boolean)) check(graphEqual(p.at.scope, scope), 'invalid_exploration_input');
    return copy(s);
  }
  prior(view, context, { kind, request }) {
    const r = this.parse(kind, request); this.grant(context, { write: true, adopt: kind === 'adopt' });
    const prior = this.receipt(view, context, { idempotency_key: r.idempotency_key }, { write: true });
    if (!prior) return null;
    check(prior.receipt.operation === kind && prior.receipt.request_digest === graphHash(r), 'exploration_idempotency_conflict'); return prior;
  }
  receipt(view, context, { idempotency_key }, { write = false } = {}) {
    graphId(idempotency_key); const g = this.grant(context, { write }); this.#format(view);
    const value = verified(view.getSource(NS, commandKey(g, idempotency_key)), 'exploration-operation'); if (!value) return null;
    if (value.receipt.operation === 'adopt') {
      this.grant(context, { write, adopt: true });
      check(graphEqual(value.request, this.parse('adopt', value.request)), 'exploration_corrupt');
    }
    check(value.receipt.actor_kind === g.kind, 'exploration_unauthorized');
    check(value.receipt.actor === g.principal_id && graphEqual(value.receipt.scope, scopeOf(g)) && value.receipt.idempotency_key === idempotency_key
      && value.receipt.config_digest === this.#config && value.receipt.result_digest === graphHash(value.result)
      && value.receipt.request_digest === graphHash(value.request), 'exploration_corrupt');
    return copy({ receipt: value.receipt, result: value.result, graph_request: value.graph_request, request: value.request });
  }
  metadata(view, context, { kind, request }) {
    const r = this.parse(kind, request), g = this.grant(context, { write: true, adopt: kind === 'adopt' }); this.#format(view);
    let execution = null, exploration = null, source = null;
    if (kind === 'bind') {
      execution = r.execution;
      if (r.exploration_id !== null) { exploration = this.getExploration(view, context, { exploration_id: r.exploration_id }, { write: true }); check(exploration, 'exploration_unavailable'); }
    } else if (kind === 'mutate' || kind === 'adopt') {
      const destination = destinationOf(kind, r);
      const binding = verified(view.getSource(NS, destination.execution_workspace_id), 'execution-workspace'); check(binding, 'exploration_unavailable');
      execution = binding.execution;
      exploration = this.getExploration(view, context, { exploration_id: binding.exploration_id }, { write: true }); check(exploration, 'exploration_corrupt');
      if (kind === 'adopt') {
        check(binding.execution_workspace_id === destination.execution_workspace_id && binding.generation_id === exploration.generation_id
          && graphEqual(binding.scope, scopeOf(g)), 'exploration_corrupt');
        check(exploration.exploration_id === destination.exploration_id && exploration.generation_id === destination.expected_graph.generation_id
          && graphEqual(destination.expected_graph.scope, scopeOf(g)), 'exploration_binding_conflict');
        check(samePin(exploration.origin.shared_base, destination.shared_base), 'exploration_selection_conflict');
        source = this.getExploration(view, context, { exploration_id: r.source.exploration_id }, { write: true });
        check(source && source.generation_id === r.source.at.generation_id && graphEqual(source.scope, scopeOf(g))
          && samePin(source.origin.shared_base, r.source.shared_base), 'exploration_source_conflict');
      }
    }
    return copy({ execution, origin_base: kind === 'bind' && r.exploration_id === null ? r.shared_base : exploration?.origin.shared_base ?? null,
      project_selection: this.projectSelection(view, context), ...(kind === 'adopt' ? { source_exploration: source, destination_exploration: exploration } : {}) });
  }
  preflight(context, { kind, request }) {
    const r = this.parse(kind, request); check(['bind', 'mutate', 'adopt'].includes(kind));
    const destination = destinationOf(kind, r), g = this.grant(context, { write: true, inspect: true, adopt: kind === 'adopt' });
    let execution, selected, metadata;
    let capturedCode;
    try { this.#store.readSnapshot(context, view => { try {
      this.#format(view);
      metadata = this.metadata(view, context, { kind, request: r });
      if (kind === 'bind') execution = r.execution;
      else {
        const b = verified(view.getSource(NS, destination.execution_workspace_id), 'execution-workspace'); check(b, 'exploration_unavailable'); execution = b.execution;
        const current = this.#binding(view, execution); check(current?.value.execution_workspace_id === destination.execution_workspace_id && current.version === destination.expected_binding_version, 'exploration_binding_conflict');
      }
      selected = selectedCatalog(view.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog'), execution);
      check(selected.catalog_version === destination.expected_catalog_version, 'exploration_catalog_conflict');
    } catch (error) { capturedCode = graphErrorCode(error); throw error; } }); }
    catch (error) { if (EXPLORATION_ERROR_CODES.includes(capturedCode)) throw fail(capturedCode); throw error; }
    const observed = observeExplorationGit(selected); this.grant(context, { write: true, inspect: true, adopt: kind === 'adopt' });
    const token = copy(metadata); this.#observations.set(token, copy({ kind, request_digest: graphHash(r), actor: g.principal_id, actor_kind: g.kind, scope: scopeOf(g), execution, observed, catalog_version: selected.catalog_version })); return token;
  }
  #observation(view, context, kind, request, token) {
    const proof = this.#observations.get(token), g = this.grant(context, { write: true, inspect: true, adopt: kind === 'adopt' });
    check(proof && proof.kind === kind && proof.actor === g.principal_id && proof.actor_kind === g.kind && graphEqual(proof.scope, scopeOf(g)) && proof.request_digest === graphHash(request), 'invalid_exploration_input');
    const selected = selectedCatalog(view.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog'), proof.execution);
    check(selected.catalog_version === proof.catalog_version && selected.catalog_version === destinationOf(kind, request).expected_catalog_version, 'exploration_catalog_conflict');
    check(graphEqual(proof.observed, observedFrom(selected)), 'exploration_rebind_required'); return { proof, selected, grant: g };
  }
  #route(value, request, metadata = null) {
    const route = copy(value); this.#routes.set(route, { request: copy(request), metadata: metadata === null ? null : copy(metadata) }); return route;
  }
  getExploration(view, context, { exploration_id }, { write = false } = {}) {
    graphId(exploration_id); const g = this.grant(context, { write }); this.#format(view);
    const value = verified(view.getSource(NS, exploration_id), 'exploration'); if (!value) return null;
    check(value.exploration_id === exploration_id && graphEqual(value.scope, scopeOf(g)) && value.config_digest === this.#config, 'exploration_corrupt');
    const owner = readExplorationOwner(view, { scope: scopeOf(g), generation_id: value.generation_id });
    check(owner && owner.exploration_id === exploration_id && owner.origin_ref === exploration_id && owner.config_digest === this.#config, 'exploration_corrupt'); return copy(value);
  }
  projectSelection(view, context) {
    this.grant(context, { write: false }); this.#format(view); const row = view.getRecord(NS, 'project-selection');
    const latest = lastRow(view, selectionPrefix); check(Boolean(row) === Boolean(latest), 'exploration_corrupt');
    if (!row) return { version: null, pin: null };
    graphFields(row.value, ['pin', 'config_digest']); validateExplorationPin(row.value.pin);
    check(row.value.config_digest === this.#config, 'exploration_configuration_mismatch');
    const witness = verified(latest, 'project-selection-declaration');
    graphFields(witness, ['schema_version', 'kind', 'version', 'pin', 'config_digest', 'identity']);
    check(witness.schema_version === 1 && witness.kind === 'project-selection-declaration' && witness.version === row.version
      && latest.id === numbered(selectionPrefix, row.version) && witness.config_digest === this.#config
      && graphEqual(witness.pin, row.value.pin), 'exploration_corrupt');
    return copy({ version: row.version, pin: row.value.pin });
  }
  #indexHead(view) {
    const row = view.getRecord(NS, 'index-head'), latest = lastRow(view, 'exploration-index/');
    check(Boolean(row) === Boolean(latest), 'exploration_corrupt'); if (!row) return { row: null, sequence: 0 };
    graphFields(row.value, ['sequence']); const sequence = row.value.sequence;
    check(Number.isSafeInteger(sequence) && sequence > 0 && sequence < Number.MAX_SAFE_INTEGER, 'exploration_corrupt');
    const witness = verified(latest, 'exploration-index');
    check(witness.sequence === sequence && latest.id === indexKey(sequence), 'exploration_corrupt'); return { row, sequence };
  }
  #summary(view, exploration_id, delta, binding) {
    const key = graphKey('summary', exploration_id), row = view.getRecord(NS, key), current = row?.value ?? { stored_current_count: 0, last_binding_id: null };
    check(Number.isSafeInteger(current.stored_current_count) && current.stored_current_count + delta >= 0, 'exploration_corrupt');
    view.compareAndSwap(NS, key, row?.version ?? null, { stored_current_count: current.stored_current_count + delta, last_binding_id: binding ?? current.last_binding_id });
  }
  bind(view, context, { request, observation, shared }) {
    const r = this.parse('bind', request), { proof, selected, grant: g } = this.#observation(view, context, 'bind', r, observation);
    this.#format(view, true); const scope = scopeOf(g), current = this.#binding(view, proof.execution);
    const publisher = this.#graphInputs.publisher(context, r.publisher_ref, { epoch: r.epoch });
    check((current?.version ?? null) === r.expected_binding_version, 'exploration_binding_conflict');
    const created = r.exploration_id === null;
    const exploration_id = created ? graphKey('exploration', [scope, g.principal_id, r.idempotency_key]) : r.exploration_id;
    const generation_id = created ? graphKey('exploration-generation', [scope, exploration_id]) : this.getExploration(view, context, { exploration_id }, { write: true })?.generation_id;
    check(generation_id, 'exploration_unavailable');
    let exploration = created ? null : this.getExploration(view, context, { exploration_id }, { write: true });
    check(created || exploration.repository_id === proof.execution.repository_id, 'invalid_exploration_input');
    const pins = this.#shared(view, context, shared, created ? r.shared_base : exploration.origin.shared_base);
    if (created) {
      check(!view.getSource(NS, exploration_id) && !readExplorationOwner(view, { scope, generation_id }), 'exploration_corrupt');
      const { row: index, sequence: previous } = this.#indexHead(view);
      check(Number.isSafeInteger(previous) && previous >= 0 && previous < Number.MAX_SAFE_INTEGER - 1, 'exploration_capacity');
      const sequence = previous + 1; view.compareAndSwap(NS, 'index-head', index?.version ?? null, { sequence });
      exploration = seal({ schema_version: 1, kind: 'exploration', scope, exploration_id, generation_id, repository_id: proof.execution.repository_id, sequence,
        config_digest: this.#config, origin: { actor: g.principal_id, actor_kind: g.kind, epoch: r.epoch, execution: proof.execution, catalog_version: selected.catalog_version,
          publisher_ref: r.publisher_ref, publisher_session_id: publisher.run.session_id, publisher_execution_id: publisher.run.execution_id,
          git_base: { state: proof.observed.unborn ? 'unborn' : 'commit', commit: proof.observed.head }, observed_git: proof.observed,
          shared_base: pins.origin_base, project_selection: pins.project_selection, source_fence: pins.source_fence } });
      view.appendSource(NS, exploration_id, 'exploration', exploration);
      view.appendSource(NS, indexKey(sequence), 'exploration-index', seal({ exploration_id, sequence }));
      const owner = seal({ schema_version: 1, kind: 'exploration-generation-owner', scope, exploration_id, generation_id, config_digest: this.#config, origin_ref: exploration_id });
      view.appendSource(GRAPH, ownerKey(scope, generation_id), 'exploration-generation-owner', owner);
      view.appendSource(GRAPH, ownerWitnessKey(scope, generation_id), 'exploration-generation-owner-witness', owner);
    }
    const execution_workspace_id = graphKey('execution-workspace', [scope, g.principal_id, r.idempotency_key]);
    const binding = seal({ schema_version: 1, kind: 'execution-workspace', scope, execution_workspace_id, exploration_id, generation_id,
      source_installation_id: selected.installation_id, execution: proof.execution, actor: g.principal_id, actor_kind: g.kind, epoch: r.epoch,
      catalog_version: selected.catalog_version, observed_git: proof.observed, previous_workspace_id: current?.value.execution_workspace_id ?? null });
    view.appendSource(NS, execution_workspace_id, 'execution-workspace', binding);
    if (current) {
      view.appendSource(NS, graphKey('binding-retired', current.value.execution_workspace_id), 'binding-retirement', seal({ execution_workspace_id: current.value.execution_workspace_id, replacement_id: execution_workspace_id, actor: g.principal_id }));
      this.#summary(view, current.value.exploration_id, -1, null);
    }
    const binding_version = view.compareAndSwap(NS, bindingKey(proof.execution), current?.version ?? null, { execution_workspace_id });
    view.appendSource(NS, numbered(bindingPrefix(proof.execution), binding_version), 'execution-workspace-version', seal({ schema_version: 1,
      kind: 'execution-workspace-version', execution: proof.execution, binding_version, execution_workspace_id }));
    this.#summary(view, exploration_id, 1, execution_workspace_id);
    if (proof.observed.ref_incarnation_id !== null) {
      const key = graphKey('ref-enrollment', [exploration_id, proof.observed.ref_incarnation_id]);
      const old = verified(view.getSource(NS, key), 'ref-enrollment');
      if (!old) view.appendSource(NS, key, 'ref-enrollment', seal({ exploration_id, ref_incarnation_id: proof.observed.ref_incarnation_id, execution: proof.execution }));
      else check(old.exploration_id === exploration_id && old.ref_incarnation_id === proof.observed.ref_incarnation_id, 'exploration_corrupt');
    }
    const route = this.#route({ kind: 'bind', scope, actor: g.principal_id, actor_kind: g.kind, epoch: r.epoch, idempotency_key: r.idempotency_key,
      publisher_ref: r.publisher_ref, publisher_session_id: publisher.run.session_id, publisher_execution_id: publisher.run.execution_id,
      request_digest: graphHash(r), execution: proof.execution, catalog_version: selected.catalog_version, execution_workspace_id, binding_version,
      exploration_id, generation_id, observed_git: proof.observed, shared: pins }, r);
    const graph_request = created ? { generation_id, epoch: r.epoch, idempotency_key: graphKey('exploration-graph', [scope, g.principal_id, r.idempotency_key]), publisher_ref: r.publisher_ref, coverage: [] } : null;
    return { route, created, generation_id, graph_request };
  }
  mutation(view, context, { request, observation, shared }) {
    const r = this.parse('mutate', request), { proof, selected, grant: g } = this.#observation(view, context, 'mutate', r, observation);
    this.#format(view); const current = this.#binding(view, proof.execution);
    const publisher = this.#graphInputs.publisher(context, r.publisher_ref, { epoch: r.epoch });
    check(current?.version === r.expected_binding_version && current.value.execution_workspace_id === r.execution_workspace_id, 'exploration_binding_conflict');
    check(sameBinding(current.value, selected), 'exploration_rebind_required');
    const exploration = this.getExploration(view, context, { exploration_id: current.value.exploration_id }, { write: true }); check(exploration, 'exploration_corrupt');
    check(r.expected_graph.generation_id === exploration.generation_id && graphEqual(r.expected_graph.scope, scopeOf(g)), 'invalid_exploration_input');
    const pins = this.#shared(view, context, shared, exploration.origin.shared_base);
    check(pins.project_selection.version === r.expected_project_selection_version, 'exploration_selection_conflict');
    check(pins.source_fence === r.expected_source_fence, 'stale_invalidation_fence');
    const route = this.#route({ kind: 'mutate', scope: scopeOf(g), actor: g.principal_id, actor_kind: g.kind, epoch: r.epoch, idempotency_key: r.idempotency_key,
      publisher_ref: r.publisher_ref, publisher_session_id: publisher.run.session_id, publisher_execution_id: publisher.run.execution_id,
      request_digest: graphHash(r), execution: proof.execution, catalog_version: selected.catalog_version, execution_workspace_id: current.value.execution_workspace_id,
      binding_version: current.version, exploration_id: exploration.exploration_id, generation_id: exploration.generation_id, observed_git: proof.observed, shared: pins }, r);
    const graph_request = { epoch: r.epoch, idempotency_key: graphKey('exploration-graph', [scopeOf(g), g.principal_id, r.idempotency_key]), publisher_ref: r.publisher_ref,
      expected_graph: r.expected_graph, expected_source_fence: r.expected_source_fence, operation: r.operation, coverage: r.coverage };
    return { route, graph_request };
  }
  adoption(view, context, { request, observation, shared, adoption }) {
    const r = this.parse('adopt', request), { proof, selected, grant: g } = this.#observation(view, context, 'adopt', r, observation);
    const metadata = this.metadata(view, context, { kind: 'adopt', request: r }), destination = r.destination;
    check(graphEqual(metadata.source_exploration, observation.source_exploration), 'exploration_source_conflict');
    check(graphEqual(metadata.destination_exploration, observation.destination_exploration), 'exploration_corrupt');
    const current = this.#binding(view, proof.execution), exploration = metadata.destination_exploration;
    check(current?.version === destination.expected_binding_version && current.value.execution_workspace_id === destination.execution_workspace_id
      && current.value.exploration_id === destination.exploration_id, 'exploration_binding_conflict');
    check(sameBinding(current.value, selected), 'exploration_rebind_required');
    const publisher = this.#graphInputs.publisher(context, r.publisher_ref, { epoch: r.epoch });
    const pins = this.#shared(view, context, shared, exploration.origin.shared_base);
    check(pins.project_selection.version === destination.expected_project_selection_version, 'exploration_selection_conflict');
    check(pins.source_fence === r.expected_source_fence, 'stale_invalidation_fence');
    // Semantic/source proof belongs to the fixed materializer. This boundary checks
    // that its documentary summary describes precisely this normalized request.
    const summary = graphInput(adoption); graphFields(summary, ['source', 'endpoint_map']);
    graphFields(summary.source, ['exploration_id', 'generation_id', 'at', 'address', 'expected_head', 'shared_base', 'operation_origin_ref']);
    graphId(summary.source.operation_origin_ref); normalizePin(summary.source.shared_base);
    const { operation_origin_ref, generation_id, ...source } = summary.source;
    check(generation_id === r.source.at.generation_id && graphEqual(source, r.source), 'exploration_source_conflict');
    check(Array.isArray(summary.endpoint_map) && summary.endpoint_map.length === r.endpoint_map.length);
    summary.endpoint_map.forEach((mapping, index) => {
      graphFields(mapping, ['source', 'destination', 'operation_origin_ref']); graphId(mapping.operation_origin_ref);
      check(graphEqual({ source: mapping.source, destination: mapping.destination }, r.endpoint_map[index]), 'exploration_source_conflict');
    });
    const route = this.#route({ kind: 'adopt', scope: scopeOf(g), actor: g.principal_id, actor_kind: g.kind, epoch: r.epoch, idempotency_key: r.idempotency_key,
      publisher_ref: r.publisher_ref, publisher_session_id: publisher.run.session_id, publisher_execution_id: publisher.run.execution_id,
      request_digest: graphHash(r), execution: proof.execution, catalog_version: selected.catalog_version, execution_workspace_id: current.value.execution_workspace_id,
      binding_version: current.version, exploration_id: exploration.exploration_id, generation_id: exploration.generation_id,
      observed_git: proof.observed, shared: pins, adoption: summary }, r, metadata);
    return { route };
  }
  assertUnchanged(view, context, route) {
    check(this.#routes.has(route)); const g = this.grant(context, { write: true, adopt: route.kind === 'adopt' });
    check(g.principal_id === route.actor && g.kind === route.actor_kind && graphEqual(scopeOf(g), route.scope), 'exploration_unauthorized');
    this.#format(view);
    check(graphEqual(this.projectSelection(view, context), route.shared.project_selection), 'exploration_selection_conflict');
    if (route.kind !== 'selection') {
      const current = this.#binding(view, route.execution);
      check(current?.version === route.binding_version && current.value.execution_workspace_id === route.execution_workspace_id, 'exploration_binding_conflict');
      const selected = selectedCatalog(view.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog'), route.execution);
      check(selected.catalog_version === route.catalog_version, 'exploration_catalog_conflict');
      check(sameBinding(current.value, selected) && graphEqual(observedFrom(selected), route.observed_git), 'exploration_rebind_required');
      const owner = readExplorationOwner(view, { scope: route.scope, generation_id: route.generation_id });
      check(owner?.exploration_id === route.exploration_id && owner.config_digest === this.#config, 'exploration_corrupt');
    }
    if (route.kind === 'adopt') {
      const stored = this.#routes.get(route), metadata = this.metadata(view, context, { kind: 'adopt', request: stored.request });
      check(graphEqual(metadata.source_exploration, stored.metadata.source_exploration), 'exploration_source_conflict');
      check(graphEqual(metadata.destination_exploration, stored.metadata.destination_exploration), 'exploration_corrupt');
    }
    return true;
  }
  retainOrigin(view, context, route, { previous_graph, next_graph, revision = null }) {
    this.assertUnchanged(view, context, route); check(route.kind !== 'selection');
    validateGraphCommitAddress2(next_graph); if (previous_graph !== null) validateGraphCommitAddress2(previous_graph);
    check(next_graph.generation_id === route.generation_id && graphEqual(next_graph.scope, route.scope), 'exploration_corrupt');
    if (route.kind === 'adopt') {
      exactAt(revision, next_graph);
      check(graphEqual(previous_graph, this.#routes.get(route).request.destination.expected_graph), 'exploration_corrupt');
    }
    const value = seal({ schema_version: 1, ...route, kind: 'exploration-operation-origin', operation: route.kind, previous_graph, next_graph,
      ...(route.kind === 'adopt' ? { revision } : {}) });
    const id = graphKey('exploration-operation-origin', [route.scope, route.actor, route.idempotency_key]);
    const old = verified(view.getSource(NS, id), 'exploration-operation-origin');
    if (old) check(graphEqual(old, value), 'exploration_corrupt'); else view.appendSource(NS, id, 'exploration-operation-origin', value);
    return id;
  }
  finish(view, context, route, { result, graph_request = null }) {
    this.assertUnchanged(view, context, route); const { request } = this.#routes.get(route), g = this.grant(context, { write: true });
    const clean = graphInput(result);
    const receipt = { schema_version: 1, kind: 'exploration_receipt', scope: route.scope, actor: route.actor, actor_kind: route.actor_kind, operation: route.kind,
      idempotency_key: route.idempotency_key, request_digest: route.request_digest, config_digest: this.#config,
      epoch: route.epoch, shared: route.shared, execution_workspace_id: route.execution_workspace_id ?? null, exploration_id: route.exploration_id ?? null,
      generation_id: route.generation_id ?? null, result_digest: graphHash(clean) };
    const value = seal({ receipt, request, graph_request, result: clean });
    view.appendSource(NS, commandKey(g, route.idempotency_key), 'exploration-operation', value);
    view.enqueue(NS, graphKey('exploration-changed', [route.scope, route.actor, route.idempotency_key]), { schema_version: 1, kind: 'exploration_changed', operation: route.kind,
      exploration_id: route.exploration_id ?? null, generation_id: route.generation_id ?? null, receipt_ref: commandKey(g, route.idempotency_key) });
    return copy({ receipt, result: clean });
  }
  setProjectSelection(view, context, { request, shared }) {
    const r = this.parse('selection', request), g = this.grant(context, { write: true }); this.#format(view, true);
    check(graphEqual(r.pin.at.scope, scopeOf(g)), 'invalid_exploration_input');
    const old = this.projectSelection(view, context); check(old.version === r.expected_version, 'exploration_selection_conflict');
    const s = this.#shared(view, context, shared, null);
    const next = view.compareAndSwap(NS, 'project-selection', old.version, { pin: r.pin, config_digest: this.#config });
    view.appendSource(NS, numbered(selectionPrefix, next), 'project-selection-declaration', seal({ schema_version: 1,
      kind: 'project-selection-declaration', version: next, pin: r.pin, config_digest: this.#config }));
    const route = this.#route({ kind: 'selection', scope: scopeOf(g), actor: g.principal_id, actor_kind: g.kind, epoch: r.epoch, idempotency_key: r.idempotency_key,
      request_digest: graphHash(r), shared: { ...s, project_selection: { version: next, pin: r.pin } } }, r);
    return { route, version: next, pin: r.pin };
  }
  getBinding(view, context, { execution }) {
    const input = graphInput(execution); execShape(input); this.grant(context, { inspect: true }); this.#format(view);
    const row = this.#binding(view, input), catalog = view.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog');
    let status = 'unmapped';
    if (row) { try { const selected = selectedCatalog(catalog, input); status = sameBinding(row.value, selected) ? 'bound' : 'rebind_required'; }
      catch (e) { if (['exploration_unavailable', 'exploration_rebind_required'].includes(e.code)) status = 'unavailable'; else throw e; } }
    return copy({ status, binding_version: row?.version ?? null, binding: row?.value ?? null, observed_catalog_version: catalog?.version ?? null });
  }
  list(view, context, { cursor, limit }) {
    const g = this.grant(context); this.#format(view); check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 32);
    const { sequence } = this.#indexHead(view);
    let after = 0, upper = sequence;
    if (cursor !== null) {
      const c = graphInput(cursor); graphFields(c, ['schema_version', 'kind', 'scope', 'config_digest', 'upper', 'after']);
      check(c.schema_version === 1 && c.kind === 'exploration-page' && graphEqual(c.scope, scopeOf(g)) && c.config_digest === this.#config
        && Number.isSafeInteger(c.upper) && Number.isSafeInteger(c.after) && c.after > 0 && c.after <= c.upper && c.upper <= sequence, 'invalid_exploration_input');
      upper = c.upper; after = c.after;
    }
    if (after >= upper) return { items: [], cursor: null };
    const count = Math.min(limit, upper - after), range = view.getSourceRange(NS, { lower: indexKey(after + 1), upper: indexKey(upper + 1), after: null, order: 'asc', limit: count });
    check(range.rows.length === count, 'exploration_corrupt');
    const items = range.rows.map((row, i) => {
      const value = verified(row, 'exploration-index'); check(value.sequence === after + i + 1 && row.id === indexKey(value.sequence), 'exploration_corrupt');
      const exploration = this.getExploration(view, context, { exploration_id: value.exploration_id }); check(exploration?.sequence === value.sequence, 'exploration_corrupt');
      const summary = view.getRecord(NS, graphKey('summary', value.exploration_id)); check(summary, 'exploration_corrupt');
      graphFields(summary.value, ['stored_current_count', 'last_binding_id']);
      check(Number.isSafeInteger(summary.value.stored_current_count) && summary.value.stored_current_count >= 0, 'exploration_corrupt');
      const last = verified(view.getSource(NS, summary.value.last_binding_id), 'execution-workspace'); check(last && last.exploration_id === exploration.exploration_id, 'exploration_corrupt');
      const current = this.#binding(view, last.execution); let last_binding_status = 'retired';
      if (current?.value.execution_workspace_id === last.execution_workspace_id) {
        try { last_binding_status = sameBinding(last, selectedCatalog(view.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog'), last.execution)) ? 'bound' : 'rebind_required'; }
        catch (e) { if (['exploration_unavailable', 'exploration_rebind_required'].includes(graphErrorCode(e))) last_binding_status = 'unavailable'; else throw e; }
      }
      return { ...exploration, binding_summary: { ...summary.value, last_binding_status } };
    });
    const last = after + count;
    return copy({ items, cursor: last < upper ? { schema_version: 1, kind: 'exploration-page', scope: scopeOf(g), config_digest: this.#config, upper, after: last } : null });
  }
}
