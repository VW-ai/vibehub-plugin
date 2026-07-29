import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_MAX_TRACE_RECORDS,
  type TicketReviewTraceRecordV0,
} from "../src/contract/ticket-review.js";
import {
  ticketGraphSnapshotPageV0Schema,
  ticketGraphSnapshotRequestV0Schema,
  ticketSubjectInspectionV0Schema,
  ticketTraceListPageV0Schema,
} from "../src/contract/ticket-review-schemas.js";
import {
  TicketReviewProjectionError,
  inspectTicketReviewSubjectV0,
  listTicketReviewTraceV0,
  projectTicketGraphSnapshotV0,
  type TicketReviewProjectionErrorCode,
} from "../src/ticket-review-projector.js";
import {
  type TicketReviewCurrentCapabilityProjectionV0,
  type TicketReviewProjectionSourceV0,
} from "../src/ticket-review-source.js";
import { ticketReviewV4Source } from "./fixtures/ticket-review-v4.js";

const AT = "2026-07-28T12:00:00-07:00";
const REVISION_A = `sha256:${"c".repeat(64)}`;
const REVISION_B = `sha256:${"d".repeat(64)}`;
const REVISION_C = `sha256:${"e".repeat(64)}`;

function cloneSource(): TicketReviewProjectionSourceV0 {
  return structuredClone(ticketReviewV4Source);
}

function captureError(
  run: () => unknown,
  code: TicketReviewProjectionErrorCode,
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

function makeTicketTrace(
  overrides: Partial<TicketReviewTraceRecordV0> = {},
): TicketReviewTraceRecordV0 {
  return {
    recordRef: "trace:ticket",
    kind: "evidence",
    subject: {
      kind: "ticket",
      ticketId: "TKT-124",
      boundTicketRevision: REVISION_A,
    },
    producer: { kind: "system", ref: "fixture-system" },
    occurredAt: AT,
    summary: "Inspectable evidence",
    crossReferences: [],
    targets: [],
    availability: "available",
    ...overrides,
  };
}

function makeRelationTrace(
  source: TicketReviewProjectionSourceV0,
  relationIndex = 0,
): TicketReviewTraceRecordV0 {
  const relation = source.directUnlocks[relationIndex]!;
  return {
    recordRef: `trace:relation:${relationIndex}`,
    kind: "evidence",
    subject: {
      kind: "relation",
      sourceRevision: source.snapshotRevision,
      relationRef: relation.relationRef,
      prerequisiteTicketId: relation.prerequisiteTicketId,
      dependentTicketId: relation.dependentTicketId,
    },
    producer: { kind: "system", ref: "fixture-system" },
    occurredAt: AT,
    summary: "Relation-bound evidence",
    crossReferences: [],
    targets: [],
    availability: "available",
  };
}

function makeTicketValidationProjection(
  source: TicketReviewProjectionSourceV0,
  producerReceiptRef = "receipt:TKT-124:validation",
): TicketReviewCurrentCapabilityProjectionV0 {
  return {
    producerReceiptRef,
    producedAt: AT,
    snapshotRevision: source.snapshotRevision,
    projectionWatermark: source.projectionWatermark,
    producer: {
      kind: "validator",
      id: "fixture-validator",
      version: "1",
    },
    subject: {
      kind: "ticket",
      ticketId: "TKT-124",
      ticketRevision: REVISION_A,
    },
    capability: "validation",
    summary: {
      label: "Validation passed",
      detail: "The current Ticket revision passed its observable checks.",
      references: [],
    },
  };
}

function makeRelationAttentionProjection(
  source: TicketReviewProjectionSourceV0,
  relationIndex = 9,
): TicketReviewCurrentCapabilityProjectionV0 {
  const relation = source.directUnlocks[relationIndex]!;
  return {
    producerReceiptRef: `receipt:${relation.relationRef}:attention`,
    producedAt: AT,
    snapshotRevision: source.snapshotRevision,
    projectionWatermark: source.projectionWatermark,
    producer: {
      kind: "skill",
      id: "fixture-attention-skill",
      version: "1",
    },
    subject: {
      kind: "relation",
      relationRef: relation.relationRef,
      prerequisiteTicketId: relation.prerequisiteTicketId,
      dependentTicketId: relation.dependentTicketId,
    },
    capability: "attention",
    summary: {
      label: "Review this unlock",
      references: [],
    },
  };
}

function reverseInsertionOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseInsertionOrder).reverse();
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nested]) => [key, reverseInsertionOrder(nested)]),
    );
  }
  return value;
}

describe("Ticket review contracts", () => {
  it("keeps browser DTOs dependency-free and runtime schemas opt-in", () => {
    const dtoSource = readFileSync(
      new URL("../src/contract/ticket-review.ts", import.meta.url),
      "utf8",
    );
    const contractBarrelSource = readFileSync(
      new URL("../src/contract/index.ts", import.meta.url),
      "utf8",
    );

    expect(dtoSource).not.toMatch(/^\s*import\s/m);
    expect(dtoSource).not.toMatch(/\b(?:zod|node:)/);
    expect(contractBarrelSource).toMatch(
      /export \* from ["']\.\/ticket-review\.js["']/,
    );
    expect(contractBarrelSource).not.toMatch(/ticket-review-schemas/);
  });

  it("accepts the three frozen read shapes and rejects hidden graph semantics", () => {
    expect(ticketGraphSnapshotRequestV0Schema.safeParse({ pageSize: 200 }).success)
      .toBe(true);
    expect(ticketGraphSnapshotRequestV0Schema.safeParse({
      rootTicketId: "TKT-001",
    }).success).toBe(false);
    expect(ticketGraphSnapshotRequestV0Schema.safeParse({
      atGraphRevision: 7,
    }).success).toBe(false);
  });

  it.each([
    "state",
    "maturity",
    "progress",
    "proof",
    "scenario",
    "reviewLens",
    "x",
    "y",
    "layout",
  ])("rejects authored prototype field %s at the source boundary", (field) => {
    const source = cloneSource() as unknown as Record<string, unknown>;
    const ticketDefinitions =
      source["ticketDefinitions"] as Array<Record<string, unknown>>;
    ticketDefinitions[0] = { ...ticketDefinitions[0], [field]: "forbidden" };
    const error = captureError(
      () => projectTicketGraphSnapshotV0(source),
      "projection_invariant_failed",
    );
    expect(error.details).toMatchObject({ cause: "source_contract_violation" });
    expect(JSON.stringify(error.details)).toContain(field);
  });

  it("rejects producer/capability family mismatches and legacy summaries", () => {
    const validatorRuntimeCapability = cloneSource();
    const semanticProjection =
      makeTicketValidationProjection(validatorRuntimeCapability);
    (validatorRuntimeCapability.currentCapabilityProjections as unknown[])
      .push({
        ...semanticProjection,
        capability: "operational",
      });
    captureError(
      () => projectTicketGraphSnapshotV0(validatorRuntimeCapability),
      "projection_invariant_failed",
    );

    const runtimeSemanticCapability = cloneSource();
    (runtimeSemanticCapability.currentCapabilityProjections as unknown[])
      .push({
        ...makeTicketValidationProjection(runtimeSemanticCapability),
        producer: {
          kind: "runtime",
          id: "fixture-runtime",
          version: "1",
        },
      });
    captureError(
      () => projectTicketGraphSnapshotV0(runtimeSemanticCapability),
      "projection_invariant_failed",
    );

    const legacySummary = cloneSource();
    (legacySummary.currentCapabilityProjections as unknown[]).push({
      ...makeTicketValidationProjection(legacySummary),
      summary: { result: "passed" },
    });
    captureError(
      () => projectTicketGraphSnapshotV0(legacySummary),
      "projection_invariant_failed",
    );
  });
});

describe("Ticket review projector", () => {
  it("projects the accepted v4 graph honestly with unavailable semantic slots", () => {
    const snapshot = projectTicketGraphSnapshotV0(ticketReviewV4Source);

    expect(snapshot.summary).toMatchObject({
      ticketCount: 29,
      directUnlockCount: 35,
      activeRuns: { availability: "unavailable" },
      needsActor: { availability: "unavailable" },
    });
    expect(snapshot.page).toEqual({
      offset: 0,
      count: 64,
      totalItems: 64,
    });
    expect(snapshot.tickets).toHaveLength(29);
    expect(snapshot.relations).toHaveLength(35);
    expect(snapshot.lenses).toEqual({ availability: "unavailable" });
    expect(snapshot.nextCursor).toBeNull();
    expect(snapshot.topologyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ticketGraphSnapshotPageV0Schema.safeParse(snapshot).success)
      .toBe(true);
    expect(snapshot.tickets.every((ticket) =>
      Object.values(ticket.capabilities).every(
        (slot) => slot.availability === "unavailable",
      ))).toBe(true);
    expect(JSON.stringify(snapshot))
      .not.toMatch(/"proof"|"reviewLens"|"layout"|"x"|"y"/);

    const ticket = inspectTicketReviewSubjectV0(ticketReviewV4Source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    expect(ticketSubjectInspectionV0Schema.safeParse(ticket).success)
      .toBe(true);
    expect(ticket.subject).toMatchObject({
      kind: "ticket",
      ticket: { ticketId: "TKT-124", ticketRevision: REVISION_A },
    });

    const relation = inspectTicketReviewSubjectV0(ticketReviewV4Source, {
      snapshotId: snapshot.snapshotId,
      subject: {
        kind: "relation",
        relationRef: "ticket-review-v4:direct-unlock:10",
      },
    });
    expect(relation.subject).toMatchObject({
      kind: "relation",
      relation: {
        prerequisiteTicketId: "TKT-124",
        dependentTicketId: "TKT-126",
      },
    });

    const traces = listTicketReviewTraceV0(ticketReviewV4Source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    expect(traces.records).toEqual([]);
    expect(ticketTraceListPageV0Schema.safeParse(traces).success).toBe(true);
  });

  it("is byte-stable across all set permutations and object insertion orders", () => {
    const source = cloneSource();
    source.ticketDefinitions[0]!.provenanceRefs = ["provenance:z", "provenance:a"];
    source.directUnlocks[0]!.provenanceRefs = ["provenance:y", "provenance:b"];
    const validation = makeTicketValidationProjection(source);
    validation.summary.references = [
      { ref: "evidence:z", label: "Last" },
      { ref: "evidence:a", label: "First" },
    ];
    source.currentCapabilityProjections.push(validation);
    source.traceRecords.push(makeTicketTrace({
      recordRef: "trace:determinism",
      crossReferences: ["cross:z", "cross:a"],
      targets: [
        { kind: "opaque", label: "Opaque", target: "artifact:z" },
        {
          kind: "url",
          label: "Evidence",
          target: "https://example.com/evidence",
        },
        {
          kind: "repo_path",
          label: "Source",
          target: "packages/core/src/index.ts",
        },
      ],
    }));
    const permuted = reverseInsertionOrder(
      structuredClone(source),
    ) as TicketReviewProjectionSourceV0;

    const first = projectTicketGraphSnapshotV0(source);
    const second = projectTicketGraphSnapshotV0(permuted);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const firstInspection = inspectTicketReviewSubjectV0(source, {
      snapshotId: first.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    const secondInspection = inspectTicketReviewSubjectV0(permuted, {
      snapshotId: second.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    expect(JSON.stringify(secondInspection))
      .toBe(JSON.stringify(firstInspection));

    const firstTrace = listTicketReviewTraceV0(source, {
      snapshotId: first.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    const secondTrace = listTicketReviewTraceV0(permuted, {
      snapshotId: second.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    expect(JSON.stringify(secondTrace)).toBe(JSON.stringify(firstTrace));
  });

  it("uses a snapshot-bound, process-independent cursor for complete transport paging", () => {
    const accumulatedTickets: string[] = [];
    const accumulatedRelations: string[] = [];
    let cursor: string | undefined;
    let snapshotId: string | undefined;
    do {
      const page = projectTicketGraphSnapshotV0(ticketReviewV4Source, {
        pageSize: 10,
        ...(cursor ? { cursor } : {}),
      });
      snapshotId ??= page.snapshotId;
      expect(page.snapshotId).toBe(snapshotId);
      accumulatedTickets.push(
        ...page.tickets.map((ticket) => ticket.ticketId),
      );
      accumulatedRelations.push(
        ...page.relations.map((relation) => relation.relationRef),
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(accumulatedTickets).toHaveLength(29);
    expect(new Set(accumulatedTickets)).toHaveLength(29);
    expect(accumulatedRelations).toHaveLength(35);
    expect(new Set(accumulatedRelations)).toHaveLength(35);
  });

  it("applies exact-boundary current capabilities and preserves topology identity", () => {
    const source = cloneSource();
    const baseline = projectTicketGraphSnapshotV0(source);
    source.projectionWatermark = "ticket-review-v4:watermark:2";
    source.currentCapabilityProjections.push(
      makeTicketValidationProjection(source),
      makeRelationAttentionProjection(source),
      {
        producerReceiptRef: "receipt:snapshot:lenses",
        producedAt: AT,
        snapshotRevision: source.snapshotRevision,
        projectionWatermark: source.projectionWatermark,
        producer: { kind: "skill", id: "fixture-lens", version: "1" },
        subject: { kind: "snapshot" },
        capability: "lenses",
        summary: {
          label: "Execution lenses",
          references: [{ ref: "lens:execution", label: "Execution" }],
        },
      },
    );

    const projected = projectTicketGraphSnapshotV0(source);
    const ticket =
      projected.tickets.find((item) => item.ticketId === "TKT-124")!;
    const relation = projected.relations.find(
      (item) => item.relationRef === "ticket-review-v4:direct-unlock:10",
    )!;
    expect(projected.snapshotId).not.toBe(baseline.snapshotId);
    expect(projected.topologyDigest).toBe(baseline.topologyDigest);
    expect(ticket.outcome).toBe(
      baseline.tickets.find((item) => item.ticketId === "TKT-124")!.outcome,
    );
    expect(ticket.capabilities.validation).toMatchObject({
      availability: "available",
      producerReceiptRef: "receipt:TKT-124:validation",
    });
    expect(relation.capabilities.attention).toMatchObject({
      availability: "available",
      producerReceiptRef:
        "receipt:ticket-review-v4:direct-unlock:10:attention",
    });
    expect(projected.lenses).toMatchObject({
      availability: "available",
      producerReceiptRef: "receipt:snapshot:lenses",
    });
  });

  it("fails closed on capability boundary, revision, endpoint, and slot ambiguity", () => {
    for (const boundary of ["snapshotRevision", "projectionWatermark"] as const) {
      const source = cloneSource();
      const projection = makeTicketValidationProjection(source);
      projection[boundary] = `stale:${boundary}`;
      source.currentCapabilityProjections.push(projection);
      expect(captureError(
        () => projectTicketGraphSnapshotV0(source),
        "projection_invariant_failed",
      ).details).toMatchObject({
        cause: "capability_projection_boundary_mismatch",
      });
    }

    const wrongRevision = cloneSource();
    const revisionProjection = makeTicketValidationProjection(wrongRevision);
    if (revisionProjection.subject.kind !== "ticket") {
      throw new Error("fixture must be ticket-bound");
    }
    revisionProjection.subject.ticketRevision = REVISION_B;
    wrongRevision.currentCapabilityProjections.push(revisionProjection);
    expect(captureError(
      () => projectTicketGraphSnapshotV0(wrongRevision),
      "projection_invariant_failed",
    ).details).toMatchObject({
      cause: "capability_ticket_revision_mismatch",
    });

    const wrongEndpoints = cloneSource();
    const relationProjection =
      makeRelationAttentionProjection(wrongEndpoints);
    if (relationProjection.subject.kind !== "relation") {
      throw new Error("fixture must be relation-bound");
    }
    relationProjection.subject.dependentTicketId = "TKT-128";
    wrongEndpoints.currentCapabilityProjections.push(relationProjection);
    expect(captureError(
      () => projectTicketGraphSnapshotV0(wrongEndpoints),
      "projection_invariant_failed",
    ).details).toMatchObject({
      cause: "capability_relation_binding_mismatch",
    });

    const duplicateSlot = cloneSource();
    duplicateSlot.currentCapabilityProjections.push(
      makeTicketValidationProjection(
        duplicateSlot,
        "receipt:TKT-124:validation:1",
      ),
      makeTicketValidationProjection(
        duplicateSlot,
        "receipt:TKT-124:validation:2",
      ),
    );
    expect(captureError(
      () => projectTicketGraphSnapshotV0(duplicateSlot),
      "projection_invariant_failed",
    ).details).toMatchObject({
      cause: "duplicate_current_capability",
    });
  });

  it("keeps topology identity independent of definition and snapshot-local relation identity", () => {
    const source = cloneSource();
    const baseline = projectTicketGraphSnapshotV0(source);
    source.ticketDefinitions[0]!.ticketRevision = REVISION_B;
    source.directUnlocks[0]!.relationRef =
      "snapshot-local-relation:renamed";
    source.projectionWatermark =
      "ticket-review-v4:watermark:topology-stable";

    const changed = projectTicketGraphSnapshotV0(source);
    expect(changed.snapshotId).not.toBe(baseline.snapshotId);
    expect(changed.topologyDigest).toBe(baseline.topologyDigest);
  });

  it("keeps display-only Git metadata out of snapshot identity", () => {
    const baselineSource = cloneSource();
    const baseline = projectTicketGraphSnapshotV0(baselineSource);
    const displayChanged = cloneSource();
    if (displayChanged.source.mode !== "worktree") {
      throw new Error("fixture must use a worktree source");
    }
    displayChanged.source.branch = "renamed-branch";
    displayChanged.source.semanticDirty = true;
    displayChanged.source.dirtyPaths = [
      ".vibehub/tickets/tickets/read-authority.yaml",
    ];
    displayChanged.source.dirtyPathsTruncated = true;

    const changed = projectTicketGraphSnapshotV0(displayChanged);
    expect(changed.snapshotId).toBe(baseline.snapshotId);
    expect(changed.source).toMatchObject({
      branch: "renamed-branch",
      semanticDirty: true,
      dirtyPathsTruncated: true,
    });

    displayChanged.source.sourceToken = "fixture-ticket-source-v4-new";
    expect(projectTicketGraphSnapshotV0(displayChanged).snapshotId)
      .not.toBe(baseline.snapshotId);
  });

  it("keeps inspect and trace strictly bound to the visible snapshot", () => {
    const source = cloneSource();
    const original = projectTicketGraphSnapshotV0(source);
    source.projectionWatermark = "ticket-review-v4:watermark:new";

    captureError(() => inspectTicketReviewSubjectV0(source, {
      snapshotId: original.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    }), "invalid_snapshot");
    captureError(() => listTicketReviewTraceV0(source, {
      snapshotId: original.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    }), "invalid_snapshot");
    captureError(() => inspectTicketReviewSubjectV0(ticketReviewV4Source, {
      subject: {
        kind: "relation",
        relationRef: "ticket-review-v4:direct-unlock:10",
      },
    }), "validation_error");
  });

  it("sorts mixed ISO offsets by instant and binds trace cursors to scope", () => {
    const source = cloneSource();
    source.traceRecords.push(
      makeTicketTrace({
        recordRef: "trace:instant-earliest",
        occurredAt: "2026-07-28T12:00:00+14:00",
      }),
      makeTicketTrace({
        recordRef: "trace:instant-latest",
        occurredAt: "2026-07-27T23:30:00-07:00",
      }),
      makeTicketTrace({
        recordRef: "trace:instant-middle",
        occurredAt: "2026-07-28T04:00:00+00:00",
      }),
    );
    const snapshot = projectTicketGraphSnapshotV0(source);
    const first = listTicketReviewTraceV0(source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
      limit: 2,
    });
    expect(first.records.map((record) => record.recordRef)).toEqual([
      "trace:instant-latest",
      "trace:instant-middle",
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = listTicketReviewTraceV0(source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.records.map((record) => record.recordRef))
      .toEqual(["trace:instant-earliest"]);

    captureError(() => listTicketReviewTraceV0(source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
      kinds: ["evidence"],
      cursor: first.nextCursor!,
    }), "validation_error");

    const submillisecondTrace = cloneSource();
    submillisecondTrace.traceRecords.push(makeTicketTrace({
      occurredAt: "2026-07-28T12:00:00.0001Z",
    }));
    captureError(
      () => projectTicketGraphSnapshotV0(submillisecondTrace),
      "projection_invariant_failed",
    );

    const submillisecondCapability = cloneSource();
    const capability =
      makeTicketValidationProjection(submillisecondCapability);
    capability.producedAt = "2026-07-28T12:00:00.0001Z";
    submillisecondCapability.currentCapabilityProjections.push(capability);
    captureError(
      () => projectTicketGraphSnapshotV0(submillisecondCapability),
      "projection_invariant_failed",
    );
  });

  it("binds relation traces to a unique visible ref, endpoints, and source revision", () => {
    const reusedRef = cloneSource();
    reusedRef.directUnlocks.push({
      ...reusedRef.directUnlocks[1]!,
      relationRef: reusedRef.directUnlocks[0]!.relationRef,
    });
    expect(captureError(
      () => projectTicketGraphSnapshotV0(reusedRef),
      "projection_invariant_failed",
    ).details).toMatchObject({ cause: "duplicate_relation_ref" });

    const unknownRef = cloneSource();
    const unknownTrace = makeRelationTrace(unknownRef);
    if (unknownTrace.subject.kind !== "relation") {
      throw new Error("fixture must be relation-bound");
    }
    unknownTrace.subject.relationRef = "stale-snapshot:relation:01";
    unknownRef.traceRecords.push(unknownTrace);
    expect(captureError(
      () => projectTicketGraphSnapshotV0(unknownRef),
      "projection_invariant_failed",
    ).details).toMatchObject({ cause: "unknown_trace_relation" });

    const wrongEndpoints = cloneSource();
    const endpointTrace = makeRelationTrace(wrongEndpoints);
    const otherRelation = wrongEndpoints.directUnlocks[1]!;
    if (endpointTrace.subject.kind !== "relation") {
      throw new Error("fixture must be relation-bound");
    }
    endpointTrace.subject.prerequisiteTicketId =
      otherRelation.prerequisiteTicketId;
    endpointTrace.subject.dependentTicketId =
      otherRelation.dependentTicketId;
    wrongEndpoints.traceRecords.push(endpointTrace);
    expect(captureError(
      () => projectTicketGraphSnapshotV0(wrongEndpoints),
      "projection_invariant_failed",
    ).details).toMatchObject({ cause: "trace_relation_binding_mismatch" });

    const wrongRevision = cloneSource();
    const revisionTrace = makeRelationTrace(wrongRevision);
    if (revisionTrace.subject.kind !== "relation") {
      throw new Error("fixture must be relation-bound");
    }
    revisionTrace.subject.sourceRevision = "stale-snapshot-revision";
    wrongRevision.traceRecords.push(revisionTrace);
    expect(captureError(
      () => projectTicketGraphSnapshotV0(wrongRevision),
      "projection_invariant_failed",
    ).details).toMatchObject({ cause: "trace_relation_binding_mismatch" });
  });

  it("rejects claimed gate authority and unsafe navigation targets", () => {
    const claimedGate = cloneSource();
    claimedGate.traceRecords.push(makeTicketTrace({
      kind: "gate_decision",
      producer: { kind: "claimed_actor", ref: "Wayne" },
    }));
    captureError(
      () => projectTicketGraphSnapshotV0(claimedGate),
      "projection_invariant_failed",
    );

    for (const kind of ["validation", "mutation_receipt"] as const) {
      const unreceipted = cloneSource();
      unreceipted.traceRecords.push(makeTicketTrace({
        recordRef: `trace:unreceipted:${kind}`,
        kind,
        producer: { kind: "system", ref: "unverified-system" },
      }));
      captureError(
        () => projectTicketGraphSnapshotV0(unreceipted),
        "projection_invariant_failed",
      );
    }

    const unsafeTargets = [
      { kind: "url", label: "Script", target: "javascript:alert(1)" },
      { kind: "opaque", label: "Data", target: "data:text/html,boom" },
      { kind: "repo_path", label: "Absolute", target: "/etc/passwd" },
      { kind: "repo_path", label: "Escape", target: "../outside" },
    ] as const;
    for (const target of unsafeTargets) {
      const source = cloneSource();
      (source.traceRecords as unknown[]).push(makeTicketTrace({
        recordRef: `trace:unsafe:${target.label}`,
        targets: [target] as TicketReviewTraceRecordV0["targets"],
      }));
      captureError(
        () => projectTicketGraphSnapshotV0(source),
        "projection_invariant_failed",
      );
    }

    const valid = cloneSource();
    valid.traceRecords.push(makeTicketTrace({
      recordRef: "trace:safe-targets",
      kind: "artifact",
      producer: { kind: "claimed_actor", ref: "Wayne" },
      targets: [
        {
          kind: "url",
          label: "Evidence",
          target: "https://example.com/evidence",
        },
        {
          kind: "repo_path",
          label: "Source",
          target: "packages/core/src/index.ts",
        },
        {
          kind: "opaque",
          label: "Artifact",
          target: "artifact:run-1",
        },
      ],
    }));
    const snapshot = projectTicketGraphSnapshotV0(valid);
    const traces = listTicketReviewTraceV0(valid, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    expect(traces.records[0]!.targets).toHaveLength(3);
  });

  it("accepts exact ticket trace revisions and rejects mismatched revisions", () => {
    const exact = cloneSource();
    const ticket = exact.ticketDefinitions.find(
      (definition) => definition.ticketId === "TKT-124",
    )!;
    ticket.ticketRevision = REVISION_B;
    exact.traceRecords.push(makeTicketTrace({
      recordRef: "trace:exact-revision",
      subject: {
        kind: "ticket",
        ticketId: "TKT-124",
        boundTicketRevision: REVISION_B,
      },
    }));

    const snapshot = projectTicketGraphSnapshotV0(exact);
    const traces = listTicketReviewTraceV0(exact, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    expect(traces.records).toHaveLength(1);
    expect(traces.records[0]!.subject).toEqual({
      kind: "ticket",
      ticketId: "TKT-124",
      boundTicketRevision: REVISION_B,
    });

    const mismatched = structuredClone(exact);
    mismatched.traceRecords.push(makeTicketTrace({
      recordRef: "trace:mismatched-revision",
      subject: {
        kind: "ticket",
        ticketId: "TKT-124",
        boundTicketRevision: REVISION_C,
      },
    }));
    expect(captureError(
      () => projectTicketGraphSnapshotV0(mismatched),
      "projection_invariant_failed",
    ).details).toMatchObject({
      cause: "trace_ticket_revision_mismatch",
      boundTicketRevision: REVISION_C,
      visibleTicketRevision: REVISION_B,
    });
  });

  it("rejects inconsistent page counts, inspected counts, and trace subjects", () => {
    const snapshot = projectTicketGraphSnapshotV0(ticketReviewV4Source);
    const wrongPageCount = structuredClone(snapshot);
    wrongPageCount.page.count -= 1;
    expect(ticketGraphSnapshotPageV0Schema.safeParse(wrongPageCount).success)
      .toBe(false);

    const inspection = inspectTicketReviewSubjectV0(ticketReviewV4Source, {
      snapshotId: snapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    const wrongIncidentCount = structuredClone(inspection);
    if (wrongIncidentCount.subject.kind !== "ticket") {
      throw new Error("fixture must inspect a Ticket");
    }
    wrongIncidentCount.subject.ticket.relationCounts.prerequisites += 1;
    expect(ticketSubjectInspectionV0Schema.safeParse(wrongIncidentCount).success)
      .toBe(false);

    const traceSource = cloneSource();
    traceSource.traceRecords.push(makeTicketTrace({
      recordRef: "trace:subject-contract",
    }));
    const traceSnapshot = projectTicketGraphSnapshotV0(traceSource);
    const tracePage = listTicketReviewTraceV0(traceSource, {
      snapshotId: traceSnapshot.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-124" },
    });
    const wrongSubject = structuredClone(tracePage);
    wrongSubject.subject = { kind: "ticket", ticketId: "TKT-126" };
    expect(ticketTraceListPageV0Schema.safeParse(wrongSubject).success)
      .toBe(false);
  });

  it("fails closed for missing endpoints, duplicate relations, and cycles", () => {
    const missing = cloneSource();
    missing.directUnlocks[0]!.dependentTicketId = "TKT-missing";
    expect(captureError(
      () => projectTicketGraphSnapshotV0(missing),
      "projection_invariant_failed",
    ).message).toMatch(/unknown Ticket/);

    const duplicate = cloneSource();
    duplicate.directUnlocks.push({
      ...duplicate.directUnlocks[0]!,
      relationRef: "ticket-review-v4:direct-unlock:duplicate",
    });
    expect(captureError(
      () => projectTicketGraphSnapshotV0(duplicate),
      "projection_invariant_failed",
    ).message).toMatch(/endpoint pair/);

    const cycle = cloneSource();
    cycle.directUnlocks.push({
      relationRef: "ticket-review-v4:direct-unlock:cycle",
      prerequisiteTicketId: "TKT-001",
      dependentTicketId: "TKT-090",
      rationale: "Invalid reverse edge for the test.",
    });
    expect(captureError(
      () => projectTicketGraphSnapshotV0(cycle),
      "projection_invariant_failed",
    ).details).toMatchObject({ cause: "direct_unlock_cycle" });
  });

  it("preflights runtime and schema ceilings as stable projection_too_large errors", () => {
    for (const count of [TICKET_REVIEW_MAX_TICKETS + 1, 2_001]) {
      const tooManyTickets = cloneSource();
      tooManyTickets.ticketDefinitions = Array.from(
        { length: count },
        (_, index) => ({
          ticketId: `capacity-${index.toString().padStart(4, "0")}`,
          ticketRevision: REVISION_A,
          outcome: `Capacity fixture ${index}`,
          context: "",
          acceptance: [],
          constraints: [],
          contextRefs: [],
        }),
      );
      tooManyTickets.directUnlocks = [];
      expect(captureError(
        () => projectTicketGraphSnapshotV0(tooManyTickets),
        "projection_too_large",
      ).details).toEqual({
        field: "ticketDefinitions",
        count,
        maximum: TICKET_REVIEW_MAX_TICKETS,
      });
    }

    const tooManyTraces = cloneSource();
    tooManyTraces.traceRecords = Array(
      TICKET_REVIEW_MAX_TRACE_RECORDS + 1,
    ).fill(makeTicketTrace());
    expect(captureError(
      () => projectTicketGraphSnapshotV0(tooManyTraces),
      "projection_too_large",
    ).details).toEqual({
      field: "traceRecords",
      count: TICKET_REVIEW_MAX_TRACE_RECORDS + 1,
      maximum: TICKET_REVIEW_MAX_TRACE_RECORDS,
    });
  });
});
