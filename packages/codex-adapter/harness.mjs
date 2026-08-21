import { startCodexTask } from "./handoff.mjs";

export function createCodexHarnessAdapter({ client }) {
  if (!client || typeof client.request !== "function") throw new Error("Codex adapter requires an app-server client");
  return Object.freeze({
    id: "codex",
    async execute(action, input) {
      if (action === "chat.create") {
        const started = await client.request("thread/start", input.options ?? {});
        return { harnessId: "codex", conversationId: started.thread.id, value: started };
      }
      if (action === "chat.resume") {
        const resumed = await client.request("thread/resume", { threadId: input.conversationId });
        return { harnessId: "codex", conversationId: resumed.thread.id, value: resumed };
      }
      if (action === "chat.send" || action === "chat.sendAttachments" || action === "chat.sendAudio") {
        const turn = await client.request("turn/start", { threadId: input.conversationId, input: input.content });
        return { harnessId: "codex", conversationId: input.conversationId, runId: turn.turn.id, value: turn };
      }
      if (action === "chat.fork") {
        const fork = await client.request("thread/fork", { threadId: input.conversationId, ...(input.turnId ? { turnId: input.turnId } : {}) });
        return { harnessId: "codex", conversationId: fork.thread.id, value: fork };
      }
      if (action === "chat.search") {
        const result = await client.request("thread/list", { archived: false, cursor: null, limit: input.limit ?? 100, searchTerm: input.query, sortDirection: "desc", sortKey: "updated_at" });
        return { harnessId: "codex", conversationId: input.conversationId ?? "search", value: result };
      }
      if (action === "chat.interrupt") {
        const value = await client.request("turn/interrupt", { threadId: input.conversationId, turnId: input.runId });
        return { harnessId: "codex", conversationId: input.conversationId, runId: input.runId, value };
      }
      if (action === "interaction.resolveApproval") {
        client.respond(input.requestId, input.result);
        return { harnessId: "codex", conversationId: input.conversationId, value: { accepted: true } };
      }
      if (action === "task.start") {
        const result = await startCodexTask({ client, payload: input.payload, cwd: input.cwd, ...(input.options ?? {}) });
        return { harnessId: "codex", conversationId: result.threadId, runId: result.turnId, value: result };
      }
      throw new Error(`Codex adapter does not implement ${action}`);
    },
    async close() {
      await client.stop?.();
    },
  });
}
