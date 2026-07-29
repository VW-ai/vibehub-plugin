import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GitFacade,
  OperationDispatcher,
  getRepoByRoot,
  openDb,
  readTaskForBranch,
  resolveDbPath,
  taskIdForBranch,
  upsertRepo,
  upsertTask,
  type Db,
  type OperationResult,
  type TicketGraphChangeProposalV0,
  type TicketGraphSnapshotPageV0,
  type TicketProposalApplicationReceiptV0,
  type TicketProposalAuthorityDecisionReceiptV0,
  type TicketProposalAuthorityProviderRequestV0,
  type TicketProposalAuthorityProviderResultV0,
  type TicketProposalReviewPacketV0,
  type TicketProposalValidationReceiptV0,
  type TicketReviewRelationProjectionV0,
  type TicketReviewTicketProjectionV0,
  type TrustedTicketProposalAuthorityProviderV0,
} from "@vw-ai/vibehub-core";

const LOOPBACK_HOST = "127.0.0.1";
const HOST_SCHEMA_VERSION = 1 as const;
const HOST_VERSION = "ticket-review-host-v0";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_STATE_PAGES = 16;
const DEFAULT_TOKEN_LIFETIME_MS = 30 * 60 * 1_000;
const PROVIDER_ARTIFACT_DIGEST = digest(HOST_VERSION);

export interface TicketReviewHostLaunchFlags {
  repo: string;
  db: string;
  proposalId: string;
  port: number;
  open: boolean;
  json: boolean;
}

export interface TicketReviewHostOptions {
  repoRoot: string;
  dbPath: string;
  proposalId: string;
  port?: number;
  assetRoot?: string;
  now?: () => string;
  token?: string;
  tokenLifetimeMs?: number;
}

export interface TicketReviewHostHandle {
  readonly token: string;
  readonly closed: Promise<void>;
  readonly ready: Promise<{
    origin: string;
    url: string;
    port: number;
  }>;
  close(): Promise<void>;
}

type HostNodeState = "existing" | "created" | "revised";

interface HostGraphNode {
  ticketId: string;
  definitionRevision: number;
  outcome: string;
  parentId: string | null;
  state: HostNodeState;
  relationCounts: {
    prerequisites: number;
    dependents: number;
  };
}

interface HostGraphRelation {
  relationRef: string;
  prerequisiteTicketId: string;
  dependentTicketId: string;
  rationale: string | null;
  state: HostNodeState;
}

interface TicketReviewHostState {
  schemaVersion: typeof HOST_SCHEMA_VERSION;
  project: {
    name: string;
    repositoryRoot: string;
    worktreeRoot: string;
    branch: string;
  };
  proposal: {
    proposalId: string;
    proposalDigest: string;
    candidateDigest: string;
    reason: string;
    submittedAt: string;
    proposerRef: string;
    observedSnapshotId: string | null;
    createdTicketCount: number;
    revisedTicketCount: number;
  };
  review: {
    eligibility: TicketProposalReviewPacketV0["eligibility"];
    nextAction: TicketProposalReviewPacketV0["nextAction"];
    requiredPath: "human_authority" | "delegated_policy" | null;
    validationSet: TicketProposalReviewPacketV0["validationSet"];
    validations: TicketProposalReviewPacketV0["validations"];
    decision: TicketProposalAuthorityDecisionReceiptV0 | null;
    application: TicketProposalApplicationReceiptV0 | null;
  };
  graph: {
    source: "proposal_candidate" | "canonical";
    snapshotId: string;
    tickets: HostGraphNode[];
    relations: HostGraphRelation[];
  };
  controls: {
    canDecide: boolean;
    canApply: boolean;
    decisionLabel: string | null;
  };
}

interface HostRuntime {
  db: Db;
  dispatcher(provider?: TrustedTicketProposalAuthorityProviderV0): OperationDispatcher;
  repoId: number;
  taskId: string;
  repoRoot: string;
  worktreeRoot: string;
  branch: string;
}

interface CurrentGraph {
  snapshotId: string;
  tickets: TicketReviewTicketProjectionV0[];
  relations: TicketReviewRelationProjectionV0[];
}

export function ticketReviewGraphDisplayMode(input: {
  eligibilityStatus: TicketProposalReviewPacketV0["eligibility"]["status"];
  hasApplication: boolean;
  hasCurrentGraph: boolean;
  candidateBaseMatches: boolean;
}): "candidate" | "canonical" | "unavailable" {
  if (input.hasApplication || input.eligibilityStatus === "stale") {
    return input.hasCurrentGraph ? "canonical" : "unavailable";
  }
  return input.candidateBaseMatches ? "candidate" : "unavailable";
}

interface DecisionBody {
  action: "authorize" | "reject";
  rationale: string;
  expectedProposalDigest: string;
  expectedCandidateDigest: string;
  expectedValidationSetDigest: string;
}

interface ApplyBody {
  expectedProposalDigest: string;
  expectedCandidateDigest: string;
  authorityDecisionId: string;
  expectedAuthorityDecisionDigest: string;
}

export function parseTicketReviewHostFlags(
  argv: string[],
): TicketReviewHostLaunchFlags {
  let repo = process.cwd();
  let dbFlag: string | undefined;
  let proposalId: string | undefined;
  let port = 0;
  let open = true;
  let json = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag ?? "")) throw new Error(`repeated flag: ${flag}`);
    seen.add(flag ?? "");
    if (flag === "--repo" || flag === "--db" || flag === "--proposal"
      || flag === "--port") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--repo") repo = value;
      else if (flag === "--db") dbFlag = value;
      else if (flag === "--proposal") proposalId = value;
      else {
        port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error("--port must be an integer between 0 and 65535");
        }
      }
    } else if (flag === "--open") {
      open = true;
    } else if (flag === "--no-open") {
      open = false;
    } else if (flag === "--json") {
      json = true;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!proposalId?.trim()) throw new Error("--proposal is required");
  return {
    repo,
    db: resolveDbPath(dbFlag),
    proposalId,
    port,
    open,
    json,
  };
}

export function launchTicketReviewHostCommand(argv: string[]): void {
  const flags = parseTicketReviewHostFlags(argv);
  const host = startTicketReviewHost({
    repoRoot: flags.repo,
    dbPath: flags.db,
    proposalId: flags.proposalId,
    port: flags.port,
  });
  void host.ready.then(({ url, origin, port }) => {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        schemaVersion: HOST_SCHEMA_VERSION,
        proposalId: flags.proposalId,
        origin,
        port,
        opened: flags.open,
        ...(flags.open ? {} : { url }),
      })}\n`);
    } else {
      process.stdout.write(
        `Ticket review host is ready for ${flags.proposalId}\n`
        + (flags.open
          ? "The local review surface is opening in your browser.\n"
          : `${url}\nThe link is a short-lived local decision capability.\n`)
        + "Keep this terminal open; press Ctrl-C to stop.\n",
      );
    }
    if (flags.open) openBrowser(url);
  }).catch((error) => {
    process.stderr.write(
      `Ticket review host failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}

export function startTicketReviewHost(
  options: TicketReviewHostOptions,
): TicketReviewHostHandle {
  const tokenLifetimeMs =
    options.tokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
  if (!Number.isSafeInteger(tokenLifetimeMs) || tokenLifetimeMs < 1) {
    throw new Error("Ticket review host token lifetime must be a positive integer");
  }
  const token = options.token ?? crypto.randomBytes(32).toString("base64url");
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("Ticket review host token must contain at least 32 bytes");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const runtime = openHostRuntime(options.repoRoot, options.dbPath, now());
  const assetRoot = options.assetRoot ?? defaultAssetRoot();
  assertAssets(assetRoot);
  const sessionId = crypto.randomUUID();
  const tokenExpiresAt = Date.now() + tokenLifetimeMs;
  let origin: string | null = null;
  let closed = false;
  let requestSequence = 0;
  const nextReadRequestId = (operation: string): string =>
    `ticket-review-host:${sessionId}:${++requestSequence}:${operation}`;
  const stableRequestId = (operation: string): string =>
    `ticket-review-host:${sessionId}:${options.proposalId}:${operation}`;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const buildState = (): TicketReviewHostState => {
    const reviewed = runtime.dispatcher().dispatch(
      "ticket.proposal.review.inspect",
      operationContext(runtime, nextReadRequestId("review"), now()),
      { proposalId: options.proposalId },
    );
    const packet = requireOperationData<TicketProposalReviewPacketV0>(reviewed);
    if (packet.proposal.kind !== "graph_change") {
      throw new HostHttpError(
        409,
        "invalid_state",
        "The review host only opens graph-change proposals.",
      );
    }
    const current = readCurrentGraph(runtime, nextReadRequestId, now);
    return projectHostState(runtime, packet, current);
  };

  const decide = (body: DecisionBody): TicketReviewHostState => {
    const packet = requireReviewPacket(runtime, options.proposalId, now());
    if (packet.proposal.kind !== "graph_change") {
      throw new HostHttpError(
        409,
        "invalid_state",
        "Comment proposals cannot receive graph authority.",
      );
    }
    assertDecisionBinding(packet, body);
    if (packet.eligibility.status !== "authority_required") {
      throw new HostHttpError(
        409,
        "invalid_state",
        `Proposal is ${packet.eligibility.status}; refresh before deciding.`,
      );
    }
    if (requiredPathForPacket(packet) !== "human_authority") {
      throw new HostHttpError(
        409,
        "unsupported_authority_path",
        "This local human review host cannot invent delegated-policy authority.",
      );
    }
    const provider = trustedLocalDecisionProvider({
      sessionId,
      token,
      action: body.action,
      rationale: body.rationale,
      expectedProposalId: options.proposalId,
      expectedProposalDigest: body.expectedProposalDigest,
      expectedCandidateDigest: body.expectedCandidateDigest,
      expectedValidationSetDigest: body.expectedValidationSetDigest,
    });
    const result = runtime.dispatcher(provider).dispatch(
      "ticket.proposal.authority.decide",
      operationContext(runtime, stableRequestId("decision"), now()),
      {
        schemaVersion: 1,
        proposalId: options.proposalId,
        expectedProposalDigest: body.expectedProposalDigest,
        expectedCandidateDigest: body.expectedCandidateDigest,
        expectedValidationSetDigest: body.expectedValidationSetDigest,
      },
    );
    const decision = requireOperationData<
      TicketProposalAuthorityDecisionReceiptV0
    >(result);
    assertLocalDecisionReceipt(decision, {
      sessionId,
      token,
      action: body.action,
      rationale: body.rationale,
      packet,
    });
    if (decision.disposition === "authorized") {
      applyAuthorizedDecision(runtime, packet.proposal, decision, now());
    }
    return buildState();
  };

  const apply = (body: ApplyBody): TicketReviewHostState => {
    const packet = requireReviewPacket(runtime, options.proposalId, now());
    if (packet.proposal.kind !== "graph_change") {
      throw new HostHttpError(409, "invalid_state", "Comment proposals cannot apply.");
    }
    if (packet.eligibility.status !== "application_ready"
      || packet.decision?.disposition !== "authorized") {
      throw new HostHttpError(
        409,
        "invalid_state",
        `Proposal is ${packet.eligibility.status}; refresh before publishing.`,
      );
    }
    if (packet.proposal.proposalDigest !== body.expectedProposalDigest
      || packet.proposal.mechanicalReview.candidateDigest
        !== body.expectedCandidateDigest
      || packet.decision.authorityDecisionId !== body.authorityDecisionId
      || packet.decision.authorityDecisionDigest
        !== body.expectedAuthorityDecisionDigest) {
      throw new HostHttpError(
        409,
        "stale_review",
        "The application binding changed. Refresh the review surface.",
      );
    }
    applyAuthorizedDecision(runtime, packet.proposal, packet.decision, now());
    return buildState();
  };

  const server = http.createServer((request, response) => {
    void routeRequest({
      request,
      response,
      token,
      tokenExpiresAt,
      origin,
      assetRoot,
      buildState,
      decide,
      apply,
      onTerminal: () => {
        response.once("finish", () => {
          if (!closed) server.close();
        });
      },
    }).catch((error) => {
      writeError(response, error);
    });
  });
  server.on("close", () => {
    clearTimeout(expiryTimer);
    if (!closed) {
      closed = true;
      runtime.db.close();
      resolveClosed();
    }
  });
  const expiryTimer = setTimeout(() => {
    if (!closed) server.close();
  }, tokenLifetimeMs);

  const ready = new Promise<{ origin: string; url: string; port: number }>(
    (resolve, reject) => {
      const fail = (error: Error): void => {
        server.off("listening", listening);
        if (!closed) {
          closed = true;
          clearTimeout(expiryTimer);
          runtime.db.close();
          resolveClosed();
        }
        reject(error);
      };
      const listening = (): void => {
        server.off("error", fail);
        const address = server.address();
        if (address === null || typeof address === "string") {
          fail(new Error("Ticket review host did not receive a TCP address"));
          return;
        }
        origin = `http://${LOOPBACK_HOST}:${address.port}`;
        resolve({
          origin,
          url: `${origin}/#${token}`,
          port: address.port,
        });
      };
      server.once("error", fail);
      server.once("listening", listening);
      server.listen(options.port ?? 0, LOOPBACK_HOST);
    },
  );

  return {
    token,
    closed: closedPromise,
    ready,
    close: async () => {
      if (closed) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function openHostRuntime(
  cwd: string,
  dbPath: string,
  at: string,
): HostRuntime {
  const gitSession = GitFacade.sessionContextAt(cwd);
  const git = new GitFacade(gitSession.toplevel);
  const db = openDb(dbPath);
  try {
    const repo = getRepoByRoot(db, gitSession.repoRoot) ?? upsertRepo(
      db,
      gitSession.repoRoot,
      git.remoteSlug(),
      git.defaultBranchOr("main"),
      at,
    );
    const branch = gitSession.branch ?? "detached";
    const existing = readTaskForBranch(db, repo.id, branch);
    const taskId = existing?.id ?? taskIdForBranch(repo.id, branch);
    if (existing === null) {
      upsertTask(db, {
        id: taskId,
        repoId: repo.id,
        title: branch,
        state: "queued",
        signalTier: "basic",
        branch,
        worktreePath:
          gitSession.toplevel === gitSession.repoRoot
            ? null
            : gitSession.toplevel,
        prNumber: null,
        prState: null,
        stateSince: at,
        lastEventAt: at,
        statusDetail: null,
        createdAt: at,
        startHeadSha: GitFacade.headShaAt(gitSession.toplevel),
      });
    }
    return {
      db,
      repoId: repo.id,
      taskId,
      repoRoot: gitSession.repoRoot,
      worktreeRoot: gitSession.toplevel,
      branch,
      dispatcher: (provider) => new OperationDispatcher(db, {
        repoRoot: gitSession.toplevel,
        ticketAuthorityProvider: provider,
      }),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function operationContext(
  runtime: HostRuntime,
  requestId: string,
  now: string,
): {
  repoId: number;
  actor: string;
  taskId: string;
  requestId: string;
  now: string;
} {
  return {
    repoId: runtime.repoId,
    actor: "ticket-review-host",
    taskId: runtime.taskId,
    requestId,
    now,
  };
}

function requireReviewPacket(
  runtime: HostRuntime,
  proposalId: string,
  now: string,
): TicketProposalReviewPacketV0 {
  const result = runtime.dispatcher().dispatch(
    "ticket.proposal.review.inspect",
    operationContext(
      runtime,
      `ticket-review-host:${crypto.randomUUID()}:review`,
      now,
    ),
    { proposalId },
  );
  return requireOperationData<TicketProposalReviewPacketV0>(result);
}

function requireOperationData<T>(result: OperationResult): T {
  if (result.ok) return result.data as T;
  throw new HostHttpError(
    operationStatus(result.error.code),
    result.error.code,
    result.error.message,
    result.error.details,
  );
}

function operationStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "validation_error" || code === "actor_required") return 400;
  if (code === "trusted_authority_unavailable") return 503;
  if (code === "internal_error") return 500;
  return 409;
}

function readCurrentGraph(
  runtime: HostRuntime,
  nextRequestId: (operation: string) => string,
  now: () => string,
): CurrentGraph | null {
  const tickets = new Map<string, TicketReviewTicketProjectionV0>();
  const relations = new Map<string, TicketReviewRelationProjectionV0>();
  let cursor: string | undefined;
  let snapshotId: string | null = null;
  for (let page = 0; page < MAX_STATE_PAGES; page += 1) {
    const result = runtime.dispatcher().dispatch(
      "ticket.graph.snapshot",
      operationContext(runtime, nextRequestId("snapshot"), now()),
      {
        pageSize: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    if (!result.ok && result.error.code === "not_found") return null;
    const data = requireOperationData<TicketGraphSnapshotPageV0>(result);
    if (snapshotId !== null && snapshotId !== data.snapshotId) {
      throw new HostHttpError(
        409,
        "snapshot_changed",
        "The canonical Ticket snapshot changed while the host was reading it.",
      );
    }
    snapshotId = data.snapshotId;
    for (const ticket of data.tickets) tickets.set(ticket.ticketId, ticket);
    for (const relation of data.relations) {
      relations.set(relation.relationRef, relation);
    }
    if (data.nextCursor === null) {
      return {
        snapshotId: data.snapshotId,
        tickets: [...tickets.values()],
        relations: [...relations.values()],
      };
    }
    cursor = data.nextCursor;
  }
  throw new HostHttpError(
    413,
    "graph_too_large",
    "The Ticket graph exceeded the review host page budget.",
  );
}

function projectHostState(
  runtime: HostRuntime,
  packet: TicketProposalReviewPacketV0,
  current: CurrentGraph | null,
): TicketReviewHostState {
  if (packet.proposal.kind !== "graph_change") {
    throw new HostHttpError(409, "invalid_state", "Expected a graph proposal.");
  }
  const proposal = packet.proposal;
  const displayMode = ticketReviewGraphDisplayMode({
    eligibilityStatus: packet.eligibility.status,
    hasApplication: packet.application !== null,
    hasCurrentGraph: current !== null,
    candidateBaseMatches:
      proposal.observedSnapshotId === (current?.snapshotId ?? null),
  });
  if (displayMode === "unavailable") {
    if (packet.eligibility.status !== "stale"
      && packet.application === null) {
      throw new HostHttpError(
        409,
        "snapshot_changed",
        "The canonical Ticket head changed while the proposal was being projected. Refresh the review surface.",
      );
    }
    throw new HostHttpError(
      409,
      "stale_candidate_unavailable",
      "This proposal no longer matches the canonical Ticket head, and the current graph is unavailable. Refresh planning before review.",
    );
  }
  const graph = displayMode === "canonical"
    ? canonicalGraph(current!)
    : candidateGraph(current, proposal);
  const requiredPath = requiredPathForPacket(packet);
  return {
    schemaVersion: HOST_SCHEMA_VERSION,
    project: {
      name: path.basename(runtime.repoRoot),
      repositoryRoot: runtime.repoRoot,
      worktreeRoot: runtime.worktreeRoot,
      branch: runtime.branch,
    },
    proposal: {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      candidateDigest: proposal.mechanicalReview.candidateDigest,
      reason: proposal.reason,
      submittedAt: proposal.submittedAt,
      proposerRef: proposal.proposer.ref,
      observedSnapshotId: proposal.observedSnapshotId,
      createdTicketCount: proposal.mechanicalReview.createdTicketIds.length,
      revisedTicketCount: proposal.mechanicalReview.revisedTicketIds.length,
    },
    review: {
      eligibility: packet.eligibility,
      nextAction: packet.nextAction,
      requiredPath,
      validationSet: packet.validationSet,
      validations: packet.validations,
      decision: packet.decision,
      application: packet.application,
    },
    graph,
    controls: {
      canDecide: packet.eligibility.status === "authority_required"
        && requiredPath === "human_authority",
      canApply: packet.eligibility.status === "application_ready",
      decisionLabel: packet.eligibility.status === "authority_required"
        ? "Authorize and publish"
        : packet.eligibility.status === "application_ready"
          ? "Publish authorized graph"
          : null,
    },
  };
}

function canonicalGraph(current: CurrentGraph): TicketReviewHostState["graph"] {
  const counts = relationCounts(current.tickets.map((ticket) => ticket.ticketId), current.relations);
  return {
    source: "canonical",
    snapshotId: current.snapshotId,
    tickets: current.tickets.map((ticket) => ({
      ticketId: ticket.ticketId,
      definitionRevision: ticket.definitionRevision,
      outcome: ticket.outcome,
      parentId: null,
      state: "existing",
      relationCounts: counts.get(ticket.ticketId)!,
    })),
    relations: current.relations.map((relation) => ({
      relationRef: relation.relationRef,
      prerequisiteTicketId: relation.prerequisiteTicketId,
      dependentTicketId: relation.dependentTicketId,
      rationale: relation.rationale ?? null,
      state: "existing",
    })),
  };
}

function candidateGraph(
  current: CurrentGraph | null,
  proposal: TicketGraphChangeProposalV0,
): TicketReviewHostState["graph"] {
  const nodes = new Map<string, HostGraphNode>();
  const relations = new Map<string, HostGraphRelation>();
  for (const ticket of current?.tickets ?? []) {
    nodes.set(ticket.ticketId, {
      ticketId: ticket.ticketId,
      definitionRevision: ticket.definitionRevision,
      outcome: ticket.outcome,
      parentId: null,
      state: "existing",
      relationCounts: { prerequisites: 0, dependents: 0 },
    });
  }
  for (const relation of current?.relations ?? []) {
    relations.set(relation.relationRef, {
      relationRef: relation.relationRef,
      prerequisiteTicketId: relation.prerequisiteTicketId,
      dependentTicketId: relation.dependentTicketId,
      rationale: relation.rationale ?? null,
      state: "existing",
    });
  }
  for (const change of proposal.changes) {
    for (const [ref, relation] of relations) {
      if (relation.dependentTicketId === change.ticketId) relations.delete(ref);
    }
    nodes.set(change.ticketId, {
      ticketId: change.ticketId,
      definitionRevision: change.definition.definitionRevision,
      outcome: change.definition.outcome,
      parentId: change.definition.parentId,
      state: change.op === "create" ? "created" : "revised",
      relationCounts: { prerequisites: 0, dependents: 0 },
    });
    for (const dependency of change.definition.dependsOn) {
      const relationRef = [
        "proposal",
        proposal.proposalId,
        dependency.ticketId,
        change.ticketId,
      ].join(":");
      relations.set(relationRef, {
        relationRef,
        prerequisiteTicketId: dependency.ticketId,
        dependentTicketId: change.ticketId,
        rationale: dependency.rationale ?? null,
        state: change.op === "create" ? "created" : "revised",
      });
    }
  }
  const orderedRelations = [...relations.values()].sort(compareRelations);
  const counts = relationCounts([...nodes.keys()], orderedRelations);
  return {
    source: "proposal_candidate",
    snapshotId: `candidate:${proposal.mechanicalReview.candidateDigest}`,
    tickets: [...nodes.values()]
      .sort((left, right) => left.ticketId.localeCompare(right.ticketId))
      .map((node) => ({
        ...node,
        relationCounts: counts.get(node.ticketId)
          ?? { prerequisites: 0, dependents: 0 },
      })),
    relations: orderedRelations,
  };
}

function relationCounts(
  ticketIds: string[],
  relations: ReadonlyArray<{
    prerequisiteTicketId: string;
    dependentTicketId: string;
  }>,
): Map<string, { prerequisites: number; dependents: number }> {
  const counts = new Map(ticketIds.map((ticketId) => [
    ticketId,
    { prerequisites: 0, dependents: 0 },
  ]));
  for (const relation of relations) {
    const prerequisite = counts.get(relation.prerequisiteTicketId);
    const dependent = counts.get(relation.dependentTicketId);
    if (prerequisite) prerequisite.dependents += 1;
    if (dependent) dependent.prerequisites += 1;
  }
  return counts;
}

function compareRelations(
  left: HostGraphRelation,
  right: HostGraphRelation,
): number {
  return left.prerequisiteTicketId.localeCompare(right.prerequisiteTicketId)
    || left.dependentTicketId.localeCompare(right.dependentTicketId)
    || left.relationRef.localeCompare(right.relationRef);
}

/** @internal Exported for receipt-boundary contract testing. */
export function trustedLocalDecisionProvider(input: {
  sessionId: string;
  token: string;
  action: DecisionBody["action"];
  rationale: string;
  expectedProposalId: string;
  expectedProposalDigest: string;
  expectedCandidateDigest: string;
  expectedValidationSetDigest: string;
}): TrustedTicketProposalAuthorityProviderV0 {
  let consumed = false;
  return {
    decide(
      request: TicketProposalAuthorityProviderRequestV0,
    ): TicketProposalAuthorityProviderResultV0 {
      if (consumed) {
        throw new Error("trusted review decision capability was already consumed");
      }
      consumed = true;
      if (request.target.proposalId !== input.expectedProposalId
        || request.target.proposalDigest !== input.expectedProposalDigest
        || request.target.candidateDigest !== input.expectedCandidateDigest
        || request.validationSet.digest !== input.expectedValidationSetDigest) {
        throw new Error("trusted review session does not bind this authority request");
      }
      if (request.requiredPath !== "human_authority") {
        throw new Error(
          "the local human review host cannot invent a durable delegation basis",
        );
      }
      const acceptedValidations = request.validationSet.validations
        .filter(isPassingValidation)
        .map((validation) => ({
          validationReceiptId: validation.validationReceiptId,
          validationReceiptDigest: validation.validationReceiptDigest,
        }))
        .sort((left, right) =>
          left.validationReceiptId.localeCompare(right.validationReceiptId));
      const authoritySignals = [...new Set([
        ...request.proposal.reviewRequirement.indicatedAuthoritySignals,
        ...request.validationSet.validations.flatMap(
          (validation) => validation.indicatedAuthoritySignals,
        ),
      ])].sort();
      const authenticationContextDigest = digest(JSON.stringify({
        kind: "loopback_browser_capability",
        sessionId: input.sessionId,
        tokenDigest: digest(input.token),
        uid: typeof process.getuid === "function" ? process.getuid() : null,
      }));
      const basisDigest = digest(JSON.stringify({
        sessionId: input.sessionId,
        action: input.action,
        proposalId: request.target.proposalId,
        proposalDigest: request.target.proposalDigest,
        candidateDigest: request.target.candidateDigest,
        validationSetDigest: request.validationSet.digest,
      }));
      return {
        disposition:
          input.action === "authorize" ? "authorized" : "rejected",
        provider: {
          kind: "trusted_host_authority_provider",
          id: "vibehub.local-ticket-review-host",
          version: HOST_VERSION,
          artifactDigest: PROVIDER_ARTIFACT_DIGEST,
          trust: "host_injected",
        },
        principal: {
          kind: "human",
          ref: localPrincipalRef(),
          authenticationContextDigest,
          trust: "host_authenticated",
        },
        basis: {
          kind: "human_authority",
          ref: `local-review-session:${input.sessionId}`,
          digest: basisDigest,
        },
        acceptedValidations:
          input.action === "authorize" ? acceptedValidations : [],
        resolvedAssessment: {
          changeClass: request.proposal.authorAssessment.changeClass,
          authoritySignals,
        },
        rationale: input.rationale,
      };
    },
  };
}

function isPassingValidation(
  validation: TicketProposalValidationReceiptV0,
): boolean {
  return validation.conclusion === "passed"
    && validation.findings.every((finding) => finding.impact !== "blocking");
}

function localPrincipalRef(): string {
  const uid = typeof process.getuid === "function"
    ? String(process.getuid())
    : digest(os.userInfo().username).slice(0, 16);
  return `local-os-user:${uid}`;
}

function assertDecisionBinding(
  packet: TicketProposalReviewPacketV0,
  body: DecisionBody,
): void {
  if (packet.proposal.kind !== "graph_change"
    || packet.proposal.proposalDigest !== body.expectedProposalDigest
    || packet.proposal.mechanicalReview.candidateDigest
      !== body.expectedCandidateDigest
    || packet.validationSet.digest !== body.expectedValidationSetDigest) {
    throw new HostHttpError(
      409,
      "stale_review",
      "The proposal or validation set changed. Refresh the review surface.",
    );
  }
}

function requiredPathForPacket(
  packet: TicketProposalReviewPacketV0,
): "human_authority" | "delegated_policy" | null {
  if (packet.proposal.kind !== "graph_change") return null;
  if (packet.decision !== null) return packet.decision.requiredPath;
  if (packet.eligibility.status !== "authority_required") return null;
  const proposal = packet.proposal;
  return proposal.observedSnapshotId === null
    || proposal.authorAssessment.introducesHumanGate
    || proposal.authorAssessment.changeClass === "expansion"
    || proposal.reviewRequirement.indicatedAuthoritySignals.length > 0
    || packet.validations.some(
      (validation) => validation.authoritySignalCount > 0,
    )
    ? "human_authority"
    : "delegated_policy";
}

/** @internal Exported for receipt-boundary contract testing. */
export function assertLocalDecisionReceipt(
  decision: TicketProposalAuthorityDecisionReceiptV0,
  expected: {
    sessionId: string;
    token: string;
    action: DecisionBody["action"];
    rationale: string;
    packet: TicketProposalReviewPacketV0;
  },
): void {
  if (expected.packet.proposal.kind !== "graph_change") {
    throw new HostHttpError(
      409,
      "authority_race",
      "The authority receipt no longer belongs to a graph-change proposal.",
    );
  }
  const proposal = expected.packet.proposal;
  const expectedDisposition =
    expected.action === "authorize" ? "authorized" : "rejected";
  const expectedAccepted = expected.action === "authorize"
    ? expected.packet.validations
      .filter((validation) =>
        validation.conclusion === "passed"
        && validation.blockingFindingCount === 0)
      .map((validation) => ({
        validationReceiptId: validation.validationReceiptId,
        validationReceiptDigest: validation.validationReceiptDigest,
      }))
      .sort((left, right) =>
        left.validationReceiptId.localeCompare(right.validationReceiptId))
    : [];
  const expectedAuthenticationContextDigest = digest(JSON.stringify({
    kind: "loopback_browser_capability",
    sessionId: expected.sessionId,
    tokenDigest: digest(expected.token),
    uid: typeof process.getuid === "function" ? process.getuid() : null,
  }));
  const expectedBasisDigest = digest(JSON.stringify({
    sessionId: expected.sessionId,
    action: expected.action,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    candidateDigest: proposal.mechanicalReview.candidateDigest,
    validationSetDigest: expected.packet.validationSet.digest,
  }));
  if (decision.disposition !== expectedDisposition
    || decision.scopeRef !== proposal.scopeRef
    || decision.target.proposalId !== proposal.proposalId
    || decision.target.proposalDigest !== proposal.proposalDigest
    || decision.target.observedSnapshotId !== proposal.observedSnapshotId
    || decision.target.candidateDigest
      !== proposal.mechanicalReview.candidateDigest
    || decision.validationSet.digest !== expected.packet.validationSet.digest
    || decision.validationSet.throughSequence
      !== expected.packet.validationSet.throughSequence
    || decision.validationSet.count !== expected.packet.validationSet.count
    || !sameJson(decision.validationSet.accepted, expectedAccepted)
    || decision.provider.id !== "vibehub.local-ticket-review-host"
    || decision.provider.kind !== "trusted_host_authority_provider"
    || decision.provider.version !== HOST_VERSION
    || decision.provider.artifactDigest !== PROVIDER_ARTIFACT_DIGEST
    || decision.provider.trust !== "host_injected"
    || decision.requiredPath !== "human_authority"
    || decision.basis.kind !== "human_authority"
    || decision.basis.ref !== `local-review-session:${expected.sessionId}`
    || decision.basis.digest !== expectedBasisDigest
    || decision.principal.kind !== "human"
    || decision.principal.ref !== localPrincipalRef()
    || decision.principal.authenticationContextDigest
      !== expectedAuthenticationContextDigest
    || decision.principal.trust !== "host_authenticated"
    || decision.resolvedAssessment.changeClass
      !== proposal.authorAssessment.changeClass
    || decision.authorityGranted !== (expected.action === "authorize")
    || decision.applicationAuthorized !== (expected.action === "authorize")
    || decision.graphMutationApplied !== false
    || decision.rationale !== expected.rationale) {
    throw new HostHttpError(
      409,
      "authority_race",
      "Another terminal authority decision won this proposal. Refresh the review surface.",
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyAuthorizedDecision(
  runtime: HostRuntime,
  proposal: TicketGraphChangeProposalV0,
  decision: Extract<TicketProposalAuthorityDecisionReceiptV0, {
    disposition: "authorized";
  }>,
  now: string,
): TicketProposalApplicationReceiptV0 {
  const result = runtime.dispatcher().dispatch(
    "ticket.proposal.apply",
    operationContext(
      runtime,
      `ticket-review-host:${proposal.proposalId}:apply`,
      now,
    ),
    {
      schemaVersion: 1,
      proposalId: proposal.proposalId,
      expectedProposalDigest: proposal.proposalDigest,
      expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
      authorityDecisionId: decision.authorityDecisionId,
      expectedAuthorityDecisionDigest: decision.authorityDecisionDigest,
    },
  );
  return requireOperationData<TicketProposalApplicationReceiptV0>(result);
}

async function routeRequest(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  token: string;
  tokenExpiresAt: number;
  origin: string | null;
  assetRoot: string;
  buildState: () => TicketReviewHostState;
  decide: (body: DecisionBody) => TicketReviewHostState;
  apply: (body: ApplyBody) => TicketReviewHostState;
  onTerminal: () => void;
}): Promise<void> {
  const {
    request,
    response,
    token,
    tokenExpiresAt,
    origin,
    assetRoot,
    buildState,
    decide,
    apply,
    onTerminal,
  } = input;
  applySecurityHeaders(response);
  const url = new URL(request.url ?? "/", origin ?? "http://127.0.0.1");
  assertHost(request, origin);
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true, schemaVersion: HOST_SCHEMA_VERSION });
    return;
  }
  if (request.method === "GET" && staticAsset(url.pathname) !== null) {
    const asset = staticAsset(url.pathname)!;
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.contentType);
    response.end(fs.readFileSync(path.join(assetRoot, asset.file)));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (Date.now() >= tokenExpiresAt) {
      throw new HostHttpError(
        410,
        "session_expired",
        "This local review capability expired. Start a new review host.",
      );
    }
    assertBearer(request, token);
    if (request.method === "GET" && url.pathname === "/api/state") {
      writeJson(response, 200, { ok: true, data: buildState() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/decision") {
      assertMutationOrigin(request, origin);
      const body = parseDecisionBody(await readJsonBody(request));
      const state = decide(body);
      if (state.review.eligibility.status === "applied"
        || state.review.eligibility.status === "rejected") {
        onTerminal();
      }
      writeJson(response, 200, { ok: true, data: state });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/apply") {
      assertMutationOrigin(request, origin);
      const body = parseApplyBody(await readJsonBody(request));
      const state = apply(body);
      if (state.review.eligibility.status === "applied") onTerminal();
      writeJson(response, 200, { ok: true, data: state });
      return;
    }
  }
  throw new HostHttpError(404, "not_found", "Route not found.");
}

function staticAsset(
  pathname: string,
): { file: string; contentType: string } | null {
  if (pathname === "/" || pathname === "/index.html") {
    return { file: "index.html", contentType: "text/html; charset=utf-8" };
  }
  if (pathname === "/app.css") {
    return { file: "app.css", contentType: "text/css; charset=utf-8" };
  }
  if (pathname === "/app.js") {
    return { file: "app.js", contentType: "text/javascript; charset=utf-8" };
  }
  return null;
}

function applySecurityHeaders(response: http.ServerResponse): void {
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

function assertHost(
  request: http.IncomingMessage,
  expectedOrigin: string | null,
): void {
  if (expectedOrigin === null
    || request.headers.host !== new URL(expectedOrigin).host) {
    throw new HostHttpError(
      403,
      "host_rejected",
      "The request was not addressed to this loopback review host.",
    );
  }
}

function assertBearer(
  request: http.IncomingMessage,
  expected: string,
): void {
  const authorization = request.headers.authorization;
  const prefix = "Bearer ";
  if (typeof authorization !== "string"
    || !authorization.startsWith(prefix)
    || !safeEqual(authorization.slice(prefix.length), expected)) {
    throw new HostHttpError(
      401,
      "unauthorized",
      "Open the exact short-lived review link printed by VibeHub.",
    );
  }
}

function assertMutationOrigin(
  request: http.IncomingMessage,
  expectedOrigin: string | null,
): void {
  if (expectedOrigin === null || request.headers.origin !== expectedOrigin) {
    throw new HostHttpError(
      403,
      "origin_rejected",
      "The decision request did not come from this review host.",
    );
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
    || !contentType.toLowerCase().startsWith("application/json")) {
    throw new HostHttpError(
      415,
      "content_type_rejected",
      "Decision requests must use application/json.",
    );
  }
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new HostHttpError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HostHttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function parseDecisionBody(value: unknown): DecisionBody {
  const record = strictRecord(value, [
    "action",
    "rationale",
    "expectedProposalDigest",
    "expectedCandidateDigest",
    "expectedValidationSetDigest",
  ]);
  const action = record["action"];
  const rationale = canonicalText(record["rationale"], "rationale", 12, 2_000);
  if (action !== "authorize" && action !== "reject") {
    throw new HostHttpError(
      400,
      "invalid_action",
      "Decision action must be authorize or reject.",
    );
  }
  return {
    action,
    rationale,
    expectedProposalDigest: digestText(
      record["expectedProposalDigest"],
      "expectedProposalDigest",
    ),
    expectedCandidateDigest: digestText(
      record["expectedCandidateDigest"],
      "expectedCandidateDigest",
    ),
    expectedValidationSetDigest: digestText(
      record["expectedValidationSetDigest"],
      "expectedValidationSetDigest",
    ),
  };
}

function parseApplyBody(value: unknown): ApplyBody {
  const record = strictRecord(value, [
    "expectedProposalDigest",
    "expectedCandidateDigest",
    "authorityDecisionId",
    "expectedAuthorityDecisionDigest",
  ]);
  return {
    expectedProposalDigest: digestText(
      record["expectedProposalDigest"],
      "expectedProposalDigest",
    ),
    expectedCandidateDigest: digestText(
      record["expectedCandidateDigest"],
      "expectedCandidateDigest",
    ),
    authorityDecisionId: canonicalText(
      record["authorityDecisionId"],
      "authorityDecisionId",
      4,
      200,
    ),
    expectedAuthorityDecisionDigest: digestText(
      record["expectedAuthorityDecisionDigest"],
      "expectedAuthorityDecisionDigest",
    ),
  };
}

function strictRecord(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostHttpError(400, "invalid_input", "Request body must be an object.");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new HostHttpError(
      400,
      "invalid_input",
      "Request body contains missing or unsupported fields.",
    );
  }
  return record;
}

function canonicalText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value !== value.trim()
    || value.length < minimum || value.length > maximum) {
    throw new HostHttpError(
      400,
      "invalid_input",
      `${field} must be trimmed text between ${minimum} and ${maximum} characters.`,
    );
  }
  return value;
}

function digestText(value: unknown, field: string): string {
  const text = canonicalText(value, field, 64, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new HostHttpError(400, "invalid_input", `${field} must be a SHA-256 digest.`);
  }
  return text;
}

function writeJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function writeError(response: http.ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof HostHttpError) {
    writeJson(response, error.status, {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }
  writeJson(response, 500, {
    ok: false,
    error: {
      code: "internal_error",
      message: "The Ticket review host could not complete the request.",
      details: null,
    },
  });
}

class HostHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

function defaultAssetRoot(): string {
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const built = path.join(moduleRoot, "ticket-review-host");
  if (fs.existsSync(built)) return built;
  return path.resolve(moduleRoot, "../assets/ticket-review-host");
}

function assertAssets(assetRoot: string): void {
  for (const file of ["index.html", "app.css", "app.js"]) {
    if (!fs.statSync(path.join(assetRoot, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Ticket review host asset is missing: ${file}`);
    }
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => {
    process.stderr.write(
      `Could not open the browser. Open this short-lived local link manually:\n${url}\n`,
    );
  });
  child.unref();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
