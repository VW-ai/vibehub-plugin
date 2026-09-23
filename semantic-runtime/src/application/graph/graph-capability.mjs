const byOwner = new WeakMap();
const states = new WeakMap();
const slot = Symbol('vibehub.graph-capability');

const invalid = () => Object.assign(new Error('Graph capability: invalid_graph_input'), { code: 'invalid_graph_input' });
const state = capability => {
  const selected = capability && typeof capability === 'object' ? states.get(capability) : null;
  if (!selected) throw invalid();
  return selected;
};

const binding = value => {
  if (!value || typeof value !== 'object' || !value.store || !value.authority) throw invalid();
  return value;
};

/** Registered only by LocalGraphStore; consumers receive an opaque branded handle. */
export function registerGraphCapability(owner, identity) {
  if (!owner || typeof owner !== 'object' || byOwner.has(owner)) throw invalid();
  for (const name of ['getHead', 'getReceipt', 'resolve', 'mutate']) if (typeof owner[name] !== 'function') throw invalid();
  const { store, authority } = binding(identity);
  const capability = Object.freeze({});
  states.set(capability, { owner, store, authority });
  byOwner.set(owner, capability);
  return capability;
}

export function graphCapabilityFor(owner, identity) {
  const capability = owner && typeof owner === 'object' ? byOwner.get(owner) : null;
  const retained = capability ? state(capability) : null;
  const { store, authority } = binding(identity);
  if (!retained || retained.store !== store || retained.authority !== authority) throw invalid();
  return capability;
}

export function withGraphCapability(options, capability) {
  state(capability);
  Object.defineProperty(options, slot, { value: capability });
  return options;
}

export function graphCapabilityFrom(options, identity) {
  const capability = options?.[slot], retained = state(capability);
  const { store, authority } = binding(identity);
  if (retained.store !== store || retained.authority !== authority) throw invalid();
  return capability;
}

// Dynamic forwarding keeps prototype instrumentation and authorization order visible.
export const graphGetHead = (capability, context, request) => state(capability).owner.getHead(context, request);
export const graphGetReceipt = (capability, context, request) => state(capability).owner.getReceipt(context, request);
export const graphResolve = (capability, context, request) => state(capability).owner.resolve(context, request);
export const graphMutate = (capability, context, request) => state(capability).owner.mutate(context, request);
