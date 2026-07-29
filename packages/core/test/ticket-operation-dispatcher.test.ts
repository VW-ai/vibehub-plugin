import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_TICKET_STORE_FORMAT,
  GIT_TICKET_STORE_RELATIVE_PATH,
  GIT_TICKET_STORE_SCHEMA_VERSION,
  OperationDispatcher,
  TICKET_PROPOSAL_MAX_INPUT_BYTES,
  deriveTicketReviewSnapshotIdV0,
  gitTicketGenerationDigestV0,
  gitTicketGenerationRelativePathV0,
  gitTicketRevisionRelativePathV0,
  openDb,
  serializeGitTicketStoreDocumentV0,
  upsertRepo,
  upsertTask,
  type Db,
  type GitTicketDefinitionRevisionV0,
  type OperationContext,
  type TicketGraphChangeProposalV0,
  type TicketProposalLedgerPageV0,
  type TicketProposalValidationLedgerPageV0,
  type TicketProposalValidationReceiptV0,
  type TicketProposalReviewPacketV0,
  type TicketProposalApplicationReceiptV0,
  type TrustedTicketProposalAuthorityProviderV0,
  type TicketReviewProjectionSourceV0,
} from "../src/index.js";
import {
  prepareGitTicketGenerationV0,
} from "../src/git-ticket-store.js";
import {
  ticketProposalDomainDigestV0,
} from "../src/ticket-proposal-service.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const NOW = "2026-07-28T12:00:00.000Z";
const STORE_ID = "ticket-store-0123456789abcdef0123456789abcdef";

const sha256 = (value: string): string => crypto
  .createHash("sha256")
  .update(value)
  .digest("hex");

function writeCanonical(target: string, value: unknown): string {
  const bytes = serializeGitTicketStoreDocumentV0(value);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return bytes;
}

function ticketWriterLockRoot(worktreeRoot: string): string {
  return git(
    worktreeRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "vibehub/ticket-publisher-v1/lock",
  ).trim();
}

function writeTicketWriterLock(
  worktreeRoot: string,
  value: { token: string } & Record<string, unknown>,
): string {
  const lockRoot = ticketWriterLockRoot(worktreeRoot);
  fs.mkdirSync(lockRoot, { recursive: true });
  return writeCanonical(
    path.join(lockRoot, `owner-${value.token}.json`),
    value,
  );
}

function publishSingleTicket(
  repoRoot: string,
  outcome = "Expose the canonical Ticket graph through operations",
): {
  snapshotId: string;
  revisionPath: string;
} {
  const storeRoot = path.join(repoRoot, GIT_TICKET_STORE_RELATIVE_PATH);
  writeCanonical(path.join(storeRoot, "protocol.yaml"), {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    format: GIT_TICKET_STORE_FORMAT,
    storeId: STORE_ID,
    indexing: "stable-ticket-revision-paths",
    integrity: "immutable-generations-pointer-v1",
    projector: "ticket-review-v0",
  });
  const definition: GitTicketDefinitionRevisionV0 = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_definition_revision",
    ticketId: "TKT-001",
    definitionRevision: 1,
    created: {
      at: NOW,
      by: "agent:planner",
      reason: "Decomposed from the accepted outcome",
      source: { kind: "plan", ref: "plan:dispatcher-test" },
    },
    outcome,
    parentId: null,
    dependsOn: [],
    provenanceRefs: ["fixture:dispatcher"],
  };
  const revisionFile = gitTicketRevisionRelativePathV0(
    definition.ticketId,
    definition.definitionRevision,
  );
  const revisionPath = path.join(storeRoot, revisionFile);
  const revisionBytes = writeCanonical(revisionPath, definition);
  const entries = [{
    ticketId: definition.ticketId,
    definitionRevision: definition.definitionRevision,
    file: revisionFile,
    sha256: sha256(revisionBytes),
  }];
  const generationDigest = gitTicketGenerationDigestV0(STORE_ID, entries);
  const snapshotRevision = [
    "ticket-generation",
    STORE_ID,
    generationDigest,
  ].join(":");
  const source: TicketReviewProjectionSourceV0 = {
    schemaVersion: 1,
    snapshotRevision,
    projectionWatermark: snapshotRevision,
    ticketDefinitions: [{
      ticketId: definition.ticketId,
      definitionRevision: definition.definitionRevision,
      outcome: definition.outcome,
      provenanceRefs: [
        `ticket-definition:${definition.ticketId}:revision:${definition.definitionRevision}`,
        ...definition.provenanceRefs,
      ],
    }],
    directUnlocks: [],
    currentCapabilityProjections: [],
    traceRecords: [],
  };
  const snapshotId = deriveTicketReviewSnapshotIdV0(source);
  writeCanonical(
    path.join(
      storeRoot,
      gitTicketGenerationRelativePathV0(snapshotId),
    ),
    {
      schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
      kind: "ticket_generation",
      storeId: STORE_ID,
      snapshotId,
      generationDigest,
      tickets: entries,
    },
  );
  writeCanonical(path.join(storeRoot, "latest.yaml"), {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_latest",
    storeId: STORE_ID,
    snapshotId,
  });
  return { snapshotId, revisionPath };
}

function bootstrapProposalInput(outcome = "Deliver the Ticket proposal loop") {
  return {
    schemaVersion: 1,
    kind: "graph_change",
    observedSnapshotId: null,
    reason: "Shape the accepted work into an executable Ticket",
    source: { kind: "plan", ref: "plan:dispatcher-proposal" },
    authorAssessment: {
      changeClass: "decomposition",
      authoritySignals: [],
      introducesHumanGate: false,
      rationale: "The work stays within the already accepted outcome.",
    },
    changes: [{
      op: "create",
      localRef: "implementation",
      definition: {
        outcome,
        parent: null,
        dependsOn: [],
      },
    }],
  };
}

function passingProposalValidationInput(proposal: {
  proposalId: string;
  proposalDigest: string;
  mechanicalReview: { candidateDigest: string };
}) {
  const evidenceRef = `proposal:${proposal.proposalId}`;
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    expectedProposalDigest: proposal.proposalDigest,
    expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
    validator: {
      id: "vibehub-ticket-validate",
      version: "1",
      artifactDigest: "1".repeat(64),
    },
    policy: {
      id: "vibehub-ticket-proposal-semantic-review",
      version: "1",
      artifactDigest: "2".repeat(64),
    },
    checks: [
      "promise_preservation",
      "containment_truth",
      "dependency_truth",
      "change_classification",
      "delegated_scope",
      "protected_boundaries",
    ].map((code, index) => ({
      localRef: `check-${index + 1}`,
      code,
      subject: { kind: "proposal" },
      outcome: "passed",
      summary: `${code} is supported by the inspected candidate.`,
      evidenceRefs: [evidenceRef],
    })),
    findings: [],
    indicatedAuthoritySignals: [],
  };
}

describe("Ticket operation dispatcher", () => {
  const repos: ScratchRepo[] = [];
  const dbRoots: string[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    repos.splice(0).forEach((repo) => repo.cleanup());
    dbRoots.splice(0).forEach((root) =>
      fs.rmSync(root, { recursive: true, force: true }));
  });

  const makeRepo = (): ScratchRepo => {
    const repo = makeScratchRepo();
    repos.push(repo);
    return repo;
  };

  const makeDb = (repo: ScratchRepo): {
    db: Db;
    repoId: number;
    dbPath: string;
  } => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vh-ticket-dispatch-")),
    );
    dbRoots.push(root);
    const dbPath = path.join(root, "operational.sqlite");
    const db = openDb(dbPath);
    dbs.push(db);
    const row = upsertRepo(db, repo.work, null, "main", NOW);
    return { db, repoId: row.id, dbPath };
  };

  const context = (
    repoId: number,
    requestId: string,
  ): OperationContext => ({
    repoId,
    actor: "agent:reviewer",
    requestId,
    now: NOW,
  });

  it("registers and serves all three reads through the default provider", () => {
    const repo = makeRepo();
    const published = publishSingleTicket(repo.work);
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });

    expect(dispatcher.operations()).toEqual(expect.arrayContaining([
      "ticket.graph.snapshot",
      "ticket.subject.inspect",
      "ticket.trace.list",
    ]));
    const graph = dispatcher.dispatch(
      "ticket.graph.snapshot",
      context(repoId, "ticket-graph"),
      {},
    );
    expect(graph).toMatchObject({
      ok: true,
      data: {
        snapshotId: published.snapshotId,
        summary: { ticketCount: 1, directUnlockCount: 0 },
        page: { count: 1, totalItems: 1 },
      },
      meta: {
        operation: "ticket.graph.snapshot",
        repoId,
        requestId: "ticket-graph",
      },
    });
    expect(dispatcher.dispatch(
      "ticket.subject.inspect",
      context(repoId, "ticket-inspect"),
      {
        snapshotId: published.snapshotId,
        subject: { kind: "ticket", ticketId: "TKT-001" },
      },
    )).toMatchObject({
      ok: true,
      data: {
        snapshotId: published.snapshotId,
        subject: {
          kind: "ticket",
          ticket: { ticketId: "TKT-001", definitionRevision: 1 },
        },
      },
    });
    expect(dispatcher.dispatch(
      "ticket.trace.list",
      context(repoId, "ticket-trace"),
      {
        snapshotId: published.snapshotId,
        subject: { kind: "ticket", ticketId: "TKT-001" },
      },
    )).toMatchObject({
      ok: true,
      data: {
        snapshotId: published.snapshotId,
        records: [],
        page: { count: 0, totalItems: 0 },
      },
    });
  });

  it("keeps validation, absence, expiry, and corruption as stable envelopes", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });

    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context(repoId, "invalid-page"),
      { pageSize: 0 },
    )).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context(repoId, "absent-graph"),
      {},
    )).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(dispatcher.dispatch(
      "ticket.subject.inspect",
      context(repoId, "expired-snapshot"),
      {
        snapshotId: `tgs-${"a".repeat(64)}`,
        subject: { kind: "ticket", ticketId: "TKT-001" },
      },
    )).toMatchObject({
      ok: false,
      error: { code: "snapshot_expired" },
    });

    const published = publishSingleTicket(repo.work);
    fs.appendFileSync(published.revisionPath, "\n");
    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context(repoId, "corrupt-graph"),
      {},
    )).toMatchObject({
      ok: false,
      error: { code: "ticket_store_corrupt" },
    });
  });

  it("binds receipts to the verified worktree before replay", () => {
    const repo = makeRepo();
    publishSingleTicket(repo.work);
    const linked = path.join(repo.root, "linked");
    git(repo.work, "worktree", "add", "-b", "ticket-linked", linked);
    const { db, repoId } = makeDb(repo);
    const request = context(repoId, "worktree-bound-request");

    const main = new OperationDispatcher(db, {
      repoRoot: repo.work,
    }).dispatch("ticket.graph.snapshot", request, {});
    expect(main).toMatchObject({ ok: true });

    const linkedAttempt = new OperationDispatcher(db, {
      repoRoot: linked,
    }).dispatch("ticket.graph.snapshot", request, {});
    expect(linkedAttempt).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
  });

  it("rejects a foreign repository before a prior receipt can replay", () => {
    const addressed = makeRepo();
    const foreign = makeRepo();
    publishSingleTicket(addressed.work);
    const { db, repoId } = makeDb(addressed);
    const request = context(repoId, "foreign-scope-request");

    expect(new OperationDispatcher(db, {
      repoRoot: addressed.work,
    }).dispatch("ticket.graph.snapshot", request, {})).toMatchObject({
      ok: true,
    });
    expect(new OperationDispatcher(db, {
      repoRoot: foreign.work,
    }).dispatch("ticket.graph.snapshot", request, {})).toMatchObject({
      ok: false,
      error: { code: "ticket_store_scope_mismatch" },
    });
  });

  it("does not replay a receipt after a Git repository is replaced in place", () => {
    const repo = makeRepo();
    publishSingleTicket(repo.work);
    const { db, repoId } = makeDb(repo);
    const request = context(repoId, "repository-incarnation-request");
    expect(new OperationDispatcher(db, {
      repoRoot: repo.work,
    }).dispatch("ticket.graph.snapshot", request, {})).toMatchObject({
      ok: true,
    });

    const retired = path.join(repo.root, "retired-work");
    fs.renameSync(repo.work, retired);
    fs.mkdirSync(repo.work);
    git(repo.work, "init", "-b", "main");
    fs.writeFileSync(path.join(repo.work, "README.md"), "# replacement\n");
    git(repo.work, "add", "README.md");
    git(repo.work, "commit", "-m", "replacement repository");

    expect(new OperationDispatcher(db, {
      repoRoot: repo.work,
    }).dispatch("ticket.graph.snapshot", request, {})).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
  });

  it("does not hold an immediate SQLite transaction while reading files", () => {
    const repo = makeRepo();
    const { db, repoId, dbPath } = makeDb(repo);
    const provider = {
      loadLatest: () => {
        const concurrent = openDb(dbPath);
        try {
          upsertRepo(
            concurrent,
            path.join(repo.root, "concurrent-repository"),
            null,
            "main",
            NOW,
          );
        } finally {
          concurrent.close();
        }
        return { status: "no_ticket_graph" as const };
      },
      loadSnapshot: () => ({ status: "snapshot_expired" as const }),
    };
    expect(new OperationDispatcher(db, {
      repoRoot: repo.work,
      ticketReviewProvider: provider,
    }).dispatch(
      "ticket.graph.snapshot",
      context(repoId, "non-blocking-ticket-read"),
      {},
    )).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(db.prepare(
      `SELECT 1 present FROM repos WHERE root_path=?`,
    ).get(path.join(repo.root, "concurrent-repository"))).toEqual({
      present: 1,
    });
  });

  it("deduplicates large Ticket read payloads across distinct request receipts", () => {
    const repo = makeRepo();
    const published = publishSingleTicket(
      repo.work,
      `Large review payload: ${"x".repeat(18_000)}`,
    );
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });

    for (let index = 0; index < 12; index += 1) {
      const at = new Date(Date.parse(NOW) + index * 1_000).toISOString();
      expect(dispatcher.dispatch(
        "ticket.graph.snapshot",
        {
          ...context(repoId, `deduplicated-ticket-read-${index}`),
          now: at,
        },
        {},
      )).toMatchObject({
        ok: true,
        meta: {
          requestId: `deduplicated-ticket-read-${index}`,
          at,
        },
      });
    }

    const receipts = db.prepare(
      `SELECT COUNT(*) count,
              COUNT(DISTINCT outcome_blob_digest) distinctPayloads,
              MAX(length(outcome)) maximumReceiptBytes
       FROM operation_request_receipts
       WHERE repo_id=? AND operation='ticket.graph.snapshot'`,
    ).get(repoId) as {
      count:number;
      distinctPayloads:number;
      maximumReceiptBytes:number;
    };
    expect(receipts).toMatchObject({count:12,distinctPayloads:1});
    expect(receipts.maximumReceiptBytes).toBeLessThan(160);
    const blob = db.prepare(
      `SELECT COUNT(*) count,MIN(byte_length) minimumBytes,
              MAX(byte_length) maximumBytes
       FROM operation_outcome_blobs`,
    ).get() as {
      count:number;
      minimumBytes:number;
      maximumBytes:number;
    };
    expect(blob.count).toBe(1);
    expect(blob.minimumBytes).toBe(blob.maximumBytes);
    expect(blob.minimumBytes).toBeGreaterThan(18_000);
    expect(() => db.prepare(
      `UPDATE operation_outcome_blobs SET created_at=?`,
    ).run("2026-07-28T13:00:00.000Z")).toThrow(/immutable/);
    expect(() => db.prepare(
      `DELETE FROM operation_outcome_blobs`,
    ).run()).toThrow(/immutable/);

    const replayed = new OperationDispatcher(db, {
      repoRoot: repo.work,
    }).dispatch(
      "ticket.graph.snapshot",
      context(repoId, "deduplicated-ticket-read-0"),
      {},
    );
    expect(replayed).toMatchObject({
      ok: true,
      data: {
        tickets: [{
          outcome: expect.stringContaining("Large review payload"),
        }],
      },
      meta: {
        requestId: "deduplicated-ticket-read-0",
        at: NOW,
      },
    });

    expect(dispatcher.dispatch(
      "ticket.subject.inspect",
      context(repoId, "distinct-ticket-inspection"),
      {
        snapshotId: published.snapshotId,
        subject: {kind:"ticket",ticketId:"TKT-001"},
      },
    )).toMatchObject({ok:true});
    expect(db.prepare(
      `SELECT COUNT(*) count FROM operation_outcome_blobs`,
    ).get()).toEqual({count:2});

    expect(dispatcher.dispatch(
      "kb.status",
      context(repoId, "inline-kb-read"),
      {},
    )).toMatchObject({ok:true});
    const inline = db.prepare(
      `SELECT outcome_blob_digest outcomeBlobDigest,
              json_type(outcome,'$.data') dataType
       FROM operation_request_receipts
       WHERE repo_id=? AND request_id='inline-kb-read'`,
    ).get(repoId);
    expect(inline).toEqual({outcomeBlobDigest:null,dataType:"object"});
  });

  it("fails closed on an outcome digest collision and rejects cross-family blob bindings", () => {
    const repo = makeRepo();
    publishSingleTicket(repo.work);
    const source = makeDb(repo);
    expect(new OperationDispatcher(source.db, {
      repoRoot: repo.work,
    }).dispatch(
      "ticket.graph.snapshot",
      context(source.repoId, "derive-ticket-outcome-digest"),
      {},
    )).toMatchObject({ok:true});
    const canonical = source.db.prepare(
      `SELECT digest,outcome_kind outcomeKind
       FROM operation_outcome_blobs`,
    ).get() as {digest:string;outcomeKind:"success"};

    const target = makeDb(repo);
    const wrongPayload = JSON.stringify({wrong:true});
    target.db.prepare(
      `INSERT INTO operation_outcome_blobs(
         digest,outcome_kind,payload,byte_length,created_at
       ) VALUES(?,?,?,?,?)`,
    ).run(
      canonical.digest,
      canonical.outcomeKind,
      wrongPayload,
      Buffer.byteLength(wrongPayload, "utf8"),
      NOW,
    );

    expect(new OperationDispatcher(target.db, {
      repoRoot: repo.work,
    }).dispatch(
      "ticket.graph.snapshot",
      context(target.repoId, "colliding-ticket-outcome"),
      {},
    )).toMatchObject({
      ok:false,
      error:{
        code:"internal_error",
        message:"operation outcome blob digest collision or corruption",
      },
    });
    expect(target.db.prepare(
      `SELECT COUNT(*) count FROM operation_request_receipts`,
    ).get()).toEqual({count:0});

    const stub = JSON.stringify({
      ok:true,
      outcomeBlob:canonical.digest,
    });
    expect(() => target.db.prepare(
      `INSERT INTO operation_request_receipts(
         repo_id,request_id,operation,payload_hash,
         outcome_kind,outcome,created_at,outcome_blob_digest
       ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      target.repoId,
      "invalid-kb-blob-binding",
      "kb.status",
      "payload-hash",
      "success",
      stub,
      NOW,
      canonical.digest,
    )).toThrow(/blob binding is invalid/);
  });

  it("atomically records and replays a proposal without publishing a graph", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });
    expect(dispatcher.operations()).toContain("ticket.proposal.submit");
    const request = context(repoId, "bootstrap-ticket-proposal");
    const input = bootstrapProposalInput();

    const submitted = dispatcher.dispatch(
      "ticket.proposal.submit",
      request,
      input,
    );
    expect(submitted).toMatchObject({
      ok: true,
      data: {
        kind: "graph_change",
        effect: "review_contribution_only",
        graphMutationApplied: false,
        reviewRequirement: {
          authorityStatus: "not_granted",
        },
      },
      meta: {
        operation: "ticket.proposal.submit",
        requestId: "bootstrap-ticket-proposal",
        at: NOW,
      },
    });
    expect(fs.existsSync(path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
    ))).toBe(false);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM operation_request_receipts
       WHERE operation='ticket.proposal.submit'
         AND outcome_blob_digest IS NOT NULL`,
    ).get()).toEqual({ count: 1 });

    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      request,
      input,
    )).toEqual(submitted);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 1 });

    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      request,
      bootstrapProposalInput("A different logical proposal"),
    )).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 1 });
  });

  it("dispatches the complete immutable proposal and validation ledger", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });
    const submitted = dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "ledger-submit"),
      bootstrapProposalInput(),
    );
    if (!submitted.ok) throw new Error("expected proposal submission");
    const proposal = submitted.data as TicketGraphChangeProposalV0;

    const inspected = dispatcher.dispatch(
      "ticket.proposal.inspect",
      context(repoId, "ledger-proposal-inspect"),
      { proposalId: proposal.proposalId },
    );
    expect(inspected).toMatchObject({ ok: true, data: proposal });

    const listed = dispatcher.dispatch(
      "ticket.proposal.list",
      context(repoId, "ledger-proposal-list"),
      { kind: "graph_change", observedSnapshotId: null, limit: 10 },
    );
    if (!listed.ok) throw new Error("expected proposal list");
    expect((listed.data as TicketProposalLedgerPageV0).items).toEqual([
      expect.objectContaining({
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
        kind: "graph_change",
        observedSnapshotId: null,
      }),
    ]);

    const validationInput = passingProposalValidationInput(proposal);
    const recorded = dispatcher.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "ledger-validation-record"),
      validationInput,
    );
    if (!recorded.ok) throw new Error("expected validation record");
    const validation = recorded.data as TicketProposalValidationReceiptV0;
    expect(validation).toMatchObject({
      target: {
        proposalId: proposal.proposalId,
        proposalDigest: proposal.proposalDigest,
        candidateDigest: proposal.mechanicalReview.candidateDigest,
      },
      conclusion: "passed",
      effect: "validation_evidence_only",
      maturityEffect: "none",
      authorityGranted: false,
      applicationAuthorized: false,
      graphMutationApplied: false,
      producer: { trust: "claimed_unverified" },
      policy: { trust: "claimed_unverified" },
    });
    expect(validation.checks).toHaveLength(6);
    expect(dispatcher.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "ledger-validation-record"),
      validationInput,
    )).toEqual(recorded);

    expect(dispatcher.dispatch(
      "ticket.proposal.validation.inspect",
      context(repoId, "ledger-validation-inspect"),
      { validationReceiptId: validation.validationReceiptId },
    )).toMatchObject({ ok: true, data: validation });

    const validationList = dispatcher.dispatch(
      "ticket.proposal.validation.list",
      context(repoId, "ledger-validation-list"),
      { proposalId: proposal.proposalId, limit: 10 },
    );
    if (!validationList.ok) throw new Error("expected validation list");
    expect(
      (validationList.data as TicketProposalValidationLedgerPageV0).items,
    ).toEqual([
      expect.objectContaining({
        validationReceiptId: validation.validationReceiptId,
        proposalId: proposal.proposalId,
        conclusion: "passed",
        checkCount: 6,
        effect: "validation_evidence_only",
        maturityEffect: "none",
        authorityGranted: false,
        applicationAuthorized: false,
        graphMutationApplied: false,
      }),
    ]);

    expect(db.prepare(
      `SELECT operation
       FROM operation_request_receipts
       WHERE operation LIKE 'ticket.proposal.%'
       ORDER BY operation`,
    ).all()).toEqual([
      { operation: "ticket.proposal.inspect" },
      { operation: "ticket.proposal.list" },
      { operation: "ticket.proposal.submit" },
      { operation: "ticket.proposal.validation.inspect" },
      { operation: "ticket.proposal.validation.list" },
      { operation: "ticket.proposal.validation.record" },
    ]);
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM operation_request_receipts
       WHERE operation LIKE 'ticket.proposal.%'
         AND outcome_blob_digest IS NOT NULL`,
    ).get()).toEqual({ count: 6 });
    expect(dispatcher.operations()).toEqual(expect.arrayContaining([
      "ticket.proposal.review.inspect",
      "ticket.proposal.authority.decide",
      "ticket.proposal.apply",
    ]));
  });

  it("requires trusted human bootstrap authority then applies through a fenced publication", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const untrusted = new OperationDispatcher(db, { repoRoot: repo.work });
    const submitted = untrusted.dispatch(
      "ticket.proposal.submit",
      context(repoId, "application-bootstrap-submit"),
      bootstrapProposalInput(),
    );
    if (!submitted.ok) throw new Error("expected proposal submission");
    const proposal = submitted.data as TicketGraphChangeProposalV0;
    const recorded = untrusted.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "application-bootstrap-validation"),
      passingProposalValidationInput(proposal),
    );
    if (!recorded.ok) throw new Error("expected proposal validation");
    const validation = recorded.data as TicketProposalValidationReceiptV0;

    const reviewed = untrusted.dispatch(
      "ticket.proposal.review.inspect",
      context(repoId, "application-bootstrap-review"),
      { proposalId: proposal.proposalId },
    );
    if (!reviewed.ok) throw new Error("expected proposal review");
    const packet = reviewed.data as TicketProposalReviewPacketV0;
    expect(packet).toMatchObject({
      eligibility: { status: "authority_required" },
      nextAction: "request_authority_decision",
      validationSet: { count: 1 },
    });
    expect(untrusted.dispatch(
      "ticket.proposal.authority.decide",
      context(repoId, "application-bootstrap-untrusted-decision"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        expectedValidationSetDigest: packet.validationSet.digest,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "trusted_authority_unavailable" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM operation_request_receipts
       WHERE request_id='application-bootstrap-untrusted-decision'`,
    ).get()).toEqual({ count: 0 });

    const authorityProvider: TrustedTicketProposalAuthorityProviderV0 = {
      decide(request) {
        expect(request.requiredPath).toBe("human_authority");
        expect(request.validationSet.digest).toBe(packet.validationSet.digest);
        return {
          disposition: "authorized",
          provider: {
            kind: "trusted_host_authority_provider",
            id: "test.host-authority",
            version: "1",
            artifactDigest: "3".repeat(64),
            trust: "host_injected",
          },
          principal: {
            kind: "human",
            ref: "human:test-reviewer",
            authenticationContextDigest: "4".repeat(64),
            trust: "host_authenticated",
          },
          basis: {
            kind: "human_authority",
            ref: "decision-sheet:test",
            digest: "5".repeat(64),
          },
          acceptedValidations: [{
            validationReceiptId: validation.validationReceiptId,
            validationReceiptDigest: validation.validationReceiptDigest,
          }],
          resolvedAssessment: {
            changeClass: "decomposition",
            authoritySignals: ["initial_plan_authority"],
          },
          rationale: "The authenticated human accepted the foundational Ticket plan.",
        };
      },
    };
    const trusted = new OperationDispatcher(db, {
      repoRoot: repo.work,
      ticketAuthorityProvider: authorityProvider,
    });
    const decided = trusted.dispatch(
      "ticket.proposal.authority.decide",
      context(repoId, "application-bootstrap-trusted-decision"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        expectedValidationSetDigest: packet.validationSet.digest,
      },
    );
    if (!decided.ok) {
      throw new Error(`expected trusted authority decision: ${JSON.stringify(decided)}`);
    }
    expect(decided).toMatchObject({
      ok: true,
      data: {
        disposition: "authorized",
        requiredPath: "human_authority",
        authorityGranted: true,
        applicationAuthorized: true,
        graphMutationApplied: false,
      },
    });
    const decision = decided.data as {
      authorityDecisionId: string;
      authorityDecisionDigest: string;
    };
    expect(trusted.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "application-bootstrap-validation-after-decision"),
      passingProposalValidationInput(proposal),
    )).toMatchObject({
      ok: false,
      error: {
        code: "invalid_state_transition",
        details: {
          proposalId: proposal.proposalId,
          authorityDecisionId: decision.authorityDecisionId,
          disposition: "authorized",
        },
      },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM ticket_proposal_validation_receipts
       WHERE proposal_id=?`,
    ).get(proposal.proposalId)).toEqual({ count: 1 });

    db.exec(`
      CREATE TRIGGER reject_first_ticket_application_receipt
      BEFORE INSERT ON ticket_proposal_application_receipts
      BEGIN SELECT RAISE(ABORT,'injected application receipt failure'); END;
    `);
    const interrupted = trusted.dispatch(
      "ticket.proposal.apply",
      context(repoId, "application-bootstrap-apply"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        authorityDecisionId: decision.authorityDecisionId,
        expectedAuthorityDecisionDigest:
          decision.authorityDecisionDigest,
      },
    );
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_application_intents`,
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_application_receipts`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM operation_request_receipts
       WHERE request_id='application-bootstrap-apply'`,
    ).get()).toEqual({ count: 0 });
    expect(fs.existsSync(path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
    ))).toBe(true);
    expect(fs.existsSync(ticketWriterLockRoot(repo.work))).toBe(true);

    const originalIntentRow = db.prepare(
      `SELECT application_intent_digest applicationIntentDigest,
              candidate_snapshot_id candidateSnapshotId,
              payload,candidate_definitions candidateDefinitions
       FROM ticket_proposal_application_intents
       WHERE proposal_id=?`,
    ).get(proposal.proposalId) as {
      applicationIntentDigest: string;
      candidateSnapshotId: string;
      payload: string;
      candidateDefinitions: string;
    };
    const originalIntent = JSON.parse(originalIntentRow.payload) as {
      applicationIntentDigest: string;
      publication: {
        storeId: string;
        candidateSnapshotId: string;
      };
      [key: string]: unknown;
    };
    const originalDefinitions = JSON.parse(
      originalIntentRow.candidateDefinitions,
    ) as GitTicketDefinitionRevisionV0[];
    const corruptDefinitions = originalDefinitions.map((
      item,
      index,
    ) => index === 0
      ? { ...item, outcome: `${item.outcome} — unauthorized substitution` }
      : item);
    const corruptPrepared = prepareGitTicketGenerationV0(
      originalIntent.publication.storeId,
      corruptDefinitions,
    );
    const {
      applicationIntentDigest: _originalDigest,
      ...originalIntentContent
    } = originalIntent;
    const corruptIntentContent = {
      ...originalIntentContent,
      publication: {
        ...originalIntent.publication,
        candidateSnapshotId: corruptPrepared.generation.snapshotId,
      },
    };
    const corruptIntent = {
      ...corruptIntentContent,
      applicationIntentDigest: ticketProposalDomainDigestV0(
        "vibehub.ticket-proposal-application-intent.v1",
        corruptIntentContent,
      ),
    };
    const corruptPayload = serializeGitTicketStoreDocumentV0(corruptIntent);
    const corruptCandidateDefinitions =
      serializeGitTicketStoreDocumentV0(corruptDefinitions);
    db.exec(
      "DROP TRIGGER ticket_proposal_application_intents_immutable_update",
    );
    db.prepare(
      `UPDATE ticket_proposal_application_intents
       SET application_intent_digest=?,candidate_snapshot_id=?,
           payload=?,byte_length=?,
           candidate_definitions=?,candidate_byte_length=?
       WHERE proposal_id=?`,
    ).run(
      corruptIntent.applicationIntentDigest,
      corruptPrepared.generation.snapshotId,
      corruptPayload,
      Buffer.byteLength(corruptPayload, "utf8"),
      corruptCandidateDefinitions,
      Buffer.byteLength(corruptCandidateDefinitions, "utf8"),
      proposal.proposalId,
    );
    expect(trusted.dispatch(
      "ticket.proposal.apply",
      context(repoId, "application-bootstrap-corrupt-candidate"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        authorityDecisionId: decision.authorityDecisionId,
        expectedAuthorityDecisionDigest:
          decision.authorityDecisionDigest,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    db.prepare(
      `UPDATE ticket_proposal_application_intents
       SET application_intent_digest=?,candidate_snapshot_id=?,
           payload=?,byte_length=?,
           candidate_definitions=?,candidate_byte_length=?
       WHERE proposal_id=?`,
    ).run(
      originalIntentRow.applicationIntentDigest,
      originalIntentRow.candidateSnapshotId,
      originalIntentRow.payload,
      Buffer.byteLength(originalIntentRow.payload, "utf8"),
      originalIntentRow.candidateDefinitions,
      Buffer.byteLength(originalIntentRow.candidateDefinitions, "utf8"),
      proposal.proposalId,
    );
    db.exec(`
      CREATE TRIGGER ticket_proposal_application_intents_immutable_update
      BEFORE UPDATE ON ticket_proposal_application_intents
      BEGIN SELECT RAISE(ABORT,
        'Ticket proposal application intents are immutable'); END;
    `);

    db.exec("DROP TRIGGER reject_first_ticket_application_receipt");
    const applied = trusted.dispatch(
      "ticket.proposal.apply",
      context(repoId, "application-bootstrap-apply-reconcile"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        authorityDecisionId: decision.authorityDecisionId,
        expectedAuthorityDecisionDigest:
          decision.authorityDecisionDigest,
      },
    );
    expect(applied).toMatchObject({
      ok: true,
      data: {
        kind: "ticket_proposal_application_receipt",
        target: { proposalId: proposal.proposalId },
        publication: {
          status: "reconciled",
          previousSnapshotId: null,
          ticketCount: 1,
          directUnlockCount: 0,
        },
        effect: "ticket_graph_publication",
        graphMutationApplied: true,
      },
    });
    if (!applied.ok) throw new Error("expected proposal application");
    const application = applied.data as TicketProposalApplicationReceiptV0;
    expect(fs.existsSync(path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
    ))).toBe(true);
    expect(fs.existsSync(ticketWriterLockRoot(repo.work))).toBe(false);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_application_intents`,
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_application_receipts`,
    ).get()).toEqual({ count: 1 });

    writeTicketWriterLock(repo.work, {
      schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
      format: "vibehub.git-ticket-writer-lock",
      token: crypto.randomUUID(),
      pid: process.pid,
      hostname: "post-commit-crash.test",
      acquiredAt: NOW,
      fence: {
        applicationIntentId: application.applicationIntentId,
        intentDigest: application.applicationIntentDigest,
        candidateSnapshotId: application.publication.snapshotId,
      },
    });
    expect(trusted.dispatch(
      "ticket.proposal.apply",
      context(repoId, "application-bootstrap-apply-release-stale-fence"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        authorityDecisionId: decision.authorityDecisionId,
        expectedAuthorityDecisionDigest:
          decision.authorityDecisionDigest,
      },
    )).toMatchObject({
      ok: true,
      data: {
        applicationReceiptId: application.applicationReceiptId,
      },
    });
    expect(fs.existsSync(ticketWriterLockRoot(repo.work))).toBe(false);

    expect(trusted.dispatch(
      "ticket.proposal.review.inspect",
      context(repoId, "application-bootstrap-review-applied"),
      { proposalId: proposal.proposalId },
    )).toMatchObject({
      ok: true,
      data: {
        eligibility: { status: "applied" },
        application: {
          applicationReceiptId: application.applicationReceiptId,
        },
        nextAction: "inspect_application",
      },
    });
    expect(trusted.dispatch(
      "ticket.graph.snapshot",
      context(repoId, "application-bootstrap-graph"),
      {},
    )).toMatchObject({
      ok: true,
      data: {
        snapshotId: application.publication.snapshotId,
        summary: { ticketCount: 1 },
      },
    });
  });

  it("allows trusted delegated policy to apply an unprotected elaboration", () => {
    const repo = makeRepo();
    const published = publishSingleTicket(repo.work);
    const { db, repoId } = makeDb(repo);
    let acceptedValidation: TicketProposalValidationReceiptV0 | undefined;
    const authorityProvider: TrustedTicketProposalAuthorityProviderV0 = {
      decide(request) {
        expect(request.requiredPath).toBe("delegated_policy");
        expect(request.validationSet.validations).toHaveLength(1);
        return {
          disposition: "authorized",
          provider: {
            kind: "trusted_host_authority_provider",
            id: "test.delegated-policy",
            version: "1",
            artifactDigest: "3".repeat(64),
            trust: "host_injected",
          },
          principal: {
            kind: "service",
            ref: "service:test-policy",
            authenticationContextDigest: "4".repeat(64),
            trust: "host_authenticated",
          },
          basis: {
            kind: "delegation",
            ref: "accepted-plan:test",
            digest: "5".repeat(64),
          },
          acceptedValidations: [{
            validationReceiptId:
              request.validationSet.validations[0]!.validationReceiptId,
            validationReceiptDigest:
              request.validationSet.validations[0]!.validationReceiptDigest,
          }],
          resolvedAssessment: {
            changeClass: "elaboration",
            authoritySignals: [],
          },
          rationale: "This remains inside the accepted technical boundary.",
        };
      },
    };
    const dispatcher = new OperationDispatcher(db, {
      repoRoot: repo.work,
      ticketAuthorityProvider: authorityProvider,
    });
    const submitted = dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "delegated-application-submit"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: published.snapshotId,
        reason: "Add executable detail without widening the accepted outcome",
        source: { kind: "plan", ref: "plan:delegated-application" },
        authorAssessment: {
          changeClass: "elaboration",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "This is implementation detail inside the accepted plan.",
        },
        changes: [{
          op: "revise",
          ticketId: "TKT-001",
          expectedDefinitionRevision: 1,
          replacement: {
            outcome:
              "Expose the canonical Ticket graph through stable operations",
            parent: null,
            dependsOn: [],
          },
        }],
      },
    );
    if (!submitted.ok) throw new Error("expected proposal submission");
    const proposal = submitted.data as TicketGraphChangeProposalV0;
    const validationResult = dispatcher.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "delegated-application-validation"),
      passingProposalValidationInput(proposal),
    );
    if (!validationResult.ok) throw new Error("expected proposal validation");
    acceptedValidation =
      validationResult.data as TicketProposalValidationReceiptV0;
    const reviewed = dispatcher.dispatch(
      "ticket.proposal.review.inspect",
      context(repoId, "delegated-application-review"),
      { proposalId: proposal.proposalId },
    );
    if (!reviewed.ok) throw new Error("expected proposal review");
    const packet = reviewed.data as TicketProposalReviewPacketV0;
    expect(packet).toMatchObject({
      eligibility: { status: "authority_required" },
      nextAction: "request_authority_decision",
    });

    const decided = dispatcher.dispatch(
      "ticket.proposal.authority.decide",
      context(repoId, "delegated-application-decision"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        expectedValidationSetDigest: packet.validationSet.digest,
      },
    );
    if (!decided.ok) throw new Error("expected delegated authority decision");
    expect(decided).toMatchObject({
      data: {
        disposition: "authorized",
        requiredPath: "delegated_policy",
        principal: { kind: "service" },
        basis: { kind: "delegation" },
      },
    });
    const decision = decided.data as {
      authorityDecisionId: string;
      authorityDecisionDigest: string;
    };
    expect(acceptedValidation).toBeDefined();
    const applied = dispatcher.dispatch(
      "ticket.proposal.apply",
      context(repoId, "delegated-application-apply"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        authorityDecisionId: decision.authorityDecisionId,
        expectedAuthorityDecisionDigest:
          decision.authorityDecisionDigest,
      },
    );
    expect(applied).toMatchObject({
      ok: true,
      data: {
        publication: {
          status: "published",
          previousSnapshotId: published.snapshotId,
          ticketCount: 1,
        },
      },
    });
    expect(dispatcher.dispatch(
      "ticket.graph.snapshot",
      context(repoId, "delegated-application-graph"),
      {},
    )).toMatchObject({
      ok: true,
      data: {
        tickets: [{
          ticketId: "TKT-001",
          definitionRevision: 2,
          outcome:
            "Expose the canonical Ticket graph through stable operations",
        }],
      },
    });
  });

  it("does not let delegated policy erase a protected authority signal", () => {
    const repo = makeRepo();
    const published = publishSingleTicket(repo.work);
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, {
      repoRoot: repo.work,
      ticketAuthorityProvider: {
        decide(request) {
          expect(request.requiredPath).toBe("human_authority");
          const validation = request.validationSet.validations[0]!;
          return {
            disposition: "authorized",
            provider: {
              kind: "trusted_host_authority_provider",
              id: "test.invalid-delegated-policy",
              version: "1",
              artifactDigest: "3".repeat(64),
              trust: "host_injected",
            },
            principal: {
              kind: "service",
              ref: "service:test-policy",
              authenticationContextDigest: "4".repeat(64),
              trust: "host_authenticated",
            },
            basis: {
              kind: "delegation",
              ref: "accepted-plan:test",
              digest: "5".repeat(64),
            },
            acceptedValidations: [{
              validationReceiptId: validation.validationReceiptId,
              validationReceiptDigest: validation.validationReceiptDigest,
            }],
            resolvedAssessment: {
              changeClass: "elaboration",
              authoritySignals: [],
            },
            rationale: "The service attempted to stay on its delegated path.",
          };
        },
      },
    });
    const submitted = dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "protected-delegation-submit"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: published.snapshotId,
        reason: "Change a protected product experience",
        authorAssessment: {
          changeClass: "elaboration",
          authoritySignals: ["experience_product"],
          introducesHumanGate: false,
          rationale: "The visible experience changes.",
        },
        changes: [{
          op: "revise",
          ticketId: "TKT-001",
          expectedDefinitionRevision: 1,
          replacement: {
            outcome: "Expose a redesigned Ticket experience",
            parent: null,
            dependsOn: [],
          },
        }],
      },
    );
    if (!submitted.ok) throw new Error("expected proposal submission");
    const proposal = submitted.data as TicketGraphChangeProposalV0;
    expect(dispatcher.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "protected-delegation-validation"),
      passingProposalValidationInput(proposal),
    )).toMatchObject({ ok: true });
    const reviewed = dispatcher.dispatch(
      "ticket.proposal.review.inspect",
      context(repoId, "protected-delegation-review"),
      { proposalId: proposal.proposalId },
    );
    if (!reviewed.ok) throw new Error("expected proposal review");
    const packet = reviewed.data as TicketProposalReviewPacketV0;
    expect(dispatcher.dispatch(
      "ticket.proposal.authority.decide",
      context(repoId, "protected-delegation-decision"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        expectedValidationSetDigest: packet.validationSet.digest,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "authority_proof_invalid" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({ count: 0 });
  });

  it("does not hold a write transaction across trusted authority resolution", () => {
    const repo = makeRepo();
    const { db, repoId, dbPath } = makeDb(repo);
    const untrusted = new OperationDispatcher(db, { repoRoot: repo.work });
    const submitted = untrusted.dispatch(
      "ticket.proposal.submit",
      context(repoId, "authority-outside-transaction-submit"),
      bootstrapProposalInput(),
    );
    if (!submitted.ok) throw new Error("expected proposal submission");
    const proposal = submitted.data as TicketGraphChangeProposalV0;
    const firstValidationResult = untrusted.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "authority-outside-transaction-validation-1"),
      passingProposalValidationInput(proposal),
    );
    if (!firstValidationResult.ok) {
      throw new Error("expected initial proposal validation");
    }
    const firstValidation =
      firstValidationResult.data as TicketProposalValidationReceiptV0;
    const reviewed = untrusted.dispatch(
      "ticket.proposal.review.inspect",
      context(repoId, "authority-outside-transaction-review"),
      { proposalId: proposal.proposalId },
    );
    if (!reviewed.ok) throw new Error("expected proposal review");
    const packet = reviewed.data as TicketProposalReviewPacketV0;

    const trusted = new OperationDispatcher(db, {
      repoRoot: repo.work,
      ticketAuthorityProvider: {
        decide() {
          const concurrent = openDb(dbPath);
          try {
            expect(new OperationDispatcher(concurrent, {
              repoRoot: repo.work,
            }).dispatch(
              "ticket.proposal.validation.record",
              context(
                repoId,
                "authority-outside-transaction-validation-2",
              ),
              passingProposalValidationInput(proposal),
            )).toMatchObject({ ok: true });
          } finally {
            concurrent.close();
          }
          return {
            disposition: "authorized",
            provider: {
              kind: "trusted_host_authority_provider",
              id: "test.concurrent-authority",
              version: "1",
              artifactDigest: "3".repeat(64),
              trust: "host_injected",
            },
            principal: {
              kind: "human",
              ref: "human:test-reviewer",
              authenticationContextDigest: "4".repeat(64),
              trust: "host_authenticated",
            },
            basis: {
              kind: "human_authority",
              ref: "decision-sheet:test",
              digest: "5".repeat(64),
            },
            acceptedValidations: [{
              validationReceiptId: firstValidation.validationReceiptId,
              validationReceiptDigest:
                firstValidation.validationReceiptDigest,
            }],
            resolvedAssessment: {
              changeClass: "decomposition",
              authoritySignals: ["initial_plan_authority"],
            },
            rationale: "The original complete evidence set was accepted.",
          };
        },
      },
    });
    expect(trusted.dispatch(
      "ticket.proposal.authority.decide",
      context(repoId, "authority-outside-transaction-decision"),
      {
        schemaVersion: 1,
        proposalId: proposal.proposalId,
        expectedProposalDigest: proposal.proposalDigest,
        expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
        expectedValidationSetDigest: packet.validationSet.digest,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "cas_conflict" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_validation_receipts`,
    ).get()).toEqual({ count: 2 });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposal_authority_decisions`,
    ).get()).toEqual({ count: 0 });
  });

  it("rolls back validation evidence when its operation receipt cannot persist", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });
    const submitted = dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "validation-rollback-target"),
      bootstrapProposalInput(),
    );
    if (!submitted.ok) throw new Error("expected proposal submission");
    const proposal = submitted.data as TicketGraphChangeProposalV0;

    db.exec(`
      CREATE TRIGGER reject_ticket_validation_operation_receipt
      BEFORE INSERT ON operation_request_receipts
      WHEN NEW.operation='ticket.proposal.validation.record'
      BEGIN SELECT RAISE(ABORT,'injected validation receipt failure'); END;
    `);
    expect(dispatcher.dispatch(
      "ticket.proposal.validation.record",
      context(repoId, "validation-receipt-failure"),
      passingProposalValidationInput(proposal),
    )).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM ticket_proposal_validation_receipts`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM operation_request_receipts
       WHERE request_id='validation-receipt-failure'`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 1 });
  });

  it("records comments only for exact current Ticket revisions", () => {
    const repo = makeRepo();
    const published = publishSingleTicket(repo.work);
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });
    const exact = {
      schemaVersion: 1,
      kind: "comment",
      observedSnapshotId: published.snapshotId,
      subject: {
        kind: "ticket",
        ticketId: "TKT-001",
        definitionRevision: 1,
      },
      body: "Preserve this exact outcome while executing the graph.",
    };
    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "exact-ticket-comment"),
      exact,
    )).toMatchObject({
      ok: true,
      data: {
        kind: "comment",
        subject: exact.subject,
        effect: "review_contribution_only",
        graphMutationApplied: false,
      },
    });
    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "stale-ticket-comment"),
      {
        ...exact,
        subject: { ...exact.subject, definitionRevision: 2 },
      },
    )).toMatchObject({
      ok: false,
      error: {
        code: "cas_conflict",
        nextSafeActions: [
          "Refresh ticket.graph.snapshot and submit a new proposal.",
        ],
      },
    });
    expect(db.prepare(
      `SELECT kind,COUNT(*) count FROM ticket_proposals GROUP BY kind`,
    ).all()).toEqual([{ kind: "comment", count: 1 }]);
  });

  it("returns proposal-specific repair guidance for graph and head conflicts", () => {
    const empty = makeRepo();
    const emptyDb = makeDb(empty);
    const cyclic = {
      ...bootstrapProposalInput(),
      changes: [{
        op: "create",
        localRef: "one",
        definition: {
          outcome: "One",
          parent: null,
          dependsOn: [{ target: { kind: "local", localRef: "two" } }],
        },
      }, {
        op: "create",
        localRef: "two",
        definition: {
          outcome: "Two",
          parent: null,
          dependsOn: [{ target: { kind: "local", localRef: "one" } }],
        },
      }],
    };
    expect(new OperationDispatcher(emptyDb.db, {
      repoRoot: empty.work,
    }).dispatch(
      "ticket.proposal.submit",
      context(emptyDb.repoId, "cyclic-ticket-proposal"),
      cyclic,
    )).toMatchObject({
      ok: false,
      error: {
        code: "ticket_store_publish_invalid",
        nextSafeActions: [
          "Correct the proposed Ticket definitions or relations and submit a new proposal.",
        ],
      },
    });

    const current = makeRepo();
    publishSingleTicket(current.work);
    const currentDb = makeDb(current);
    expect(new OperationDispatcher(currentDb.db, {
      repoRoot: current.work,
    }).dispatch(
      "ticket.proposal.submit",
      context(currentDb.repoId, "stale-head-proposal"),
      {
        ...bootstrapProposalInput(),
        observedSnapshotId: `tgs-${"f".repeat(64)}`,
      },
    )).toMatchObject({
      ok: false,
      error: {
        code: "ticket_store_cas_conflict",
        nextSafeActions: [
          "Refresh ticket.graph.snapshot and submit against its current snapshotId.",
        ],
      },
    });
  });

  it("rolls back proposal rows on validation or receipt failure", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });
    const duplicate = bootstrapProposalInput();
    duplicate.changes.push({
      ...duplicate.changes[0]!,
      definition: {
        ...duplicate.changes[0]!.definition,
        outcome: "Duplicate local identity",
      },
    });
    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "duplicate-local-proposal"),
      duplicate,
    )).toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT outcome_kind outcomeKind
       FROM operation_request_receipts
       WHERE request_id='duplicate-local-proposal'`,
    ).get()).toEqual({ outcomeKind: "error" });

    db.exec(`
      CREATE TRIGGER reject_ticket_proposal_receipt
      BEFORE INSERT ON operation_request_receipts
      WHEN NEW.operation='ticket.proposal.submit'
      BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;
    `);
    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "receipt-failure-proposal"),
      bootstrapProposalInput("This transaction must roll back"),
    )).toMatchObject({
      ok: false,
      error: { code: "internal_error" },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM operation_request_receipts
       WHERE request_id='receipt-failure-proposal'`,
    ).get()).toEqual({ count: 0 });
  });

  it("rejects oversized proposal input before hashing or persistence", () => {
    const repo = makeRepo();
    const { db, repoId } = makeDb(repo);
    const dispatcher = new OperationDispatcher(db, { repoRoot: repo.work });
    expect(dispatcher.dispatch(
      "ticket.proposal.submit",
      context(repoId, "oversized-ticket-proposal"),
      {
        schemaVersion: 1,
        kind: "comment",
        observedSnapshotId: `tgs-${"a".repeat(64)}`,
        subject: {
          kind: "ticket",
          ticketId: "TKT-001",
          definitionRevision: 1,
        },
        body: "x".repeat(TICKET_PROPOSAL_MAX_INPUT_BYTES),
      },
    )).toMatchObject({
      ok: false,
      error: {
        code: "validation_error",
        message: "operation input exceeds its safe JSON byte budget",
        details: {
          operation: "ticket.proposal.submit",
          maximumBytes: TICKET_PROPOSAL_MAX_INPUT_BYTES,
        },
      },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      `SELECT COUNT(*) count
       FROM operation_request_receipts
       WHERE request_id='oversized-ticket-proposal'`,
    ).get()).toEqual({ count: 0 });
  });

  it("binds proposal task attribution to the task's exact worktree", () => {
    const repo = makeRepo();
    const linked = path.join(repo.root, "proposal-task-worktree");
    git(repo.work, "worktree", "add", "-b", "proposal-task", linked);
    const { db, repoId } = makeDb(repo);
    upsertTask(db, {
      id: "task:proposal-linked",
      repoId,
      title: "Linked proposal task",
      state: "running",
      signalTier: "hooks",
      branch: "proposal-task",
      worktreePath: fs.realpathSync(linked),
      prNumber: null,
      prState: null,
      stateSince: NOW,
      lastEventAt: NOW,
      statusDetail: null,
      createdAt: NOW,
      startHeadSha: null,
    });

    expect(new OperationDispatcher(db, {
      repoRoot: repo.work,
    }).dispatch(
      "ticket.proposal.submit",
      {
        ...context(repoId, "wrong-task-worktree"),
        taskId: "task:proposal-linked",
      },
      bootstrapProposalInput(),
    )).toMatchObject({
      ok: false,
      error: {
        code: "ticket_store_scope_mismatch",
        message: "the proposal checkout does not match the task worktree",
      },
    });
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 0 });
  });
});
