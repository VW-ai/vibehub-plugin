const CONTEXT_ITEM_LIMIT = 12;
const DETAIL_CHAR_LIMIT = 2_400;
const MESSAGE_CHAR_LIMIT = 12_000;

function boundedText(value, limit) {
  const text = String(value ?? "");
  return text.length <= limit
    ? { text, truncated: false, originalChars: text.length }
    : { text: `${text.slice(0, Math.max(0, limit - 1))}…`, truncated: true, originalChars: text.length };
}

function contextIdFromRef(ref) {
  return String(ref ?? "").match(/^\.vibehub\/rooms\/(?:[a-z0-9-]+\/)+([a-z0-9-]+)\.yaml$/u)?.[1] ?? null;
}

function stableUnique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((left, right) => left.localeCompare(right));
}

function taskIdentity(handoff) {
  return {
    ticketId: handoff.ticketId,
    ticketRef: handoff.ticketRef,
    maturity: handoff.maturity,
    operationalState: handoff.operationalState,
    nextAction: handoff.nextAction,
    outcome: handoff.outcome,
    context: handoff.context,
    acceptance: handoff.acceptance,
    constraints: handoff.constraints,
    relations: handoff.relations,
    humanBoundaries: handoff.humanBoundaries,
  };
}

export function buildTaskContextPacket({
  handoff,
  project = null,
  contexts = [],
  rooms = [],
  selectedContextIds = [],
  priorAccepted = [],
  thread = null,
  operation = "start",
  humanMessage = null,
}) {
  if (handoff?.kind !== "vibehub_ticket_handoff" || typeof handoff.ticketId !== "string") {
    throw new Error("Task Context packet requires one canonical VibeHub handoff");
  }
  if (!new Set(["start", "continue", "steer", "explore"]).has(operation)) {
    throw new Error(`Unsupported Task conversation operation: ${operation}`);
  }
  const contextsById = new Map(contexts.map((item) => [item.contextId, item]));
  const directContextIds = stableUnique((handoff.contextRefs ?? []).map((item) => contextIdFromRef(item.ref)));
  const selectedIds = stableUnique(selectedContextIds);
  const requestedContextIds = [...directContextIds, ...selectedIds.filter((id) => !directContextIds.includes(id))];
  const includedIds = requestedContextIds.filter((id) => contextsById.has(id)).slice(0, CONTEXT_ITEM_LIMIT);
  const includedContexts = includedIds.map((id) => {
    const item = contextsById.get(id);
    const detail = boundedText(item.detail, DETAIL_CHAR_LIMIT);
    return {
      contextId: item.contextId,
      room: item.room,
      type: item.type,
      summary: item.summary,
      detail: detail.text,
      detailTruncated: detail.truncated,
      originalDetailChars: detail.originalChars,
      tags: item.tags ?? [],
      sourceRef: item.sourceRef,
      inclusion: directContextIds.includes(id) ? "ticket_context_ref" : "human_selected_for_next_turn",
      writebackAuthority: "none",
    };
  });
  const roomNames = stableUnique(includedContexts.map((item) => item.room));
  const roomContext = rooms
    .filter((room) => roomNames.includes(room.room))
    .map((room) => ({
      room: room.room,
      roomId: room.roomId,
      boundary: room.boundary,
      description: room.description,
      drift: room.drift?.state ?? "UNKNOWN",
      reasonIncluded: "owns_included_context",
    }))
    .sort((left, right) => left.room.localeCompare(right.room));
  const unavailableReferences = (handoff.contextRefs ?? [])
    .filter((item) => contextIdFromRef(item.ref) && !contextsById.has(contextIdFromRef(item.ref)))
    .map((item) => ({ ref: item.ref, purpose: item.purpose, reason: "canonical_context_unavailable" }));
  const externalReferences = (handoff.contextRefs ?? [])
    .filter((item) => !contextIdFromRef(item.ref))
    .map((item) => ({ ref: item.ref, purpose: item.purpose, authority: "read_only_reference" }));
  const overflowContextIds = requestedContextIds.filter((id) => contextsById.has(id)).slice(CONTEXT_ITEM_LIMIT);
  const message = humanMessage === null ? null : boundedText(humanMessage, MESSAGE_CHAR_LIMIT);
  return {
    schemaVersion: 1,
    kind: "vibehub_task_context_packet",
    operation,
    task: taskIdentity(handoff),
    project: project
      ? {
          scope: "project",
          projectId: project.name,
          name: project.name,
          branch: project.branch,
          repositoryRoot: project.repositoryRoot,
          ownership: "single_current_project",
        }
      : { scope: "standalone", projectId: null, name: null, ownership: "no_project" },
    context: {
      ordering: "direct Ticket Context refs first, then human-selected Context IDs; each set is lexical and de-duplicated",
      limits: { maxItems: CONTEXT_ITEM_LIMIT, maxDetailChars: DETAIL_CHAR_LIMIT, maxMessageChars: MESSAGE_CHAR_LIMIT },
      directContextIds,
      selectedContextIds: selectedIds,
      items: includedContexts,
      rooms: roomContext,
      externalReferences,
      unavailableReferences,
      overflowContextIds,
      conflicts: [],
      conflictPolicy: "Canonical conflicts or authority crossings must be shown to the Human; the packet never resolves them silently.",
    },
    conversation: {
      threadId: thread?.id ?? null,
      runId: thread?.activeTurnId ?? null,
      provenance: thread ? "codex_app_server_thread" : "new_thread_requested",
      humanMessage: message?.text ?? null,
      humanMessageTruncated: message?.truncated ?? false,
      originalHumanMessageChars: message?.originalChars ?? 0,
    },
    proof: {
      evidence: handoff.evidence ?? [],
      outcome: handoff.outcomeRecord ?? null,
      priorAccepted,
      completedRunIsOutcome: false,
    },
    authority: {
      contextRead: "explicit_packet_only",
      crossProjectRead: "explicit_reference_only",
      writeback: "governed_proposal_only",
      readingNeverGrantsWriteback: true,
      browserMayReconstructPrompt: false,
    },
    citations: stableUnique([
      handoff.ticketRef,
      ...(handoff.contextRefs ?? []).map((item) => item.ref),
      ...(handoff.evidence ?? []).flatMap((item) => item.refs ?? []),
      handoff.outcomeRecord ? `.vibehub/outcomes/${handoff.ticketId}.yaml` : null,
      ...priorAccepted.flatMap((item) => [item.outcomeRef, ...(item.evidence ?? []).flatMap((evidence) => [evidence.evidenceRef, ...(evidence.refs ?? [])])]),
    ]),
    source: handoff.source,
  };
}

export function taskLinkFromPreview(preview) {
  try {
    const parsed = JSON.parse(preview);
    if (parsed?.kind === "vibehub_task_context_packet" && typeof parsed.task?.ticketId === "string") {
      return { ticketId: parsed.task.ticketId, kind: parsed.kind };
    }
    if (parsed?.kind === "vibehub_ticket_handoff" && typeof parsed.ticketId === "string") {
      return { ticketId: parsed.ticketId, kind: parsed.kind };
    }
  } catch {
    return null;
  }
  return null;
}

export async function startTaskContextThread({ client, packet, cwd, ephemeral = false, approvalPolicy = "on-request", sandbox = "workspace-write" }) {
  const started = await client.request("thread/start", {
    approvalPolicy,
    cwd,
    ephemeral,
    sandbox,
  });
  const payloadText = JSON.stringify(packet, null, 2);
  await client.request("thread/name/set", {
    threadId: started.thread.id,
    name: `VibeHub Task · ${packet.task.ticketId}`,
  });
  const turn = await client.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: payloadText }],
  });
  return { ticketId: packet.task.ticketId, threadId: started.thread.id, turnId: turn.turn.id, payloadText };
}
