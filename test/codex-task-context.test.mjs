import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskContextPacket, startTaskContextThread, taskLinkFromPreview } from "../packages/codex-adapter/task-context.mjs";

const handoff = {
  kind: "vibehub_ticket_handoff",
  ticketId: "ticket-context-packet",
  ticketRef: ".vibehub/tickets/ticket-context-packet.yaml",
  maturity: "firm",
  operationalState: "READY",
  nextAction: { action: "EXECUTE" },
  outcome: "Ship one bounded Task workspace.",
  context: "Use only governed Context.",
  acceptance: [{ acceptance_id: "packet-is-exact", criterion: "Packet stays host-owned.", authority: "agent" }],
  constraints: ["No browser prompt reconstruction."],
  relations: [],
  humanBoundaries: [],
  evidence: [],
  outcomeRecord: null,
  contextRefs: [
    { ref: ".vibehub/rooms/product/decision-task-context.yaml", purpose: "Product direction" },
    { ref: "docs/BOUNDARY.md", purpose: "Implementation boundary" },
  ],
  source: { repositoryRoot: "/workspace/vibehub", resolvedCommit: "abc123" },
};

const contexts = [
  { contextId: "decision-task-context", room: "product", type: "decision", summary: "Task Context", detail: "Direct context", tags: ["task"], sourceRef: "conversation:1" },
  { contextId: "contract-extra", room: "knowledge", type: "contract", summary: "Extra", detail: "Selected context", tags: [], sourceRef: "docs:1" },
];

test("Task Context packet is deterministic, bounded, cited, and host-owned", () => {
  const input = {
    handoff,
    project: { name: "vibehub", branch: "codex/test", repositoryRoot: "/workspace/vibehub" },
    contexts,
    rooms: [
      { room: "knowledge", roomId: "knowledge", description: "Knowledge", boundary: "Durable claims", drift: { state: "FRESH" } },
      { room: "product", roomId: "product", description: "Product", boundary: "Product decisions", drift: { state: "FRESH" } },
    ],
    selectedContextIds: ["contract-extra", "decision-task-context"],
    priorAccepted: [{
      ticketId: "ticket-prerequisite",
      rationale: "The Task consumes the accepted renderer.",
      outcomeRef: ".vibehub/outcomes/ticket-prerequisite.yaml",
      outcome: { status: "successful", summary: "Renderer accepted.", closedAt: "2026-08-21T00:00:00Z", acceptedAcceptanceIds: ["renderer-ready"] },
      evidence: [{ evidenceId: "renderer-proof", evidenceRef: ".vibehub/evidence/ticket-prerequisite/renderer-proof.yaml", summary: "Renderer proof.", acceptanceIds: ["renderer-ready"], origin: "agent", refs: ["docs/renderer.md"] }],
    }],
    thread: { id: "thread-1", activeTurnId: "turn-1" },
    operation: "continue",
    humanMessage: "Focus on the interaction boundary.",
  };
  const first = buildTaskContextPacket(input);
  const second = buildTaskContextPacket(input);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "vibehub_task_context_packet");
  assert.equal(first.project.scope, "project");
  assert.deepEqual(first.context.items.map((item) => item.contextId), ["decision-task-context", "contract-extra"]);
  assert.equal(first.context.items.find((item) => item.contextId === "decision-task-context").inclusion, "ticket_context_ref");
  assert.equal(first.context.items.find((item) => item.contextId === "contract-extra").inclusion, "human_selected_for_next_turn");
  assert.deepEqual(first.context.rooms.map((room) => room.room), ["knowledge", "product"]);
  assert.equal(first.context.externalReferences[0].authority, "read_only_reference");
  assert.equal(first.authority.browserMayReconstructPrompt, false);
  assert.equal(first.authority.readingNeverGrantsWriteback, true);
  assert.equal(first.proof.completedRunIsOutcome, false);
  assert.equal(first.proof.priorAccepted[0].ticketId, "ticket-prerequisite");
  assert.ok(first.citations.includes(".vibehub/outcomes/ticket-prerequisite.yaml"));
  assert.ok(first.citations.includes(".vibehub/evidence/ticket-prerequisite/renderer-proof.yaml"));
  assert.ok(first.citations.includes(handoff.ticketRef));
  assert.equal(first.conversation.threadId, "thread-1");
});

test("standalone Tasks remain valid and unavailable Context is explicit", () => {
  const packet = buildTaskContextPacket({ handoff: { ...handoff, contextRefs: [{ ref: ".vibehub/rooms/product/missing-context.yaml", purpose: "Missing" }] }, project: null, contexts: [], rooms: [] });
  assert.equal(packet.project.scope, "standalone");
  assert.equal(packet.project.projectId, null);
  assert.equal(packet.context.items.length, 0);
  assert.equal(packet.context.unavailableReferences[0].reason, "canonical_context_unavailable");
});

test("Task linkage accepts the new packet and preserves legacy handoff recovery", () => {
  const packet = buildTaskContextPacket({ handoff, project: null });
  assert.deepEqual(taskLinkFromPreview(JSON.stringify(packet)), { ticketId: "ticket-context-packet", kind: "vibehub_task_context_packet" });
  assert.deepEqual(taskLinkFromPreview(JSON.stringify(handoff)), { ticketId: "ticket-context-packet", kind: "vibehub_ticket_handoff" });
  assert.equal(taskLinkFromPreview("ordinary chat"), null);
});

test("the first Task Turn receives the exact host-owned packet", async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-task" } };
      if (method === "thread/name/set") return {};
      if (method === "turn/start") return { turn: { id: "turn-task" } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const packet = buildTaskContextPacket({ handoff, project: null });
  const result = await startTaskContextThread({ client, packet, cwd: "/workspace/vibehub" });
  assert.equal(result.threadId, "thread-task");
  assert.equal(result.turnId, "turn-task");
  assert.equal(calls[0].method, "thread/start");
  assert.deepEqual(calls[1], { method: "thread/name/set", params: { threadId: "thread-task", name: "VibeHub Task · ticket-context-packet" } });
  assert.equal(calls[2].method, "turn/start");
  assert.deepEqual(JSON.parse(calls[2].params.input[0].text), packet);
});
