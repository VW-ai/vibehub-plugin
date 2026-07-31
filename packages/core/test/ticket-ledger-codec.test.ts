import { describe, expect, it } from "vitest";
import {
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_RELATIONS,
  TICKET_LEDGER_MAX_TICKETS,
  TICKET_LEDGER_TICKET_MAX_BYTES,
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  createTicketDecisionDocument,
  createTicketReviewDocument,
  decodeTicketLedger,
  encodeTicketDecisionDocument,
  encodeTicketReviewDocument,
  isTicketLedgerDocumentPath,
  normalizeTicketDecisionDocument,
  normalizeTicketReviewDocument,
  ticketDecisionDocumentPath,
  ticketDocumentPath,
  ticketReviewDocumentPath,
  ticketRelationId,
  validateTicketLedger,
  type TicketLedgerFile,
} from "../src/ticket-ledger/index.js";

const protocol = `
schema_version: 1
kind: ticket_protocol
format: vibehub.ticket-ledger
`;

const ticket = (
  ticketId: string,
  outcome = `Deliver ${ticketId}`,
  relations = "[]",
): string => `
schema_version: 1
kind: ticket
ticket_id: ${ticketId}
outcome: ${outcome}
context: Context for ${ticketId}
acceptance:
  - acceptance_id: complete
    criterion: The outcome is observable.
constraints:
  - Keep Git as the authority.
context_refs:
  - ref: META/spec.yaml
    purpose: Product boundary
relations: ${relations}
provenance_refs:
  - META/plan.md
`;

const bytes = (
  documentPath: string,
  source: string,
): TicketLedgerFile => ({
  documentPath,
  bytes: Buffer.from(source),
});

const ledger = (...ticketFiles: TicketLedgerFile[]) =>
  decodeTicketLedger([
    bytes(`${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`, protocol),
    ...ticketFiles,
  ]);

const expectCode = (
  callback: () => unknown,
  code: TicketLedgerError["code"],
): void => {
  try {
    callback();
    throw new Error("expected TicketLedgerError");
  } catch (error) {
    expect(error).toBeInstanceOf(TicketLedgerError);
    expect((error as TicketLedgerError).code).toBe(code);
  }
};

describe("Ticket ledger codec", () => {
  it("derives revisions and graph digests from normalized semantic values", () => {
    const first = ledger(bytes(
      ticketDocumentPath("read-cut"),
      `${ticket("read-cut")}
# a formatting-only comment
`,
    ));
    const reordered = ledger(bytes(
      ticketDocumentPath("read-cut"),
      `
kind: ticket
schema_version: 1
ticket_id: read-cut
context: Context for read-cut
outcome: Deliver read-cut
constraints: [Keep Git as the authority.]
relations: []
provenance_refs: [META/plan.md]
context_refs:
  - purpose: Product boundary
    ref: META/spec.yaml
acceptance:
  - criterion: The outcome is observable.
    acceptance_id: complete
`,
    ));

    expect(first.graphDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.graphDigest).toBe(reordered.graphDigest);
    expect(first.tickets[0]!.ticketRevision)
      .toBe(reordered.tickets[0]!.ticketRevision);
  });

  it("keeps review facts out of Ticket identity and graph topology", () => {
    const ticketFile = bytes(
      ticketDocumentPath("read-cut"),
      ticket("read-cut"),
    );
    const base = ledger(ticketFile);
    const subject = {
      kind: "ticket" as const,
      ticket_id: "read-cut",
      ticket_revision: base.tickets[0]!.ticketRevision,
    };
    const review = createTicketReviewDocument({
      schema_version: 1,
      kind: "ticket_review",
      review_type: "comment",
      subject,
      observed: {
        resolved_commit: "a".repeat(40),
        graph_digest: base.graphDigest,
      },
      author: {
        actor_id: "Wayne",
        actor_kind: "human",
        attribution: "claimed",
      },
      body: "Please preserve the direct-unlock reading.",
      occurred_at: "2026-07-30T18:00:00Z",
    });
    const withReview = ledger(
      ticketFile,
      {
        documentPath: ticketReviewDocumentPath(
          review.subject,
          review.review_id,
        ),
        bytes: encodeTicketReviewDocument(review),
      },
    );

    expect(withReview.graphDigest).toBe(base.graphDigest);
    expect(withReview.tickets[0]!.ticketRevision)
      .toBe(base.tickets[0]!.ticketRevision);
    expect(withReview.semanticLedgerDigest)
      .not.toBe(base.semanticLedgerDigest);
    expect(withReview.reviews).toEqual([expect.objectContaining({
      document: review,
    })]);
  });

  it("derives append-only review and subject-stable decision identities", () => {
    const base = ledger(bytes(
      ticketDocumentPath("read-cut"),
      ticket("read-cut"),
    ));
    const ticketSubject = {
      kind: "ticket" as const,
      ticket_id: "read-cut",
      ticket_revision: base.tickets[0]!.ticketRevision,
    };
    const edit = createTicketReviewDocument({
      schema_version: 1,
      kind: "ticket_review",
      review_type: "ticket_edit",
      subject: ticketSubject,
      observed: {
        resolved_commit: "b".repeat(40),
        graph_digest: base.graphDigest,
      },
      author: {
        actor_id: "codex",
        actor_kind: "agent",
        attribution: "host_attested",
      },
      body: "Tighten the observable outcome.",
      occurred_at: "2026-07-30T18:01:02.123-07:00",
      expected_ticket_revision: ticketSubject.ticket_revision,
      replacement_ticket: {
        schema_version: 1,
        kind: "ticket",
        ticket_id: "read-cut",
        outcome: "Deliver a tighter read cut",
        context: "Context for read-cut",
        acceptance: [],
        constraints: [],
        context_refs: [],
        relations: [],
        provenance_refs: [],
      },
      rationale: "The existing outcome is ambiguous.",
    });
    expect(edit.review_id).toMatch(/^trv-[0-9a-f]{64}$/u);
    expect(edit.occurred_at).toBe("2026-07-31T01:01:02.123Z");
    expect(ticketReviewDocumentPath(edit.subject, edit.review_id))
      .toMatch(/\/reviews\/[0-9a-f]{64}\/trv-[0-9a-f]{64}\.yaml$/u);

    const protectedDecision = createTicketDecisionDocument({
      schema_version: 1,
      kind: "ticket_decision",
      decision_type: "protected_boundary",
      subject: ticketSubject,
      boundary: "Which primary interaction should ship?",
      disposition: "resolve",
      selection: "Keep the graph-first interaction.",
      rationale: "It directly exposes what may execute next.",
      resolution_refs: ["META/review.yaml"],
      authority: {
        principal_id: "wayne",
        principal_kind: "human",
        basis: "repository_owner",
        basis_ref: "local-host/session-1",
        attestation: "host_bound_local",
      },
      decided_at: "2026-07-30T18:03:00Z",
    });
    const otherBoundary = createTicketDecisionDocument({
      ...Object.fromEntries(
        Object.entries(protectedDecision)
          .filter(([key]) => key !== "decision_id"),
      ),
      boundary: "Which typography should ship?",
    } as Parameters<typeof createTicketDecisionDocument>[0]);

    expect(protectedDecision.decision_id)
      .toMatch(/^tdc-[0-9a-f]{64}$/u);
    expect(ticketDecisionDocumentPath(protectedDecision))
      .not.toBe(ticketDecisionDocumentPath(otherBoundary));
    expect(encodeTicketDecisionDocument(protectedDecision).toString("utf8"))
      .toContain("kind: ticket_decision");
    expect(normalizeTicketDecisionDocument(protectedDecision))
      .toEqual(protectedDecision);
  });

  it("rejects forged identities, malformed edit bindings, and unsafe review paths", () => {
    const base = ledger(bytes(
      ticketDocumentPath("read-cut"),
      ticket("read-cut"),
    ));
    const subject = {
      kind: "ticket" as const,
      ticket_id: "read-cut",
      ticket_revision: base.tickets[0]!.ticketRevision,
    };
    const review = createTicketReviewDocument({
      schema_version: 1,
      kind: "ticket_review",
      review_type: "comment",
      subject,
      observed: {
        resolved_commit: "c".repeat(40),
        graph_digest: base.graphDigest,
      },
      author: {
        actor_id: "reviewer",
        actor_kind: "human",
        attribution: "claimed",
      },
      body: "One exact review contribution.",
      occurred_at: "2026-07-30T18:04:00Z",
    });
    expectCode(
      () => normalizeTicketReviewDocument({
        ...review,
        review_id: `trv-${"f".repeat(64)}`,
      }),
      "invalid_document",
    );
    expectCode(
      () => normalizeTicketReviewDocument({
        ...review,
        review_type: "ticket_edit",
        expected_ticket_revision: "d".repeat(64),
        replacement_ticket: {
          schema_version: 1,
          kind: "ticket",
          ticket_id: "other",
          outcome: "Wrong target",
          context: "Wrong target",
          acceptance: [],
          constraints: [],
          context_refs: [],
          relations: [],
          provenance_refs: [],
        },
        rationale: "Invalid bindings",
      }),
      "invalid_document",
    );
    expect(isTicketLedgerDocumentPath(
      `${TICKET_LEDGER_RELATIVE_PATH}/reviews/../${review.review_id}.yaml`,
    )).toBe(false);
    expect(isTicketLedgerDocumentPath(
      `${TICKET_LEDGER_RELATIVE_PATH}/reviews/${
        "a".repeat(64)
      }/nested/${review.review_id}.yaml`,
    )).toBe(false);
    expectCode(
      () => ledger(
        bytes(ticketDocumentPath("read-cut"), ticket("read-cut")),
        {
          documentPath:
            `${TICKET_LEDGER_RELATIVE_PATH}/reviews/${
              "a".repeat(64)
            }/${review.review_id}.yaml`,
          bytes: encodeTicketReviewDocument(review),
        },
      ),
      "invalid_path",
    );
  });

  it("requires host-bound human authority and exact decision union fields", () => {
    const graphSubject = {
      kind: "graph" as const,
      graph_digest: "a".repeat(64),
    };
    const valid = createTicketDecisionDocument({
      schema_version: 1,
      kind: "ticket_decision",
      decision_type: "plan_review",
      subject: graphSubject,
      disposition: "delegate_within_boundaries",
      delegated_boundaries: ["Ticket implementation within accepted UX"],
      rationale: "Delegate the mechanically constrained implementation.",
      resolution_refs: [],
      authority: {
        principal_id: "wayne",
        principal_kind: "human",
        basis: "repository_owner",
        basis_ref: "local-host/session-2",
        attestation: "host_bound_local",
      },
      decided_at: "2026-07-30T18:05:00Z",
    });
    expect(valid.decision_type).toBe("plan_review");

    for (const invalid of [
      {
        ...valid,
        decision_id: `tdc-${"0".repeat(64)}`,
      },
      {
        ...valid,
        authority: {
          ...valid.authority,
          principal_kind: "agent",
        },
      },
      {
        ...valid,
        authority: {
          ...valid.authority,
          attestation: "claimed",
        },
      },
      {
        ...valid,
        delegated_boundaries: [],
      },
      {
        ...valid,
        disposition: "approve_execution",
      },
    ]) {
      expectCode(
        () => normalizeTicketDecisionDocument(invalid),
        "invalid_document",
      );
    }
  });

  it("binds graph and relation reviews to stable semantic subjects", () => {
    const relationRef = ticketRelationId("dependent", {
      type: "depends_on",
      target_ticket_id: "prerequisite",
    });
    const relationReview = createTicketReviewDocument({
      schema_version: 1,
      kind: "ticket_review",
      review_type: "comment",
      subject: {
        kind: "relation",
        relation_ref: relationRef,
        prerequisite_ticket_id: "prerequisite",
        dependent_ticket_id: "dependent",
        dependent_ticket_revision: "b".repeat(64),
      },
      observed: {
        resolved_commit: "c".repeat(40),
        graph_digest: "d".repeat(64),
      },
      author: {
        actor_id: "codex",
        actor_kind: "agent",
        attribution: "claimed",
      },
      body: "This direct dependency is unnecessarily serialized.",
      occurred_at: "2026-07-30T18:06:00Z",
    });
    expect(relationReview.subject.kind).toBe("relation");

    expectCode(
      () => createTicketReviewDocument({
        ...Object.fromEntries(
          Object.entries(relationReview)
            .filter(([key]) => key !== "review_id"),
        ),
        subject: {
          ...relationReview.subject,
          relation_ref: `trl-${"f".repeat(64)}`,
        },
      } as Parameters<typeof createTicketReviewDocument>[0]),
      "invalid_document",
    );
    expectCode(
      () => createTicketReviewDocument({
        schema_version: 1,
        kind: "ticket_review",
        review_type: "comment",
        subject: {
          kind: "graph",
          graph_digest: "a".repeat(64),
        },
        observed: {
          resolved_commit: "c".repeat(40),
          graph_digest: "b".repeat(64),
        },
        author: {
          actor_id: "reviewer",
          actor_kind: "human",
          attribution: "claimed",
        },
        body: "Review a mismatched graph.",
        occurred_at: "2026-07-30T18:07:00Z",
      }),
      "invalid_document",
    );
  });

  it("normalizes identity-keyed collections but preserves constraint order", () => {
    const source = `
schema_version: 1
kind: ticket
ticket_id: normalized
outcome: Normalize the package
context: Normalize stable identities
acceptance:
  - acceptance_id: z-last
    criterion: Last
  - acceptance_id: a-first
    criterion: First
constraints:
  - First constraint
  - Second constraint
context_refs:
  - ref: z.yaml
    purpose: Last
  - ref: a.yaml
    purpose: First
relations: []
provenance_refs: [z.md, a.md]
`;
    const decoded = ledger(bytes(ticketDocumentPath("normalized"), source));
    const document = decoded.tickets[0]!.document;

    expect(document.acceptance.map((item) => item.acceptance_id))
      .toEqual(["a-first", "z-last"]);
    expect(document.context_refs.map((item) => item.ref))
      .toEqual(["a.yaml", "z.yaml"]);
    expect(document.provenance_refs).toEqual(["a.md", "z.md"]);
    expect(document.constraints)
      .toEqual(["First constraint", "Second constraint"]);
  });

  it("keeps relation identity stable across rationale and graph edits", () => {
    const first = ticketRelationId("dependent", {
      type: "depends_on",
      target_ticket_id: "prerequisite",
    });
    const withRationale = ticketRelationId("dependent", {
      type: "depends_on",
      target_ticket_id: "prerequisite",
      rationale: "A later rationale is semantic but not relation identity.",
    });

    expect(first).toMatch(/^trl-[0-9a-f]{64}$/u);
    expect(first).toBe(withRationale);
  });

  it("rejects unknown fields, aliases, merge keys, custom tags, and duplicate keys", () => {
    const invalidSources = [
      `${ticket("strict")}\nstatus: active\n`,
      ticket("strict").replace(
        "outcome: Deliver strict",
        "outcome: &shared Deliver strict\ncontext: *shared",
      ).replace("context: Context for strict\n", ""),
      ticket("strict").replace(
        "outcome: Deliver strict",
        "<<: { status: active }\noutcome: Deliver strict",
      ),
      ticket("strict").replace(
        "outcome: Deliver strict",
        "outcome: !product Deliver strict",
      ),
      `${ticket("strict")}\noutcome: Duplicate outcome\n`,
    ];

    for (const [index, source] of invalidSources.entries()) {
      expectCode(
        () => ledger(bytes(ticketDocumentPath("strict"), source)),
        "invalid_document",
      );
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects filename mismatch, duplicate IDs and duplicate relation identities", () => {
    expectCode(
      () => ledger(bytes(ticketDocumentPath("wrong"), ticket("actual"))),
      "invalid_path",
    );

    const document = {
      schema_version: 1,
      kind: "ticket",
      ticket_id: "duplicate",
      outcome: "One promise",
      context: "One context",
      acceptance: [],
      constraints: [],
      context_refs: [],
      relations: [],
      provenance_refs: [],
    };
    expectCode(
      () => validateTicketLedger({
        protocol: {
          schema_version: 1,
          kind: "ticket_protocol",
          format: "vibehub.ticket-ledger",
        },
        tickets: [
          { documentPath: ticketDocumentPath("duplicate"), document },
          { documentPath: ticketDocumentPath("duplicate"), document },
        ],
      }),
      "invalid_document",
    );

    const duplicateRelations = ticket(
      "dependent",
      "Depend once",
      `[{ type: depends_on, target_ticket_id: base }, { type: depends_on, target_ticket_id: base }]`,
    );
    expectCode(
      () => ledger(
        bytes(ticketDocumentPath("base"), ticket("base")),
        bytes(ticketDocumentPath("dependent"), duplicateRelations),
      ),
      "invalid_document",
    );
  });

  it("rejects missing endpoints, self dependencies, and dependency cycles", () => {
    expectCode(
      () => ledger(bytes(
        ticketDocumentPath("dependent"),
        ticket(
          "dependent",
          "Missing endpoint",
          "[{ type: depends_on, target_ticket_id: absent }]",
        ),
      )),
      "invalid_graph",
    );
    expectCode(
      () => ledger(bytes(
        ticketDocumentPath("self"),
        ticket(
          "self",
          "Self endpoint",
          "[{ type: depends_on, target_ticket_id: self }]",
        ),
      )),
      "invalid_graph",
    );
    expectCode(
      () => ledger(
        bytes(
          ticketDocumentPath("left"),
          ticket(
            "left",
            "Left",
            "[{ type: depends_on, target_ticket_id: right }]",
          ),
        ),
        bytes(
          ticketDocumentPath("right"),
          ticket(
            "right",
            "Right",
            "[{ type: depends_on, target_ticket_id: left }]",
          ),
        ),
      ),
      "invalid_graph",
    );
  });

  it("enforces document byte limits before parsing", () => {
    expectCode(
      () => ledger(bytes(
        ticketDocumentPath("oversized"),
        "x".repeat(TICKET_LEDGER_TICKET_MAX_BYTES + 1),
      )),
      "file_too_large",
    );
  });

  it("enforces the aggregate ledger byte limit before parsing files", () => {
    const largeFiles = Array.from({ length: 40 }, (_, index) =>
      bytes(
        ticketDocumentPath(`large-${index}`),
        "x".repeat(220 * 1024),
      ));
    expect(
      largeFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    ).toBeGreaterThan(TICKET_LEDGER_MAX_BYTES);
    expectCode(() => ledger(...largeFiles), "ledger_too_large");
  });

  it("keeps the canonical ledger within every review consumer capacity", () => {
    const protocolDocument = {
      schema_version: 1 as const,
      kind: "ticket_protocol" as const,
      format: "vibehub.ticket-ledger" as const,
    };
    const document = (ticketId: string, relations: {
      type: "depends_on";
      target_ticket_id: string;
    }[] = []) => ({
      schema_version: 1 as const,
      kind: "ticket" as const,
      ticket_id: ticketId,
      outcome: `Deliver ${ticketId}`,
      context: `Context for ${ticketId}`,
      acceptance: [],
      constraints: [],
      context_refs: [],
      relations,
      provenance_refs: [],
    });
    const tooManyTickets = Array.from(
      { length: TICKET_LEDGER_MAX_TICKETS + 1 },
      (_, index) => {
        const ticketId = `ticket-${index}`;
        return {
          documentPath: ticketDocumentPath(ticketId),
          document: document(ticketId),
        };
      },
    );
    expectCode(
      () => validateTicketLedger({
        protocol: protocolDocument,
        tickets: tooManyTickets,
      }),
      "ledger_too_large",
    );

    const targetIds = Array.from(
      { length: 250 },
      (_, index) => `target-${index}`,
    );
    const relationCount = TICKET_LEDGER_MAX_RELATIONS + 1;
    const dependentCount = Math.ceil(relationCount / targetIds.length);
    const relationTickets = [
      ...Array.from({ length: dependentCount }, (_, dependentIndex) => {
        const ticketId = `dependent-${dependentIndex}`;
        const offset = dependentIndex * targetIds.length;
        const targets = targetIds.slice(
          0,
          Math.min(targetIds.length, relationCount - offset),
        );
        return {
          documentPath: ticketDocumentPath(ticketId),
          document: document(
            ticketId,
            targets.map((target_ticket_id) => ({
              type: "depends_on" as const,
              target_ticket_id,
            })),
          ),
        };
      }),
      ...targetIds.map((ticketId) => ({
        documentPath: ticketDocumentPath(ticketId),
        document: document(ticketId),
      })),
    ];
    expectCode(
      () => validateTicketLedger({
        protocol: protocolDocument,
        tickets: relationTickets,
      }),
      "ledger_too_large",
    );
  });

  it("rejects path escapes and non-canonical Ticket IDs", () => {
    expectCode(() => ticketDocumentPath("../escape"), "invalid_path");
    expectCode(() => ticketDocumentPath("Uppercase"), "invalid_path");
    expectCode(() => ticketDocumentPath("nested/path"), "invalid_path");
  });
});
