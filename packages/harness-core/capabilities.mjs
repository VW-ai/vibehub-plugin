import contract from "../../docs/proposals/harness-neutral-core/capabilities.v1.json" with { type: "json" };

export const HARNESS_CAPABILITY_SCHEMA_VERSION = 1;

const CAPABILITY_IDS = Object.freeze(Object.keys(contract.capabilities));
const ACTION_CAPABILITY = Object.freeze({
  "chat.create": "replay",
  "chat.resume": "replay",
  "chat.send": "replay",
  "chat.fork": "fork",
  "chat.search": "search",
  "chat.sendAttachments": "attachments",
  "chat.sendAudio": "audio",
  "chat.interrupt": "interruption",
  "interaction.resolveApproval": "approvals",
  "task.start": "replay",
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertCarrier(carrierId) {
  if (!Object.hasOwn(contract.carriers, carrierId)) {
    throw new Error(`Unknown harness carrier: ${carrierId}`);
  }
}

export function capabilityForAction(action) {
  const capability = ACTION_CAPABILITY[action];
  if (!capability) throw new Error(`Unknown harness action: ${action}`);
  return capability;
}

export function capabilitySnapshot(carrierId) {
  assertCarrier(carrierId);
  const carrier = contract.carriers[carrierId];
  const capabilities = Object.fromEntries(CAPABILITY_IDS.map((id) => {
    const value = carrier.capabilities[id];
    if (!value) throw new Error(`${carrierId} omits capability ${id}`);
    return [id, { ...value }];
  }));
  return deepFreeze({
    schemaVersion: HARNESS_CAPABILITY_SCHEMA_VERSION,
    carrierId,
    upstream: structuredClone(carrier.upstream),
    capabilities,
  });
}

export function supportsAction(carrierId, action) {
  const capability = capabilityForAction(action);
  return capabilitySnapshot(carrierId).capabilities[capability].available;
}

export function assertCapabilityContract() {
  if (contract.schemaVersion !== HARNESS_CAPABILITY_SCHEMA_VERSION) {
    throw new Error(`Unsupported harness capability schema ${contract.schemaVersion}`);
  }
  for (const [carrierId, carrier] of Object.entries(contract.carriers)) {
    for (const capability of CAPABILITY_IDS) {
      const value = carrier.capabilities[capability];
      if (!value || typeof value.available !== "boolean") {
        throw new Error(`${carrierId}.${capability} must declare availability`);
      }
      if (!["native", "adapted", "unsupported"].includes(value.mode)) {
        throw new Error(`${carrierId}.${capability} has invalid mode ${value.mode}`);
      }
      if (!value.available && value.mode !== "unsupported") {
        throw new Error(`${carrierId}.${capability} cannot be unavailable with mode ${value.mode}`);
      }
      if (typeof value.source !== "string" || value.source.length === 0) {
        throw new Error(`${carrierId}.${capability} must cite an exact source seam`);
      }
    }
  }
  return true;
}

export { contract as harnessCapabilityContract };
