import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

export const CANONICAL_RECORD_PROFILE = 'vibehub-records-v1';

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_AGGREGATE_BYTES = 256 * 1024;
const MAX_RECORDS = 16;
const MAX_PATHS = 32;
const MAX_NODES = 25000;
const MAX_DEPTH = 32;
const KINDS = new Set(['context', 'room', 'ticket', 'ticket_evidence', 'ticket_outcome']);
const CONTEXT_TYPES = new Set(['intent', 'decision', 'constraint', 'contract', 'convention', 'change', 'note', 'authority']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const COMMIT_REF = /^commit:[0-9a-f]{40}$/u;
const PR_REF = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/iu;

class ProfileError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

const reject = reason => { throw new ProfileError(reason); };
const assert = (condition, reason = 'invalid_schema') => { if (!condition) reject(reason); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && /\S/u.test(value);
const id = value => typeof value === 'string' && ID.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 1;
const digest = value => typeof value === 'string' && DIGEST.test(value);
const dateTime = value => {
  if (typeof value !== 'string') return false;
  const match = DATE_TIME.exec(value); if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[7] ?? 0), offsetMinute = Number(match[8] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 60 && offsetHour <= 23 && offsetMinute <= 59;
};
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const equal = (left, right) => canonical(left) === canonical(right);
const semanticDigest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function exactKeys(value, required, optional = []) {
  assert(object(value));
  const allowed = new Set([...required, ...optional]);
  assert(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key)));
}
function unique(values, key = item => canonical(item)) {
  assert(Array.isArray(values));
  const selected = values.map(key); assert(new Set(selected).size === selected.length);
}
function textArray(value, { nonempty = false, ids = false } = {}) {
  assert(Array.isArray(value) && (!nonempty || value.length > 0));
  assert(value.every(item => ids ? id(item) : text(item))); unique(value, item => item);
}
function enumValue(value, values) { assert(values.includes(value)); }
function inertObject(value, required, optional = []) {
  assert(object(value) && !isProxy(value), 'invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert(Object.getOwnPropertySymbols(value).length === 0, 'invalid_input');
  for (const descriptor of Object.values(descriptors)) {
    assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'invalid_input');
  }
  exactKeys(value, required, optional);
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
function assertInertTree(value, depth = 0, state = { nodes: 0, stack: new Set() }) {
  assert(++state.nodes <= MAX_NODES && depth <= MAX_DEPTH, 'invalid_input');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') { assert(Number.isFinite(value), 'invalid_input'); return; }
  assert(typeof value === 'object' && !isProxy(value) && !state.stack.has(value), 'invalid_input');
  assert(Object.getOwnPropertySymbols(value).length === 0, 'invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    assert(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'invalid_input');
  }
  if (Array.isArray(value)) assert(Object.keys(value).length === value.length, 'invalid_input');
  else assert([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'invalid_input');
  state.stack.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    assertInertTree(descriptor.value, depth + 1, state);
  }
  state.stack.delete(value);
}
function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function decodeInput(input) {
  let value;
  if (input && typeof input === 'object' && isProxy(input)) reject('invalid_input');
  if (typeof input === 'string') value = input;
  else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(input); }
    catch { reject('invalid_utf8'); }
  } else reject('invalid_input');
  assert(!hasUnpairedSurrogate(value), 'invalid_utf8');
  const bytes = Buffer.byteLength(value, 'utf8'); assert(bytes <= MAX_RECORD_BYTES, 'record_too_large');
  return { value, bytes };
}

// A deliberately small JSON parser. JSON.parse cannot report duplicate object
// keys, which are ambiguous canonical input even though JavaScript accepts them.
function parseJson(source) {
  let at = 0, nodes = 0;
  const whitespace = () => { while (/[\t\n\r ]/u.test(source[at] ?? '')) at++; };
  const readString = () => {
    assert(source[at++] === '"', 'invalid_json'); let result = '';
    while (at < source.length) {
      const character = source[at++];
      if (character === '"') return result;
      if (character === '\\') {
        const escaped = source[at++];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (Object.hasOwn(simple, escaped)) { result += simple[escaped]; continue; }
        assert(escaped === 'u', 'invalid_json');
        const digits = source.slice(at, at + 4); assert(/^[0-9a-fA-F]{4}$/u.test(digits), 'invalid_json'); at += 4;
        const first = Number.parseInt(digits, 16);
        if (first >= 0xd800 && first <= 0xdbff) {
          assert(source.slice(at, at + 2) === '\\u', 'invalid_json'); at += 2;
          const lowDigits = source.slice(at, at + 4); assert(/^[0-9a-fA-F]{4}$/u.test(lowDigits), 'invalid_json'); at += 4;
          const second = Number.parseInt(lowDigits, 16); assert(second >= 0xdc00 && second <= 0xdfff, 'invalid_json');
          result += String.fromCodePoint(0x10000 + (first - 0xd800) * 0x400 + second - 0xdc00);
        } else {
          assert(!(first >= 0xdc00 && first <= 0xdfff), 'invalid_json'); result += String.fromCharCode(first);
        }
        continue;
      }
      const code = character.charCodeAt(0); assert(code >= 0x20, 'invalid_json');
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = source[at]; const lowCode = low?.charCodeAt(0);
        assert(lowCode >= 0xdc00 && lowCode <= 0xdfff, 'invalid_json'); result += character + low; at++;
      } else { assert(!(code >= 0xdc00 && code <= 0xdfff), 'invalid_json'); result += character; }
    }
    reject('invalid_json');
  };
  const read = depth => {
    assert(++nodes <= MAX_NODES && depth <= MAX_DEPTH, 'record_too_large'); whitespace();
    if (source[at] === '{') {
      at++; whitespace(); const result = Object.create(null), keys = new Set();
      if (source[at] === '}') { at++; return result; }
      while (true) {
        whitespace(); assert(source[at] === '"', 'invalid_json'); const key = readString();
        assert(!keys.has(key), 'duplicate_json_key'); keys.add(key); whitespace(); assert(source[at++] === ':', 'invalid_json');
        result[key] = read(depth + 1); whitespace();
        if (source[at] === '}') { at++; return result; }
        assert(source[at++] === ',', 'invalid_json');
      }
    }
    if (source[at] === '[') {
      at++; whitespace(); const result = [];
      if (source[at] === ']') { at++; return result; }
      while (true) {
        result.push(read(depth + 1)); whitespace();
        if (source[at] === ']') { at++; return result; }
        assert(source[at++] === ',', 'invalid_json');
      }
    }
    if (source[at] === '"') return readString();
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, at)) { at += token.length; return value; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(at));
    assert(match, 'invalid_json'); at += match[0].length; const value = Number(match[0]);
    assert(Number.isFinite(value), 'invalid_json'); return value;
  };
  whitespace(); assert(source[at] === '{', source.trimStart().startsWith('{') ? 'invalid_json' : 'unsupported_source_form');
  const value = read(0); whitespace(); assert(at === source.length, 'invalid_json'); return value;
}

function repoPath(value) {
  assert(text(value) && !value.startsWith('/') && !value.includes('\\') && !value.includes('#'));
  const components = value.split('/');
  assert(components.length >= 1 && components.length <= 16
    && components.every(component => component !== '' && component !== '.' && component !== '..'));
  return components.join('/');
}
function anchoredPath(value) {
  if (typeof value === 'string' && value.includes('#')) reject('segment_anchor_unsupported');
  const selected = repoPath(value);
  assert(selected.split('/').every(component => !['.git', '.vibehub'].includes(component.toLowerCase())));
  return selected;
}
function artifactPath(value) {
  const selected = repoPath(value);
  assert(selected.split('/').every(component => !['.git', '.vibehub'].includes(component.toLowerCase())));
  return selected;
}
function acceptanceRef(value) {
  exactKeys(value, ['acceptance_id', 'revision', 'identity']);
  assert(id(value.acceptance_id) && revision(value.revision) && digest(value.identity));
}
function lineageRef(value) {
  exactKeys(value, ['acceptance_id', 'revision']); assert(id(value.acceptance_id) && revision(value.revision));
}
function presentation(value) {
  exactKeys(value, [], ['label', 'description']); assert(Object.keys(value).length > 0);
  if (value.label !== undefined) assert(text(value.label));
  if (value.description !== undefined) assert(text(value.description));
}
function acceptanceIdentity(ticketId, value) {
  return semanticDigest({ ticket_id: ticketId, acceptance_id: value.acceptance_id, revision: value.revision,
    criterion: value.criterion, authority: value.authority ?? 'agent',
    derived_from: [...(value.derived_from ?? [])].map(item => ({ acceptance_id: item.acceptance_id, revision: item.revision }))
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id) || left.revision - right.revision) });
}
function contractIdentity(ticketId, value) {
  return semanticDigest({ ticket_id: ticketId, revision: value.revision,
    acceptance_revisions: [...value.acceptance_revisions]
      .map(item => ({ acceptance_id: item.acceptance_id, revision: item.revision, identity: item.identity }))
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id) || left.revision - right.revision) });
}

function validateContext(value) {
  exactKeys(value, ['schema_version', 'kind', 'context_id', 'type', 'state', 'summary', 'detail', 'tags', 'source', 'evidence', 'relations'], ['authority']);
  assert(value.schema_version === 1 && value.kind === 'context' && id(value.context_id)
    && CONTEXT_TYPES.has(value.type) && ['active', 'superseded', 'archived'].includes(value.state)
    && text(value.summary) && text(value.detail));
  textArray(value.tags);
  exactKeys(value.source, ['ref', 'captured_at'], ['quote']);
  assert(text(value.source.ref) && dateTime(value.source.captured_at));
  if (value.source.quote !== undefined) assert(text(value.source.quote));
  assert(Array.isArray(value.evidence) && value.evidence.length > 0);
  value.evidence.forEach(item => { exactKeys(item, ['ref', 'note']); assert(text(item.ref) && text(item.note)); });
  assert(Array.isArray(value.relations));
  value.relations.forEach(item => { exactKeys(item, ['type', 'target_context_id']);
    assert(['relates_to', 'depends_on', 'supersedes'].includes(item.type) && id(item.target_context_id)); });
  if (value.type === 'authority') {
    exactKeys(value.authority, ['governs', 'canonical', 'update_rules', 'validation'], ['approval']);
    for (const name of ['governs', 'canonical', 'update_rules', 'validation']) textArray(value.authority[name], { nonempty: true });
    value.authority.governs.forEach(anchoredPath); value.authority.canonical.forEach(artifactPath);
    if (value.authority.approval !== undefined) enumValue(value.authority.approval, ['none', 'human']);
  } else assert(value.authority === undefined);
}
function validateRoom(value) {
  exactKeys(value, ['schema_version', 'kind', 'room_id', 'description', 'boundary', 'anchors', 'stale'],
    ['alignment', 'stale_reason', 'coverage_exceptions']);
  assert(value.schema_version === 1 && value.kind === 'room' && id(value.room_id)
    && text(value.description) && text(value.boundary) && typeof value.stale === 'boolean');
  textArray(value.anchors); value.anchors.forEach(anchoredPath);
  if (value.alignment !== undefined) {
    exactKeys(value.alignment, ['last_aligned_commit', 'checked_at', 'anchor_hashes']);
    assert(text(value.alignment.last_aligned_commit) && dateTime(value.alignment.checked_at));
    assert(Array.isArray(value.alignment.anchor_hashes)); unique(value.alignment.anchor_hashes);
    value.alignment.anchor_hashes.forEach(item => { exactKeys(item, ['path', 'blob']); assert(text(item.path) && text(item.blob)); });
  }
  if (value.stale_reason !== undefined) assert(text(value.stale_reason));
  if (value.coverage_exceptions !== undefined) {
    assert(Array.isArray(value.coverage_exceptions)); unique(value.coverage_exceptions);
    value.coverage_exceptions.forEach(item => { exactKeys(item, ['segment', 'reason']); assert(text(item.segment) && text(item.reason)); });
  }
}
function validateDelivery(value) {
  assert(object(value));
  if (value.kind === 'pull_request') {
    exactKeys(value, ['kind', 'ref', 'state'], ['delivered_at', 'delivered_commit', 'reverted_by']);
    assert(PR_REF.test(value.ref) && ['proposed', 'delivered', 'abandoned'].includes(value.state));
  } else if (value.kind === 'cherry_pick') {
    exactKeys(value, ['kind', 'ref', 'state', 'delivered_at', 'delivered_commit'], ['reverted_by']);
    assert(COMMIT_REF.test(value.ref) && value.state === 'delivered');
  } else reject('invalid_schema');
  if (value.delivered_at !== undefined) assert(dateTime(value.delivered_at));
  if (value.delivered_commit !== undefined) assert(typeof value.delivered_commit === 'string' && COMMIT.test(value.delivered_commit));
  if (value.reverted_by !== undefined) assert(typeof value.reverted_by === 'string' && COMMIT_REF.test(value.reverted_by));
}
function validateTicket(value) {
  exactKeys(value, ['schema_version', 'kind', 'ticket_id', 'revision_state', 'outcome', 'deliveries', 'context', 'acceptance',
    'constraints', 'context_refs', 'relations', 'provenance_refs'], ['active_contract_revision', 'contract_revisions', 'maturity']);
  assert(value.schema_version === 3 && value.kind === 'ticket' && id(value.ticket_id));
  if (value.revision_state !== 'bound') reject('unsupported_binding');
  assert(text(value.outcome) && text(value.context));
  if (value.maturity !== undefined) enumValue(value.maturity, ['firm', 'draft']);
  assert(Array.isArray(value.deliveries)); value.deliveries.forEach(validateDelivery);
  textArray(value.constraints); textArray(value.provenance_refs);
  assert(Array.isArray(value.context_refs)); value.context_refs.forEach(item => {
    exactKeys(item, ['ref', 'purpose']); assert(text(item.ref) && text(item.purpose));
  });
  assert(Array.isArray(value.relations)); value.relations.forEach(item => {
    exactKeys(item, ['type', 'target_ticket_id'], ['rationale']);
    assert(item.type === 'depends_on' && id(item.target_ticket_id)); if (item.rationale !== undefined) assert(text(item.rationale));
  });
  assert(Array.isArray(value.acceptance) && value.acceptance.length > 0);
  const byKey = new Map(), activeIds = new Set(), revisions = new Map();
  value.acceptance.forEach(item => {
    exactKeys(item, ['acceptance_id', 'revision', 'identity', 'criterion', 'state'],
      ['authority', 'derived_from', 'presentation']);
    assert(id(item.acceptance_id) && revision(item.revision) && digest(item.identity) && text(item.criterion));
    if (item.authority !== undefined) enumValue(item.authority, ['agent', 'human']);
    enumValue(item.state, ['active', 'retired']);
    if (item.derived_from !== undefined) { assert(Array.isArray(item.derived_from)); unique(item.derived_from);
      item.derived_from.forEach(lineageRef); }
    if (item.presentation !== undefined) presentation(item.presentation);
    assert(item.identity === acceptanceIdentity(value.ticket_id, item));
    const key = `${item.acceptance_id}@${item.revision}`; assert(!byKey.has(key)); byKey.set(key, item);
    const selected = revisions.get(item.acceptance_id) ?? []; selected.push(item.revision); revisions.set(item.acceptance_id, selected);
    if (item.state === 'active') { assert(!activeIds.has(item.acceptance_id)); activeIds.add(item.acceptance_id); }
  });
  for (const selected of revisions.values()) {
    selected.sort((a, b) => a - b).forEach((number, index) => assert(number === index + 1));
  }
  for (const item of value.acceptance) for (const source of item.derived_from ?? []) {
    const found = byKey.get(`${source.acceptance_id}@${source.revision}`);
    assert(found && found.acceptance_id !== item.acceptance_id && found.state === 'retired');
  }
  assert(revision(value.active_contract_revision) && Array.isArray(value.contract_revisions) && value.contract_revisions.length > 0);
  const contractNumbers = new Set();
  value.contract_revisions.forEach(contract => {
    exactKeys(contract, ['revision', 'identity', 'acceptance_revisions']);
    assert(revision(contract.revision) && digest(contract.identity) && !contractNumbers.has(contract.revision));
    contractNumbers.add(contract.revision); assert(Array.isArray(contract.acceptance_revisions));
    unique(contract.acceptance_revisions, item => `${item.acceptance_id}@${item.revision}`);
    contract.acceptance_revisions.forEach(item => {
      acceptanceRef(item); const found = byKey.get(`${item.acceptance_id}@${item.revision}`);
      assert(found && found.identity === item.identity);
    });
    assert(contract.identity === contractIdentity(value.ticket_id, contract));
  });
  [...contractNumbers].sort((a, b) => a - b).forEach((number, index) => assert(number === index + 1));
  const orderedContracts = [...value.contract_revisions].sort((left, right) => left.revision - right.revision);
  for (let index = 1; index < orderedContracts.length; index++) {
    const membership = contract => [...contract.acceptance_revisions]
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id) || left.revision - right.revision);
    assert(!equal(membership(orderedContracts[index - 1]), membership(orderedContracts[index])));
  }
  assert(value.active_contract_revision === Math.max(...contractNumbers));
  const current = value.contract_revisions.find(item => item.revision === value.active_contract_revision);
  const expected = value.acceptance.filter(item => item.state === 'active')
    .map(item => ({ acceptance_id: item.acceptance_id, revision: item.revision, identity: item.identity }))
    .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id) || left.revision - right.revision);
  const actual = [...current.acceptance_revisions]
    .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id) || left.revision - right.revision);
  assert(equal(actual, expected));
}
function validateUnresolved(value) {
  exactKeys(value, ['reason', 'attempted_refs']); enumValue(value.reason, ['missing-history', 'ambiguous-history']);
  textArray(value.attempted_refs, { nonempty: true });
}
function validateEvidence(value) {
  exactKeys(value, ['schema_version', 'kind', 'evidence_id', 'ticket_id', 'acceptance_ids', 'binding_state', 'summary', 'refs', 'recorded_at'],
    ['binding_origin', 'acceptance_revisions', 'unresolved', 'origin']);
  assert(value.schema_version === 2 && value.kind === 'ticket_evidence' && id(value.evidence_id) && id(value.ticket_id));
  textArray(value.acceptance_ids, { nonempty: true, ids: true });
  enumValue(value.binding_state, ['bound', 'legacy-pending-reconstruction', 'legacy-unresolved']);
  if (value.binding_state === 'bound') {
    assert(['native', 'reconstructed'].includes(value.binding_origin)
      && Array.isArray(value.acceptance_revisions) && value.acceptance_revisions.length > 0 && value.unresolved === undefined);
    unique(value.acceptance_revisions, item => item.acceptance_id); value.acceptance_revisions.forEach(acceptanceRef);
    assert(equal([...value.acceptance_ids].sort(), value.acceptance_revisions.map(item => item.acceptance_id).sort()));
  } else {
    assert(value.binding_origin === undefined && value.acceptance_revisions === undefined);
    if (value.binding_state === 'legacy-unresolved') validateUnresolved(value.unresolved);
    else assert(value.unresolved === undefined);
  }
  assert(text(value.summary) && dateTime(value.recorded_at)); textArray(value.refs, { nonempty: true });
  if (value.origin !== undefined) enumValue(value.origin, ['agent', 'human']);
  if (value.binding_state !== 'bound' || value.binding_origin !== 'native') reject('unsupported_binding');
}
function validateOutcome(value) {
  exactKeys(value, ['schema_version', 'kind', 'outcome_id', 'ticket_id', 'binding_state', 'status', 'accepted_acceptance_ids',
    'unresolved_acceptance_ids', 'evidence_ids', 'summary', 'closed_at'],
  ['binding_origin', 'contract_revision', 'unresolved', 'independence']);
  assert(value.schema_version === 2 && value.kind === 'ticket_outcome' && id(value.outcome_id) && id(value.ticket_id));
  enumValue(value.binding_state, ['bound', 'legacy-pending-reconstruction', 'legacy-unresolved']);
  if (value.binding_state === 'bound') {
    assert(['native', 'reconstructed'].includes(value.binding_origin) && value.unresolved === undefined);
    exactKeys(value.contract_revision, ['revision', 'identity']);
    assert(revision(value.contract_revision.revision) && digest(value.contract_revision.identity));
  } else {
    assert(value.binding_origin === undefined && value.contract_revision === undefined);
    if (value.binding_state === 'legacy-unresolved') validateUnresolved(value.unresolved);
    else assert(value.unresolved === undefined);
  }
  enumValue(value.status, ['successful', 'partial', 'failed', 'deviated']);
  textArray(value.accepted_acceptance_ids, { ids: true }); textArray(value.unresolved_acceptance_ids, { ids: true });
  textArray(value.evidence_ids, { ids: true }); assert(text(value.summary) && dateTime(value.closed_at));
  if (value.independence !== undefined) {
    exactKeys(value.independence, ['source'], ['note']);
    enumValue(value.independence.source, ['subagent', 'separate_session', 'different_human']);
    if (value.independence.note !== undefined) assert(text(value.independence.note));
  }
  if (value.binding_state !== 'bound' || value.binding_origin !== 'native') reject('unsupported_binding');
}
function validateKind(kind, value) {
  const expectedVersion = { context: 1, room: 1, ticket: 3, ticket_evidence: 2, ticket_outcome: 2 }[kind];
  if (value?.schema_version !== expectedVersion) reject('unsupported_schema');
  if (kind === 'context') validateContext(value);
  else if (kind === 'room') validateRoom(value);
  else if (kind === 'ticket') validateTicket(value);
  else if (kind === 'ticket_evidence') validateEvidence(value);
  else if (kind === 'ticket_outcome') validateOutcome(value);
  else reject('unsupported_schema');
}
const recordId = (kind, value) => ({ context: value.context_id, room: value.room_id, ticket: value.ticket_id,
  ticket_evidence: value.evidence_id, ticket_outcome: value.outcome_id })[kind];

function parseFailure(reason, kind = null, selectedId = null, bytes = 0) {
  const status = reason.startsWith('unsupported_') || reason === 'segment_anchor_unsupported' ? 'unsupported' : 'invalid';
  return freeze({ status, reason, kind, id: selectedId, record: null, byte_length: bytes });
}

export function parseCanonicalRecord(input, options) {
  let selectedKind = null, selectedId = null, bytes = 0;
  try {
    const selected = inertObject(options, ['kind', 'id']);
    assert(typeof selected.kind === 'string' && KINDS.has(selected.kind) && id(selected.id), 'invalid_input');
    selectedKind = selected.kind; selectedId = selected.id;
    const decoded = decodeInput(input); bytes = decoded.bytes; const record = parseJson(decoded.value);
    assert(typeof record.kind === 'string', 'invalid_schema');
    if (!KINDS.has(record.kind)) reject('unsupported_schema');
    assert(record.kind === selectedKind, 'selected_kind_mismatch');
    validateKind(selectedKind, record);
    assert(recordId(selectedKind, record) === selectedId, 'selected_id_mismatch');
    return freeze({ status: 'valid', reason: null, kind: selectedKind, id: selectedId,
      record: freeze(record), byte_length: bytes });
  } catch (error) {
    const reason = error instanceof ProfileError ? error.reason : 'invalid_input';
    return parseFailure(reason, selectedKind, selectedId, bytes);
  }
}

function validatePath(value) { return repoPath(value); }
function entryResult(value, kind, selectedId) {
  const selected = inertObject(value, ['status', 'reason', 'kind', 'id', 'record', 'byte_length']);
  enumValue(selected.status, ['valid', 'invalid', 'unsupported', 'absent', 'unavailable']);
  assert(selected.kind === kind && selected.id === selectedId && Number.isSafeInteger(selected.byte_length)
    && selected.byte_length >= 0 && selected.byte_length <= MAX_RECORD_BYTES, 'invalid_input');
  if (selected.status === 'valid') {
    assert(selected.reason === null && object(selected.record), 'invalid_input'); assertInertTree(selected.record); validateKind(kind, selected.record);
    assert(recordId(kind, selected.record) === selectedId, 'invalid_input');
  } else {
    assert(typeof selected.reason === 'string' && selected.reason.length > 0 && selected.record === null, 'invalid_input');
    if (['absent', 'unavailable'].includes(selected.status)) assert(selected.byte_length === 0, 'invalid_input');
  }
  return selected;
}
function artifact(value) {
  const selected = inertObject(value, ['path', 'status', 'entry_type']);
  selected.path = artifactPath(selected.path);
  enumValue(selected.status, ['present', 'absent', 'unavailable']);
  enumValue(selected.entry_type, ['regular_blob', 'symlink', 'gitlink', 'tree']);
  return selected;
}
function bindingKey(reference) { return `${reference.acceptance_id}@${reference.revision}`; }
function ticketAcceptance(ticket) {
  return new Map(ticket.acceptance.map(item => [bindingKey(item), item]));
}
function evidenceMatchesTicket(evidence, ticket) {
  const known = ticketAcceptance(ticket);
  return evidence.ticket_id === ticket.ticket_id
    && evidence.acceptance_revisions.every(reference => known.get(bindingKey(reference))?.identity === reference.identity);
}
function contractFor(ticket, reference) {
  return ticket.contract_revisions.find(item => item.revision === reference.revision && item.identity === reference.identity) ?? null;
}
function outcomeBinding(outcome, ticket, evidenceById) {
  const contract = contractFor(ticket, outcome.contract_revision);
  if (!contract) return { status: 'misbound', reason: 'contract_binding_mismatch' };
  const members = new Map(contract.acceptance_revisions.map(item => [item.acceptance_id, item]));
  const accepted = new Set(outcome.accepted_acceptance_ids), unresolved = new Set(outcome.unresolved_acceptance_ids);
  if ([...accepted].some(item => !members.has(item) || unresolved.has(item))
    || [...unresolved].some(item => !members.has(item))
    || [...members].some(([item]) => !accepted.has(item) && !unresolved.has(item))) {
    return { status: 'misbound', reason: 'outcome_membership_mismatch' };
  }
  if (outcome.status === 'successful' && (accepted.size !== members.size || unresolved.size !== 0)) {
    return { status: 'misbound', reason: 'successful_outcome_incomplete' };
  }
  if (outcome.status === 'successful' && outcome.independence === undefined) {
    return { status: 'misbound', reason: 'independence_claim_missing' };
  }
  const selectedEvidence = [];
  for (const evidenceId of outcome.evidence_ids) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) return { status: 'unavailable', reason: 'evidence_unavailable' };
    if (evidence.ticket_id !== outcome.ticket_id) return { status: 'misbound', reason: 'evidence_ticket_mismatch' };
    if (!evidenceMatchesTicket(evidence, ticket)) return { status: 'misbound', reason: 'evidence_binding_mismatch' };
    selectedEvidence.push(evidence);
  }
  const acceptance = ticketAcceptance(ticket);
  for (const acceptanceId of accepted) {
    const expected = members.get(acceptanceId);
    const support = selectedEvidence.filter(item => item.acceptance_ids.includes(acceptanceId));
    if (support.length === 0) return { status: 'misbound', reason: 'accepted_without_evidence' };
    const exact = support.filter(item => item.acceptance_revisions.some(reference => equal(reference, expected)));
    if (exact.length !== support.length) return { status: 'misbound', reason: 'evidence_binding_mismatch' };
    const criterion = acceptance.get(bindingKey(expected));
    if (!criterion) return { status: 'misbound', reason: 'acceptance_binding_missing' };
    if ((criterion.authority ?? 'agent') === 'human'
      && !exact.some(item => (item.origin ?? 'agent') === 'human' && item.refs.length > 0)) {
      return { status: 'misbound', reason: 'human_evidence_missing' };
    }
  }
  if (outcome.status === 'successful' && outcome.contract_revision.revision !== ticket.active_contract_revision) {
    return { status: 'historical', reason: 'outcome_contract_historical' };
  }
  return outcome.status === 'successful'
    ? { status: 'verified', reason: null }
    : { status: 'historical', reason: 'outcome_not_successful' };
}

function evaluationFailure(reason) {
  return freeze({ schema_version: 1, profile: CANONICAL_RECORD_PROFILE, status: 'invalid', reason,
    entries: [], bindings: [], artifact_requirements: [], canonical_refs: [] });
}

export function evaluateCanonicalRecords(selectedEntries, options = { artifacts: [] }) {
  try {
    assert(Array.isArray(selectedEntries) && !isProxy(selectedEntries), 'invalid_input'); assertInertTree(selectedEntries);
    assert(selectedEntries.length >= 1 && selectedEntries.length <= MAX_RECORDS, 'invalid_input');
    assert(Array.isArray(options) === false, 'invalid_input');
    const selectedOptions = inertObject(options, ['artifacts']);
    assert(Array.isArray(selectedOptions.artifacts) && !isProxy(selectedOptions.artifacts), 'invalid_input');
    assertInertTree(selectedOptions.artifacts);
    const entries = selectedEntries.map(value => {
      const selected = inertObject(value, ['key', 'path', 'kind', 'id', 'result']);
      assert(id(selected.key) && KINDS.has(selected.kind) && id(selected.id), 'invalid_input');
      const path = validatePath(selected.path), result = entryResult(selected.result, selected.kind, selected.id);
      return { key: selected.key, path, kind: selected.kind, id: selected.id, result };
    });
    unique(entries, item => item.key); unique(entries, item => item.path);
    assert(entries.reduce((total, item) => total + item.result.byte_length, 0) <= MAX_AGGREGATE_BYTES, 'aggregate_too_large');
    assert(selectedOptions.artifacts.length <= MAX_PATHS, 'invalid_input');
    const artifacts = selectedOptions.artifacts.map(artifact); unique(artifacts, item => item.path);
    assert(new Set([...entries.map(item => item.path), ...artifacts.map(item => item.path)]).size <= MAX_PATHS, 'invalid_input');
    const artifactByPath = new Map(artifacts.map(item => [item.path, item]));
    const ticketById = new Map(), evidenceById = new Map(), outcomes = [];
    for (const item of entries) if (item.result.status === 'valid') {
      if (item.kind === 'ticket') { assert(!ticketById.has(item.id), 'invalid_input'); ticketById.set(item.id, item.result.record); }
      if (item.kind === 'ticket_evidence') { assert(!evidenceById.has(item.id), 'invalid_input'); evidenceById.set(item.id, item.result.record); }
      if (item.kind === 'ticket_outcome') outcomes.push(item);
    }
    const outcomeContracts = new Set(), artifactRequirements = new Set(), bindings = [], evaluated = [];
    for (const item of entries) {
      const record = item.result.record;
      let status = item.result.status === 'valid' ? 'usable' : item.result.status;
      let reason = item.result.reason;
      if (record && item.kind === 'context') {
        if (record.state !== 'active') { status = 'historical'; reason = 'context_not_active'; }
        if (record.type === 'authority') {
          for (const path of record.authority.canonical) artifactRequirements.add(path);
          const selected = record.authority.canonical.map(path => artifactByPath.get(path));
          if (selected.some(value => value?.status === 'absent' || value?.status === 'present' && value.entry_type !== 'regular_blob')) {
            status = 'invalid'; reason = 'authority_artifact_invalid';
          } else if (selected.some(value => !value || value.status === 'unavailable')) {
            if (status !== 'historical') status = 'unavailable'; reason = 'authority_artifact_unavailable';
          }
        }
      } else if (record && item.kind === 'ticket_evidence') {
        const ticket = ticketById.get(record.ticket_id);
        if (!ticket) { status = 'unavailable'; reason = 'ticket_unavailable'; }
        else {
          status = evidenceMatchesTicket(record, ticket)
            ? 'usable' : 'misbound'; reason = status === 'usable' ? null : 'evidence_binding_mismatch';
        }
        bindings.push({ key: item.key, kind: item.kind, status: status === 'usable' ? 'verified' : status, reason,
          ticket_id: record.ticket_id, acceptance_revisions: record.acceptance_revisions });
      } else if (record && item.kind === 'ticket_outcome') {
        const contractKey = `${record.ticket_id}@${record.contract_revision.revision}`;
        if (outcomeContracts.has(contractKey)) { status = 'misbound'; reason = 'duplicate_contract_outcome'; }
        else {
          outcomeContracts.add(contractKey); const ticket = ticketById.get(record.ticket_id);
          if (!ticket) { status = 'unavailable'; reason = 'ticket_unavailable'; }
          else ({ status, reason } = outcomeBinding(record, ticket, evidenceById));
        }
        bindings.push({ key: item.key, kind: item.kind, status, reason, ticket_id: record.ticket_id,
          contract_revision: record.contract_revision, independence_claim: record.independence ?? null });
      }
      evaluated.push({ key: item.key, path: item.path, kind: item.kind, id: item.id, status, reason,
        record: record ?? null, byte_length: item.result.byte_length });
    }
    assert(artifactRequirements.size <= MAX_PATHS, 'invalid_input');
    const hardInvalid = evaluated.some(item => ['invalid', 'misbound'].includes(item.status));
    const incomplete = evaluated.some(item => item.status !== 'usable' && item.status !== 'verified');
    const status = hardInvalid ? 'invalid' : incomplete ? 'partial' : 'usable';
    const reason = hardInvalid ? 'selected_record_invalid' : incomplete ? 'selected_record_incomplete' : null;
    return freeze({ schema_version: 1, profile: CANONICAL_RECORD_PROFILE, status, reason, entries: evaluated,
      bindings, artifact_requirements: [...artifactRequirements].sort(),
      canonical_refs: evaluated.filter(item => item.record).map(item => ({ key: item.key, kind: item.kind, id: item.id })) });
  } catch (error) {
    return evaluationFailure(error instanceof ProfileError ? error.reason : 'invalid_input');
  }
}
