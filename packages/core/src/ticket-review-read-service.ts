import { type ZodType } from "zod";
import {
  type TicketGraphSnapshotPageV0,
  type TicketGraphSnapshotRequestV0,
  type TicketSubjectInspectionV0,
  type TicketSubjectInspectRequestV0,
  type TicketTraceListPageV0,
  type TicketTraceListRequestV0,
} from "./contract/ticket-review.js";
import {
  ticketGraphSnapshotRequestV0Schema,
  ticketSubjectInspectRequestV0Schema,
  ticketTraceListRequestV0Schema,
} from "./contract/ticket-review-schemas.js";
import {
  TicketReviewProjectionError,
  inspectTicketReviewSubjectV0,
  listTicketReviewTraceV0,
  projectTicketGraphSnapshotV0,
  readTicketGraphCursorSnapshotIdV0,
  validateTicketTraceCursorSelectorsV0,
} from "./ticket-review-projector.js";
import {
  type ResolvedTicketReviewProjectionSourceProviderV0,
  type TicketReviewLatestSourceLoadV0,
  type TicketReviewRepositoryScopeV0,
  type TicketReviewSnapshotSourceLoadV0,
} from "./ticket-review-resolver.js";

/**
 * Stateless Core orchestration for the three frozen Ticket Review V0 reads.
 *
 * The service chooses only *which already-resolved source* to request. All
 * source validation, graph invariants, deterministic ordering, projection, and
 * snapshot binding remain in the pure projector.
 */
export class TicketReviewReadServiceV0 {
  constructor(
    private readonly provider:
    ResolvedTicketReviewProjectionSourceProviderV0,
  ) {}

  graphSnapshot(
    scope: TicketReviewRepositoryScopeV0,
    input: unknown = {},
  ): TicketGraphSnapshotPageV0 {
    const request = parseRequest(
      ticketGraphSnapshotRequestV0Schema,
      input,
      "ticket.graph.snapshot input",
    );
    const snapshotId = readTicketGraphCursorSnapshotIdV0(request);
    const source = snapshotId === null
      ? latestSource(this.provider.loadLatest(scope), scope)
      : snapshotSource(
          this.provider.loadSnapshot(scope, snapshotId),
          scope,
          snapshotId,
        );
    return snapshotId === null
      ? projectTicketGraphSnapshotV0(source, request)
      : projectExactSnapshot(
          scope,
          snapshotId,
          () => projectTicketGraphSnapshotV0(source, request),
        );
  }

  subjectInspect(
    scope: TicketReviewRepositoryScopeV0,
    input: unknown,
  ): TicketSubjectInspectionV0 {
    const request = parseRequest(
      ticketSubjectInspectRequestV0Schema,
      input,
      "ticket.subject.inspect input",
    );
    const source = snapshotSource(
      this.provider.loadSnapshot(scope, request.snapshotId),
      scope,
      request.snapshotId,
    );
    return projectExactSnapshot(
      scope,
      request.snapshotId,
      () => inspectTicketReviewSubjectV0(source, request),
    );
  }

  traceList(
    scope: TicketReviewRepositoryScopeV0,
    input: unknown,
  ): TicketTraceListPageV0 {
    const request = parseRequest(
      ticketTraceListRequestV0Schema,
      input,
      "ticket.trace.list input",
    );
    validateTicketTraceCursorSelectorsV0(request);
    const source = snapshotSource(
      this.provider.loadSnapshot(scope, request.snapshotId),
      scope,
      request.snapshotId,
    );
    return projectExactSnapshot(
      scope,
      request.snapshotId,
      () => listTicketReviewTraceV0(source, request),
    );
  }
}

function parseRequest<T>(
  schema: ZodType<T>,
  value: unknown,
  scope: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new TicketReviewProjectionError("validation_error", `invalid ${scope}`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function latestSource(
  load: TicketReviewLatestSourceLoadV0,
  scope: TicketReviewRepositoryScopeV0,
): unknown {
  if (isExactProviderEnvelope(load, "available", ["source"])) {
    return (load as unknown as { source: unknown }).source;
  }
  if (isExactProviderEnvelope(load, "no_ticket_graph")) {
    throw new TicketReviewProjectionError(
      "not_found",
      "the repository has no canonical Ticket graph to review",
      { worktreeRoot: scope.worktreeRoot },
    );
  }
  return invalidProviderResult("loadLatest", load);
}

function snapshotSource(
  load: TicketReviewSnapshotSourceLoadV0,
  scope: TicketReviewRepositoryScopeV0,
  snapshotId: string,
): unknown {
  if (isExactProviderEnvelope(load, "available", ["source"])) {
    return (load as unknown as { source: unknown }).source;
  }
  if (isExactProviderEnvelope(load, "snapshot_expired")) {
    throw new TicketReviewProjectionError(
      "snapshot_expired",
      "the bound Ticket review snapshot can no longer be reconstructed",
      { worktreeRoot: scope.worktreeRoot, snapshotId },
    );
  }
  return invalidProviderResult("loadSnapshot", load);
}

function projectExactSnapshot<T>(
  scope: TicketReviewRepositoryScopeV0,
  snapshotId: string,
  project: () => T,
): T {
  try {
    return project();
  } catch (error) {
    if (!(error instanceof TicketReviewProjectionError)
      || error.code !== "invalid_snapshot") {
      throw error;
    }
    throw new TicketReviewProjectionError(
      "snapshot_expired",
      "the bound Ticket review snapshot can no longer be reconstructed",
      {
        worktreeRoot: scope.worktreeRoot,
        snapshotId,
        cause: "resolved_source_does_not_match_snapshot",
      },
    );
  }
}

function isExactProviderEnvelope(
  value: unknown,
  status: string,
  fields: string[] = [],
): value is Record<string, unknown> & { status: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["status", ...fields].sort();
  const actualKeys = Object.keys(record).sort();
  return record["status"] === status
    && actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function invalidProviderResult(
  operation: "loadLatest" | "loadSnapshot",
  value: unknown,
): never {
  const status = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    ? (value as Record<string, unknown>)["status"]
    : undefined;
  throw new TicketReviewProjectionError(
    "projection_invariant_failed",
    "Ticket review source provider returned an invalid result envelope",
    {
      cause: "source_provider_contract_violation",
      operation,
      receivedStatus: typeof status === "string" ? status : null,
    },
  );
}
