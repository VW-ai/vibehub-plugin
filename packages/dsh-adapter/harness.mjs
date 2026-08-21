import { encodeTaskLink } from "./linkage.mjs";

export function createDshHarnessAdapter({ sessions, workspaces }) {
  if (!sessions || !workspaces) throw new Error("DSH adapter requires native Sessions and Workspaces ports");
  const binding = (id) => {
    const session = sessions.binding(id)?.session;
    if (!session) throw new Error(`DSH Session ${id} is unavailable`);
    return session;
  };
  return Object.freeze({
    id: "dsh",
    async execute(action, input) {
      if (action === "chat.create") {
        const conversationId = await sessions.create(input.options ?? {});
        return { harnessId: "dsh", conversationId, value: { sessionId: conversationId } };
      }
      if (action === "chat.resume") {
        sessions.open(input.conversationId);
        return { harnessId: "dsh", conversationId: input.conversationId, value: { sessionId: input.conversationId } };
      }
      if (action === "chat.send" || action === "chat.sendAttachments") {
        const value = await binding(input.conversationId).prompt(input.content, input.mode ?? "queue");
        return { harnessId: "dsh", conversationId: input.conversationId, value };
      }
      if (action === "chat.fork") {
        const conversationId = await sessions.fork({ sessionId: input.conversationId, ...(input.atSeq === undefined ? {} : { atSeq: input.atSeq }), increaseTitle: true });
        return { harnessId: "dsh", conversationId, value: { sessionId: conversationId } };
      }
      if (action === "chat.search") {
        const value = await sessions.search(input.query, input.signal ?? new AbortController().signal);
        return { harnessId: "dsh", conversationId: input.conversationId ?? "search", value };
      }
      if (action === "chat.interrupt") {
        const value = await binding(input.conversationId).cancel();
        return { harnessId: "dsh", conversationId: input.conversationId, value };
      }
      if (action === "interaction.resolveApproval") {
        const value = await input.pending.respond(input.result);
        return { harnessId: "dsh", conversationId: input.conversationId, value };
      }
      if (action === "task.start") {
        const workspace = await workspaces.create({ path: input.cwd });
        const conversationId = input.conversationId ?? await workspaces.connectWorkspace(workspace.workspaceId);
        const session = binding(conversationId);
        const encoded = encodeTaskLink({ version: 1, workspace: input.cwd, ticketId: input.payload.ticketId, commit: input.commit ?? null });
        const linked = await session.command(`/vibehub-task ${encoded}`);
        if (!linked.ok || !linked.value.matched) throw new Error("DSH rejected VibeHub Task linkage");
        const value = await session.prompt([{ type: "text", text: JSON.stringify(input.payload, null, 2) }], "queue");
        return { harnessId: "dsh", conversationId, value };
      }
      throw new Error(`DSH adapter does not implement ${action}`);
    },
  });
}
