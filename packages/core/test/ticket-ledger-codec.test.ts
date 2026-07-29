import { describe, expect, it } from "vitest";
import {
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_RELATIONS,
  TICKET_LEDGER_MAX_TICKETS,
  TICKET_LEDGER_TICKET_MAX_BYTES,
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  decodeTicketLedger,
  ticketDocumentPath,
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
