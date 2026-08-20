#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import http from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  documents,
  loadRepository,
  projectRoomDrift,
  projectTicketQuery,
  ticketArchived,
  ticketNextAction,
  ticketStatus,
} from "./vh.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const HOST_SCHEMA_VERSION = 1;
const DEFAULT_TOKEN_LIFETIME_MS = 30 * 60 * 1_000;
const MAX_DIRTY_PATHS = 100;
const TICKET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FOCUS_VIEWS = new Set(["execution", "contract", "log"]);
const ASSET_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app-model.js", ["app-model.js", "text/javascript; charset=utf-8"]],
  ["/app-layout.js", ["app-layout.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/vibehub-mark.svg", ["vibehub-mark.svg", "image/svg+xml"]],
]);

class UiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
}

function digest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

function git(repo, args) {
  try {
    // The UI accepts arbitrary repository paths. Never let repository-local
    // fsmonitor configuration turn a read-only projection into hook execution.
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function githubWebBase(remote) {
  if (!remote) return null;
  const match = remote.match(
    /^(?:git@github\.com:|https?:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/u,
  );
  return match ? `https://github.com/${match[1]}` : null;
}

function pathActions(source, path) {
  const absolutePath = isAbsolute(path)
    ? path
    : resolve(source.worktreeRoot, path);
  const repositoryPath = relative(source.repositoryRoot, absolutePath)
    .split("\\").join("/");
  const insideRepository = repositoryPath !== ".."
    && !repositoryPath.startsWith("../");
  const revision = source.resolvedCommit || source.branch;
  return {
    path,
    absolutePath,
    editorHref: `vscode://file${encodeURI(absolutePath)}`,
    githubHref: insideRepository && source.githubWebBase && revision
      ? `${source.githubWebBase}/blob/${encodeURIComponent(revision)}/${repositoryPath
        .split("/").map(encodeURIComponent).join("/")}`
      : null,
  };
}

function referenceKind(reference) {
  if (/^https?:\/\//u.test(reference)) return "url";
  if (/^(?:commit|git):/u.test(reference)) return "commit";
  if (/^test:/u.test(reference)) return "test";
  if (/^browser:/u.test(reference)) return "browser";
  if (/^conversation:/u.test(reference)) return "conversation";
  if (/^(?:file:)?[^:]+\.(?:md|ya?ml|json|m?js|c?js|css|html|tsx?|jsx?)$/u.test(reference)) {
    return "file";
  }
  return "reference";
}

function referenceLabel(reference, kind = referenceKind(reference)) {
  if (kind === "file") return basename(reference.replace(/^file:/u, ""));
  if (kind === "url") {
    try {
      return new URL(reference).hostname;
    } catch {
      return "Web reference";
    }
  }
  const value = reference.includes(":")
    ? reference.slice(reference.indexOf(":") + 1)
    : reference;
  const compact = value.length > 32 ? `${value.slice(0, 20)}…${value.slice(-8)}` : value;
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} · ${compact}`;
}

function typedReference(source, reference) {
  const kind = referenceKind(reference);
  const filePath = kind === "file" ? reference.replace(/^file:/u, "") : null;
  return {
    kind,
    label: referenceLabel(reference, kind),
    target: reference,
    href: kind === "url" ? reference : null,
    actions: filePath ? pathActions(source, filePath) : null,
  };
}

function gitSource(repo, graphDigest) {
  const repositoryRoot = git(repo, ["rev-parse", "--show-toplevel"]) || repo;
  const worktreeRoot = realpathSync(repo);
  const branch = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const resolvedCommit = git(repo, ["rev-parse", "--verify", "HEAD"]);
  const remoteOrigin = git(repo, ["config", "--get", "remote.origin.url"]);
  const githubBase = githubWebBase(remoteOrigin);
  const status = git(repo, [
    "status",
    "--short",
    "--untracked-files=all",
    "--",
    ".vibehub",
  ]);
  const allDirtyPaths = status
    ? status.split("\n").map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  const dirtyPaths = allDirtyPaths.slice(0, MAX_DIRTY_PATHS);
  const source = {
    mode: "worktree",
    repositoryRoot,
    worktreeRoot,
    worktreeIdentity: digest(worktreeRoot),
    branch: branch || null,
    resolvedCommit: resolvedCommit || null,
    graphDigest,
    semanticLedgerDigest: graphDigest,
    semanticDirty: allDirtyPaths.length > 0,
    dirtyPaths,
    dirtyPathsTruncated: allDirtyPaths.length > dirtyPaths.length,
    remoteOrigin: remoteOrigin || null,
    githubWebBase: githubBase,
  };
  source.actions = {
    worktree: {
      ...pathActions(source, source.worktreeRoot),
      githubHref: null,
    },
    repository: githubBase,
    commit: githubBase && resolvedCommit
      ? `${githubBase}/commit/${resolvedCommit}`
      : null,
  };
  source.agentPayload = {
    kind: "vibehub_git_source",
    repository: source.repositoryRoot,
    worktree: source.worktreeRoot,
    branch: source.branch,
    commit: source.resolvedCommit,
    semanticDirty: source.semanticDirty,
    dirtyPaths: source.dirtyPaths,
  };
  return source;
}

function relationRef(prerequisiteTicketId, dependentTicketId) {
  return `rel-${digest({ prerequisiteTicketId, dependentTicketId }).slice(7, 23)}`;
}

function outcomeState(outcome) {
  if (!outcome) return null;
  return outcome.status === "successful" ? "DONE" : "DEVIATED";
}

function operationalState(repository, ticket, outcome) {
  const label = outcomeState(outcome) ?? ticketStatus(repository, ticket);
  if (label === "DONE") {
    return {
      label,
      detail: "Every acceptance criterion was independently accepted.",
      references: [{ ref: `.vibehub/outcomes/${ticket.ticket_id}.yaml`, label: "Outcome" }],
    };
  }
  if (label === "DEVIATED") {
    return {
      label,
      detail: `The independent Outcome is ${outcome.status}; this Ticket does not unlock dependents.`,
      references: [{ ref: `.vibehub/outcomes/${ticket.ticket_id}.yaml`, label: outcome.status }],
    };
  }
  const blockers = ticket.relations
    .map((relation) => relation.target_ticket_id)
    .filter((id) => repository.outcomes.documents.get(id)?.document.status !== "successful");
  if (label === "BLOCKED") {
    return {
      label,
      detail: "Waiting for direct prerequisites to close successfully.",
      references: blockers.map((ref) => ({ ref, label: "Prerequisite" })),
    };
  }
  if (label === "REFINE") {
    return {
      label,
      detail: "Draft Ticket: unblocked but under-defined; its acceptance must be refined and maturity set to firm before execution.",
      references: [{ ref: `.vibehub/tickets/${ticket.ticket_id}.yaml`, label: "Draft" }],
    };
  }
  return {
    label,
    detail: "No unresolved direct prerequisite prevents execution.",
    references: [],
  };
}

function projectedNextAction(repository, ticket) {
  const derived = ticketNextAction(repository, ticket);
  return {
    action: derived.action,
    reason: derived.reason,
    detail: derived.detail,
    acceptanceIds: derived.acceptance_ids,
    blockingTicketIds: derived.blocking_ticket_ids,
  };
}

function acceptanceAuthority(criterion) {
  return criterion.authority ?? "agent";
}

function evidenceOrigin(evidence) {
  return evidence.origin ?? "agent";
}

function handoffInstruction(ticketId, nextAction) {
  const routes = {
    EXECUTE: {
      skill: "vibehub-ticket-run",
      instruction: `Execute the READY VibeHub Ticket ${ticketId} in this exact worktree with the Skill vibehub-ticket-run.`,
    },
    CLOSE_OUT: {
      skill: "vibehub-ticket-closeout",
      instruction: `Independently adjudicate VibeHub Ticket ${ticketId} in this exact worktree with the Skill vibehub-ticket-closeout. Read the exact current Ticket, Acceptance authority, Evidence, Git diff or refs, and tests; do not execute it again, accept an executor summary as proof, or write a successful Outcome unless every current criterion is independently satisfied.`,
      requiresIndependentAgent: true,
    },
    NEEDS_HUMAN: {
      skill: "vibehub-ticket-review",
      instruction: `Present the Contract for VibeHub Ticket ${ticketId} with the Skill vibehub-ticket-review and wait for explicit human input. Do not substitute Agent-origin Evidence for human authority.`,
    },
    REFINE: {
      skill: "vibehub-ticket-plan",
      instruction: `Refine VibeHub Ticket ${ticketId} in this exact worktree with the Skill vibehub-ticket-plan; do not start vibehub-ticket-run until its contract is firm.`,
    },
    REPLAN: {
      skill: "vibehub-ticket-plan",
      instruction: `Replan VibeHub Ticket ${ticketId} in this exact worktree with the Skill vibehub-ticket-plan, preserving the non-successful Outcome.`,
    },
    WAIT: {
      skill: "vibehub-ticket-review",
      instruction: `Inspect VibeHub Ticket ${ticketId} with the Skill vibehub-ticket-review and wait for its direct prerequisites to close successfully.`,
    },
    DONE: {
      skill: "vibehub-ticket-review",
      instruction: `Inspect the recorded Outcome for VibeHub Ticket ${ticketId} with the Skill vibehub-ticket-review.`,
    },
  };
  return {
    action: nextAction.action,
    readOnly: true,
    requiresIndependentAgent: false,
    ...(routes[nextAction.action] ?? routes.DONE),
  };
}

function humanAttentionState(repository, ticket, outcome) {
  const humanCriteria = ticket.acceptance.filter(
    (criterion) => acceptanceAuthority(criterion) === "human",
  );
  const humanEvidence = documents(repository.evidence.documents).filter(
    (evidence) => evidence.ticket_id === ticket.ticket_id
      && evidenceOrigin(evidence) === "human",
  );
  const recordedIds = new Set(humanEvidence.flatMap(
    (evidence) => evidence.acceptance_ids,
  ));
  const criteria = humanCriteria.map((criterion) => ({
    acceptanceId: criterion.acceptance_id,
    criterion: criterion.criterion,
    authority: "human",
    evidenceState: recordedIds.has(criterion.acceptance_id)
      ? "recorded"
      : "pending",
  }));
  const recordedAcceptanceIds = criteria
    .filter((criterion) => criterion.evidenceState === "recorded")
    .map((criterion) => criterion.acceptanceId);
  const pendingAcceptanceIds = criteria
    .filter((criterion) => criterion.evidenceState === "pending")
    .map((criterion) => criterion.acceptanceId);
  const humanAcceptanceCount = criteria.length;
  const humanEvidenceCount = recordedAcceptanceIds.length;
  const operational = ticketStatus(repository, ticket);
  let label = "NONE";
  let detail = "No acceptance criterion reserves human authority.";
  if (humanAcceptanceCount > 0 && outcome?.status === "successful") {
    label = "COMPLETE";
    detail = "Human-authority acceptance was independently accepted.";
  } else if (humanAcceptanceCount > 0
    && humanEvidenceCount === humanAcceptanceCount) {
    label = "RECORDED";
    detail = "Human-origin Evidence is recorded; independent Outcome is pending.";
  } else if (humanAcceptanceCount > 0
    && (operational === "BLOCKED" || operational === "REFINE")) {
    label = "UPCOMING";
    detail = "A human boundary is ahead; dependency or refinement work comes first.";
  } else if (humanAcceptanceCount > 0) {
    label = "PENDING";
    detail = `${pendingAcceptanceIds.length} human-authority criterion${pendingAcceptanceIds.length === 1 ? "" : "s"} await human-origin Evidence.`;
  }
  return {
    label,
    detail,
    humanAcceptanceCount,
    humanEvidenceCount,
    acceptanceIds: criteria.map((criterion) => criterion.acceptanceId),
    recordedAcceptanceIds,
    pendingAcceptanceIds,
    criteria,
  };
}

function projectGraph(repository, queryOptions = {}) {
  const query = projectTicketQuery(repository, queryOptions);
  const ticketDocuments = query.tickets;
  const relations = query.relations.map((relation) => {
    const dependent = repository.tickets.documents
      .get(relation.dependent_ticket_id)?.document;
    return {
      relationRef: relationRef(relation.prerequisite_ticket_id, relation.dependent_ticket_id),
      prerequisiteTicketId: relation.prerequisite_ticket_id,
      dependentTicketId: relation.dependent_ticket_id,
      rationale: relation.rationale,
      provenanceRefs: dependent?.provenance_refs ?? [],
    };
  });
  const counts = new Map(ticketDocuments.map((ticket) => [
    ticket.ticket_id,
    { prerequisites: 0, dependents: 0 },
  ]));
  for (const relation of relations) {
    counts.get(relation.dependentTicketId).prerequisites += 1;
    counts.get(relation.prerequisiteTicketId).dependents += 1;
  }
  const tickets = ticketDocuments.map((ticket) => {
    const outcome = repository.outcomes.documents.get(ticket.ticket_id)?.document ?? null;
    const attention = humanAttentionState(repository, ticket, outcome);
    const nextAction = projectedNextAction(repository, ticket);
    return {
      ticketId: ticket.ticket_id,
      ticketRevision: digest(ticket),
      outcome: ticket.outcome,
      archived: ticketArchived(repository, ticket),
      deliveries: ticket.deliveries ?? [],
      provenanceRefs: ticket.provenance_refs,
      relationCounts: counts.get(ticket.ticket_id),
      capabilities: {
        operational: {
          availability: "available",
          summary: operationalState(repository, ticket, outcome),
        },
        attention: {
          availability: "available",
          summary: attention,
        },
        nextAction: {
          availability: "available",
          summary: nextAction,
        },
        runtime: {
          availability: "unavailable",
          reason: "No trusted runtime source is connected to this read-only host.",
        },
      },
    };
  });
  return {
    tickets,
    relations,
    stubs: query.stubs.map((stub) => ({
      stubRef: stub.stub_ref,
      anchorTicketId: stub.anchor_ticket_id,
      direction: stub.direction,
      hiddenTicketCount: stub.hidden_ticket_count,
      nextTicketIds: stub.next_ticket_ids,
    })),
    filters: query.filters,
  };
}

function projectRooms(repo, repository) {
  let drift;
  try {
    drift = projectRoomDrift(repo, repository);
  } catch (error) {
    if (error?.code !== "git_error") throw error;
    drift = {
      cold_start: true,
      rooms: [...repository.rooms.documents.keys()].map((room) => ({
        room,
        state: "UNKNOWN",
        reason: "Git snapshot unavailable",
      })),
    };
  }
  const driftByRoom = new Map(drift.rooms.map((item) => [item.room, item]));
  const contextEntries = [...repository.contexts.documents.values()];
  const tickets = documents(repository.tickets.documents);
  const rooms = [...repository.rooms.documents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roomPath, entry]) => {
      const prefix = `${join(repository.paths.rooms, ...roomPath.split("/"))}/`;
      const contexts = contextEntries
        .filter((item) => item.path.startsWith(prefix))
        .map(({ document, path }) => ({
          contextId: document.context_id,
          type: document.type,
          state: document.state,
          summary: document.summary,
          path: relative(repo, path).split("\\").join("/"),
        }))
        .sort((left, right) => left.contextId.localeCompare(right.contextId));
      const consumingTickets = tickets.filter((ticket) => ticket.context_refs.some(({ ref }) => {
        const match = ref.match(/^\.vibehub\/rooms\/(.+)\/[^/]+\.yaml$/u);
        return match && (match[1] === roomPath || match[1].startsWith(`${roomPath}/`));
      })).map((ticket) => ticket.ticket_id).sort();
      return {
        room: roomPath,
        roomId: entry.document.room_id,
        parent: roomPath.includes("/") ? roomPath.slice(0, roomPath.lastIndexOf("/")) : null,
        description: entry.document.description,
        boundary: entry.document.boundary,
        anchors: entry.document.anchors,
        contexts,
        consumingTickets,
        drift: (() => {
          const item = driftByRoom.get(roomPath) ?? { room: roomPath, state: "UNKNOWN", reason: "never aligned" };
          return item.state === "UNKNOWN" ? { ...item, state: "COLD_START" } : item;
        })(),
      };
    });
  return { coldStart: drift.cold_start, rooms };
}

function canonicalContextFromRef(repository, reference) {
  const match = reference.match(/^\.vibehub\/rooms\/((?:[a-z0-9-]+\/)+)([a-z0-9-]+)\.yaml$/u);
  if (!match || match[2] === "room") return null;
  const context = repository.contexts.documents.get(match[2])?.document;
  if (!context) return null;
  return {
    room: match[1].slice(0, -1),
    contextId: context.context_id,
    type: context.type,
    state: context.state,
    summary: context.summary,
    detail: context.detail,
    tags: context.tags,
    source: context.source,
    evidence: context.evidence,
    relations: context.relations,
  };
}

function ticketContextPackage(ticket, relations, repository, source) {
  const outcome = repository.outcomes.documents.get(ticket.ticket_id)?.document ?? null;
  const evidence = documents(repository.evidence.documents)
    .filter((item) => item.ticket_id === ticket.ticket_id)
    .map((item) => ({
      evidenceId: item.evidence_id,
      acceptanceIds: item.acceptance_ids,
      origin: evidenceOrigin(item),
      summary: item.summary,
      refs: item.refs,
      recordedAt: item.recorded_at,
    }));
  const attention = humanAttentionState(repository, ticket, outcome);
  const maturity = ticket.maturity ?? "firm";
  const operational = outcomeState(outcome) ?? ticketStatus(repository, ticket);
  const nextAction = projectedNextAction(repository, ticket);
  const acceptance = ticket.acceptance.map((item) => ({
    acceptanceId: item.acceptance_id,
    criterion: item.criterion,
    authority: acceptanceAuthority(item),
  }));
  const contextRefs = ticket.context_refs.map((item) => ({
    ...item,
    kind: canonicalContextFromRef(repository, item.ref) ? "context" : "source",
    canonicalContext: canonicalContextFromRef(repository, item.ref),
  }));
  const agentPayload = {
    kind: "vibehub_ticket_handoff",
    ticketId: ticket.ticket_id,
    ticketRef: `.vibehub/tickets/${ticket.ticket_id}.yaml`,
    maturity,
    operationalState: operational,
    nextAction,
    handoff: handoffInstruction(ticket.ticket_id, nextAction),
    outcome: ticket.outcome,
    outcomeRecord: outcome,
    context: ticket.context,
    acceptance: ticket.acceptance.map((item) => ({
      ...item,
      authority: acceptanceAuthority(item),
    })),
    humanBoundaries: attention.criteria,
    evidence,
    constraints: ticket.constraints,
    contextRefs: ticket.context_refs,
    relations: ticket.relations,
    provenanceRefs: ticket.provenance_refs,
    source: source.agentPayload,
    reviewInputs: {
      ticketRef: `.vibehub/tickets/${ticket.ticket_id}.yaml`,
      evidenceRefs: evidence.map(({ evidenceId }) =>
        `.vibehub/evidence/${ticket.ticket_id}/${evidenceId}.yaml`),
      outcomeRef: outcome
        ? `.vibehub/outcomes/${ticket.ticket_id}.yaml`
        : null,
      commit: source.resolvedCommit,
      semanticDirty: source.semanticDirty,
      dirtyPaths: source.dirtyPaths,
    },
  };
  return {
    maturity,
    operationalState: operational,
    nextAction,
    outcome: ticket.outcome,
    context: ticket.context,
    acceptance,
    evidence,
    attention,
    constraints: ticket.constraints,
    contextRefs,
    relations: ticket.relations.map((relation) => ({
      type: relation.type,
      targetTicketId: relation.target_ticket_id,
      rationale: relation.rationale ?? "Direct execution dependency.",
      relationRef: relations.find((candidate) =>
        candidate.prerequisiteTicketId === relation.target_ticket_id
        && candidate.dependentTicketId === ticket.ticket_id)?.relationRef,
    })),
    provenanceRefs: ticket.provenance_refs.map((ref) => typedReference(source, ref)),
    agentPayload,
  };
}

function evidenceTrace(evidence, source) {
  return {
    kind: "evidence",
    subkind: "acceptance",
    status: "recorded",
    acceptanceIds: evidence.acceptance_ids,
    origin: evidenceOrigin(evidence),
    occurredAt: evidence.recorded_at,
    summary: evidence.summary,
    body: `Acceptance: ${evidence.acceptance_ids.join(", ")}`,
    targets: evidence.refs.map((ref) => typedReference(source, ref)),
    agentPayload: {
      kind: "vibehub_ticket_evidence",
      evidenceId: evidence.evidence_id,
      ticketId: evidence.ticket_id,
      acceptanceIds: evidence.acceptance_ids,
      origin: evidenceOrigin(evidence),
      summary: evidence.summary,
      refs: evidence.refs,
      recordedAt: evidence.recorded_at,
    },
  };
}

function outcomeTrace(outcome, source) {
  const outcomeRef = `.vibehub/outcomes/${outcome.ticket_id}.yaml`;
  return {
    kind: "outcome",
    subkind: outcome.status,
    status: outcome.status,
    acceptedAcceptanceIds: outcome.accepted_acceptance_ids,
    unresolvedAcceptanceIds: outcome.unresolved_acceptance_ids,
    occurredAt: outcome.closed_at,
    summary: outcome.summary,
    body: [
      `Accepted: ${outcome.accepted_acceptance_ids.join(", ") || "none"}`,
      `Unresolved: ${outcome.unresolved_acceptance_ids.join(", ") || "none"}`,
    ].join("\n"),
    targets: [{
      ...typedReference(source, outcomeRef),
      label: "Canonical Outcome",
    }],
    agentPayload: {
      kind: "vibehub_ticket_outcome",
      ticketId: outcome.ticket_id,
      status: outcome.status,
      acceptedAcceptanceIds: outcome.accepted_acceptance_ids,
      unresolvedAcceptanceIds: outcome.unresolved_acceptance_ids,
      evidenceIds: outcome.evidence_ids,
      summary: outcome.summary,
      closedAt: outcome.closed_at,
      ref: outcomeRef,
    },
  };
}

function traceRecords(repository, source, ticketId = null) {
  const evidence = documents(repository.evidence.documents)
    .filter((item) => ticketId === null || item.ticket_id === ticketId)
    .map((item) => evidenceTrace(item, source));
  const outcomes = documents(repository.outcomes.documents)
    .filter((item) => ticketId === null || item.ticket_id === ticketId)
    .map((item) => outcomeTrace(item, source));
  return [...evidence, ...outcomes].sort((left, right) =>
    String(left.occurredAt).localeCompare(String(right.occurredAt)),
  );
}

export function buildUiSnapshot(repoRoot, queryOptions = {}) {
  const repo = realpathSync(resolve(repoRoot));
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  const contexts = documents(repository.contexts.documents);
  const rawTickets = documents(repository.tickets.documents);
  const rawEvidence = documents(repository.evidence.documents);
  const rawOutcomes = documents(repository.outcomes.documents);
  const graphDigest = digest({ contexts, tickets: rawTickets, evidence: rawEvidence, outcomes: rawOutcomes });
  const source = gitSource(repo, graphDigest);
  const graph = projectGraph(repository, queryOptions);
  const rooms = projectRooms(repo, repository);
  const protectedBoundaries = graph.tickets
    .filter((ticket) =>
      ticket.capabilities.attention.summary.humanAcceptanceCount > 0)
    .map((ticket) => ({
      ticketId: ticket.ticketId,
      state: ticket.capabilities.attention.summary.label,
      criteria: ticket.capabilities.attention.summary.criteria,
    }));
  const snapshotId = digest({ graphDigest, source: {
    resolvedCommit: source.resolvedCommit,
    branch: source.branch,
    dirtyPaths: source.dirtyPaths,
  } });
  const state = {
    schemaVersion: HOST_SCHEMA_VERSION,
    project: {
      name: basename(source.repositoryRoot || repo),
      repositoryRoot: source.repositoryRoot,
      worktreeRoot: source.worktreeRoot,
      branch: source.branch ?? "detached",
    },
    graph: {
      snapshotId,
      source,
      tickets: graph.tickets,
      relations: graph.relations,
      stubs: graph.stubs,
      filters: graph.filters,
    },
    rooms,
    interventions: {
      review: { available: false },
      planReview: { available: false },
      protectedDecision: { available: false },
      protectedBoundaries,
      authority: {
        status: "available",
        scope: "acceptance",
        default: "agent",
      },
    },
  };
  return { repo, repository, graph, state };
}

function queryOptionsFromUrl(url) {
  return {
    scope: url.searchParams.get("scope") ?? "current",
    delivery: url.searchParams.get("delivery"),
    rooms: url.searchParams.getAll("room"),
    historyIds: url.searchParams.getAll("history"),
  };
}

function subjectFrom(snapshot, url) {
  const snapshotId = url.searchParams.get("snapshotId");
  if (snapshotId !== snapshot.state.graph.snapshotId) {
    throw new UiError(409, "snapshot_stale", "The Ticket files changed. Refresh the graph.");
  }
  const kind = url.searchParams.get("kind");
  const base = {
    schemaVersion: HOST_SCHEMA_VERSION,
    snapshotId,
    source: snapshot.state.graph.source,
  };
  if (kind === "graph") return { ...base, subject: { kind: "graph" } };
  if (kind === "ticket") {
    const ticketId = url.searchParams.get("ticketId");
    const ticket = snapshot.repository.tickets.documents.get(ticketId)?.document;
    const node = snapshot.graph.tickets.find((item) => item.ticketId === ticketId);
    if (!ticket || !node) throw new UiError(404, "not_found", `Ticket not found: ${ticketId}`);
    return {
      ...base,
      subject: {
        kind: "ticket",
        ticket: node,
        contextPackage: ticketContextPackage(
          ticket,
          snapshot.graph.relations,
          snapshot.repository,
          snapshot.state.graph.source,
        ),
      },
      contextPackage: ticketContextPackage(
        ticket,
        snapshot.graph.relations,
        snapshot.repository,
        snapshot.state.graph.source,
      ),
    };
  }
  if (kind === "relation") {
    const ref = url.searchParams.get("relationRef");
    const relation = snapshot.graph.relations.find((item) => item.relationRef === ref);
    if (!relation) throw new UiError(404, "not_found", `Relation not found: ${ref}`);
    return { ...base, subject: { kind: "relation", relation } };
  }
  throw new UiError(400, "invalid_subject", "kind must be graph, ticket, or relation");
}

function traceFrom(snapshot, url) {
  const inspected = subjectFrom(snapshot, url);
  const subject = inspected.subject.kind === "ticket"
    ? { kind: "ticket", ticketId: inspected.subject.ticket.ticketId }
    : inspected.subject.kind === "relation"
      ? { kind: "relation", relationRef: inspected.subject.relation.relationRef }
      : { kind: "graph" };
  return {
    schemaVersion: HOST_SCHEMA_VERSION,
    snapshotId: inspected.snapshotId,
    subject,
    records: subject.kind === "ticket"
      ? traceRecords(snapshot.repository, snapshot.state.graph.source, subject.ticketId)
      : subject.kind === "graph"
        ? traceRecords(snapshot.repository, snapshot.state.graph.source)
        : [],
    nextCursor: null,
  };
}

function defaultAssetRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../vibehub-ticket-review/assets");
}

function assertAssets(assetRoot) {
  for (const [file] of ASSET_FILES.values()) {
    const path = join(assetRoot, file);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`VibeHub UI asset is missing: ${path}`);
    }
  }
}

function validateFocus(ticket, view) {
  if (ticket !== null && !TICKET_ID_PATTERN.test(ticket)) {
    throw new Error("--ticket must be a canonical Ticket ID");
  }
  if (view !== null && !FOCUS_VIEWS.has(view)) {
    throw new Error("--view must be execution, contract, or log");
  }
  if (view !== null && ticket === null) {
    throw new Error("--view requires --ticket");
  }
}

function focusedUrl(origin, token, ticket, view) {
  const url = new URL(`${origin}/`);
  if (ticket !== null) url.searchParams.set("ticket", ticket);
  if (view !== null) url.searchParams.set("view", view);
  url.hash = token;
  return url.toString();
}

function securityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function writeJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

function requireHost(request, origin) {
  if (!origin || request.headers.host !== new URL(origin).host) {
    throw new UiError(403, "host_rejected", "The request was not addressed to this loopback host.");
  }
}

function requireBearer(request, token) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string"
    || !authorization.startsWith("Bearer ")
    || !safeEqual(authorization.slice(7), token)) {
    throw new UiError(401, "unauthorized", "Open the exact short-lived URL printed by VibeHub.");
  }
}

function writeError(response, error) {
  if (error instanceof UiError) {
    writeJson(response, error.status, {
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  writeJson(response, 500, {
    ok: false,
    error: {
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
      details: null,
    },
  });
}

export function startVibeHubUi({
  repoRoot,
  port = 0,
  token = crypto.randomBytes(32).toString("hex"),
  tokenLifetimeMs = DEFAULT_TOKEN_LIFETIME_MS,
  assetRoot = defaultAssetRoot(),
  ticket = null,
  view = null,
} = {}) {
  if (!repoRoot) throw new Error("repoRoot is required");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535");
  }
  if (!Number.isInteger(tokenLifetimeMs) || tokenLifetimeMs <= 0) {
    throw new Error("tokenLifetimeMs must be a positive integer");
  }
  validateFocus(ticket, view);
  if (!existsSync(resolve(repoRoot))) throw new Error(`Repository does not exist: ${repoRoot}`);
  assertAssets(assetRoot);
  const initialSnapshot = buildUiSnapshot(repoRoot);
  if (ticket !== null
    && !initialSnapshot.state.graph.tickets.some((item) => item.ticketId === ticket)) {
    throw new Error(`Unknown Ticket for --ticket: ${ticket}`);
  }
  let origin = null;
  let closed = false;
  let expiry = null;
  let resolveClosed;
  const closedPromise = new Promise((resolveClosedPromise) => {
    resolveClosed = resolveClosedPromise;
  });
  const server = http.createServer((request, response) => {
    securityHeaders(response);
    try {
      requireHost(request, origin);
      const url = new URL(request.url ?? "/", origin);
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new UiError(405, "read_only", "The local Ticket graph is read-only.");
      }
      if (url.pathname === "/health") {
        writeJson(response, 200, { ok: true, schemaVersion: HOST_SCHEMA_VERSION, readOnly: true });
        return;
      }
      const asset = ASSET_FILES.get(url.pathname);
      if (asset) {
        response.statusCode = 200;
        response.setHeader("Content-Type", asset[1]);
        if (request.method === "HEAD") response.end();
        else response.end(readFileSync(join(assetRoot, asset[0])));
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        throw new UiError(404, "not_found", "Route not found");
      }
      requireBearer(request, token);
      let snapshot;
      try {
        snapshot = buildUiSnapshot(repoRoot, queryOptionsFromUrl(url));
      } catch (error) {
        if (error?.code === "invalid_argument") {
          throw new UiError(400, "invalid_filter", error.message, error.details ?? null);
        }
        throw error;
      }
      let data;
      if (url.pathname === "/api/state") data = snapshot.state;
      else if (url.pathname === "/api/subject") data = subjectFrom(snapshot, url);
      else if (url.pathname === "/api/trace") data = traceFrom(snapshot, url);
      else throw new UiError(404, "not_found", "Route not found");
      writeJson(response, 200, { ok: true, data });
    } catch (error) {
      writeError(response, error);
    }
  });
  server.on("close", () => {
    if (closed) return;
    closed = true;
    if (expiry) clearTimeout(expiry);
    resolveClosed();
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", rejectReady);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectReady(new Error("Unable to resolve VibeHub UI address"));
        return;
      }
      origin = `http://${LOOPBACK_HOST}:${address.port}`;
      expiry = setTimeout(() => server.close(), tokenLifetimeMs);
      expiry.unref();
      resolveReady({
        origin,
        url: focusedUrl(origin, token, ticket, view),
        port: address.port,
        expiresInMs: tokenLifetimeMs,
        focus: { ticket, view },
      });
    });
  });
  return {
    token,
    ready,
    closed: closedPromise,
    close: () => new Promise((resolveClose, rejectClose) => {
      if (closed) {
        resolveClose();
        return;
      }
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

export function parseUiFlags(argv) {
  let repo = process.cwd();
  let port = 0;
  let open = true;
  let json = false;
  let ticket = null;
  let view = null;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`repeated flag: ${flag}`);
    seen.add(flag);
    if (flag === "--repo" || flag === "--port"
      || flag === "--ticket" || flag === "--view") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--repo") repo = value;
      else if (flag === "--port") {
        port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error("--port must be an integer between 0 and 65535");
        }
      } else if (flag === "--ticket") ticket = value;
      else view = value;
    } else if (flag === "--open") open = true;
    else if (flag === "--no-open") open = false;
    else if (flag === "--json") json = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  validateFocus(ticket, view);
  return { repo: resolve(repo), port, open, json, ticket, view };
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    process.stderr.write(`Could not open the browser. Open this URL manually:\n${url}\n`);
  });
  child.unref();
}

async function launch(argv) {
  const flags = parseUiFlags(argv);
  const handle = startVibeHubUi({
    repoRoot: flags.repo,
    port: flags.port,
    ticket: flags.ticket,
    view: flags.view,
  });
  const ready = await handle.ready;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      readOnly: true,
      repo: flags.repo,
      opened: flags.open,
      ...ready,
    })}\n`);
  } else {
    process.stdout.write(`VibeHub Ticket graph (read-only)\n${ready.url}\n`);
  }
  if (flags.open) openBrowser(ready.url);
  const close = () => void handle.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await handle.closed;
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  launch(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
