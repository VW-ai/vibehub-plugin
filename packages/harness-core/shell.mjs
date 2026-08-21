import { createHarnessRouter } from "./router.mjs";

export function createSharedHarnessShell({ adapter, associations }) {
  const router = createHarnessRouter({ adapter, associations });
  let booted = false;
  return Object.freeze({
    carrierId: router.selectedHarnessId,
    capabilities: router.capabilities,
    boot() {
      if (booted) return { carrierId: router.selectedHarnessId, capabilities: router.capabilities };
      booted = true;
      return { carrierId: router.selectedHarnessId, capabilities: router.capabilities };
    },
    newChat(options = {}) {
      if (!booted) throw new Error("Shared harness shell is not booted");
      return router.dispatch("chat.create", { options });
    },
    sendChat(input) {
      if (!booted) throw new Error("Shared harness shell is not booted");
      return router.dispatch("chat.send", input);
    },
    startTask(input) {
      if (!booted) throw new Error("Shared harness shell is not booted");
      return router.dispatch("task.start", input);
    },
    recoverTask(ticketId) {
      if (!booted) throw new Error("Shared harness shell is not booted");
      return router.recoverTask(ticketId);
    },
    close() {
      booted = false;
      return router.close();
    },
  });
}
