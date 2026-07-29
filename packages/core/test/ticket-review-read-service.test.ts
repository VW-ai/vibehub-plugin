import { describe, expect, it } from "vitest";
import {
  TicketReviewProjectionError,
  listTicketReviewTraceV0,
  projectTicketGraphSnapshotV0,
} from "../src/ticket-review-projector.js";
import { TicketReviewReadServiceV0 } from "../src/ticket-review-read-service.js";
import {
  type ResolvedTicketReviewProjectionSourceProviderV0,
  type TicketReviewRepositoryScopeV0,
} from "../src/ticket-review-resolver.js";
import {
  type TicketReviewProjectionSourceV0,
} from "../src/ticket-review-source.js";
import { ticketReviewV4Source } from "./fixtures/ticket-review-v4.js";

const scope: TicketReviewRepositoryScopeV0 = {
  repoId: 7,
  repositoryRoot: "/repo",
  worktreeRoot: "/repo",
};

function captureError(
  run: () => unknown,
  code: TicketReviewProjectionError["code"],
): TicketReviewProjectionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TicketReviewProjectionError);
    expect((error as TicketReviewProjectionError).code).toBe(code);
    return error as TicketReviewProjectionError;
  }
  throw new Error(`expected ${code}`);
}

function reconstructibleProvider(
  latest: unknown = ticketReviewV4Source,
  retained: unknown[] = [latest],
): ResolvedTicketReviewProjectionSourceProviderV0 {
  const sourcesBySnapshot = new Map(retained.map((source) => [
    projectTicketGraphSnapshotV0(source).snapshotId,
    source,
  ]));
  return {
    loadLatest: () => ({
      status: "available",
      source: structuredClone(latest),
    }),
    loadSnapshot: (_scope, snapshotId) => {
      const source = sourcesBySnapshot.get(snapshotId);
      return source === undefined
        ? { status: "snapshot_expired" }
        : { status: "available", source: structuredClone(source) };
    },
  };
}

describe("TicketReviewReadServiceV0", () => {
  it("loads the latest source once, then reconstructs exact snapshot pages", () => {
    const firstService = new TicketReviewReadServiceV0(
      reconstructibleProvider(),
    );
    const first = firstService.graphSnapshot(scope, { pageSize: 10 });

    expect(first.summary).toMatchObject({
      ticketCount: 29,
      directUnlockCount: 35,
    });
    expect(first.page).toEqual({ offset: 0, count: 10, totalItems: 64 });
    expect(first.nextCursor).not.toBeNull();

    const changed = structuredClone(ticketReviewV4Source);
    changed.projectionWatermark = "ticket-review-v4:watermark:later";
    // Distinct service and provider instances model a later CLI/MCP process.
    // Even though its latest graph changed, the provider reconstructs the
    // cursor's retained source rather than retaining projector state.
    const secondService = new TicketReviewReadServiceV0(
      reconstructibleProvider(changed, [ticketReviewV4Source, changed]),
    );
    const second = secondService.graphSnapshot(scope, {
      pageSize: 10,
      cursor: first.nextCursor,
    });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.page).toEqual({ offset: 10, count: 10, totalItems: 64 });
  });

  it("uses the exact snapshot source for inspection and trace reads", () => {
    const service = new TicketReviewReadServiceV0(
      reconstructibleProvider(),
    );
    const snapshot = service.graphSnapshot(scope);
    const inspection = service.subjectInspect(scope, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    const traces = service.traceList(scope, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });

    expect(inspection.snapshotId).toBe(snapshot.snapshotId);
    expect(inspection.subject).toMatchObject({
      kind: "ticket",
      ticket: { ticketId: "TKT-124" },
    });
    expect(traces).toMatchObject({
      snapshotId: snapshot.snapshotId,
      records: [],
    });
  });

  it("fails closed when no canonical graph or exact snapshot exists", () => {
    const noGraph = new TicketReviewReadServiceV0({
      loadLatest: () => ({ status: "no_ticket_graph" }),
      loadSnapshot: () => ({ status: "snapshot_expired" }),
    });

    expect(captureError(
      () => noGraph.graphSnapshot(scope),
      "not_found",
    ).details).toEqual({ repoId: 7 });
    expect(captureError(
      () => noGraph.subjectInspect(scope, {
        snapshotId: "tgs-unavailable",
        subject: { kind: "ticket", ticketId: "TKT-124" },
      }),
      "snapshot_expired",
    ).details).toEqual({
      repoId: 7,
      snapshotId: "tgs-unavailable",
    });
  });

  it("validates selectors before consulting the provider", () => {
    let calls = 0;
    const service = new TicketReviewReadServiceV0({
      loadLatest: () => {
        calls += 1;
        return { status: "no_ticket_graph" };
      },
      loadSnapshot: () => {
        calls += 1;
        return { status: "snapshot_expired" };
      },
    });

    captureError(
      () => service.graphSnapshot(scope, { pageSize: 0 }),
      "validation_error",
    );
    captureError(
      () => service.graphSnapshot(scope, { cursor: "not-base64-json" }),
      "validation_error",
    );
    captureError(
      () => service.subjectInspect(scope, {
        snapshotId: " tgs-padded ",
        subject: { kind: "ticket", ticketId: "TKT-124" },
      }),
      "validation_error",
    );
    expect(calls).toBe(0);
  });

  it("validates trace cursor encoding and scope before source access", () => {
    const source: TicketReviewProjectionSourceV0 =
      structuredClone(ticketReviewV4Source);
    source.traceRecords.push(
      {
        recordRef: "trace:cursor:2",
        kind: "evidence",
        subject: {
          kind: "ticket",
          ticketId: "TKT-124",
          boundDefinitionRevision: 1,
        },
        producer: { kind: "system", ref: "fixture-system" },
        occurredAt: "2026-07-28T12:00:01.000Z",
        summary: "Second trace record",
        crossReferences: [],
        targets: [],
        availability: "available",
      },
      {
        recordRef: "trace:cursor:1",
        kind: "evidence",
        subject: {
          kind: "ticket",
          ticketId: "TKT-124",
          boundDefinitionRevision: 1,
        },
        producer: { kind: "system", ref: "fixture-system" },
        occurredAt: "2026-07-28T12:00:00.000Z",
        summary: "First trace record",
        crossReferences: [],
        targets: [],
        availability: "available",
      },
    );
    const snapshot = projectTicketGraphSnapshotV0(source);
    const first = listTicketReviewTraceV0(source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
      limit: 1,
    });
    if (!first.nextCursor) throw new Error("fixture must produce a cursor");

    let calls = 0;
    const service = new TicketReviewReadServiceV0({
      loadLatest: () => {
        calls += 1;
        return { status: "no_ticket_graph" };
      },
      loadSnapshot: () => {
        calls += 1;
        return { status: "snapshot_expired" };
      },
    });
    const common = {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket" as const, ticketId: "TKT-124" },
      limit: 1,
    };

    captureError(
      () => service.traceList(scope, {
        ...common,
        cursor: "not-base64-json",
      }),
      "validation_error",
    );
    captureError(
      () => service.traceList(scope, {
        ...common,
        snapshotId: "tgs-another-snapshot",
        cursor: first.nextCursor,
      }),
      "validation_error",
    );
    captureError(
      () => service.traceList(scope, {
        ...common,
        subject: { kind: "ticket", ticketId: "TKT-126" },
        cursor: first.nextCursor,
      }),
      "validation_error",
    );
    expect(calls).toBe(0);
  });

  it("does not accept a latest source as a substitute for a bound snapshot", () => {
    const original = projectTicketGraphSnapshotV0(
      ticketReviewV4Source,
      { pageSize: 1 },
    );
    if (!original.nextCursor) throw new Error("fixture must produce a cursor");
    const changed = structuredClone(ticketReviewV4Source);
    changed.projectionWatermark = "ticket-review-v4:watermark:changed";
    const service = new TicketReviewReadServiceV0({
      loadLatest: () => ({ status: "available", source: changed }),
      loadSnapshot: () => ({ status: "available", source: changed }),
    });

    const attempts = [
      () => service.graphSnapshot(scope, {
        pageSize: 1,
        cursor: original.nextCursor,
      }),
      () => service.subjectInspect(scope, {
        snapshotId: original.snapshotId,
        subject: { kind: "ticket", ticketId: "TKT-124" },
      }),
      () => service.traceList(scope, {
        snapshotId: original.snapshotId,
        subject: { kind: "ticket", ticketId: "TKT-124" },
      }),
    ];
    for (const attempt of attempts) {
      const error = captureError(attempt, "snapshot_expired");
      expect(error.details).toMatchObject({
        snapshotId: original.snapshotId,
        cause: "resolved_source_does_not_match_snapshot",
      });
    }
  });

  it("rejects malformed provider result envelopes as source invariants", () => {
    const service = new TicketReviewReadServiceV0({
      loadLatest: (() => ({
        status: "available",
        source: ticketReviewV4Source,
        fallback: true,
      })) as ResolvedTicketReviewProjectionSourceProviderV0["loadLatest"],
      loadSnapshot: () => ({ status: "snapshot_expired" }),
    });

    const error = captureError(
      () => service.graphSnapshot(scope),
      "projection_invariant_failed",
    );
    expect(error.details).toEqual({
      cause: "source_provider_contract_violation",
      operation: "loadLatest",
      receivedStatus: "available",
    });
  });

  it("reports malformed provider sources as source invariants, not input errors", () => {
    const service = new TicketReviewReadServiceV0({
      loadLatest: () => ({ status: "available", source: null }),
      loadSnapshot: () => ({ status: "snapshot_expired" }),
    });

    const error = captureError(
      () => service.graphSnapshot(scope),
      "projection_invariant_failed",
    );
    expect(error.details).toMatchObject({
      cause: "source_contract_violation",
    });
  });

  it("rejects malformed exact-snapshot provider envelopes", () => {
    const snapshot = projectTicketGraphSnapshotV0(ticketReviewV4Source);
    const service = new TicketReviewReadServiceV0({
      loadLatest: () => ({ status: "no_ticket_graph" }),
      loadSnapshot: (() => ({
        status: "available",
      })) as unknown as
        ResolvedTicketReviewProjectionSourceProviderV0["loadSnapshot"],
    });

    const error = captureError(
      () => service.subjectInspect(scope, {
        snapshotId: snapshot.snapshotId,
        subject: { kind: "ticket", ticketId: "TKT-124" },
      }),
      "projection_invariant_failed",
    );
    expect(error.details).toEqual({
      cause: "source_provider_contract_violation",
      operation: "loadSnapshot",
      receivedStatus: "available",
    });
  });

  it("forwards repository scope and requires provider-partitioned snapshots", () => {
    const snapshot = projectTicketGraphSnapshotV0(ticketReviewV4Source);
    const scopeKey = (value: TicketReviewRepositoryScopeV0): string =>
      JSON.stringify([
        value.repoId,
        value.repositoryRoot,
        value.worktreeRoot,
      ]);
    const sourceByScope = new Map([
      [scopeKey(scope), ticketReviewV4Source],
    ]);
    const seen: TicketReviewRepositoryScopeV0[] = [];
    const service = new TicketReviewReadServiceV0({
      loadLatest: (requestedScope) => {
        seen.push(requestedScope);
        const source = sourceByScope.get(scopeKey(requestedScope));
        return source
          ? { status: "available", source }
          : { status: "no_ticket_graph" };
      },
      loadSnapshot: (requestedScope, snapshotId) => {
        seen.push(requestedScope);
        const source = sourceByScope.get(scopeKey(requestedScope));
        return source
          && projectTicketGraphSnapshotV0(source).snapshotId === snapshotId
          ? { status: "available", source }
          : { status: "snapshot_expired" };
      },
    });
    const otherScope: TicketReviewRepositoryScopeV0 = {
      repoId: 8,
      repositoryRoot: "/other-repo",
      worktreeRoot: "/other-repo",
    };

    expect(service.graphSnapshot(scope).snapshotId).toBe(snapshot.snapshotId);
    captureError(
      () => service.subjectInspect(otherScope, {
        snapshotId: snapshot.snapshotId,
        subject: { kind: "ticket", ticketId: "TKT-124" },
      }),
      "snapshot_expired",
    );
    expect(seen).toEqual([scope, otherScope]);
  });
});
