import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GitFacade,
  OperationDispatcher,
  TICKET_REVIEW_MAX_PAGE_SIZE,
  TICKET_REVIEW_MAX_RELATIONS,
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_TRACE_RECORDS,
  TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE,
  openDb,
  resolveDbPath,
  type Db,
  type OperationResult,
  type TicketDecisionAuthorityGrant,
  type TicketReviewHostAttribution,
  type TicketReviewSourceMetadataV0,
} from "@vw-ai/vibehub-core";

const LOOPBACK_HOST = "127.0.0.1";
const HOST_SCHEMA_VERSION = 2 as const;
const MAX_STATE_PAGES = Math.ceil(
  (TICKET_REVIEW_MAX_TICKETS + TICKET_REVIEW_MAX_RELATIONS)
    / TICKET_REVIEW_MAX_PAGE_SIZE,
);
const DEFAULT_TOKEN_LIFETIME_MS = 30 * 60 * 1_000;
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

interface TicketReviewHostInterventions {
  review: TicketReviewHostReviewCapability;
  planReview: { available: boolean };
  protectedBoundaries: Array<{
    ticketId: string;
    ticketRevision: string;
    boundary: string;
  }>;
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
  const host = startTicketReviewHost({
    repoRoot: flags.repo,
    dbPath: flags.db,
    port: flags.port,
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
          ? "The local read-only graph is opening in your browser.\n"
          : `${url}\nThe link is a short-lived local read capability.\n`)
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
  const now = options.now ?? (() => new Date().toISOString());
  const runtime = openHostRuntime(options.repoRoot, options.dbPath, {
    ticketReviewAttribution: options.ticketReviewAttribution,
    ticketDecisionAuthority: options.ticketDecisionAuthority,
  });
  const assetRoot = options.assetRoot ?? defaultAssetRoot();
  assertAssets(assetRoot);
  const sessionId = crypto.randomUUID();
  const tokenExpiresAt = Date.now() + tokenLifetimeMs;
  let requestSequence = 0;
  let origin: string | null = null;
  let closed = false;
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

function interventionCapabilities(
  options: Pick<
    TicketReviewHostOptions,
    "ticketReviewAttribution" | "ticketDecisionAuthority"
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
  return {
    review: options.ticketReviewAttribution?.actorKind !== "human"
      ? { available: false }
      : {
          available: true,
          actorKind: options.ticketReviewAttribution.actorKind,
          attribution: options.ticketReviewAttribution.attribution,
        },
    planReview: {
      available: grant?.scopes.some(
        (scope) =>
          scope.decisionType === "plan_review"
          && scope.graphDigest === source.graphDigest,
      ) ?? false,
    },
    protectedBoundaries,
  };
}

function openHostRuntime(
  cwd: string,
  dbPath: string,
  trust: {
    ticketReviewAttribution?: TicketReviewHostAttribution;
    ticketDecisionAuthority?: TicketDecisionAuthorityGrant;
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
    response.end(fs.readFileSync(path.join(assetRoot, asset.file)));
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
    if (request.method === "POST" && url.pathname === "/api/decision") {
      assertOrigin(request, origin);
      const body = await readJsonBody(request, DECISION_BODY_MAX_BYTES);
      writeJson(response, 200, { ok: true, data: recordDecision(body) });
      return;
    }
  }
  throw new HostHttpError(404, "not_found", "Route not found.");
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
