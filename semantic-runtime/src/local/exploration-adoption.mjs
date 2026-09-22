/**
 * Fixed internal adoption materializer. The Graph facade owns authorization,
 * selected semantic reads, canonical proofs and the surrounding transaction.
 * No public callback, caller-supplied proof or independently committed effect.
 *
 * materializeExplorationAdoption({view,context,inputs,request,source,endpoints,
 *   source_storage,destination_storage,grant,execution_id,source_exploration,
 *   destination_exploration,config_digest}) -> {operation,adoption}
 * source is an authorized resolveIncrementalGraph result; endpoints are
 * [{source:<exact A ref>,destination:<exact B ref>,resolved:<authorized B result>}].
 * The same read-only helper is used on retry with the original execution_id.
 */
import { GraphStorage } from './graph-storage.mjs';
import { GraphInputs, graphInput, graphFields, graphHash, graphKey, graphEqual, graphAssert, graphFail, graphErrorCode, graphId } from './graph-inputs.mjs';
import { EXPLORATION_NAMESPACE, readExplorationOwner } from './exploration-inputs.mjs';
import { validateSemanticRevision, exactRevisionAddress } from '../core/working-graph.mjs';
import { eventObservationKey, sourceObjectKey, effectiveEventAccess } from '../core/event-provenance.mjs';
import { sourcePartitionKey } from '../core/causal-ordering.mjs';
import { canonical } from '../core/contracts.mjs';

const GRAPH = 'working-graph', NS = EXPLORATION_NAMESPACE;
const check = (ok, code = 'exploration_corrupt') => graphAssert(ok, code);
const scopeOf = g => ({ tenant_id: g.tenant_id, project_id: g.project_id });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = items => [...items].sort((a, b) => compare(canonical(a), canonical(b)));
const lifecycle = e => ['SOURCE_ACCESS_CHANGED', 'SOURCE_TOMBSTONE'].includes(e.event_type);
const samePin = (left, right) => {
  const normalize = value => value === null ? null : { ...value, record_keys: [...value.record_keys].sort() };
  return graphEqual(normalize(left), normalize(right));
};
function row(view, namespace, id, kind) {
  const selected = view.getSource(namespace, id); check(selected?.kind === kind);
  return graphInput(selected.value);
}
function sealed(view, namespace, id, kind) {
  const value = row(view, namespace, id, kind), { identity, ...body } = value;
  check(identity === graphHash(body)); return value;
}
function exploration(view, supplied, id, generation, scope, config) {
  const value = sealed(view, NS, id, 'exploration'), owner = readExplorationOwner(view, { scope, generation_id: generation });
  check(graphEqual(value, supplied) && value.kind === 'exploration' && value.schema_version === 1
    && value.exploration_id === id && value.generation_id === generation && graphEqual(value.scope, scope)
    && value.config_digest === config && owner?.exploration_id === id && owner.origin_ref === id && owner.config_digest === config);
  return value;
}
function selectedRevision(resolved, address, at) {
  check(resolved.status === 'resolved' && resolved.revision, 'graph_access_denied');
  const revision = resolved.revision; validateSemanticRevision(revision);
  check(graphEqual(exactRevisionAddress(revision), address) && graphEqual(resolved.graph_revision, at));
  check(!resolved.entity?.quarantined && ['candidate', 'validated', 'resolved'].includes(revision.assertion.status), 'graph_access_denied');
  // canonical-selection is service-issued metadata, never an ordinary assertion.
  check(revision.entity_kind !== 'entity' || revision.assertion.content.semantic_type !== 'canonical-selection'
    && revision.assertion.content.data?.kind !== 'canonical_selection', 'invalid_exploration_input');
  return revision;
}

/** Actual immutable publication chain; intentionally not an actor-private getReceipt. */
export function verifyExplorationPublication(view, storage, at, revision, explorationId, config) {
  const address = exactRevisionAddress(revision);
  const fact = storage.fact({ at, kind: 'revision', key: [revision.revision_digest] });
  check(fact.value && graphEqual(fact.value, revision) && fact.origin);
  const link = row(view, GRAPH, graphKey('commit-receipt', fact.origin), 'graph-commit-receipt');
  check(graphEqual(link.next_graph, fact.origin));
  const receipt = row(view, GRAPH, link.receipt_ref, 'graph-receipt');
  check(receipt.schema_version === 1 && receipt.kind === 'graph_receipt' && graphEqual(receipt.scope, revision.scope)
    && receipt.generation_id === revision.generation_id && graphEqual(receipt.next_graph, fact.origin)
    && graphEqual(receipt.result?.revision, address));
  const key = [1, revision.scope, receipt.actor, revision.generation_id, receipt.idempotency_key];
  check(link.receipt_ref === graphKey('receipt', key));
  const command = row(view, GRAPH, graphKey('command', key), 'graph-command');
  check(command.receipt_ref === link.receipt_ref && command.receipt_digest === graphHash(receipt)
    && graphHash(command.request) === receipt.raw_request_digest && graphHash(command.command) === receipt.command_digest
    && graphEqual(command.result, receipt.result));
  const commit = storage.fact({ at: fact.origin, kind: 'commit', key: [fact.origin.commit_digest] }).value;
  check(commit && commit.command_digest === receipt.command_digest && graphEqual(commit.previous_commit, receipt.previous_graph)
    && graphEqual(commit.records, receipt.record_refs));
  graphId(receipt.operation_origin_ref);
  const origin = sealed(view, NS, receipt.operation_origin_ref, 'exploration-operation-origin');
  check(origin.kind === 'exploration-operation-origin' && ['mutate', 'adopt'].includes(origin.operation)
    && origin.schema_version === 1 && origin.exploration_id === explorationId && origin.generation_id === revision.generation_id
    && graphEqual(origin.scope, revision.scope) && graphEqual(origin.next_graph, fact.origin)
    && graphEqual(origin.previous_graph, receipt.previous_graph) && origin.actor === receipt.actor && origin.actor_kind === receipt.actor_kind
    && origin.publisher_ref === receipt.publisher_ref && origin.publisher_execution_id === revision.assertion.execution_id
    && origin.epoch === receipt.epoch && receipt.operation_origin_ref === graphKey('exploration-operation-origin', [origin.scope, origin.actor, origin.idempotency_key]));
  if (Object.hasOwn(origin, 'revision')) check(graphEqual(origin.revision, address));
  const operation = sealed(view, NS, graphKey('operation', [origin.scope, origin.actor, origin.idempotency_key]), 'exploration-operation');
  check(operation.receipt.operation === origin.operation && operation.receipt.config_digest === config
    && operation.receipt.actor === origin.actor && operation.receipt.actor_kind === origin.actor_kind
    && graphEqual(operation.receipt.scope, origin.scope) && operation.receipt.epoch === origin.epoch
    && operation.receipt.idempotency_key === origin.idempotency_key && graphEqual(operation.receipt.shared, origin.shared)
    && operation.receipt.execution_workspace_id === origin.execution_workspace_id
    && operation.receipt.exploration_id === explorationId && operation.receipt.generation_id === revision.generation_id
    && operation.receipt.request_digest === origin.request_digest && graphHash(operation.request) === origin.request_digest
    && operation.receipt.result_digest === graphHash(operation.result) && graphEqual(operation.graph_request, command.request)
    && graphEqual(operation.result.receipt, receipt) && graphEqual(operation.result.revision, address)
    && operation.result.operation_origin_ref === receipt.operation_origin_ref);
  const request = operation.request, destination = origin.operation === 'adopt' ? request.destination : request;
  check(destination && request.epoch === origin.epoch && request.publisher_ref === origin.publisher_ref
    && request.idempotency_key === origin.idempotency_key && destination.execution_workspace_id === origin.execution_workspace_id
    && destination.expected_binding_version === origin.binding_version && destination.expected_catalog_version === origin.catalog_version
    && graphEqual(destination.expected_graph, origin.previous_graph)
    && destination.expected_project_selection_version === origin.shared.project_selection.version
    && request.expected_source_fence === origin.shared.source_fence
    && receipt.idempotency_key === graphKey('exploration-graph', [origin.scope, origin.actor, origin.idempotency_key]));
  if (origin.operation === 'adopt') {
    check(destination.exploration_id === origin.exploration_id && samePin(destination.shared_base, origin.shared.origin_base)
      && graphEqual(origin.revision, address) && graphEqual(operation.result.adoption, origin.adoption));
    const source = origin.adoption.source, expected = request.source;
    check(source.exploration_id === expected.exploration_id && source.generation_id === expected.at.generation_id
      && graphEqual(source.at, expected.at) && graphEqual(source.address, expected.address)
      && graphEqual(source.expected_head, expected.expected_head) && samePin(source.shared_base, expected.shared_base)
      && Array.isArray(origin.adoption.endpoint_map) && origin.adoption.endpoint_map.length <= 2
      && graphEqual(origin.adoption.endpoint_map.map(({ source, destination }) => ({ source, destination })), request.endpoint_map));
    graphId(source.operation_origin_ref);
    origin.adoption.endpoint_map.forEach(mapping => graphId(mapping.operation_origin_ref));
  }
  const workspace = sealed(view, NS, origin.execution_workspace_id, 'execution-workspace');
  check(workspace.kind === 'execution-workspace' && workspace.schema_version === 1
    && workspace.execution_workspace_id === origin.execution_workspace_id && workspace.exploration_id === explorationId
    && workspace.generation_id === revision.generation_id && graphEqual(workspace.scope, origin.scope)
    && graphEqual(workspace.execution, origin.execution));
  check(Number.isSafeInteger(origin.binding_version) && origin.binding_version > 0);
  const witness = sealed(view, NS, `binding-version/${graphHash(origin.execution).slice(7)}/${String(origin.binding_version).padStart(20, '0')}`, 'execution-workspace-version');
  check(witness.kind === 'execution-workspace-version' && witness.schema_version === 1
    && witness.binding_version === origin.binding_version && witness.execution_workspace_id === origin.execution_workspace_id
    && graphEqual(witness.execution, origin.execution));
  const publisher = row(view, GRAPH, origin.publisher_ref, 'graph-publisher');
  check(publisher.kind === 'runtime_publication_run' && publisher.schema_version === 1 && publisher.publisher_ref === origin.publisher_ref
    && publisher.actor === origin.actor && publisher.actor_kind === origin.actor_kind && publisher.epoch === origin.epoch
    && graphEqual(publisher.scope, origin.scope) && publisher.session_id === origin.publisher_session_id
    && publisher.execution_id === origin.publisher_execution_id
    && publisher.publisher_ref === graphKey('publisher', [1, origin.scope, origin.actor, publisher.run_key]));
  return { origin, ref: receipt.operation_origin_ref, operation: command.request.operation };
}

function materialize(options) {
  const { view, context, inputs, source_storage, destination_storage } = options;
  check(inputs instanceof GraphInputs && source_storage instanceof GraphStorage && destination_storage instanceof GraphStorage, 'invalid_exploration_input');
  const request = graphInput(options.request), source = graphInput(options.source), endpoints = graphInput(options.endpoints);
  const grant = inputs.grant(context, 'exploration:adopt');
  check(graphEqual(scopeOf(grant), scopeOf(options.grant)) && grant.principal_id === options.grant.principal_id && grant.kind === options.grant.kind, 'graph_unauthorized');
  const scope = scopeOf(grant), a = request.source, b = request.destination;
  check(a.at.generation_id !== b.expected_graph.generation_id && a.exploration_id !== b.exploration_id
    && graphEqual(a.at.scope, scope) && graphEqual(b.expected_graph.scope, scope), 'invalid_exploration_input');
  const aMeta = exploration(view, graphInput(options.source_exploration), a.exploration_id, a.at.generation_id, scope, options.config_digest);
  const bMeta = exploration(view, graphInput(options.destination_exploration), b.exploration_id, b.expected_graph.generation_id, scope, options.config_digest);
  check(samePin(aMeta.origin.shared_base, a.shared_base) && samePin(bMeta.origin.shared_base, b.shared_base), 'exploration_selection_conflict');
  const revision = selectedRevision(source, a.address, a.at), sourcePublication = verifyExplorationPublication(view, source_storage, a.at, revision, a.exploration_id, options.config_digest);
  check(Array.isArray(request.endpoint_map) && request.endpoint_map.length <= 2 && endpoints.length === request.endpoint_map.length, 'invalid_exploration_input');
  const needed = new Map();
  if (revision.entity_kind === 'relation') for (const endpoint of [revision.assertion.content.from, revision.assertion.content.to]) {
    if (endpoint.kind === 'semantic_revision') needed.set(canonical(endpoint), endpoint);
  }
  check(needed.size === endpoints.length, 'invalid_exploration_input');
  const replacements = new Map(), endpointRevisions = [], mapped = [];
  for (const item of endpoints) {
    graphFields(item, ['source', 'destination', 'resolved']); const key = canonical(item.source);
    check(needed.has(key) && !replacements.has(key) && request.endpoint_map.some(pair => graphEqual(pair.source, item.source) && graphEqual(pair.destination, item.destination)), 'invalid_exploration_input');
    check(item.destination.generation_id === b.expected_graph.generation_id && graphEqual(item.destination.scope, scope), 'invalid_exploration_input');
    const selected = selectedRevision(item.resolved, item.destination, b.expected_graph);
    const adopted = verifyExplorationPublication(view, destination_storage, b.expected_graph, selected, b.exploration_id, options.config_digest);
    const original = adopted.origin.adoption?.source;
    check(adopted.origin.operation === 'adopt' && original?.exploration_id === a.exploration_id
      && original.generation_id === a.at.generation_id && graphEqual(original.address, item.source)
      && samePin(original.shared_base, a.shared_base), 'invalid_exploration_input');
    // Verify the linked original A publication as well; a plausible origin ref alone is insufficient.
    const sourceEndpoint = source_storage.fact({ at: original.at, kind: 'revision', key: [item.source.revision_digest] }).value;
    check(sourceEndpoint && graphEqual(exactRevisionAddress(sourceEndpoint), item.source));
    const originalPublication = verifyExplorationPublication(view, source_storage, original.at, sourceEndpoint, a.exploration_id, options.config_digest);
    check(original.operation_origin_ref === originalPublication.ref);
    replacements.set(key, item.destination); endpointRevisions.push(selected);
    mapped.push({ source: item.source, destination: item.destination, operation_origin_ref: adopted.ref });
  }

  const allEvents = new Map(), ordinary = new Map(), capturedAccess = new Set();
  const admit = event => {
    const observation = eventObservationKey(event), prior = allEvents.get(observation);
    check(!prior || graphEqual(prior, event));
    if (!prior) {
      check(allEvents.size < 32, 'exploration_capacity');
      const current = inputs.acceptedEvent(context, observation);
      check(current.retained && graphEqual(current.fact.event, event));
      check(effectiveEventAccess(event).allowed_principal_ids.includes(grant.principal_id), 'graph_access_denied');
      allEvents.set(observation, event);
    }
  };
  for (const r of [revision, ...endpointRevisions]) {
    for (const event of r.provenance.events) { check(!lifecycle(event)); admit(event); ordinary.set(eventObservationKey(event), event); }
    for (const event of r.provenance.access_events) { check(lifecycle(event)); admit(event); capturedAccess.add(graphHash(event)); }
  }
  const objects = new Map([...ordinary.values()].flatMap(e => e.provenance.source_objects.map(s => [sourceObjectKey(s.object), s.object])));
  check(objects.size <= 32, 'exploration_capacity');
  const currentHead = destination_storage.head(); check(currentHead, 'graph_unavailable');
  const access = new Map();
  for (const [key, object] of objects) {
    const value = destination_storage.fact({ at: currentHead.value.head, kind: 'source_access', key: [key] }).value;
    if (value === null) continue;
    graphFields(value, ['object', 'updates']); check(graphEqual(value.object, object) && Array.isArray(value.updates) && value.updates.length <= 32);
    const epochs = new Set();
    for (const u of value.updates) {
      graphFields(u, ['event', 'event_digest', 'access_state']);
      check(lifecycle(u.event) && graphHash(u.event) === u.event_digest && u.event.producer.sequence !== null
        && u.event.provenance.source_objects.some(s => sourceObjectKey(s.object) === key));
      const epoch = sourcePartitionKey({ partition: u.event.partition, producer: { producer_id: u.event.producer.producer_id, epoch: u.event.producer.epoch } });
      check(!epochs.has(epoch)); epochs.add(epoch);
      check(u.access_state === 'active', 'graph_access_denied'); admit(u.event);
      const accepted = destination_storage.fact({ at: currentHead.value.head, kind: 'access_update', key: [u.event_digest] });
      check(accepted.value && graphEqual(accepted.value.event, u.event) && accepted.value.event_digest === u.event_digest && accepted.value.access_state === 'active');
      const commit = destination_storage.fact({ at: accepted.origin, kind: 'commit', key: [accepted.origin.commit_digest] }).value;
      check(commit && graphEqual(accepted.value.predecessor, commit.previous_commit));
      check(!access.has(u.event_digest) || graphEqual(access.get(u.event_digest), u.event)); access.set(u.event_digest, u.event);
    }
  }
  check([...capturedAccess].every(digest => access.has(digest)), 'graph_access_denied');
  graphId(options.execution_id);
  const identity = [scope, grant.principal_id, grant.kind, graphHash(request), request.idempotency_key];
  const content = graphInput(revision.assertion.content);
  if (revision.entity_kind === 'relation') for (const side of ['from', 'to']) if (content[side].kind === 'semantic_revision') content[side] = replacements.get(canonical(content[side]));
  const operation = { kind: 'assert', assertion: { schema_version: 1,
    assertion_id: graphKey('adopted-assertion', identity), entity_kind: revision.entity_kind, entity_id: graphKey('adopted-item', identity),
    base_revision: null, parents: [], execution_id: options.execution_id, status: 'candidate', content,
    events: order(revision.provenance.events), canonical_refs: order(revision.assertion.canonical_refs), access_revisions: [...access.keys()].sort() } };
  const adoption = { source: { exploration_id: a.exploration_id, generation_id: a.at.generation_id, at: a.at, address: a.address,
    expected_head: a.expected_head, shared_base: a.shared_base, operation_origin_ref: sourcePublication.ref }, endpoint_map: mapped.sort((a, b) => compare(canonical(a.source), canonical(b.source))) };
  return graphInput({ operation, adoption });
}

export function materializeExplorationAdoption(options) {
  try { return materialize(options); }
  catch (error) {
    const code = graphErrorCode(error);
    if (code) throw error;
    throw graphFail('exploration_corrupt');
  }
}

/** Retained-result verification uses original immutable facts, never live Git/epoch admission. */
export function verifyExplorationAdoptionResult({ view, request, result, destination_storage, destination_exploration, config_digest }) {
  try {
    check(destination_storage instanceof GraphStorage, 'invalid_exploration_input');
    request = graphInput(request); result = graphInput(result); destination_exploration = graphInput(destination_exploration);
    const at = result.receipt.next_graph, scope = at.scope;
    exploration(view, destination_exploration, request.destination.exploration_id, at.generation_id, scope, config_digest);
    const selected = destination_storage.fact({ at, kind: 'revision', key: [result.revision.revision_digest] });
    check(selected.value && graphEqual(exactRevisionAddress(selected.value), result.revision)); validateSemanticRevision(selected.value);
    const proof = verifyExplorationPublication(view, destination_storage, at, selected.value, request.destination.exploration_id, config_digest);
    check(proof.ref === result.operation_origin_ref && proof.ref === result.receipt.operation_origin_ref
      && proof.origin.operation === 'adopt' && proof.origin.request_digest === graphHash(request)
      && graphEqual(proof.origin.adoption, result.adoption));
    return graphInput(proof.origin);
  } catch (error) {
    if (graphErrorCode(error)) throw error;
    throw graphFail('exploration_corrupt');
  }
}
