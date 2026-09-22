import { realpathSync, lstatSync, statSync, existsSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { DomainStore } from './domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from './auth.mjs';
import { GitProjectRegistry } from './git-projects.mjs';
import { ProjectActivation } from './project-activation.mjs';
import { DurableIngress } from './durable-ingress.mjs';
import { graphCapabilityFrom, graphGetHead, graphGetReceipt, graphMutate, graphResolve } from './graph-capability.mjs';
import { SourceInvalidationFeed } from './source-invalidation.mjs';
import { GitProvenance } from '../adapters/git-provenance.mjs';
import { parseCanonicalRecord, evaluateCanonicalRecords, CANONICAL_RECORD_PROFILE } from '../core/canonical-records.mjs';
import { validateSemanticRevision, validateSemanticAddress, canonicalArtifactAddress, exactRevisionAddress } from '../core/working-graph.mjs';
import { canonical } from '../core/contracts.mjs';
import { validateGraphCommitAddress2 } from '../core/incremental-graph.mjs';
import { graphInput, graphFields, graphHash, graphEqual, graphId, graphUint, graphErrorCode } from './graph-inputs.mjs';

const KINDS = new Set(['context', 'room', 'ticket', 'ticket_evidence', 'ticket_outcome']);
const fail = code => Object.assign(new Error(`Canonical reader: ${code}`), { code,
  category: ['store_busy', 'store_closed', 'store_unavailable'].includes(code) ? 'retryable_failure' : 'rejected' });
const check = (condition, code = 'invalid_canonical_reader_input') => { if (!condition) throw fail(code); };
const id = value => graphId(value);
const scopeOf = grant => ({ tenant_id: grant.tenant_id, project_id: grant.project_id });
const key = (kind, tuple) => `${kind}/${graphHash(tuple).slice(7)}`;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f\\]/.test(path)
  && !path.startsWith('/') && path.split('/').length <= 16 && path.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git');
const physical = path => { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.birthtimeNs}`; };
const metadataText = path => {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor); check(info.isFile() && info.size <= 4096, 'canonical_membership_unavailable');
    const bytes = Buffer.alloc(4097), length = readSync(descriptor, bytes, 0, bytes.length, 0);
    check(length <= 4096 && length === info.size, 'canonical_membership_unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
};
const projectionGit = value => Object.fromEntries(['status', 'reason', 'object', 'path', 'raw_commit_digest', 'tree_oid', 'tree_chain', 'entry', 'content_digest'].map(k => [k, value[k]]));
const codes = new Set(['invalid_canonical_reader_input', 'canonical_reader_unauthorized', 'canonical_membership_unavailable',
  'canonical_source_mismatch', 'canonical_source_unavailable', 'canonical_capacity', 'canonical_idempotency_conflict', 'canonical_selection_mismatch',
  'canonical_graph_changed', 'canonical_record_corrupt', 'source_access_denied', 'source_invalidation_denied', 'stale_invalidation_fence',
  'graph_revision_mismatch', 'graph_access_denied', 'graph_unauthorized', 'graph_capacity', 'graph_plan_rejected', 'graph_publisher_unavailable',
  'graph_idempotency_conflict', 'graph_unavailable', 'graph_corrupt', 'graph_storage_corrupt', 'graph_maintenance', 'graph_storage_conflict',
  'project_disabled', 'stale_activation_epoch', 'activation_unauthorized', 'invalid_activation_state', 'invalid_execution_membership',
  'ingress_unauthorized', 'source_disabled', 'source_mismatch', 'unknown_source', 'invalid_ingress_input', 'idempotency_conflict',
  'invalidation_unauthorized', 'invalidation_corrupt', 'invalid_invalidation_input', 'store_busy', 'store_closed', 'store_unavailable',
  'store_unauthorized', 'unknown_namespace', 'store_page_too_large', 'invalid_store_input', 'cas_conflict', 'duplicate_identity']);

/** Explicit local read/refresh. Configuration is a trusted process-owner capability, never record authority. */
export class CanonicalSourceReaderService {
  #store; #authority; #registry; #activation; #ingress; #graph; #feed; #path; #execution; #registration; #selection; #config;
  constructor(options) {
    const { store, authority, repository_path, execution: requestedExecution, registration_id, selection: requestedSelection } = options;
    let execution = requestedExecution, selection = requestedSelection;
    check(store instanceof DomainStore && authority instanceof LocalCredentialAuthority);
    this.#graph = graphCapabilityFrom(options, { store, authority });
    check(typeof repository_path === 'string' && isAbsolute(repository_path) && !/[\x00-\x1f]/.test(repository_path));
    execution = graphInput(execution); graphFields(execution, ['repository_id', 'checkout_id', 'worktree_id']); Object.values(execution).forEach(id); id(registration_id);
    selection = graphInput(selection); graphFields(selection, ['schema_profile', 'selection_id', 'policy_id', 'object_format', 'records']);
    check(selection.schema_profile === CANONICAL_RECORD_PROFILE && ['sha1', 'sha256'].includes(selection.object_format));
    id(selection.selection_id); id(selection.policy_id); check(Array.isArray(selection.records) && selection.records.length >= 1 && selection.records.length <= 16, 'canonical_capacity');
    const seenKeys = new Set(), seenPaths = new Set(), seenIds = new Set();
    for (const record of selection.records) {
      graphFields(record, ['key', 'kind', 'id', 'path']); id(record.key); id(record.id);
      check(KINDS.has(record.kind) && safePath(record.path) && /\.(?:json|yaml)$/.test(record.path));
      const identity = `${record.kind}:${record.id}`;
      check(!seenKeys.has(record.key) && !seenPaths.has(record.path) && !seenIds.has(identity));
      seenKeys.add(record.key); seenPaths.add(record.path); seenIds.add(identity);
    }
    selection.records.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    this.#path = repository_path; this.#execution = freeze(execution); this.#selection = freeze(selection); this.#registration = registration_id;
    this.#config = graphHash({ repository_path, execution, registration_id, selection }); this.#authority = authority; this.#store = store;
    this.#registry = new GitProjectRegistry({ store, authority }); this.#activation = new ProjectActivation({ store, authority });
    this.#ingress = new DurableIngress({ store, authority }); this.#feed = new SourceInvalidationFeed({ store, authority });
  }
  #call(operation) {
    try { return freeze(graphInput(operation())); } catch (error) { const code = graphErrorCode(error); throw fail(codes.has(code) ? code : 'invalid_canonical_reader_input'); }
  }
  #grant(context, write = false) {
    const grant = this.#authority.inspect(context), actions = ['store:read', 'graph:read', 'ingress:read', 'source:invalidation:read'];
    if (write) actions.push('store:write', 'graph:write', 'ingress:submit', 'project:inspect', 'activation:read', 'activation:admit');
    check(grant && grant.audience === LOCAL_AUDIENCE && actions.every(a => grant.actions.includes(a))
      && (!write || ['human', 'service'].includes(grant.kind)), 'canonical_reader_unauthorized'); return grant;
  }
  #entity(grant) { return key('canonical-selection', [scopeOf(grant), this.#execution.repository_id, this.#selection.selection_id]); }
  #request(context, options, grant) {
    const value = graphInput(options);
    graphFields(value, ['epoch', 'publisher_ref', 'expected_graph', 'previous_selection', 'commit_oid', 'idempotency_key', 'observation']);
    graphUint(value.epoch); id(value.idempotency_key); validateGraphCommitAddress2(value.expected_graph);
    check(graphEqual(value.expected_graph.scope, scopeOf(grant)));
    graphFields(value.publisher_ref, ['publisher_ref', 'session_id', 'execution_id'], ['epoch', 'status']);
    ['publisher_ref', 'session_id', 'execution_id'].forEach(k => id(value.publisher_ref[k]));
    check(value.publisher_ref.epoch === undefined || value.publisher_ref.epoch === value.epoch);
    check(value.publisher_ref.status === undefined || ['registered', 'duplicate'].includes(value.publisher_ref.status));
    value.publisher_ref = Object.fromEntries(['publisher_ref', 'session_id', 'execution_id'].map(k => [k, value.publisher_ref[k]]));
    graphFields(value.observation, ['observed_at', 'sequence_start']);
    check(typeof value.observation.observed_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observation.observed_at)
      && Number.isFinite(Date.parse(value.observation.observed_at)) && new Date(value.observation.observed_at).toISOString() === value.observation.observed_at);
    check(value.observation.sequence_start === null || Number.isSafeInteger(value.observation.sequence_start) && value.observation.sequence_start >= 0
      && value.observation.sequence_start <= Number.MAX_SAFE_INTEGER - this.#selection.records.length);
    check(typeof value.commit_oid === 'string' && new RegExp(`^[a-f0-9]{${this.#selection.object_format === 'sha1' ? 40 : 64}}$`).test(value.commit_oid));
    if (value.previous_selection !== null) {
      validateSemanticRevision(value.previous_selection); const previous = value.previous_selection;
      check(previous.entity_kind === 'entity' && previous.entity_id === this.#entity(grant) && graphEqual(previous.scope, scopeOf(grant))
        && previous.generation_id === value.expected_graph.generation_id && previous.assertion.content.semantic_type === 'canonical-selection', 'canonical_selection_mismatch');
      const data = previous.assertion.content.data;
      check(data.kind === 'canonical_selection' && data.schema_version === 1 && data.config_digest === this.#config
        && data.selection_id === this.#selection.selection_id && typeof data.commit_oid === 'string', 'canonical_selection_mismatch');
      this.#checkIssuance(context, previous);
    }
    return value;
  }
  #issuance(scope, generation_id, assertion) {
    const data = assertion.content.data;
    return { schema_version: 1, kind: 'canonical_reader_issuance', scope, generation_id,
      entity_id: assertion.entity_id, selection_id: this.#selection.selection_id, config_digest: this.#config,
      request_digest: data.request_digest, commit_oid: data.commit_oid, source_fence: data.source_fence,
      assertion_digest: graphHash(assertion) };
  }
  #issuanceId(value) { return key('canonical-issuance', [value.config_digest, value.request_digest]); }
  #checkIssuance(context, revision) {
    const expected = this.#issuance(revision.scope, revision.generation_id, revision.assertion);
    const retained = this.#store.getSource(context, 'working-graph', this.#issuanceId(expected));
    check(retained?.kind === 'canonical-reader-issuance' && graphEqual(retained.value, expected), 'canonical_selection_mismatch');
  }
  #issue(context, request, grant, assertion, fence) {
    const value = this.#issuance(scopeOf(grant), request.expected_graph.generation_id, assertion);
    let capturedCode;
    try {
      const result = this.#activation.withAdmission(context, { epoch: request.epoch, stage: 'result', execution: this.#execution }, tx => {
        try {
          this.#grant(context, true); this.#feed.assertFence(context, { sequence: fence });
          const retained = tx.getSource('working-graph', this.#issuanceId(value));
          if (retained) check(retained.kind === 'canonical-reader-issuance' && graphEqual(retained.value, value), 'canonical_idempotency_conflict');
          else tx.appendSource('working-graph', this.#issuanceId(value), 'canonical-reader-issuance', value);
          this.#feed.assertFence(context, { sequence: fence }); this.#grant(context, true);
          return null;
        } catch (error) { capturedCode = graphErrorCode(error); throw error; }
      });
      if (!result.admitted) throw fail(result.reason);
    } catch (error) { if (codes.has(capturedCode)) throw fail(capturedCode); throw error; }
  }
  #selected(context, request, grant) {
    const source = this.#ingress.getRegistration(context, { registration_id: this.#registration }), r = source.registration;
    check(r.producer_principal_id === grant.principal_id && graphEqual(r.execution, this.#execution)
      && r.partition.tenant_id === grant.tenant_id && r.partition.project_id === grant.project_id
      && r.mapping.event_types.canonical_record === 'DOC_CHANGED', 'canonical_source_mismatch');
    check(r.access.enabled, 'source_disabled');
    const activation = this.#activation.get(context).state;
    check(activation.enabled, 'project_disabled'); check(activation.epoch === request.epoch, 'stale_activation_epoch');
    const catalog = this.#registry.get(context), checkout = catalog?.value.checkouts.find(c => c.state === 'active'
      && c.repository_id === this.#execution.repository_id && c.checkout_id === this.#execution.checkout_id);
    const worktree = checkout?.worktrees.find(w => w.state === 'active' && w.status === 'available' && w.worktree_id === this.#execution.worktree_id);
    check(worktree && r.partition.source_installation_id === catalog.value.installation_id, 'canonical_membership_unavailable');
    const width = this.#selection.object_format === 'sha1' ? 40 : 64;
    check([...checkout.worktrees.map(w => w.head), ...checkout.refs.map(ref => ref.oid)].filter(Boolean).every(oid => oid.length === width), 'canonical_source_mismatch');
    return { source, catalog, checkout, worktree };
  }
  #physical(selected) {
    try {
      const { checkout, worktree } = selected;
      check(realpathSync(this.#path) === worktree.path && realpathSync(worktree.path) === worktree.path
        && physical(checkout.common_dir) === checkout.common_identity && physical(worktree.git_dir) === worktree.identity, 'canonical_membership_unavailable');
      const marker = join(worktree.path, '.git'), markerStat = lstatSync(marker);
      let actual;
      if (markerStat.isDirectory()) actual = realpathSync(marker);
      else { const text = metadataText(marker); check(/^gitdir: [^\r\n]+$/.test(text), 'canonical_membership_unavailable'); actual = realpathSync(resolve(worktree.path, text.slice(8))); }
      check(actual === worktree.git_dir, 'canonical_membership_unavailable');
      const commonMarker = join(actual, 'commondir');
      const common = existsSync(commonMarker) ? realpathSync(resolve(actual, metadataText(commonMarker))) : actual;
      check(common === checkout.common_dir, 'canonical_membership_unavailable');
      const objects = join(common, 'objects'); check(lstatSync(objects).isDirectory() && realpathSync(objects) === objects, 'canonical_membership_unavailable'); return objects;
    } catch { throw fail('canonical_membership_unavailable'); }
  }
  #guard(context, object, fence) {
    const result = this.#ingress.assertGitReadAccess(context, { registration_id: this.#registration, object });
    check(result.source_fence === fence, 'stale_invalidation_fence'); this.#feed.assertFence(context, { sequence: fence }); return result;
  }
  #read(context, at, address) {
    const grant = this.#grant(context); validateGraphCommitAddress2(at); validateSemanticAddress(address);
    check(address.entity_kind === 'entity' && address.entity_id === this.#entity(grant) && graphEqual(address.scope, scopeOf(grant)), 'canonical_selection_mismatch');
    const fence = this.#feed.head(context).sequence;
    const selected = graphResolve(this.#graph, context, { at, address });
    if (selected.status !== 'resolved') return { status: selected.status === 'denied' ? 'quarantined' : 'unavailable', selection: null };
    const data = selected.revision.assertion.content.data;
    check(selected.revision.assertion.content.semantic_type === 'canonical-selection' && data.kind === 'canonical_selection'
      && data.config_digest === this.#config, 'canonical_selection_mismatch');
    this.#checkIssuance(context, selected.revision);
    if (data.source_fence !== fence) return { status: 'quarantined', selection: null };
    const head = graphGetHead(this.#graph, context, { generation_id: at.generation_id });
    this.#feed.assertFence(context, { sequence: fence }); this.#grant(context);
    return { status: graphEqual(head.graph_revision, at) && graphEqual(selected.entity.head, exactRevisionAddress(selected.revision)) ? 'current' : 'historical',
      selection: selected.revision, address: exactRevisionAddress(selected.revision), graph_revision: at };
  }
  resolve(context, options) { return this.#call(() => { const value = graphInput(options); graphFields(value, ['at', 'address']); return this.#read(context, value.at, value.address); }); }
  refresh(context, options) {
    return this.#call(() => {
      const grant = this.#grant(context), request = this.#request(context, options, grant);
      const requestDigest = graphHash({ schema_version: 1, config_digest: this.#config, request });
      const commandKey = key('canonical-refresh', [this.#selection.selection_id, request.idempotency_key]);
      const prior = graphGetReceipt(this.#graph, context, { generation_id: request.expected_graph.generation_id, idempotency_key: commandKey });
      if (prior) {
        const read = this.#read(context, prior.next_graph, prior.result.revision);
        check(read.selection !== null, 'stale_invalidation_fence');
        check(read.selection.assertion.content.data.request_digest === requestDigest, 'canonical_idempotency_conflict');
        return { status: 'duplicate', receipt: prior, selection_status: read.status, selection: read.selection, address: read.address, graph_revision: read.graph_revision };
      }
      this.#grant(context, true);
      const selected = this.#selected(context, request, grant), fence = this.#feed.head(context).sequence;
      const object = { kind: 'git_commit', tenant_id: grant.tenant_id, repository_id: this.#execution.repository_id,
        object_format: this.#selection.object_format, oid: request.commit_oid };
      const observed = this.#selection.records.map((record, index) => {
        const retryKey = key('canonical-record', [this.#selection.selection_id, request.idempotency_key, record.key]);
        const event_id = this.#ingress.eventIdFor(context, { registration_id: this.#registration, idempotency_key: retryKey });
        const receipt = this.#ingress.getReceipt(context, { event_id });
        const existing = receipt ? this.#ingress.readEvent(context, { event_id }) : null;
        if (existing) {
          check(existing.raw.source_native_event_id === `${requestDigest.slice(7)}/${fence}`, 'canonical_idempotency_conflict');
          check(existing.receipt.registration_id === this.#registration && existing.receipt.activation_epoch === request.epoch, 'canonical_idempotency_conflict');
        }
        return { record, index, retryKey, event_id, existing };
      });
      this.#guard(context, object, fence);
      const objects = this.#physical(selected);
      const git = new GitProvenance({ repository_path: this.#path, object_directory: objects,
        authorize_commit: candidate => { this.#guard(context, candidate, fence); },
        repository: { tenant_id: grant.tenant_id, repository_id: this.#execution.repository_id, object_format: this.#selection.object_format } });
      if (request.previous_selection !== null) {
        const relation = git.proveDescendant({ ancestor_oid: request.previous_selection.assertion.content.data.commit_oid, descendant_oid: request.commit_oid });
        if (!['same', 'descendant'].includes(relation.status)) return { status: 'not_advanced', reason: relation.status, metrics: git.metrics() };
      }
      const entries = [], proofs = [];
      for (const item of observed) {
        this.#guard(context, object, fence);
        const read = git.readFileAtCommit({ commit_oid: request.commit_oid, path: item.record.path });
        if (read.reason === 'limit_exceeded') throw fail('canonical_capacity');
        check(read.raw_commit_digest && read.tree_oid, 'canonical_source_unavailable');
        const result = read.status === 'resolved' ? parseCanonicalRecord(read.bytes, { kind: item.record.kind, id: item.record.id })
          : { status: read.status, reason: read.reason, kind: item.record.kind, id: item.record.id, record: null, byte_length: 0 };
        entries.push({ ...item.record, result }); proofs.push(projectionGit(read));
      }
      const preliminary = evaluateCanonicalRecords(entries, { artifacts: [] }), artifacts = [];
      check(preliminary.entries.length === entries.length, 'canonical_record_corrupt');
      check(new Set([...this.#selection.records.map(r => r.path), ...preliminary.artifact_requirements]).size <= 32, 'canonical_capacity');
      for (const path of preliminary.artifact_requirements) {
        this.#guard(context, object, fence);
        const read = git.readEntryAtCommit({ commit_oid: request.commit_oid, path });
        if (read.reason === 'limit_exceeded') throw fail('canonical_capacity');
        const entryType = read.entry?.mode === '120000' ? 'symlink' : read.entry?.mode === '160000' ? 'gitlink' : read.entry?.type === 'tree' ? 'tree' : 'regular_blob';
        artifacts.push({ path, status: read.status === 'resolved' ? 'present' : read.status === 'absent' ? 'absent' : 'unavailable', entry_type: entryType });
        // Exact entry proofs are retained separately from the evaluator's small facts.
        proofs.push(projectionGit(read));
      }
      const evaluated = evaluateCanonicalRecords(entries, { artifacts });
      check(evaluated.entries.length === entries.length, 'canonical_record_corrupt');
      this.#guard(context, object, fence); this.#physical(selected);
      check(graphEqual(this.#selected(context, request, grant).catalog, selected.catalog), 'canonical_membership_unavailable');
      const events = [], positions = [];
      for (const [index, item] of observed.entries()) {
        const proof = proofs[index], source = selected.source, r = source.registration;
        const acl = { revision: `registration-${source.version}`, allowed_principal_ids: r.access.allowed_principal_ids };
        const payload = proof.status === 'resolved' ? { kind: 'git_revision', object, path: item.record.path, digest: proof.content_digest }
          : { kind: 'git_revision', object, path: null, digest: proof.raw_commit_digest };
        const raw = { schema_version: 1, kind: 'raw_event', event_id: item.event_id, partition: r.partition,
          source_native_event_id: `${requestDigest.slice(7)}/${fence}`, idempotency_key: item.retryKey, source_event_type: 'canonical_record',
          occurred_at: request.observation.observed_at, observed_at: request.observation.observed_at,
          producer: { ...r.producer, sequence: request.observation.sequence_start === null ? null : request.observation.sequence_start + item.index },
          causal_parents: [], identity: this.#execution, payload,
          provenance: { delivery: { channel: 'local_git', delivery_id: item.retryKey }, source_objects: [{ object, acl, sensitivity: r.access.sensitivity }] },
          acl, sensitivity: r.access.sensitivity };
        if (item.existing) check(graphEqual(item.existing.raw, raw), 'canonical_idempotency_conflict');
        else this.#ingress.submit(context, { registration_id: this.#registration, epoch: request.epoch, event: raw });
        const admitted = this.#ingress.readEvent(context, { event_id: item.event_id }); events.push(admitted.event);
        positions.push({ key: item.record.key, event_id: item.event_id, event_digest: admitted.receipt.event_digest,
          registration_id: this.#registration, sequence: admitted.event.producer.sequence, cursor_status: admitted.receipt.cursor_status });
      }
      this.#guard(context, object, fence);
      const order = values => [...values].sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
      const canonicalRefs = order(events.map(canonicalArtifactAddress));
      const data = { schema_version: 1, kind: 'canonical_selection', selection_id: this.#selection.selection_id,
        policy_id: this.#selection.policy_id, config_digest: this.#config, request_digest: requestDigest, commit_oid: request.commit_oid,
        source_fence: fence, source_watermark: { kind: 'selected_admitted_observations', positions, completion: 'unknown' },
        schema_profile: evaluated.profile, evaluation_status: evaluated.status, evaluation_reason: evaluated.reason,
        records: evaluated.entries.map((entry, index) => ({ ...entry, canonical_ref_index: canonicalRefs.findIndex(ref => ref.event.event_id === events[index].event_id), source_proof_index: index,
          projection_state: entry.status === 'absent' ? 'absent' : entry.record ? 'present' : 'unusable' })), bindings: evaluated.bindings, record_refs: evaluated.canonical_refs,
        artifact_requirements: evaluated.artifact_requirements, source_proofs: proofs };
      const assertion = { schema_version: 1, assertion_id: key('canonical-assertion', [requestDigest]), entity_kind: 'entity', entity_id: this.#entity(grant),
        base_revision: request.previous_selection === null ? null : exactRevisionAddress(request.previous_selection), parents: [],
        execution_id: request.publisher_ref.execution_id, status: 'candidate', content: { semantic_type: 'canonical-selection', data }, events: order(events),
        canonical_refs: canonicalRefs };
      this.#issue(context, request, grant, assertion, fence);
      const result = graphMutate(this.#graph, context, { epoch: request.epoch, publisher_ref: request.publisher_ref.publisher_ref,
        expected_graph: request.expected_graph, idempotency_key: commandKey, operation: { kind: 'assert', assertion }, coverage: null, expected_source_fence: fence });
      if (result.status === 'graph_revision_mismatch') return { status: result.status, graph_revision: result.graph_revision, metrics: git.metrics() };
      if (result.conflict) return { status: 'conflict', receipt: result.receipt, conflict: result.conflict, metrics: git.metrics() };
      const read = this.#read(context, result.receipt.next_graph, result.revision);
      check(read.selection !== null, 'stale_invalidation_fence');
      return { status: 'applied', receipt: result.receipt, selection_status: read.status, selection: read.selection,
        address: read.address, graph_revision: read.graph_revision, metrics: git.metrics() };
    });
  }
}
