import { capabilitiesForInput, capabilitySnapshot } from "./capabilities.mjs";

function validateTaskHandoff(input) {
  if (input?.payload?.kind !== "vibehub_ticket_handoff" || typeof input.payload.ticketId !== "string") {
    throw new Error("task.start requires one canonical VibeHub Ticket handoff");
  }
}

export class UnsupportedHarnessCapabilityError extends Error {
  constructor(carrierId, capability, reason) {
    super(`${carrierId} does not support ${capability}: ${reason}`);
    this.name = "UnsupportedHarnessCapabilityError";
    this.carrierId = carrierId;
    this.capability = capability;
  }
}

export function createHarnessRouter({ adapter, associations }) {
  if (!adapter || typeof adapter.id !== "string" || typeof adapter.execute !== "function") {
    throw new Error("Harness router requires exactly one selected adapter");
  }
  const selectedHarnessId = adapter.id;
  const capabilities = capabilitySnapshot(selectedHarnessId);
  let closed = false;

  return Object.freeze({
    selectedHarnessId,
    capabilities,
    async dispatch(action, input = {}) {
      if (closed) throw new Error("Harness router is closed");
      if (input.harnessId && input.harnessId !== selectedHarnessId) {
        throw new Error(`Action targets ${input.harnessId}, but ${selectedHarnessId} is selected`);
      }
      for (const capabilityId of capabilitiesForInput(action, input)) {
        const capability = capabilities.capabilities[capabilityId];
        if (!capability.available) {
          throw new UnsupportedHarnessCapabilityError(selectedHarnessId, capabilityId, capability.fallback);
        }
      }
      if (action === "task.start") validateTaskHandoff(input);
      const result = await adapter.execute(action, { ...input, harnessId: selectedHarnessId });
      if (result?.harnessId !== selectedHarnessId) {
        throw new Error(`Adapter result escaped selected harness ${selectedHarnessId}`);
      }
      if (action === "task.start" && associations) {
        await associations.put({
          ticketId: input.payload.ticketId,
          harnessId: selectedHarnessId,
          conversationId: result.conversationId,
          origin: input.origin ?? null,
        });
      }
      return result;
    },
    async recoverTask(ticketId) {
      const association = associations ? await associations.get(ticketId) : null;
      if (association && association.harnessId !== selectedHarnessId) {
        throw new Error(`Task ${ticketId} belongs to ${association.harnessId}, not ${selectedHarnessId}`);
      }
      return association;
    },
    async close() {
      if (closed) return;
      closed = true;
      await adapter.close?.();
      await associations?.close?.();
    },
  });
}
