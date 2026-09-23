import { fixture as adoptionFixture, adoption, ADOPTION_ACTIONS } from './adoption-fixture.mjs';
import { mutation, assertion, rows, register, capture, bind, git, SCOPE } from './exploration-fixture.mjs';
import { LocalContextStore } from '../../src/application/context/context-store.mjs';
import { graphHash } from '../../src/application/graph/graph-inputs.mjs';
import { canonicalArtifactAddress } from '../../src/domain/graph/working-graph.mjs';
import { hashText } from './graph-store-fixture.mjs';

export const CONTEXT_ACTIONS = [...ADOPTION_ACTIONS, 'context:read', 'context:write'];
export function fixture(t, options = {}) {
  const f = adoptionFixture(t, options);
  f.context = f.issue({ actions: CONTEXT_ACTIONS }).context;
  f.contexts = new LocalContextStore({ store: f.store, authority: f.authority, canonical_reader: f.config });
  const reopen = f.reopen;
  f.reopen = options => { const next = reopen(options); next.context = next.issue({ actions: CONTEXT_ACTIONS }).context;
    next.contexts = new LocalContextStore({ store: next.store, authority: next.authority, canonical_reader: f.config }); return next; };
  return f;
}
export function content(name, { change = 'create', reason = `Explicit synthetic ${change}`, role = 'decision', detail = '', applicability, ...extra } = {}) {
  return { semantic_type: 'context', data: { schema_version: 1, kind: 'runtime_context', role,
    summary: `Synthetic ${name}`, detail, applicability: applicability ?? { project: 'owning', exploration: 'owning',
      tickets: { mode: 'unspecified', refs: [] }, code: { mode: 'unspecified', refs: [] } }, change: { kind: change, reason }, ...extra } };
}
export const head = (f, binding = f.a) => f.graph.getHead(f.context, { generation_id: binding.generation_id }).graph_revision;
export function contextRequest(f, binding, name, { base = null, parents = [], status = 'candidate', change = base ? 'revise' : parents.length ? 'derive' : 'create',
  entity_id = base?.entity_id ?? name, events = [f.event], canonical_refs = [], typed = {}, operation_kind = 'assert', conflict_digest, ...extra } = {}) {
  const expected_graph = head(f, binding), selection = f.explorations.getSelection(f.context, { exploration_id: binding.exploration_id, at: expected_graph });
  const a = assertion(f, events[0], name, { entity_id, base_revision: base, parents, status, content: content(name, { change, ...typed }), events, canonical_refs });
  return mutation(f, binding, name, { expected_graph, expected_project_selection_version: selection.shared.current_project.version,
    operation: { kind: operation_kind, ...(conflict_digest ? { conflict_digest } : {}), assertion: a }, ...extra });
}
export const publish = (f, name, options = {}, binding = f.a) => f.contexts.mutate(f.context, contextRequest(f, binding, name, options));
export function selectedInput(f, binding, result, { mode = 'current', at = head(f, binding), address = result.revision, ...extra } = {}) {
  return { exploration_id: binding.exploration_id, at, address, mode, ...extra };
}
export const read = (f, binding, result, options = {}) => f.contexts.resolve(f.context, selectedInput(f, binding, result, options));
export const revision = (f, result) => f.graph.resolve(f.context, { at: result.receipt.next_graph, address: result.revision }).revision;
export const boundedFailure = fn => {
  try { fn(); } catch (error) { if (/^[a-z_]+$/.test(error.code)) return error; throw error; }
  throw new Error('expected bounded domain failure');
};
export function canonicalRefs(f, key = 'ticket') {
  const selected = f.canonical.selection;
  const artifact = selected.assertion.canonical_refs.find(ref => ref.event.payload.path === `.vibehub/${key}.yaml`);
  if (!artifact) throw new Error('missing actual canonical fixture artifact');
  return { artifact, ticket: { at: f.canonical.graph_revision, address: f.canonical.address, record_key: key },
    code: { event_digest: graphHash(artifact.event) }, canonical_refs: [canonicalArtifactAddress(artifact.event)] };
}
export function gitCodeRef(f) {
  const raw = structuredClone(f.ingress.readEvent(f.context, { event_id: f.event.event_id }).raw), key = 'selected-code-version';
  const object = { kind: 'git_commit', tenant_id: SCOPE.tenant_id, repository_id: f.execution.repository_id, object_format: 'sha1', oid: git(f.folder, 'rev-parse', 'HEAD') };
  Object.assign(raw, { event_id: f.ingress.eventIdFor(f.context, { registration_id: f.source.registration_id, idempotency_key: key }),
    source_native_event_id: key, idempotency_key: key, producer: { ...raw.producer, sequence: 1 },
    payload: { kind: 'git_revision', object, path: 'src/api.mjs', digest: hashText('export const synthetic = true;\n') } });
  raw.provenance = { delivery: { channel: 'local_git', delivery_id: key }, source_objects: [{ object, acl: raw.acl, sensitivity: raw.sensitivity }] };
  f.ingress.submit(f.context, { registration_id: f.source.registration_id, epoch: f.epoch, event: raw });
  const event = f.ingress.readEvent(f.context, { event_id: raw.event_id }).event;
  return { ref: { event_digest: graphHash(event) }, artifact: canonicalArtifactAddress(event), object, path: raw.payload.path };
}
export { adoption, mutation, assertion, rows, register, capture, bind, git, SCOPE };
