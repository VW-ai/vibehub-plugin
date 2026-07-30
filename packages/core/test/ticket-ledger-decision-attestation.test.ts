import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  appendTicketDecisionAttestation,
  applyTicketWorktreePatch,
  commitTicketCheckpoint,
  loadTicketLedgerAtRef,
  loadTicketLedgerFromWorktree,
  prepareTicketCheckpoint,
  prepareTicketDecisionForSnapshot,
  recordTicketDecision,
  ticketDecisionAttestationChallenge,
  ticketDecisionAttestationDocumentPath,
  ticketDecisionDocumentDigest,
  type TicketDecisionAttestationDocumentPayload,
  type TicketDecisionAuthorityContext,
  type TicketDecisionRecordRequest,
  type TicketDocument,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
} from "../src/index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ticket Attestation Test",
      GIT_AUTHOR_EMAIL: "ticket-attestation@example.test",
      GIT_COMMITTER_NAME: "Ticket Attestation Test",
      GIT_COMMITTER_EMAIL: "ticket-attestation@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const ticket = (): TicketDocument => ({
  schema_version: 1,
  kind: "ticket",
  ticket_id: "protected-api",
  outcome: "Freeze the protected API policy",
  context: "A fresh Agent must preserve the exact human-owned choice.",
  acceptance: [{
    acceptance_id: "policy-bound",
    criterion: "The selected policy is bound to this exact Ticket.",
  }],
  constraints: ["Do not infer human authority from repository bytes."],
  context_refs: [],
  relations: [],
  provenance_refs: [],
});

const expectedSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerPatchExpectedSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected worktree snapshot");
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.semanticLedgerDigest}`,
  };
};

const authority: TicketDecisionAuthorityContext = {
  principal_id: "wayne",
  principal_kind: "human",
  basis: "repository_owner",
  basis_ref: "vibehub-trust:wayne",
  attestation: "host_bound_local",
};

const setup = (): string => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-ticket-attestation-"),
  );
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Ticket Attestation Test");
  git(repository, "config", "user.email", "ticket-attestation@example.test");
  fs.writeFileSync(path.join(repository, "README.md"), "# fixture\n");
  const ledgerRoot = path.join(repository, ".vibehub", "tickets");
  fs.mkdirSync(ledgerRoot, { recursive: true });
  fs.writeFileSync(path.join(ledgerRoot, "protocol.yaml"), [
    "schema_version: 1",
    "kind: ticket_protocol",
    "format: vibehub.ticket-ledger",
    "",
  ].join("\n"));
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "seed Ticket ledger");
  const empty = loadTicketLedgerFromWorktree(repository);
  applyTicketWorktreePatch({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(empty),
      changes: [{
        op: "put",
        ticketId: "protected-api",
        expectedTicketRevision: null,
        document: ticket(),
      }],
    },
  });
  git(repository, "add", TICKET_LEDGER_RELATIVE_PATH);
  git(repository, "commit", "-m", "seed protected Ticket");
  git(repository, "switch", "-c", "feat/durable-attestation");
  return repository;
};

const decisionRequest = (
  snapshot: TicketLedgerSnapshot,
): TicketDecisionRecordRequest => {
  const subject = snapshot.tickets[0];
  if (subject === undefined) throw new Error("missing Ticket");
  return {
    expectedSource: expectedSource(snapshot),
    decision: {
      decision_type: "protected_boundary",
      subject: {
        kind: "ticket",
        ticket_id: subject.document.ticket_id,
        ticket_revision: subject.ticketRevision,
      },
      boundary: "Select the public compatibility policy.",
      disposition: "resolve",
      selection: "Preserve backwards compatibility.",
      rationale: "This exact product boundary belongs to the human.",
      resolution_refs: [],
    },
  };
};

const attestationPayload = (
  snapshot: TicketLedgerSnapshot,
  decisionPath: string,
  decisionId: string,
  decisionDigest: string,
  overrides: {
    decisionDigest?: string;
    selection?: string;
  } = {},
): TicketDecisionAttestationDocumentPayload => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected worktree snapshot");
  }
  const decision = snapshot.decisions.find((candidate) =>
    candidate.documentPath === decisionPath);
  if (decision === undefined) throw new Error("missing Decision");
  if (decision.document.decision_type !== "protected_boundary") {
    throw new Error("expected protected-boundary Decision");
  }
  const envelope = {
    schema_version: 1 as const,
    kind: "ticket_decision_attestation" as const,
    decision: {
      decision_id: decisionId,
      document_path: decisionPath,
      document_digest: overrides.decisionDigest ?? decisionDigest,
    },
    authority: {
      principal_id: authority.principal_id,
      principal_kind: "human" as const,
      basis: authority.basis,
      basis_ref: authority.basis_ref,
    },
    repository: {
      repository_incarnation: snapshot.source.repositoryIncarnation,
      repository_root: snapshot.source.repositoryRoot,
      worktree_identity: snapshot.source.worktreeIdentity,
      worktree_root: snapshot.source.worktreeRoot,
      checkout: snapshot.source.branch === null
        ? {
            mode: "detached" as const,
            commit: snapshot.source.resolvedCommit,
          }
        : {
            mode: "branch" as const,
            branch: snapshot.source.branch,
          },
    },
    scope: {
      scope_type: "protected_boundary" as const,
      ticket_id: decision.document.subject.ticket_id,
      ticket_revision: decision.document.subject.ticket_revision,
      boundary: decision.document.boundary,
      disposition: decision.document.disposition,
      selection: overrides.selection ?? decision.document.selection!,
    },
    credential: {
      credential_id: Buffer.from("credential-1").toString("base64url"),
      fingerprint: "a".repeat(64),
    },
    webauthn: {
      rp_id: "localhost" as const,
      origin: "http://localhost:43123",
      algorithm: "ES256" as const,
    },
    nonce: Buffer.alloc(16, 7).toString("base64url"),
    issued_at: "2026-07-30T23:01:00.000Z",
    not_before: "2026-07-30T23:01:00.000Z",
    expires_at: "2026-07-31T00:01:00.000Z",
  };
  const challenge = ticketDecisionAttestationChallenge(envelope);
  return {
    ...envelope,
    webauthn: {
      ...envelope.webauthn,
      client_data_json: Buffer.from(JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin: envelope.webauthn.origin,
        crossOrigin: false,
      })).toString("base64url"),
      authenticator_data: Buffer.alloc(37, 1).toString("base64url"),
      signature: Buffer.alloc(64, 2).toString("base64url"),
    },
  };
};

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

describe("Git-native Ticket Decision attestations", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes one Decision, then appends and reloads its detached receipt without changing graph identity", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const request = decisionRequest(base);
    const prepared = prepareTicketDecisionForSnapshot({
      snapshot: base,
      request,
      authority,
      decidedAt: "2026-07-30T23:00:00.000Z",
    });
    expect(prepared.digest)
      .toBe(ticketDecisionDocumentDigest(prepared.document));

    const recorded = recordTicketDecision({
      worktreeRoot: repository,
      request,
      authority,
      decidedAt: "2026-07-30T23:00:00.000Z",
    });
    expect(recorded.decision).toEqual({
      documentPath: prepared.documentPath,
      document: prepared.document,
    });
    git(repository, "add", recorded.decision.documentPath);
    git(repository, "commit", "-m", "record exact Decision");
    const decisionSnapshot = loadTicketLedgerFromWorktree(repository);
    expect(decisionSnapshot.attestations).toEqual([]);
    expect(decisionSnapshot.graphDigest).toBe(base.graphDigest);

    const payload = attestationPayload(
      decisionSnapshot,
      recorded.decision.documentPath,
      recorded.decision.document.decision_id,
      prepared.digest,
    );
    const appended = appendTicketDecisionAttestation({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(decisionSnapshot),
        attestation: payload,
      },
    });
    expect(appended.status).toBe("applied");
    expect(appended.changedPaths).toEqual([
      appended.attestation.documentPath,
    ]);
    expect(appended.attestation.documentPath).toBe(
      ticketDecisionAttestationDocumentPath(
        appended.attestation.document,
      ),
    );
    expect(appended.attestation.document.attestation_id)
      .toMatch(/^tda-[0-9a-f]{64}$/u);

    const reloaded = loadTicketLedgerFromWorktree(repository);
    expect(reloaded.attestations).toEqual([appended.attestation]);
    expect(reloaded.graphDigest).toBe(base.graphDigest);
    expect(reloaded.semanticLedgerDigest)
      .not.toBe(decisionSnapshot.semanticLedgerDigest);
    expect(reloaded.source.sourceToken)
      .not.toBe(decisionSnapshot.source.sourceToken);
    expect(appendTicketDecisionAttestation({
      worktreeRoot: repository,
      request: {
        expectedSource: expectedSource(reloaded),
        attestation: payload,
      },
    })).toMatchObject({
      status: "noop",
      changedPaths: [],
      attestation: appended.attestation,
    });
    const checkpoint = prepareTicketCheckpoint({
      repoRoot: repository,
      checkpointSelection: appended.checkpointSelection,
    });
    expect(checkpoint.changedPaths)
      .toEqual([appended.attestation.documentPath]);
    commitTicketCheckpoint({
      repoRoot: repository,
      receipt: checkpoint,
      actor: "agent:test",
      taskId: "ticket:durable-attestation",
      requestId: "request:durable-attestation",
      now: "2026-07-30T23:02:00.000Z",
    });
    const committed = loadTicketLedgerAtRef(repository, "HEAD");
    expect(committed.attestations).toEqual([appended.attestation]);
    expect(committed.graphDigest).toBe(base.graphDigest);
  });

  it("rejects a mismatched Decision digest or typed scope and leaves a raw Decision valid but un-attested", () => {
    const repository = setup();
    roots.push(repository);
    const base = loadTicketLedgerFromWorktree(repository);
    const recorded = recordTicketDecision({
      worktreeRoot: repository,
      request: decisionRequest(base),
      authority,
      decidedAt: "2026-07-30T23:00:00.000Z",
    });
    const decisionSnapshot = loadTicketLedgerFromWorktree(repository);
    const digest = ticketDecisionDocumentDigest(
      recorded.decision.document,
    );

    expectCode(
      () => appendTicketDecisionAttestation({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(decisionSnapshot),
          attestation: attestationPayload(
            decisionSnapshot,
            recorded.decision.documentPath,
            recorded.decision.document.decision_id,
            digest,
            { decisionDigest: "0".repeat(64) },
          ),
        },
      }),
      "stale_subject",
    );
    expectCode(
      () => appendTicketDecisionAttestation({
        worktreeRoot: repository,
        request: {
          expectedSource: expectedSource(decisionSnapshot),
          attestation: attestationPayload(
            decisionSnapshot,
            recorded.decision.documentPath,
            recorded.decision.document.decision_id,
            digest,
            { selection: "Break backwards compatibility." },
          ),
        },
      }),
      "stale_subject",
    );
    const after = loadTicketLedgerFromWorktree(repository);
    expect(after.decisions).toHaveLength(1);
    expect(after.attestations).toEqual([]);
    expect(after.source.sourceToken)
      .toBe(decisionSnapshot.source.sourceToken);
    expect(fs.existsSync(path.join(
      repository,
      TICKET_LEDGER_RELATIVE_PATH,
      "attestations",
    ))).toBe(false);
  });
});
