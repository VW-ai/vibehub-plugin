export async function startCodexTask({
  client,
  payload,
  cwd,
  ephemeral = false,
  approvalPolicy = "on-request",
  sandbox = "workspace-write",
}) {
  if (payload?.kind !== "vibehub_ticket_handoff" || typeof payload.ticketId !== "string") {
    throw new Error("Codex Task start requires one canonical VibeHub Ticket handoff");
  }
  const payloadText = JSON.stringify(payload, null, 2);
  const started = await client.request("thread/start", {
    approvalPolicy,
    cwd,
    ephemeral,
    sandbox,
  });
  const threadId = started.thread.id;
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: payloadText }],
  });
  return {
    ticketId: payload.ticketId,
    threadId,
    turnId: turn.turn.id,
    payloadText,
  };
}
