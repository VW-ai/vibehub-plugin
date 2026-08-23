import { createHarnessRouter } from "./router.mjs";

export function createSharedHarnessShell({ adapter, associations }) {
  const router = createHarnessRouter({ adapter, associations });
  let booted = false;
  const dispatch = (action, input) => {
    if (!booted) throw new Error("Shared harness shell is not booted");
    return router.dispatch(action, input);
  };
  return Object.freeze({
    carrierId: router.selectedHarnessId,
    capabilities: router.capabilities,
    boot() {
      if (booted) return { carrierId: router.selectedHarnessId, capabilities: router.capabilities };
      booted = true;
      return { carrierId: router.selectedHarnessId, capabilities: router.capabilities };
    },
    newChat(options = {}) {
      return dispatch("chat.create", { options });
    },
    resumeChat(input) {
      return dispatch("chat.resume", input);
    },
    sendChat(input) {
      return dispatch("chat.send", input);
    },
    sendChatAttachments(input) {
      return dispatch("chat.sendAttachments", input);
    },
    sendChatAudio(input) {
      return dispatch("chat.sendAudio", input);
    },
    forkChat(input) {
      return dispatch("chat.fork", input);
    },
    searchChats(input) {
      return dispatch("chat.search", input);
    },
    interruptChat(input) {
      return dispatch("chat.interrupt", input);
    },
    listModels(input = {}) {
      return dispatch("chat.listModels", input);
    },
    compactChat(input) {
      return dispatch("chat.compact", input);
    },
    searchFiles(input) {
      return dispatch("chat.searchFiles", input);
    },
    listSkills(input) {
      return dispatch("chat.listSkills", input);
    },
    resolveInteraction(input) {
      return dispatch("interaction.resolveApproval", input);
    },
    startTask(input) {
      return dispatch("task.start", input);
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
