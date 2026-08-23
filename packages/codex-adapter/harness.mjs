import { startCodexTask } from "./handoff.mjs";

// turn/start overrides the app-server accepts for this Turn and subsequent
// Turns (TurnStartParams model, effort, approvalPolicy, sandboxPolicy). Only
// keys the caller set are sent; nothing is defaulted on the way out.
const TURN_SETTING_KEYS = Object.freeze(["model", "effort", "approvalPolicy", "sandboxPolicy"]);

function turnSettings(settings) {
  const params = {};
  for (const key of TURN_SETTING_KEYS) {
    if (settings?.[key] !== undefined && settings[key] !== null) params[key] = settings[key];
  }
  return params;
}

// model/list is paged by an opaque cursor; the adapter follows it to the end
// within a small bound so one call returns the whole catalog.
const MODEL_PAGE_LIMIT = 10;

async function listModels(client, input) {
  const models = [];
  let cursor = null;
  for (let page = 0; page < MODEL_PAGE_LIMIT; page += 1) {
    const result = await client.request("model/list", { cursor, includeHidden: Boolean(input.includeHidden), ...(input.limit ? { limit: input.limit } : {}) });
    models.push(...(result.data ?? []));
    cursor = result.nextCursor ?? null;
    if (!cursor) break;
  }
  return models;
}

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
        const turn = await client.request("turn/start", { threadId: input.conversationId, input: input.content, ...turnSettings(input.settings) });
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
      if (action === "chat.listModels") {
        const models = await listModels(client, input);
        return { harnessId: "codex", conversationId: input.conversationId ?? "models", value: { models } };
      }
      if (action === "chat.compact") {
        const value = await client.request("thread/compact/start", { threadId: input.conversationId });
        return { harnessId: "codex", conversationId: input.conversationId, value };
      }
      if (action === "chat.searchFiles") {
        const value = await client.request("fuzzyFileSearch", { query: input.query, roots: input.roots, cancellationToken: input.cancellationToken ?? null });
        return { harnessId: "codex", conversationId: input.conversationId ?? "files", value };
      }
      if (action === "chat.listSkills") {
        const value = await client.request("skills/list", { cwds: input.cwds, forceReload: Boolean(input.forceReload) });
        return { harnessId: "codex", conversationId: input.conversationId ?? "skills", value };
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
