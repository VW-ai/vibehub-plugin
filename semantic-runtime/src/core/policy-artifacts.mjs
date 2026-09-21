import { canonical, fingerprint, timestamp } from './contracts.mjs';
import { validatePolicy } from './policy.mjs';

export const POLICY_NODE_TYPES = Object.freeze(['deterministic', 'judge', 'retrieve', 'aggregate', 'guard', 'action', 'worker']);
export const POLICY_PORT_TYPES = Object.freeze(['event_ref', 'snapshot_ref', 'signal_ref', 'candidates_ref', 'job_ref', 'error_ref', 'boolean', 'number', 'string']);
const ACTIONS = ['IGNORE', 'INGEST', 'INJECT', 'DEFER', 'ESCALATE'];
const ID = '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$';
const HASH = '^sha256:[a-f0-9]{64}$';
const budgetProperties = {
  timeout_ms: { type: 'integer', minimum: 1, maximum: 3_600_000 },
  max_attempts: { type: 'integer', minimum: 1, maximum: 10 },
  max_tokens: { type: 'integer', minimum: 0, maximum: 10_000_000 },
  max_cost_microunits: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
};
const objectSchema = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const nameSchema = { type: 'string', pattern: ID };
const refSchema = objectSchema({ policy_id: nameSchema, version: nameSchema, content_hash: { type: 'string', pattern: HASH } });
const portSchema = { type: 'object', maxProperties: 32, propertyNames: nameSchema, additionalProperties: { enum: POLICY_PORT_TYPES } };
const edgeSchema = objectSchema({ target: nameSchema, ports: { type: 'object', maxProperties: 32, propertyNames: nameSchema, additionalProperties: nameSchema } });
const presentationSchema = objectSchema({ label: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 2000 } }, []);

/** Authoring schema; compilePolicyArtifact additionally checks graph and operation semantics. */
export const POLICY_ARTIFACT_SCHEMA = freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://vibehub.dev/schemas/runtime-policy.v2.json',
  ...objectSchema({
    schema_version: { const: 2 }, policy_id: nameSchema, version: nameSchema,
    compatibility: objectSchema({ min_runtime_version: { type: 'integer', minimum: 1 }, max_runtime_version: { type: 'integer', minimum: 1 } }),
    rollback_predecessor: { anyOf: [{ type: 'null' }, refSchema] },
    entry: nameSchema, inputs: portSchema,
    limits: objectSchema({ max_nodes: { type: 'integer', minimum: 1, maximum: 128 }, ...budgetProperties, max_attempts: { type: 'integer', minimum: 1, maximum: 1280 } }),
    nodes: { type: 'object', minProperties: 1, maxProperties: 128, propertyNames: nameSchema, additionalProperties: objectSchema({
      type: { enum: POLICY_NODE_TYPES }, operation: objectSchema({ id: nameSchema, version: nameSchema }),
      inputs: portSchema, outputs: portSchema, budget: objectSchema(budgetProperties),
      config: { type: 'object' },
      next: { type: 'object', maxProperties: 16, propertyNames: nameSchema, additionalProperties: edgeSchema },
      on_error: edgeSchema,
      action: { enum: ACTIONS },
      join: objectSchema({ name: nameSchema, mode: { enum: ['any', 'all'] }, fork: nameSchema }, ['name', 'mode']),
      presentation: presentationSchema,
    }, ['type', 'operation', 'inputs', 'outputs', 'budget', 'config', 'next']) },
    presentation: presentationSchema,
  }, ['schema_version', 'policy_id', 'version', 'compatibility', 'rollback_predecessor', 'entry', 'inputs', 'limits', 'nodes']),
});

const operationSchema = objectSchema({
  id: nameSchema, version: nameSchema, type: { enum: POLICY_NODE_TYPES },
  implementation_hash: { type: 'string', pattern: HASH },
  inputs: portSchema, outputs: portSchema, error_outputs: portSchema,
  branches: { type: 'array', maxItems: 16, uniqueItems: true, items: nameSchema },
  branch_mode: { enum: ['exclusive', 'parallel', 'terminal'] },
  config_schema: { type: 'object' },
});

function invariant(condition, message) { if (!condition) throw new Error(`Policy artifact: ${message}`); }
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function jsonCopy(input) {
  const seen = new Set();
  function visit(value, depth) {
    invariant(depth <= 64, 'JSON nesting exceeds 64');
    invariant(value === null || ['string', 'number', 'boolean', 'object'].includes(typeof value), 'only JSON values are accepted');
    if (typeof value === 'number') invariant(Number.isFinite(value), 'non-finite JSON number');
    if (!value || typeof value !== 'object') return;
    invariant(!seen.has(value), 'cyclic input');
    invariant(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'only plain JSON objects are accepted');
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      invariant(typeof key === 'string', 'symbol keys are not JSON');
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      invariant(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'accessors/non-enumerable properties are not JSON');
      invariant(!['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe object key');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(value)) invariant(Object.keys(value).length === value.length, 'sparse or decorated array');
    seen.delete(value);
  }
  visit(input, 0);
  const encoded = canonical(input);
  invariant(encoded.length <= 1_000_000, 'definition exceeds 1 MB');
  return JSON.parse(encoded);
}
function check(value, schema, path) {
  if (schema.anyOf) {
    invariant(schema.anyOf.some(candidate => { try { check(value, candidate, path); return true; } catch { return false; } }), `${path} does not match schema`);
    return;
  }
  if (Object.hasOwn(schema, 'const')) invariant(value === schema.const, `${path} must be ${schema.const}`);
  if (schema.enum) invariant(schema.enum.includes(value), `${path} has unsupported value`);
  if (schema.type) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    invariant(schema.type === 'integer' ? Number.isSafeInteger(value) : type === schema.type, `${path} must be ${schema.type}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) invariant(value >= schema.minimum, `${path} below minimum`);
    if (schema.maximum !== undefined) invariant(value <= schema.maximum, `${path} above maximum`);
  }
  if (typeof value === 'string') {
    if (schema.pattern) invariant(new RegExp(schema.pattern).test(value), `${path} has invalid format`);
    if (schema.maxLength !== undefined) invariant(value.length <= schema.maxLength, `${path} too long`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined) invariant(value.length <= schema.maxItems, `${path} has too many items`);
    if (schema.uniqueItems) invariant(new Set(value.map(canonical)).size === value.length, `${path} has duplicate items`);
    if (schema.items) value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined) invariant(keys.length >= schema.minProperties, `${path} is empty`);
    if (schema.maxProperties !== undefined) invariant(keys.length <= schema.maxProperties, `${path} has too many properties`);
    for (const key of schema.required ?? []) invariant(Object.hasOwn(value, key), `${path}.${key} is required`);
    for (const key of keys) {
      if (schema.propertyNames) check(key, schema.propertyNames, `${path} key`);
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      invariant(property || schema.additionalProperties !== false, `${path}.${key} is unknown`);
      if (property) check(value[key], property, `${path}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(value[key], schema.additionalProperties, `${path}.${key}`);
    }
  }
}

// Operation configuration intentionally supports a small, fail-closed schema dialect.
function configSchema(schema) {
  check(schema, objectSchema({ type: { const: 'object' }, additionalProperties: { const: false }, properties: { type: 'object', maxProperties: 32 }, required: { type: 'array', uniqueItems: true, items: nameSchema } }), 'operation.config_schema');
  for (const [name, property] of Object.entries(schema.properties)) {
    check(name, nameSchema, 'config property name');
    check(property, objectSchema({ type: { enum: ['string', 'number', 'integer', 'boolean'] }, enum: { type: 'array', maxItems: 64, uniqueItems: true }, minimum: { type: 'number' }, maximum: { type: 'number' }, maxLength: { type: 'integer', minimum: 1, maximum: 100_000 } }, ['type']), `config property ${name}`);
    invariant(!property.enum || property.enum.length > 0, 'empty configuration enum');
    if (property.enum) property.enum.forEach(value => check(value, { type: property.type }, 'configuration enum'));
    invariant(property.maxLength === undefined || property.type === 'string', 'maxLength requires a string configuration field');
    invariant((property.minimum === undefined && property.maximum === undefined) || ['number', 'integer'].includes(property.type), 'numeric bounds require a numeric configuration field');
    invariant(property.minimum === undefined || property.maximum === undefined || property.minimum <= property.maximum, 'configuration range is reversed');
  }
  invariant(schema.required.every(name => Object.hasOwn(schema.properties, name)), 'required configuration field is undeclared');
}

function operationMap(operations) {
  invariant(Array.isArray(operations) && operations.length > 0 && operations.length <= 256, 'supply 1–256 trusted versioned operations');
  const map = new Map();
  for (const original of operations) {
    const operation = jsonCopy(original);
    check(operation, operationSchema, 'operation');
    configSchema(operation.config_schema);
    const key = canonical([operation.id, operation.version]);
    invariant(!map.has(key), 'duplicate operation identity');
    const terminal = operation.type === 'action';
    invariant(terminal === (operation.branch_mode === 'terminal'), 'only Action operations are terminal');
    invariant(terminal ? operation.branches.length === 0 && Object.keys(operation.outputs).length === 0 && Object.keys(operation.error_outputs).length === 0 : operation.branches.length > 0, 'incomplete operation branches');
    invariant(operation.branch_mode !== 'parallel' || (operation.type === 'deterministic' && operation.branches.length >= 2), 'parallel fork must be a deterministic operation with at least two branches');
    operation.branches.sort();
    operation.config_schema.required.sort();
    for (const property of Object.values(operation.config_schema.properties)) if (property.enum) property.enum.sort((a, b) => lexical(canonical(a), canonical(b)));
    map.set(key, operation);
  }
  return map;
}

/** Compile declarations only. This function never executes operations or resolves opaque refs. */
export function compilePolicyArtifact(input, { operations } = {}) {
  const definition = jsonCopy(input);
  check(definition, POLICY_ARTIFACT_SCHEMA, 'definition');
  const { nodes, limits, compatibility } = definition;
  invariant(compatibility.min_runtime_version <= compatibility.max_runtime_version, 'compatibility range is reversed');
  invariant(Object.keys(nodes).length <= limits.max_nodes, 'node count exceeds graph budget');
  invariant(Object.hasOwn(nodes, definition.entry), 'missing entry node');
  const registry = operationMap(operations);
  const used = new Map();
  const signatures = new Map();
  const incoming = new Map(Object.keys(nodes).map(id => [id, []]));
  const edges = new Map();
  for (const [id, node] of Object.entries(nodes)) {
    delete node.presentation;
    const operationKey = canonical([node.operation.id, node.operation.version]);
    const operation = registry.get(operationKey);
    invariant(operation, `unknown operation at ${id}`);
    invariant(node.type === operation.type, `operation kind mismatch at ${id}`);
    invariant(canonical(node.inputs) === canonical(operation.inputs) && canonical(node.outputs) === canonical(operation.outputs), `operation port signature mismatch at ${id}`);
    check(node.config, operation.config_schema, `${id}.config`);
    used.set(operationKey, operation);
    signatures.set(id, operation);
    invariant(canonical(Object.keys(node.next).sort()) === canonical(operation.branches), `incomplete branches at ${id}`);
    invariant(node.type === 'action' ? ACTIONS.includes(node.action) && !node.on_error : !!node.on_error && node.action === undefined, `incomplete action/error branch at ${id}`);
    if (node.join) invariant(node.join.mode === 'all' ? !!node.join.fork : node.join.fork === undefined, `invalid join declaration at ${id}`);
    const outgoing = Object.entries(node.next).map(([branch, edge]) => ({ ...edge, source: id, branch, error: false }));
    if (node.on_error) outgoing.push({ ...node.on_error, source: id, branch: '$error', error: true });
    edges.set(id, outgoing);
    for (const edge of outgoing) {
      invariant(Object.hasOwn(nodes, edge.target), `missing edge target at ${id}`);
      incoming.get(edge.target).push(edge);
      const sourcePorts = edge.error ? operation.error_outputs : node.outputs;
      for (const [targetPort, sourcePort] of Object.entries(edge.ports)) {
        invariant(Object.hasOwn(nodes[edge.target].inputs, targetPort) && Object.hasOwn(sourcePorts, sourcePort), `missing typed port at ${id}.${edge.branch}`);
        invariant(nodes[edge.target].inputs[targetPort] === sourcePorts[sourcePort], `incompatible ports at ${id}.${edge.branch}`);
      }
      if (edge.error) invariant(nodes[edge.target].type === 'action' && ['DEFER', 'ESCALATE'].includes(nodes[edge.target].action), `error edge must terminate with DEFER/ESCALATE at ${id}`);
    }
  }
  delete definition.presentation;
  invariant(incoming.get(definition.entry).length === 0, 'entry cannot have incoming edges');
  invariant(canonical(definition.inputs) === canonical(nodes[definition.entry].inputs), 'entry input port mismatch');
  invariant(!nodes[definition.entry].join, 'entry cannot be a join');
  const visiting = new Set();
  const visited = new Set();
  const order = [];
  function visit(id) {
    invariant(!visiting.has(id), 'unsupported cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of edges.get(id)) visit(edge.target);
    visiting.delete(id); visited.add(id); order.push(id);
  }
  visit(definition.entry);
  invariant(visited.size === Object.keys(nodes).length, 'unreachable node');
  const joins = new Set();
  const pairedForks = new Set();
  for (const [id, node] of Object.entries(nodes)) {
    const arrivals = incoming.get(id);
    if (node.join) { invariant(!joins.has(node.join.name), 'duplicate join name'); joins.add(node.join.name); }
    invariant(arrivals.length <= 1 || !!node.join, `multiple incoming edges require named join at ${id}`);
    if (node.join) invariant(arrivals.length >= 2, `join requires multiple incoming edges at ${id}`);
    if (node.join?.mode === 'all') {
      const fork = node.join.fork;
      invariant(nodes[fork] && signatures.get(fork).branch_mode === 'parallel', `all join requires parallel fork at ${id}`);
      invariant(!pairedForks.has(fork), 'parallel fork may have only one join'); pairedForks.add(fork);
      const ownership = new Map();
      const supplied = new Set();
      for (const [branch, start] of Object.entries(nodes[fork].next)) {
        const terminals = [];
        const traversed = new Set();
        function region(edge) {
          if (edge.target === id) { terminals.push(edge); return; }
          invariant(edge.target !== fork, 'cyclic fork region');
          invariant(!ownership.has(edge.target) || ownership.get(edge.target) === branch, 'parallel branches overlap before join');
          ownership.set(edge.target, branch);
          if (traversed.has(edge.target)) return;
          traversed.add(edge.target);
          invariant(nodes[edge.target].type !== 'action', 'parallel branch can terminate before all join');
          invariant(signatures.get(edge.target).branch_mode !== 'parallel' && nodes[edge.target].join?.mode !== 'all', 'nested parallel regions are unsupported in schema 2');
          for (const child of edges.get(edge.target).filter(item => !item.error)) region(child);
        }
        region({ ...start, source: fork, branch });
        invariant(terminals.length > 0, 'parallel branch does not reach all join');
        const ports = Object.keys(terminals[0].ports).sort();
        invariant(terminals.every(edge => canonical(Object.keys(edge.ports).sort()) === canonical(ports)), 'parallel branch supplies inconsistent join ports');
        for (const port of ports) { invariant(!supplied.has(port), 'ambiguous all-join port writers'); supplied.add(port); }
      }
      invariant(arrivals.every(edge => !edge.error && (ownership.has(edge.source) || edge.source === fork)), 'all join has an arrival outside its fork');
      // Prevent an outside branch entering a parallel region midway.
      for (const [member, owner] of ownership) invariant(incoming.get(member).every(edge => !edge.error && (edge.source === fork || ownership.get(edge.source) === owner)), 'external arrival inside parallel region');
      invariant(canonical([...supplied].sort()) === canonical(Object.keys(node.inputs).sort()), 'all join inputs are incomplete');
    } else {
      for (const edge of arrivals) invariant(canonical(Object.keys(edge.ports).sort()) === canonical(Object.keys(node.inputs).sort()), `incomplete input ports at ${id}`);
    }
  }
  for (const [id, operation] of signatures) invariant(operation.branch_mode !== 'parallel' || pairedForks.has(id), `parallel fork requires an all join at ${id}`);
  // Summing every node is a conservative finite cap, including parallel work,
  // retries and alternative/error paths; it never underestimates a single run.
  const bounds = { max_nodes: Object.keys(nodes).length, timeout_ms: 0, max_attempts: 0, max_tokens: 0, max_cost_microunits: 0 };
  for (const node of Object.values(nodes)) {
    bounds.max_attempts += node.budget.max_attempts;
    for (const key of ['timeout_ms', 'max_tokens', 'max_cost_microunits']) bounds[key] += node.budget[key] * node.budget.max_attempts;
  }
  for (const key of Object.keys(bounds)) invariant(bounds[key] <= limits[key], `unbounded path: aggregate ${key} exceeds graph budget`);
  const descriptors = [...used.values()].sort((a, b) => lexical(canonical([a.id, a.version]), canonical([b.id, b.version])));
  const executable = { compiler_version: 1, schema_version: 2, entry: definition.entry, inputs: definition.inputs, nodes, limits, operations: descriptors };
  const executable_hash = `sha256:${fingerprint(executable)}`;
  return freeze({ kind: 'policy_artifact', compiler_version: 1, schema_version: 2, policy_id: definition.policy_id, version: definition.version,
    compatibility, rollback_predecessor: definition.rollback_predecessor, executable_hash,
    content_hash: `sha256:${fingerprint({ definition, executable_hash })}`, definition, operations: descriptors,
    bounds, topological_order: order.reverse(),
  });
}

export function validatePolicyArtifact(input, options) { return compilePolicyArtifact(input, options).definition; }

/** Load the old format unchanged. It remains executable only by the Phase 0 evaluator. */
export function loadPhaseZeroPolicyArtifact(input) {
  const policy = validatePolicy(jsonCopy(input));
  return freeze({ kind: 'phase_zero_policy', schema_version: 1, policy_id: policy.policy_id, version: policy.version,
    policy_hash: fingerprint(policy), policy,
  });
}

/** Synchronous reference contract, not hosted persistence or an authorization system. */
export function createPolicyRegistry({ operations, runtime_version = 1 } = {}) {
  invariant(Number.isSafeInteger(runtime_version) && runtime_version >= 1, 'invalid runtime version');
  const trustedOperations = [...operationMap(operations).values()];
  const publications = new Map();
  const active = new Map();
  const history = new Map();
  const keyFor = ref => canonical([ref.policy_id, ref.version]);
  const copy = value => freeze(structuredClone(value));
  const exact = ref => { check(ref, refSchema, 'artifact reference'); const record = publications.get(keyFor(ref)); invariant(record && record.artifact.content_hash === ref.content_hash, 'exact artifact not found'); return record; };
  const current = id => active.get(id) ?? null;
  const sameRef = (a, b) => canonical(a) === canonical(b);
  const checkExpected = (id, expected) => { invariant(expected === null || expected !== undefined, 'explicit expected_active is required'); if (expected !== null) check(expected, refSchema, 'expected_active'); invariant(sameRef(current(id), expected), 'active policy compare-and-swap conflict'); };
  const metadata = input => { check(input, objectSchema({ at: { type: 'string' }, actor_ref: nameSchema, reason: { type: 'string', maxLength: 1000 } }), 'activation metadata'); invariant(input.reason.trim(), 'activation reason is empty'); return { ...input, at: timestamp(input.at, 'activation.at') }; };
  return Object.freeze({
    publish(definition) {
      const artifact = compilePolicyArtifact(definition, { operations: trustedOperations });
      const key = keyFor(artifact);
      const existing = publications.get(key);
      if (existing) { invariant(existing.artifact.content_hash === artifact.content_hash, 'published version is immutable'); return copy(existing); }
      if (artifact.rollback_predecessor) { invariant(artifact.rollback_predecessor.policy_id === artifact.policy_id, 'rollback predecessor belongs to another policy'); exact(artifact.rollback_predecessor); }
      const record = { artifact, activation: null, retired_at: null };
      publications.set(key, record);
      return copy(record);
    },
    resolve(ref) { return copy(exact(ref)); },
    active(policy_id) { check(policy_id, nameSchema, 'policy_id'); const ref = current(policy_id); return ref ? copy(exact(ref)) : null; },
    activate(ref, { expected_active, ...input } = {}) {
      const record = exact(ref); const audit = metadata(input);
      checkExpected(ref.policy_id, expected_active);
      invariant(!record.retired_at, 'retired artifact cannot activate');
      invariant(runtime_version >= record.artifact.compatibility.min_runtime_version && runtime_version <= record.artifact.compatibility.max_runtime_version, 'incompatible runtime version');
      if (sameRef(current(ref.policy_id), ref)) return copy(record);
      const event = { type: 'activate', ref: jsonCopy(ref), previous: current(ref.policy_id), ...audit };
      record.activation = audit;
      active.set(ref.policy_id, jsonCopy(ref));
      history.set(ref.policy_id, [...(history.get(ref.policy_id) ?? []), event]);
      return copy(record);
    },
    retire(ref, { expected_active, ...input } = {}) {
      const record = exact(ref); const audit = metadata(input);
      checkExpected(ref.policy_id, expected_active);
      if (record.retired_at) return copy(record);
      const previous = current(ref.policy_id);
      if (sameRef(previous, ref)) active.delete(ref.policy_id);
      record.retired_at = audit.at;
      history.set(ref.policy_id, [...(history.get(ref.policy_id) ?? []), { type: 'retire', ref: jsonCopy(ref), previous, ...audit }]);
      return copy(record);
    },
    history(policy_id) { check(policy_id, nameSchema, 'policy_id'); return copy(history.get(policy_id) ?? []); },
  });
}
