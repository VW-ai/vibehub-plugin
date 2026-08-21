#!/usr/bin/env node

import { createHash } from "node:crypto";
import { CodexAppServerClient } from "./client.mjs";
import { buildTaskContextPacket } from "./task-context.mjs";

const cwd = process.cwd();
const ticketId = "ticket-codex-task-context-probe";

const handoff = {
  kind: "vibehub_ticket_handoff",
  ticketId,
  ticketRef: `.vibehub/tickets/${ticketId}.yaml`,
  maturity: "firm",
  operationalState: "READY",
  nextAction: { action: "EXECUTE", reason: "synthetic_probe" },
  handoff: "Transport-only probe. Do not perform repository work.",
  outcome: "A synthetic Task Context packet survives one interrupted Turn and app-server restart.",
  outcomeRecord: null,
  context: "Use the bash tool to run exactly `sleep 30`, then reply that the transport probe finished. Do not inspect or modify repository files.",
  acceptance: [{ acceptance_id: "task-context-transport-is-exact", criterion: "Packet enters Codex unchanged.", authority: "agent" }],
  humanBoundaries: [],
  evidence: [],
  constraints: ["The only permitted tool command is `sleep 30`.", "Do not inspect or modify the repository."],
  contextRefs: [],
  relations: [],
  provenanceRefs: ["probe:synthetic-task-context"],
  source: { resolvedCommit: "synthetic", repositoryRoot: cwd, semanticDirty: false, dirtyPaths: [] },
  reviewInputs: { ticketRef: `.vibehub/tickets/${ticketId}.yaml`, evidenceRefs: [], outcomeRef: null, commit: "synthetic", semanticDirty: false, dirtyPaths: [] },
};

const packet = buildTaskContextPacket({ handoff, project: null, contexts: [], rooms: [], operation: "start" });

async function list(client) {
  // Current app-server search matches conversation preview, not the persisted
  // thread name. Linkage recovery therefore lists the bounded cwd scope and
  // resolves the exact thread ID/name itself.
  return client.request("thread/list", { archived: false, cursor: null, cwd, limit: 100, searchTerm: null, sortDirection: "desc", sortKey: "updated_at" });
}

async function main() {
  let first = null;
  let second = null;
  try {
    first = new CodexAppServerClient({ cwd, timeoutMs: 90_000 });
    await first.start();
    const staleResult = await list(first);
    for (const thread of staleResult.data ?? staleResult.threads ?? []) {
      if (thread.name === `VibeHub Task · ${ticketId}`) await first.request("thread/delete", { threadId: thread.id });
    }
    const startedThread = await first.request("thread/start", { approvalPolicy: "never", cwd, ephemeral: false, sandbox: "read-only" });
    const threadId = startedThread.thread.id;
    await first.request("thread/name/set", { threadId, name: `VibeHub Task · ${ticketId}` });
    const payloadText = JSON.stringify(packet, null, 2);
    // Register before turn/start and interrupt immediately after the canonical
    // userMessage is durable. This keeps the Thread recoverable while avoiding
    // a race with a fast model response.
    const userMessageCompleted = first.waitForNotification("item/completed", (params) => params?.threadId === threadId && params?.item?.type === "userMessage");
    const turnResponse = first.request("turn/start", { threadId, input: [{ type: "text", text: payloadText }] });
    const userMessageNotice = await userMessageCompleted;
    const routed = { ticketId, threadId, turnId: userMessageNotice.turnId, payloadText };
    const completed = first.waitForNotification("turn/completed", (params) => params?.threadId === routed.threadId && params?.turn?.id === routed.turnId);
    await first.request("turn/interrupt", { threadId: routed.threadId, turnId: routed.turnId });
    await turnResponse;
    const interrupted = await completed;
    await first.stop();

    second = new CodexAppServerClient({ cwd, timeoutMs: 60_000 });
    await second.start();
    const after = await list(second);
    const threads = after.data ?? after.threads ?? [];
    const recovered = threads.find((thread) => thread.id === routed.threadId && thread.name === `VibeHub Task · ${ticketId}`);
    if (!recovered) throw new Error("named Task Thread did not survive app-server restart");
    await second.request("thread/resume", { threadId: routed.threadId, approvalPolicy: "never", cwd, sandbox: "read-only" });
    const replay = await second.request("thread/read", { threadId: routed.threadId, includeTurns: true });
    const turn = replay.thread.turns.find((item) => item.id === routed.turnId);
    await second.request("thread/delete", { threadId: routed.threadId });
    if (turn?.status !== "interrupted") throw new Error(`expected interrupted replay, got ${turn?.status ?? "missing"}`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      ticketId,
      threadId: routed.threadId,
      turnId: routed.turnId,
      status: interrupted.turn?.status ?? interrupted.status,
      recoveredAfterRestart: true,
      resumedBeforeReuse: true,
      packetSha256: createHash("sha256").update(routed.payloadText).digest("hex"),
      packetBrowserDerived: false,
      namedLinkage: recovered.name,
      completedRunIsOutcome: packet.proof.completedRunIsOutcome,
      standalone: packet.project.scope === "standalone",
      cleanedUp: true
    }, null, 2)}\n`);
  } finally {
    await second?.stop();
    await first?.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
