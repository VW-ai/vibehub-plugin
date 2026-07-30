import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendTicketDecisionAttestation,
  GitFacade,
  loadTicketLedgerFromWorktree,
  OperationDispatcher,
  operationInputSchemas,
  prepareTicketDecisionForSnapshot,
  TICKET_REVIEW_MAX_PAGE_SIZE,
  TICKET_REVIEW_MAX_RELATIONS,
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_TRACE_RECORDS,
  TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE,
  TicketLedgerError,
  ticketDecisionAttestationChallenge,
  ticketDecisionDocumentDigest,
  ticketDecisionRecordRequest,
  openDb,
  resolveDbPath,
  type Db,
  type OperationResult,
  type TicketDecisionAttestationEnvelope,
  type TicketDecisionDocument,
  type TicketDecisionAuthorityContext,
  type TicketDecisionAuthorityGrant,
  type TicketReviewHostAttribution,
  type TicketReviewSourceMetadataV0,
} from "@vw-ai/vibehub-core";
import {
  TicketWebAuthnAuthorityError,
  TicketWebAuthnAuthorityRegistry,
  ticketDecisionAttestationTrustProfileResolver,
  type TicketWebAuthnAuthorityProfileV1,
  type TicketWebAuthnVerifiedPresenceV1,
} from "./ticket-webauthn-authority.js";

const LOOPBACK_HOST = "127.0.0.1";
const HOST_SCHEMA_VERSION = 3 as const;
const MAX_STATE_PAGES = Math.ceil(
  (TICKET_REVIEW_MAX_TICKETS + TICKET_REVIEW_MAX_RELATIONS)
    / TICKET_REVIEW_MAX_PAGE_SIZE,
);
const DEFAULT_TOKEN_LIFETIME_MS = 30 * 60 * 1_000;
const CEREMONY_LIFETIME_MS = 2 * 60 * 1_000;
const DECISION_ATTESTATION_LIFETIME_MS = 30 * 60 * 1_000;
const WEBAUTHN_TIMEOUT_MS = 90 * 1_000;
const REVIEW_BODY_MAX_BYTES = 512 * 1024;
const DECISION_BODY_MAX_BYTES = 128 * 1024;
const MAX_TRACE_PAGES = Math.ceil(
  TICKET_REVIEW_MAX_TRACE_RECORDS
    / TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE,
);

type TicketSourceMetadata = Extract<
  TicketReviewSourceMetadataV0,
  { mode: "worktree" }
>;

interface HostGraphNode {
  ticketId: string;
  ticketRevision: string;
  outcome: string;
  provenanceRefs: string[];
  relationCounts: {
    prerequisites: number;
    dependents: number;
  };
}

interface HostGraphRelation {
  relationRef: string;
  prerequisiteTicketId: string;
  dependentTicketId: string;
  rationale?: string;
  provenanceRefs: string[];
}

interface GraphSnapshotPage {
  schemaVersion: 3;
  snapshotId: string;
  source: TicketSourceMetadata;
  tickets: HostGraphNode[];
  relations: HostGraphRelation[];
  nextCursor: string | null;
}

type TicketReviewHostReviewCapability =
  | { available: false }
  | {
      available: true;
      actorKind: "human" | "agent";
      attribution: "host_attested";
    };

type TicketWebAuthnAuthorityRegistryLike = Pick<
  TicketWebAuthnAuthorityRegistry,
  | "listProfiles"
  | "createRegistrationOptions"
  | "verifyRegistration"
  | "createAuthenticationOptions"
  | "verifyAuthentication"
  | "revoke"
>;

type TicketReviewHostAuthorityCapability =
  | { status: "unavailable" }
  | { status: "unenrolled" }
  | {
      status: "active";
      profileId: string;
      principalId: string;
      credentialFingerprint: string;
    };

interface TicketReviewHostInterventions {
  review: TicketReviewHostReviewCapability;
  planReview:
    | { available: false }
    | { available: true; ceremony?: "direct" | "webauthn" };
  protectedDecision:
    | { available: false }
    | { available: true; ceremony: "webauthn" };
  protectedBoundaries: Array<{
    ticketId: string;
    ticketRevision: string;
    boundary: string;
  }>;
  authority: TicketReviewHostAuthorityCapability;
}

export interface TicketReviewHostState {
  schemaVersion: typeof HOST_SCHEMA_VERSION;
  project: {
    name: string;
    repositoryRoot: string;
    worktreeRoot: string;
    branch: string;
  };
  graph: {
    snapshotId: string;
    source: TicketSourceMetadata;
    tickets: HostGraphNode[];
    relations: HostGraphRelation[];
  };
  interventions: TicketReviewHostInterventions;
}

export interface TicketReviewHostLaunchFlags {
  repo: string;
  db: string;
  port: number;
  open: boolean;
  json: boolean;
}

export interface TicketReviewHostOptions {
  repoRoot: string;
  dbPath: string;
  port?: number;
  assetRoot?: string;
  now?: () => string;
  token?: string;
  tokenLifetimeMs?: number;
  /**
   * V0 trust model: the embedding same-OS-account process attests this
   * reviewer. The browser cannot supply or override it.
   */
  ticketReviewAttribution?: TicketReviewHostAttribution;
  /**
   * Optional exact Decision authority from the embedding process.
   * Without it, Decision writes fail closed.
   */
  ticketDecisionAuthority?: TicketDecisionAuthorityGrant;
  /**
   * Optional host-owned WebAuthn authority registry. Production launchers
   * provide this; deterministic tests may inject a structural implementation.
   */
  ticketWebAuthnAuthorityRegistry?: TicketWebAuthnAuthorityRegistryLike;
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

interface HostRuntime {
  db: Db;
  dispatcher: OperationDispatcher;
  repoId: number;
  repositoryRoot: string;
  worktreeRoot: string;
}

interface PendingCeremonyBase {
  ceremonyId: string;
  challenge: string;
  origin: string;
  repositoryIncarnation: string;
  expiresAtEpochMs: number;
}

interface PendingEnrollmentCeremony extends PendingCeremonyBase {
  kind: "enrollment";
  principalId: string;
  authorityBasis: "repository_owner";
  authorityRef: string;
}

interface PendingDecisionCeremony extends PendingCeremonyBase {
  kind: "decision";
  profile: TicketWebAuthnAuthorityProfileV1;
  input: Record<string, unknown>;
  expectedSource: ReturnType<
    typeof ticketDecisionRecordRequest
  >["expectedSource"];
  authority: TicketDecisionAuthorityContext;
  decidedAt: string;
  prepared: {
    documentPath: string;
    decisionId: string;
    digest: string;
  };
  envelope: TicketDecisionAttestationEnvelope;
}

interface PendingRevocationCeremony extends PendingCeremonyBase {
  kind: "revocation";
  profile: TicketWebAuthnAuthorityProfileV1;
}

type PendingCeremony =
  | PendingEnrollmentCeremony
  | PendingDecisionCeremony
  | PendingRevocationCeremony;

export function parseTicketReviewHostFlags(
  argv: string[],
): TicketReviewHostLaunchFlags {
  let repo = process.cwd();
  let dbFlag: string | undefined;
  let port = 0;
  let open = true;
  let json = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag ?? "")) throw new Error(`repeated flag: ${flag}`);
    seen.add(flag ?? "");
    if (flag === "--repo" || flag === "--db" || flag === "--port") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--repo") repo = value;
      else if (flag === "--db") dbFlag = value;
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
  return {
    repo,
    db: resolveDbPath(dbFlag),
    port,
    open,
    json,
  };
}

export function launchTicketReviewHostCommand(argv: string[]): void {
  const flags = parseTicketReviewHostFlags(argv);
  const ticketWebAuthnAuthorityRegistry =
    new TicketWebAuthnAuthorityRegistry();
  const host = startTicketReviewHost({
    repoRoot: flags.repo,
    dbPath: flags.db,
    port: flags.port,
    ticketWebAuthnAuthorityRegistry,
  });
  void host.ready.then(({ url, origin, port }) => {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        schemaVersion: HOST_SCHEMA_VERSION,
        origin,
        port,
        opened: flags.open,
        ...(flags.open ? {} : { url }),
      })}\n`);
    } else {
      process.stdout.write(
        "Ticket graph is ready\n"
        + (flags.open
          ? "The local structured graph is opening in your browser.\n"
          : `${url}\nThe link is a short-lived local host capability; human Decisions still require an authenticator.\n`)
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
  if (
    options.ticketReviewAttribution !== undefined
    && options.ticketDecisionAuthority !== undefined
    && (
      options.ticketReviewAttribution.actorKind !== "human"
      || options.ticketReviewAttribution.actorId
        !== options.ticketDecisionAuthority.authority.principal_id
    )
  ) {
    throw new Error(
      "Ticket review attribution and Decision authority must bind the same human",
    );
  }
  if (
    options.ticketDecisionAuthority !== undefined
    && options.ticketWebAuthnAuthorityRegistry !== undefined
  ) {
    throw new Error(
      "Ticket review host must use either injected Decision authority or WebAuthn authority",
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  const runtime = openHostRuntime(options.repoRoot, options.dbPath, {
    ticketReviewAttribution: options.ticketReviewAttribution,
    ticketDecisionAuthority: options.ticketDecisionAuthority,
    ticketWebAuthnAuthorityRegistry:
      options.ticketWebAuthnAuthorityRegistry,
  });
  const assetRoot = options.assetRoot ?? defaultAssetRoot();
  assertAssets(assetRoot);
  const sessionId = crypto.randomUUID();
  const tokenExpiresAt = Date.now() + tokenLifetimeMs;
  let requestSequence = 0;
  let origin: string | null = null;
  let closed = false;
  const pendingCeremonies = new Map<string, PendingCeremony>();
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const hostActor = options.ticketReviewAttribution?.actorId
    ?? options.ticketDecisionAuthority?.authority.principal_id
    ?? "ticket-review-host";
  const operationContext = () => ({
    repoId: runtime.repoId,
    actor: hostActor,
    requestId: `ticket-review-host:${sessionId}:${++requestSequence}`,
    now: now(),
  });

  const readGraph = (): TicketReviewHostState => {
    const tickets = new Map<string, HostGraphNode>();
    const relations = new Map<string, HostGraphRelation>();
    let cursor: string | undefined;
    let first: GraphSnapshotPage | null = null;
    for (let page = 0; page < MAX_STATE_PAGES; page += 1) {
      const data = requireOperationData<GraphSnapshotPage>(
        runtime.dispatcher.dispatch(
          "ticket.graph.snapshot",
          operationContext(),
          {
            pageSize: TICKET_REVIEW_MAX_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        ),
      );
      if (first !== null && data.snapshotId !== first.snapshotId) {
        throw new HostHttpError(
          409,
          "snapshot_changed",
          "The Ticket graph changed while it was being read. Refresh the page.",
        );
      }
      first ??= data;
      for (const ticket of data.tickets) tickets.set(ticket.ticketId, ticket);
      for (const relation of data.relations) {
        relations.set(relation.relationRef, relation);
      }
      if (data.nextCursor === null) {
        return {
          schemaVersion: HOST_SCHEMA_VERSION,
          project: {
            name: path.basename(runtime.repositoryRoot),
            repositoryRoot: runtime.repositoryRoot,
            worktreeRoot: runtime.worktreeRoot,
            branch: data.source.branch ?? "detached",
          },
          graph: {
            snapshotId: data.snapshotId,
            source: data.source,
            tickets: [...tickets.values()],
            relations: [...relations.values()],
          },
          interventions: interventionCapabilities(
            options,
            data.source,
            tickets,
          ),
        };
      }
      cursor = data.nextCursor;
    }
    throw new HostHttpError(
      413,
      "graph_too_large",
      "The Ticket graph exceeded the review host page budget.",
    );
  };

  const inspectSubject = (url: URL): unknown => {
    const snapshotId = requiredQuery(url, "snapshotId");
    const kind = requiredQuery(url, "kind");
    const subject = kind === "graph"
      ? { kind }
      : kind === "ticket"
        ? { kind, ticketId: requiredQuery(url, "ticketId") }
        : kind === "relation"
          ? { kind, relationRef: requiredQuery(url, "relationRef") }
          : null;
    if (subject === null) {
      throw new HostHttpError(
        400,
        "invalid_subject",
        "Subject kind must be graph, ticket, or relation.",
      );
    }
    return requireOperationData(runtime.dispatcher.dispatch(
      "ticket.subject.inspect",
      operationContext(),
      { snapshotId, subject },
    ));
  };

  const listTrace = (url: URL): unknown => {
    const snapshotId = requiredQuery(url, "snapshotId");
    const kind = requiredQuery(url, "kind");
    const subject = kind === "graph"
      ? { kind }
      : kind === "ticket"
        ? { kind, ticketId: requiredQuery(url, "ticketId") }
        : kind === "relation"
          ? { kind, relationRef: requiredQuery(url, "relationRef") }
          : null;
    if (subject === null) {
      throw new HostHttpError(
        400,
        "invalid_subject",
        "Subject kind must be graph, ticket, or relation.",
      );
    }
    let cursor: string | undefined;
    let first: Record<string, unknown> | null = null;
    const records: unknown[] = [];
    for (let page = 0; page < MAX_TRACE_PAGES; page += 1) {
      const data = requireOperationData<Record<string, unknown>>(
        runtime.dispatcher.dispatch(
          "ticket.trace.list",
          operationContext(),
          {
            snapshotId,
            subject,
            limit: TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE,
            ...(cursor === undefined ? {} : { cursor }),
          },
        ),
      );
      if (data.snapshotId !== snapshotId) {
        throw new HostHttpError(
          409,
          "snapshot_changed",
          "The Ticket trace changed while it was being read. Refresh the page.",
        );
      }
      if (!Array.isArray(data.records)) {
        throw new HostHttpError(
          500,
          "invalid_trace_projection",
          "The Ticket trace projection returned invalid records.",
        );
      }
      first ??= data;
      records.push(...data.records);
      if (data.nextCursor === null) {
        return {
          ...first,
          records,
          page: {
            offset: 0,
            count: records.length,
            totalItems: records.length,
          },
          nextCursor: null,
        };
      }
      if (typeof data.nextCursor !== "string" || data.nextCursor.length === 0) {
        throw new HostHttpError(
          500,
          "invalid_trace_projection",
          "The Ticket trace projection returned an invalid cursor.",
        );
      }
      cursor = data.nextCursor;
    }
    throw new HostHttpError(
      413,
      "trace_too_large",
      "The Ticket trace exceeded the review host page budget.",
    );
  };

  const appendReview = (body: unknown): unknown => {
    if (options.ticketReviewAttribution?.actorKind !== "human") {
      throw new HostHttpError(
        409,
        "ticket_attribution_unavailable",
        "This Ticket host is read-only because no trusted human reviewer was bound.",
        null,
        ["Open the review surface from a plugin host with trusted attribution."],
      );
    }
    return requireOperationData(runtime.dispatcher.dispatch(
      "ticket.review.append",
      operationContext(),
      body,
    ));
  };

  const recordDecision = (body: unknown): unknown =>
    requireOperationData(runtime.dispatcher.dispatch(
      "ticket.decision.record",
      operationContext(),
      body,
    ));

  const requireWebAuthnRegistry =
    (): TicketWebAuthnAuthorityRegistryLike => {
      if (options.ticketWebAuthnAuthorityRegistry === undefined) {
        throw new HostHttpError(
          409,
          "ticket_webauthn_unavailable",
          "This Ticket host was not started with a WebAuthn authority registry.",
        );
      }
      return options.ticketWebAuthnAuthorityRegistry;
    };

  const requirePublicOrigin = (): string => {
    if (origin === null) {
      throw new HostHttpError(
        503,
        "host_not_ready",
        "The Ticket review host is not ready for a WebAuthn ceremony.",
      );
    }
    return origin;
  };

  const activeProfileForRepository = (
    repositoryIncarnation: string,
  ): TicketWebAuthnAuthorityProfileV1 | null => {
    const profiles = requireWebAuthnRegistry().listProfiles().filter(
      (profile) =>
        profile.repositoryIncarnation === repositoryIncarnation
        && profile.revokedAt === null,
    );
    if (profiles.length > 1) {
      throw new HostHttpError(
        409,
        "ticket_webauthn_authority_ambiguous",
        "More than one active WebAuthn authority is bound to this repository.",
        { profileIds: profiles.map((profile) => profile.profileId) },
        ["Revoke all but one authority before recording a Decision."],
      );
    }
    return profiles[0] ?? null;
  };

  const rememberCeremony = <T extends PendingCeremony>(
    ceremony: Omit<T, "ceremonyId" | "expiresAtEpochMs">,
  ): T => {
    pruneExpiredCeremonies(pendingCeremonies);
    const pending = {
      ...ceremony,
      ceremonyId: crypto.randomBytes(32).toString("base64url"),
      expiresAtEpochMs: Date.now() + CEREMONY_LIFETIME_MS,
    } as T;
    pendingCeremonies.set(pending.ceremonyId, pending);
    return pending;
  };

  const takeCeremony = <Kind extends PendingCeremony["kind"]>(
    ceremonyId: string,
    expectedKind: Kind,
  ): Extract<PendingCeremony, { kind: Kind }> => {
    const pending = pendingCeremonies.get(ceremonyId);
    pendingCeremonies.delete(ceremonyId);
    if (
      pending === undefined
      || pending.kind !== expectedKind
      || pending.expiresAtEpochMs <= Date.now()
    ) {
      throw new HostHttpError(
        409,
        "ticket_webauthn_ceremony_expired",
        "This one-use WebAuthn ceremony is unavailable or expired.",
        null,
        ["Refresh the current Ticket source and begin a new ceremony."],
      );
    }
    return pending as Extract<PendingCeremony, { kind: Kind }>;
  };

  const createEnrollmentChallenge = async (
    body: unknown,
  ): Promise<unknown> => {
    const input = enrollmentChallengeBody(body);
    const registry = requireWebAuthnRegistry();
    const snapshot = loadTicketLedgerFromWorktree(runtime.worktreeRoot);
    if (activeProfileForRepository(
      snapshot.source.repositoryIncarnation,
    ) !== null) {
      throw new HostHttpError(
        409,
        "ticket_webauthn_authority_exists",
        "This repository already has one active WebAuthn authority.",
      );
    }
    const issuedAt = requireInstant(now(), "host clock");
    const authorityBasis = "repository_owner" as const;
    const authorityRef =
      `vibehub:repository-owner:${snapshot.source.repositoryIncarnation}`;
    const challenge = hostCeremonyChallenge({
      kind: "ticket_authority_enrollment",
      principalId: input.principalId,
      authorityBasis,
      authorityRef,
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      origin: requirePublicOrigin(),
      issuedAt,
      nonce: crypto.randomBytes(32).toString("base64url"),
    });
    const pending = rememberCeremony<PendingEnrollmentCeremony>({
      kind: "enrollment",
      challenge,
      origin: requirePublicOrigin(),
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      principalId: input.principalId,
      authorityBasis,
      authorityRef,
    });
    const registrationOptions = await registry.createRegistrationOptions({
      principalId: pending.principalId,
      authorityBasis: pending.authorityBasis,
      authorityRef: pending.authorityRef,
      repositoryIncarnation: pending.repositoryIncarnation,
      challenge: pending.challenge,
      timeoutMs: WEBAUTHN_TIMEOUT_MS,
    });
    return {
      ceremonyId: pending.ceremonyId,
      options: registrationOptions,
    };
  };

  const completeEnrollment = async (body: unknown): Promise<unknown> => {
    const input = ceremonyCompletionBody(body);
    const pending = takeCeremony(input.ceremonyId, "enrollment");
    assertCeremonyRepository(runtime.worktreeRoot, pending);
    const profile = await requireWebAuthnRegistry().verifyRegistration({
      principalId: pending.principalId,
      authorityBasis: pending.authorityBasis,
      authorityRef: pending.authorityRef,
      repositoryIncarnation: pending.repositoryIncarnation,
      challenge: pending.challenge,
      origin: pending.origin,
      response: input.credential as unknown as Parameters<
        TicketWebAuthnAuthorityRegistryLike["verifyRegistration"]
      >[0]["response"],
    });
    return {
      authority: {
        profileId: profile.profileId,
        principalId: profile.principalId,
        credentialFingerprint: profile.keyFingerprint,
      },
    };
  };

  const createDecisionChallenge = async (
    body: unknown,
  ): Promise<unknown> => {
    const parsed = operationInputSchemas[
      "ticket.decision.record"
    ].safeParse(body);
    if (!parsed.success) {
      throw new HostHttpError(
        400,
        "validation_error",
        "The Ticket Decision request is invalid.",
        {
          issues: parsed.error.issues.slice(0, 16).map((issue) => ({
            path: issue.path.map(String),
            code: issue.code,
            message: issue.message,
          })),
        },
      );
    }
    const snapshot = loadTicketLedgerFromWorktree(runtime.worktreeRoot);
    const profile = activeProfileForRepository(
      snapshot.source.repositoryIncarnation,
    );
    if (profile === null) {
      throw new HostHttpError(
        409,
        "ticket_webauthn_authority_unenrolled",
        "Enroll one WebAuthn authority before recording a Ticket Decision.",
      );
    }
    const input = parsed.data as Record<string, unknown>;
    const request = ticketDecisionRecordRequest(input);
    const decidedAt = requireInstant(now(), "host clock");
    const authority = decisionAuthority(profile);
    const prepared = prepareTicketDecisionForSnapshot({
      snapshot,
      request,
      authority,
      decidedAt,
    });
    const envelope = decisionAttestationEnvelope({
      snapshot,
      profile,
      prepared,
      origin: requirePublicOrigin(),
      issuedAt: decidedAt,
    });
    const challenge = ticketDecisionAttestationChallenge(envelope);
    const pending = rememberCeremony<PendingDecisionCeremony>({
      kind: "decision",
      challenge,
      origin: requirePublicOrigin(),
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      profile,
      input,
      expectedSource: request.expectedSource,
      authority,
      decidedAt,
      prepared: {
        documentPath: prepared.documentPath,
        decisionId: prepared.document.decision_id,
        digest: prepared.digest,
      },
      envelope,
    });
    const authenticationOptions =
      await requireWebAuthnRegistry().createAuthenticationOptions({
        profileId: profile.profileId,
        challenge,
        timeoutMs: WEBAUTHN_TIMEOUT_MS,
      });
    return {
      ceremonyId: pending.ceremonyId,
      options: authenticationOptions,
    };
  };

  const completeDecision = async (body: unknown): Promise<unknown> => {
    const input = ceremonyCompletionBody(body);
    const pending = takeCeremony(input.ceremonyId, "decision");
    assertCeremonyRepository(runtime.worktreeRoot, pending);
    const presence =
      await requireWebAuthnRegistry().verifyAuthentication({
        profileId: pending.profile.profileId,
        challenge: pending.challenge,
        origin: pending.origin,
        response: input.credential as unknown as Parameters<
          TicketWebAuthnAuthorityRegistryLike["verifyAuthentication"]
        >[0]["response"],
      });
    assertVerifiedPresence(pending, presence);

    const grant: TicketDecisionAuthorityGrant = {
      authority: pending.authority,
      scopes: [decisionAuthorityScope(pending.envelope)],
    };
    const decisionDispatcher = new OperationDispatcher(runtime.db, {
      repoRoot: runtime.worktreeRoot,
      ticketDecisionAuthority: grant,
      ticketDecisionAttestationTrustProfiles:
        ticketDecisionAttestationTrustProfileResolver(
          requireWebAuthnRegistry(),
        ),
    });
    const decision = requireOperationData<{
      status: "applied" | "noop";
      before: Record<string, string>;
      after: Record<string, string>;
      changedPaths: string[];
      decision: {
        documentPath: string;
        document: TicketDecisionDocument;
      };
    }>(decisionDispatcher.dispatch(
      "ticket.decision.record",
      {
        repoId: runtime.repoId,
        actor: pending.profile.principalId,
        requestId:
          `ticket-review-host:${sessionId}:${++requestSequence}`,
        now: pending.decidedAt,
      },
      pending.input,
    ));
    if (
      decision.decision.documentPath !== pending.prepared.documentPath
      || decision.decision.document.decision_id
        !== pending.prepared.decisionId
      || ticketDecisionDocumentDigest(decision.decision.document)
        !== pending.prepared.digest
    ) {
      throw new HostHttpError(
        409,
        "ticket_decision_changed",
        "The exact Ticket Decision changed after human verification.",
      );
    }
    const attestation = appendTicketDecisionAttestation({
      worktreeRoot: runtime.worktreeRoot,
      request: {
        expectedSource: decision.after as {
          sourceToken: string;
          worktreeIdentity: string;
          resolvedCommit: string;
          graphDigest: string;
          semanticLedgerDigest: string;
        },
        attestation: {
          ...pending.envelope,
          webauthn: {
            ...pending.envelope.webauthn,
            client_data_json: presence.assertion.clientDataJSON,
            authenticator_data: presence.assertion.authenticatorData,
            signature: presence.assertion.signature,
          },
        },
      },
    });
    const changedPaths = [
      ...new Set([
        ...decision.changedPaths,
        ...attestation.changedPaths,
      ]),
    ];
    return {
      status:
        decision.status === "applied" || attestation.status === "applied"
          ? "applied"
          : "noop",
      before: decision.before,
      after: attestation.after,
      changedPaths,
      decision: decision.decision,
      attestation: attestation.attestation,
      checkpointSelection: {
        source: attestation.after,
        changedPaths,
      },
    };
  };

  const createRevocationChallenge = async (
    body: unknown,
  ): Promise<unknown> => {
    emptyBody(body, "WebAuthn authority revocation");
    const snapshot = loadTicketLedgerFromWorktree(runtime.worktreeRoot);
    const profile = activeProfileForRepository(
      snapshot.source.repositoryIncarnation,
    );
    if (profile === null) {
      throw new HostHttpError(
        409,
        "ticket_webauthn_authority_unenrolled",
        "This repository has no active WebAuthn authority to revoke.",
      );
    }
    const issuedAt = requireInstant(now(), "host clock");
    const challenge = hostCeremonyChallenge({
      kind: "ticket_authority_revocation",
      profileId: profile.profileId,
      credentialFingerprint: profile.keyFingerprint,
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      origin: requirePublicOrigin(),
      issuedAt,
      nonce: crypto.randomBytes(32).toString("base64url"),
    });
    const pending = rememberCeremony<PendingRevocationCeremony>({
      kind: "revocation",
      challenge,
      origin: requirePublicOrigin(),
      repositoryIncarnation: snapshot.source.repositoryIncarnation,
      profile,
    });
    const authenticationOptions =
      await requireWebAuthnRegistry().createAuthenticationOptions({
        profileId: profile.profileId,
        challenge,
        timeoutMs: WEBAUTHN_TIMEOUT_MS,
      });
    return {
      ceremonyId: pending.ceremonyId,
      options: authenticationOptions,
    };
  };

  const completeRevocation = async (body: unknown): Promise<unknown> => {
    const input = ceremonyCompletionBody(body);
    const pending = takeCeremony(input.ceremonyId, "revocation");
    assertCeremonyRepository(runtime.worktreeRoot, pending);
    const profile = await requireWebAuthnRegistry().revoke({
      profileId: pending.profile.profileId,
      challenge: pending.challenge,
      origin: pending.origin,
      response: input.credential as unknown as Parameters<
        TicketWebAuthnAuthorityRegistryLike["revoke"]
      >[0]["response"],
    });
    return {
      authority: {
        profileId: profile.profileId,
        principalId: profile.principalId,
        credentialFingerprint: profile.keyFingerprint,
        status: "revoked",
      },
    };
  };

  const server = http.createServer((request, response) => {
    void routeRequest({
      request,
      response,
      token,
      tokenExpiresAt,
      origin,
      assetRoot,
      readGraph,
      inspectSubject,
      listTrace,
      appendReview,
      recordDecision,
      createEnrollmentChallenge,
      completeEnrollment,
      createDecisionChallenge,
      completeDecision,
      createRevocationChallenge,
      completeRevocation,
    }).catch((error) => {
      writeError(response, error);
    });
  });
  const expiryTimer = setTimeout(() => {
    if (!closed) server.close();
  }, tokenLifetimeMs);
  server.on("close", () => {
    clearTimeout(expiryTimer);
    if (closed) return;
    closed = true;
    pendingCeremonies.clear();
    runtime.db.close();
    resolveClosed();
  });

  const ready = new Promise<{ origin: string; url: string; port: number }>(
    (resolve, reject) => {
      const fail = (error: Error): void => {
        server.off("listening", listening);
        if (!closed) {
          closed = true;
          clearTimeout(expiryTimer);
          pendingCeremonies.clear();
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
        // WebAuthn treats `localhost` as a secure-context RP ID. Keep the
        // socket bound to 127.0.0.1 while publishing the canonical localhost
        // origin used by every human-presence ceremony.
        origin = `http://localhost:${address.port}`;
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

function interventionCapabilities(
  options: Pick<
    TicketReviewHostOptions,
    | "ticketReviewAttribution"
    | "ticketDecisionAuthority"
    | "ticketWebAuthnAuthorityRegistry"
  >,
  source: TicketSourceMetadata,
  tickets: ReadonlyMap<string, HostGraphNode>,
): TicketReviewHostInterventions {
  const grant = options.ticketDecisionAuthority;
  const protectedBoundaries = grant?.scopes.flatMap((scope) => {
    if (scope.decisionType !== "protected_boundary") return [];
    const ticket = tickets.get(scope.ticketId);
    if (ticket?.ticketRevision !== scope.ticketRevision) return [];
    return [{
      ticketId: scope.ticketId,
      ticketRevision: scope.ticketRevision,
      boundary: scope.boundary,
    }];
  }) ?? [];
  let authority: TicketReviewHostAuthorityCapability = {
    status: "unavailable",
  };
  let webauthnPlanReview:
    | { available: false }
    | { available: true; ceremony: "webauthn" } = { available: false };
  let webauthnProtectedDecision:
    | { available: false }
    | { available: true; ceremony: "webauthn" } = { available: false };
  if (options.ticketWebAuthnAuthorityRegistry !== undefined) {
    try {
      const active = options.ticketWebAuthnAuthorityRegistry.listProfiles()
        .filter((profile) =>
          profile.repositoryIncarnation === source.repositoryIncarnation
          && profile.revokedAt === null);
      if (active.length === 0) {
        authority = { status: "unenrolled" };
      } else if (active.length === 1) {
        const profile = active[0]!;
        authority = {
          status: "active",
          profileId: profile.profileId,
          principalId: profile.principalId,
          credentialFingerprint: profile.keyFingerprint,
        };
        webauthnPlanReview = {
          available: true,
          ceremony: "webauthn",
        };
        webauthnProtectedDecision = {
          available: true,
          ceremony: "webauthn",
        };
      }
    } catch {
      // Invalid or unavailable external trust state fails closed.
    }
  }
  return {
    review: options.ticketReviewAttribution?.actorKind !== "human"
      ? { available: false }
      : {
          available: true,
          actorKind: options.ticketReviewAttribution.actorKind,
          attribution: options.ticketReviewAttribution.attribution,
        },
    planReview: grant?.scopes.some(
      (scope) =>
        scope.decisionType === "plan_review"
        && scope.graphDigest === source.graphDigest,
    )
      ? { available: true }
      : webauthnPlanReview,
    protectedDecision: webauthnProtectedDecision,
    protectedBoundaries,
    authority,
  };
}

function openHostRuntime(
  cwd: string,
  dbPath: string,
  trust: {
    ticketReviewAttribution?: TicketReviewHostAttribution;
    ticketDecisionAuthority?: TicketDecisionAuthorityGrant;
    ticketWebAuthnAuthorityRegistry?:
      TicketWebAuthnAuthorityRegistryLike;
  },
): HostRuntime {
  const session = GitFacade.sessionContextAt(cwd);
  const db = openDb(dbPath);
  return {
    db,
    dispatcher: new OperationDispatcher(db, {
      repoRoot: session.toplevel,
      ...(trust.ticketReviewAttribution === undefined
        ? {}
        : { ticketReviewAttribution: trust.ticketReviewAttribution }),
      ...(trust.ticketDecisionAuthority === undefined
        ? {}
        : { ticketDecisionAuthority: trust.ticketDecisionAuthority }),
      ...(trust.ticketWebAuthnAuthorityRegistry === undefined
        ? {}
        : {
            ticketDecisionAttestationTrustProfiles:
              ticketDecisionAttestationTrustProfileResolver(
                trust.ticketWebAuthnAuthorityRegistry,
              ),
          }),
    }),
    repoId: 1,
    repositoryRoot: session.repoRoot,
    worktreeRoot: session.toplevel,
  };
}

async function routeRequest(input: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  token: string;
  tokenExpiresAt: number;
  origin: string | null;
  assetRoot: string;
  readGraph: () => TicketReviewHostState;
  inspectSubject: (url: URL) => unknown;
  listTrace: (url: URL) => unknown;
  appendReview: (body: unknown) => unknown;
  recordDecision: (body: unknown) => unknown;
  createEnrollmentChallenge: (body: unknown) => Promise<unknown>;
  completeEnrollment: (body: unknown) => Promise<unknown>;
  createDecisionChallenge: (body: unknown) => Promise<unknown>;
  completeDecision: (body: unknown) => Promise<unknown>;
  createRevocationChallenge: (body: unknown) => Promise<unknown>;
  completeRevocation: (body: unknown) => Promise<unknown>;
}): Promise<void> {
  const {
    request,
    response,
    token,
    tokenExpiresAt,
    origin,
    assetRoot,
    readGraph,
    inspectSubject,
    listTrace,
    appendReview,
    recordDecision,
    createEnrollmentChallenge,
    completeEnrollment,
    createDecisionChallenge,
    completeDecision,
    createRevocationChallenge,
    completeRevocation,
  } = input;
  applySecurityHeaders(response);
  const url = new URL(request.url ?? "/", origin ?? "http://127.0.0.1");
  assertHost(request, origin);
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true, schemaVersion: HOST_SCHEMA_VERSION });
    return;
  }
  const asset = staticAsset(url.pathname);
  if (request.method === "GET" && asset !== null) {
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.contentType);
    response.end(fs.readFileSync(managedAssetPath(assetRoot, asset.file)));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (Date.now() >= tokenExpiresAt) {
      throw new HostHttpError(
        410,
        "session_expired",
        "This local Ticket capability expired. Start a new review host.",
      );
    }
    assertBearer(request, token);
    if (request.method === "GET" && url.pathname === "/api/state") {
      writeJson(response, 200, { ok: true, data: readGraph() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/subject") {
      writeJson(response, 200, { ok: true, data: inspectSubject(url) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/trace") {
      writeJson(response, 200, { ok: true, data: listTrace(url) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/review") {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, REVIEW_BODY_MAX_BYTES);
      writeJson(response, 200, { ok: true, data: appendReview(body) });
      return;
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/authority/enroll/challenge"
    ) {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, {
        ok: true,
        data: await createEnrollmentChallenge(body),
      });
      return;
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/authority/enroll/complete"
    ) {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, {
        ok: true,
        data: await completeEnrollment(body),
      });
      return;
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/decision/challenge"
    ) {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, {
        ok: true,
        data: await createDecisionChallenge(body),
      });
      return;
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/decision/complete"
    ) {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, {
        ok: true,
        data: await completeDecision(body),
      });
      return;
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/authority/revoke/challenge"
    ) {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, {
        ok: true,
        data: await createRevocationChallenge(body),
      });
      return;
    }
    if (
      request.method === "POST"
      && url.pathname === "/api/authority/revoke/complete"
    ) {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, {
        ok: true,
        data: await completeRevocation(body),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/decision") {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, { ok: true, data: recordDecision(body) });
      return;
    }
  }
  throw new HostHttpError(404, "not_found", "Route not found.");
}

function enrollmentChallengeBody(body: unknown): {
  principalId: string;
} {
  const value = plainObject(body, "WebAuthn enrollment request");
  assertExactKeys(value, ["principalId"], "WebAuthn enrollment request");
  const principalId = value.principalId;
  if (
    typeof principalId !== "string"
    || principalId.length === 0
    || principalId !== principalId.trim()
    || [...principalId].length > 256
  ) {
    throw new HostHttpError(
      400,
      "validation_error",
      "principalId must be non-empty trimmed text of at most 256 characters.",
    );
  }
  return { principalId };
}

function ceremonyCompletionBody(body: unknown): {
  ceremonyId: string;
  credential: Record<string, unknown>;
} {
  const value = plainObject(body, "WebAuthn ceremony completion");
  assertExactKeys(
    value,
    ["ceremonyId", "credential"],
    "WebAuthn ceremony completion",
  );
  if (
    typeof value.ceremonyId !== "string"
    || !/^[A-Za-z0-9_-]{32,128}$/u.test(value.ceremonyId)
  ) {
    throw new HostHttpError(
      400,
      "validation_error",
      "ceremonyId is invalid.",
    );
  }
  return {
    ceremonyId: value.ceremonyId,
    credential: plainObject(
      value.credential,
      "WebAuthn credential response",
    ),
  };
}

function emptyBody(body: unknown, label: string): void {
  const value = plainObject(body, label);
  assertExactKeys(value, [], label);
}

function plainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new HostHttpError(
      400,
      "validation_error",
      `${label} must be a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new HostHttpError(
      400,
      "validation_error",
      `${label} contains unsupported fields.`,
      { expectedFields: wanted, actualFields: actual },
    );
  }
}

function pruneExpiredCeremonies(
  ceremonies: Map<string, PendingCeremony>,
): void {
  const current = Date.now();
  for (const [ceremonyId, pending] of ceremonies) {
    if (pending.expiresAtEpochMs <= current) {
      ceremonies.delete(ceremonyId);
    }
  }
}

function requireInstant(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new HostHttpError(
      500,
      "invalid_host_clock",
      `${label} did not return a valid instant.`,
    );
  }
  return new Date(timestamp).toISOString();
}

function hostCeremonyChallenge(
  value: Readonly<Record<string, unknown>>,
): string {
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 1,
      ...value,
    }))
    .digest("base64url");
}

function decisionAuthority(
  profile: TicketWebAuthnAuthorityProfileV1,
): TicketDecisionAuthorityContext {
  return {
    principal_id: profile.principalId,
    principal_kind: "human",
    basis: profile.authorityBasis,
    basis_ref: profile.authorityRef,
    attestation: "host_bound_local",
  };
}

function decisionAttestationEnvelope(input: {
  snapshot: ReturnType<typeof loadTicketLedgerFromWorktree>;
  profile: TicketWebAuthnAuthorityProfileV1;
  prepared: ReturnType<typeof prepareTicketDecisionForSnapshot>;
  origin: string;
  issuedAt: string;
}): TicketDecisionAttestationEnvelope {
  if (input.snapshot.source.mode !== "worktree") {
    throw new HostHttpError(
      409,
      "ticket_source_not_worktree",
      "Durable Ticket Decision attestation requires a worktree source.",
    );
  }
  const document = input.prepared.document;
  const scope: TicketDecisionAttestationEnvelope["scope"] =
    document.decision_type === "plan_review"
      ? {
          scope_type: "plan_review",
          graph_digest: document.subject.graph_digest,
          disposition: document.disposition,
          ...(document.delegated_boundaries === undefined
            ? {}
            : {
                delegated_boundaries:
                  document.delegated_boundaries,
              }),
        }
      : {
          scope_type: "protected_boundary",
          ticket_id: document.subject.ticket_id,
          ticket_revision: document.subject.ticket_revision,
          boundary: document.boundary,
          disposition: document.disposition,
          ...(document.selection === undefined
            ? {}
            : { selection: document.selection }),
        };
  return {
    schema_version: 1,
    kind: "ticket_decision_attestation",
    decision: {
      decision_id: document.decision_id,
      document_path: input.prepared.documentPath,
      document_digest: input.prepared.digest,
    },
    authority: {
      principal_id: document.authority.principal_id,
      principal_kind: "human",
      basis: document.authority.basis,
      basis_ref: document.authority.basis_ref,
    },
    repository: {
      repository_incarnation:
        input.snapshot.source.repositoryIncarnation,
      repository_root: input.snapshot.source.repositoryRoot,
      worktree_identity: input.snapshot.source.worktreeIdentity,
      worktree_root: input.snapshot.source.worktreeRoot,
      checkout: input.snapshot.source.branch === null
        ? {
            mode: "detached",
            commit: input.snapshot.source.resolvedCommit,
          }
        : {
            mode: "branch",
            branch: input.snapshot.source.branch,
          },
    },
    scope,
    credential: {
      credential_id: input.profile.credentialId,
      fingerprint: input.profile.keyFingerprint,
    },
    webauthn: {
      rp_id: input.profile.rpId,
      origin: input.origin,
      algorithm: input.profile.algorithm,
    },
    nonce: crypto.randomBytes(32).toString("base64url"),
    issued_at: input.issuedAt,
    not_before: input.issuedAt,
    expires_at: new Date(
      Date.parse(input.issuedAt) + DECISION_ATTESTATION_LIFETIME_MS,
    ).toISOString(),
  };
}

function decisionAuthorityScope(
  envelope: TicketDecisionAttestationEnvelope,
): TicketDecisionAuthorityGrant["scopes"][number] {
  return envelope.scope.scope_type === "plan_review"
    ? {
        decisionType: "plan_review",
        graphDigest: `sha256:${envelope.scope.graph_digest}`,
      }
    : {
        decisionType: "protected_boundary",
        ticketId: envelope.scope.ticket_id,
        ticketRevision: `sha256:${envelope.scope.ticket_revision}`,
        boundary: envelope.scope.boundary,
      };
}

function assertCeremonyRepository(
  worktreeRoot: string,
  pending: PendingCeremony,
): void {
  const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
  if (
    snapshot.source.mode !== "worktree"
    || snapshot.source.repositoryIncarnation
      !== pending.repositoryIncarnation
  ) {
    throw new HostHttpError(
      409,
      "ticket_webauthn_repository_changed",
      "The repository identity changed during the WebAuthn ceremony.",
    );
  }
  if (pending.kind !== "decision") return;
  const actualSource = {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.source.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.source.semanticLedgerDigest}`,
  };
  if (
    Object.keys(actualSource).some((field) =>
      actualSource[field as keyof typeof actualSource]
      !== pending.expectedSource[
        field as keyof typeof pending.expectedSource
      ])
  ) {
    throw new HostHttpError(
      409,
      "ticket_ledger_stale_source",
      "The exact Ticket source changed during human verification.",
      { expected: pending.expectedSource, actual: actualSource },
      ["Refresh the graph and begin a new Decision ceremony."],
    );
  }
  const checkout = pending.envelope.repository.checkout;
  const checkoutMatches = checkout.mode === "branch"
    ? snapshot.source.branch === checkout.branch
    : snapshot.source.branch === null
      && snapshot.source.resolvedCommit === checkout.commit;
  if (
    !checkoutMatches
    || snapshot.source.repositoryRoot
      !== pending.envelope.repository.repository_root
    || snapshot.source.worktreeIdentity
      !== pending.envelope.repository.worktree_identity
    || snapshot.source.worktreeRoot
      !== pending.envelope.repository.worktree_root
  ) {
    throw new HostHttpError(
      409,
      "ticket_webauthn_checkout_changed",
      "The worktree or checkout changed during human verification.",
      null,
      ["Return to the reviewed worktree and begin a new Decision ceremony."],
    );
  }
}

function assertVerifiedPresence(
  pending: PendingDecisionCeremony,
  presence: TicketWebAuthnVerifiedPresenceV1,
): void {
  if (
    presence.challenge !== pending.challenge
    || presence.origin !== pending.origin
    || presence.userVerified !== true
    || presence.profile.profileId !== pending.profile.profileId
    || presence.profile.repositoryIncarnation
      !== pending.repositoryIncarnation
    || presence.profile.principalId !== pending.profile.principalId
    || presence.profile.authorityBasis !== pending.profile.authorityBasis
    || presence.profile.authorityRef !== pending.profile.authorityRef
    || presence.profile.credentialId !== pending.profile.credentialId
    || presence.profile.keyFingerprint !== pending.profile.keyFingerprint
    || presence.assertion.credentialId !== pending.profile.credentialId
  ) {
    throw new HostHttpError(
      409,
      "ticket_webauthn_identity_changed",
      "The verified WebAuthn authority did not match the prepared Decision.",
    );
  }
}

function requireOperationData<T = unknown>(result: OperationResult): T {
  if (result.ok) return result.data as T;
  throw new HostHttpError(
    operationStatus(result.error.code),
    result.error.code,
    result.error.message,
    result.error.details,
    result.error.nextSafeActions,
  );
}

function operationStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "validation_error" || code === "actor_required") return 400;
  if (code === "internal_error") return 500;
  return 409;
}

function requiredQuery(url: URL, field: string): string {
  const value = url.searchParams.get(field);
  if (value === null || value.length === 0 || value !== value.trim()) {
    throw new HostHttpError(
      400,
      "invalid_input",
      `${field} is required as trimmed text.`,
    );
  }
  return value;
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
  if (pathname === "/webauthn.js") {
    return {
      file: "webauthn.js",
      contentType: "text/javascript; charset=utf-8",
    };
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
      "The request was not addressed to this loopback Ticket host.",
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
      "Open the exact short-lived Ticket link printed by VibeHub.",
    );
  }
}

function assertOrigin(
  request: http.IncomingMessage,
  expectedOrigin: string | null,
): void {
  if (
    expectedOrigin === null
    || request.headers.origin !== expectedOrigin
  ) {
    throw new HostHttpError(
      403,
      "origin_rejected",
      "The write request did not originate from this Ticket review host.",
    );
  }
}

async function readJsonBody(
  request: http.IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new HostHttpError(
      415,
      "unsupported_media_type",
      "Ticket review writes require Content-Type: application/json.",
    );
  }
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      throw new HostHttpError(
        400,
        "invalid_content_length",
        "Content-Length must be a canonical non-negative integer.",
      );
    }
    if (Number(declaredLength) > maximumBytes) {
      throw new HostHttpError(
        413,
        "body_too_large",
        "The Ticket review write body exceeds the allowed size.",
      );
    }
  }
  const chunks: Buffer[] = [];
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (error: unknown): void => {
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.byteLength;
      if (received > maximumBytes) {
        fail(new HostHttpError(
          413,
          "body_too_large",
          "The Ticket review write body exceeds the allowed size.",
        ));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onAborted = (): void => {
      cleanup();
      reject(new HostHttpError(
        400,
        "request_aborted",
        "The Ticket review write request was aborted.",
      ));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HostHttpError(
      400,
      "malformed_json",
      "The Ticket review write body is not valid JSON.",
    );
  }
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
        nextSafeActions: error.nextSafeActions,
      },
    });
    return;
  }
  if (error instanceof TicketWebAuthnAuthorityError) {
    writeJson(
      response,
      error.code === "invalid_input" ? 400 : 409,
      {
        ok: false,
        error: {
          code: `ticket_webauthn_${error.code}`,
          message: error.message,
          details: null,
          nextSafeActions: [
            "Refresh the current Ticket source and begin a new ceremony.",
          ],
        },
      },
    );
    return;
  }
  if (error instanceof TicketLedgerError) {
    const status = error.code === "invalid_document"
      || error.code === "invalid_path"
      ? 400
      : error.code === "io" || error.code === "git_error"
        ? 500
        : 409;
    writeJson(response, status, {
      ok: false,
      error: {
        code: `ticket_ledger_${error.code}`,
        message: error.message,
        details: error.details,
        nextSafeActions: [
          "Refresh the current Ticket source and begin a new ceremony.",
        ],
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
    readonly nextSafeActions: readonly string[] = [],
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
  for (const file of ["index.html", "app.css", "app.js", "webauthn.js"]) {
    if (!fs.statSync(
      managedAssetPath(assetRoot, file),
      { throwIfNoEntry: false },
    )?.isFile()) {
      throw new Error(`Ticket review host asset is missing: ${file}`);
    }
  }
}

function managedAssetPath(assetRoot: string, file: string): string {
  const managed = path.join(assetRoot, file);
  if (
    file !== "webauthn.js"
    || fs.statSync(managed, { throwIfNoEntry: false })?.isFile()
  ) {
    return managed;
  }
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    moduleRoot,
    "../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js",
  );
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
