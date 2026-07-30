import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperationDispatcher,
  appendTicketDecisionAttestation,
  applyTicketWorktreePatch,
  canonicalTicketLedgerValue,
  createTicketDecisionAttestationDocument,
  loadTicketLedgerFromWorktree,
  openDb,
  projectTicketLedgerForReview,
  recordTicketDecision,
  ticketDecisionAttestationDocumentPath,
  ticketDecisionAttestationSigningBytes,
  ticketDecisionDocumentDigest,
  type Db,
  type TicketDecisionAttestationDocument,
  type TicketDecisionAttestationDocumentPayload,
  type TicketDecisionAttestationEnvelope,
  type TicketDecisionAttestationScope,
  type TicketDecisionAuthorityContext,
  type TicketDocument,
  type TicketLedgerDecision,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
  type TicketLedgerWorktreeSource,
  type TicketReviewSubject,
} from "../src/index.js";
import {
  DurableLocalSignatureTicketDecisionAttestationVerifierV0,
  projectTicketLedgerForTrustedDecisionHostV0,
  type TicketDecisionLocalSignatureTrustProfileResolverV0,
  type TicketDecisionLocalSignatureTrustProfileV0,
} from "../src/ticket-decision-attestation.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Durable Attestation Test",
      GIT_AUTHOR_EMAIL: "durable-attestation@example.test",
      GIT_COMMITTER_NAME: "Durable Attestation Test",
      GIT_COMMITTER_EMAIL: "durable-attestation@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

const ticketDocument = (): TicketDocument => ({
  schema_version: 1,
  kind: "ticket",
  ticket_id: "implement-api",
  outcome: "Expose the reviewed API",
  context: "Implement the exact reviewed API boundary.",
  acceptance: [{
    acceptance_id: "api-observable",
    criterion: "The reviewed API is observable.",
  }],
  constraints: ["Preserve the protected product boundary."],
  context_refs: [],
  relations: [],
  provenance_refs: [],
});

const expectedSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerPatchExpectedSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected worktree source");
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: `sha256:${snapshot.graphDigest}`,
    semanticLedgerDigest: `sha256:${snapshot.semanticLedgerDigest}`,
  };
};

const ticketSubject = (
  snapshot: TicketLedgerSnapshot,
): Extract<TicketReviewSubject, { kind: "ticket" }> => {
  const ticket = snapshot.tickets[0];
  if (ticket === undefined) throw new Error("missing fixture Ticket");
  return {
    kind: "ticket",
    ticket_id: ticket.document.ticket_id,
    ticket_revision: ticket.ticketRevision,
  };
};

const worktreeSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerWorktreeSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected worktree snapshot");
  }
  return snapshot.source;
};

interface SignerFixture {
  privateKey: crypto.KeyObject;
  profile: TicketDecisionLocalSignatureTrustProfileV0;
  profileId: string;
  authority: TicketDecisionAuthorityContext;
}

const signerFixture = (
  snapshot: TicketLedgerSnapshot,
  createdAt: string,
): SignerFixture => {
  const source = worktreeSource(snapshot);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const keyFingerprint = crypto.createHash("sha256")
    .update(publicKeyDer)
    .digest("hex");
  const keyId = `tdk-${keyFingerprint}`;
  const profileIdentity = {
    keyId,
    keyFingerprint,
    repositoryIncarnation: source.repositoryIncarnation,
    algorithm: "Ed25519",
  };
  const profileId = `tla-${crypto.createHash("sha256")
    .update(JSON.stringify(profileIdentity))
    .digest("hex")}`;
  const principalId = `local-installation:${profileId}`;
  const basisRef = `vibehub:local-installation:${profileId}`;
  return {
    privateKey,
    profileId,
    profile: {
      keyId,
      keyFingerprint,
      publicKeySpkiPem: publicKey.export({
        type: "spki",
        format: "pem",
      }).toString(),
      principalId,
      principalKind: "human",
      basis: "repository_owner",
      basisRef,
      repositoryIncarnation: source.repositoryIncarnation,
      createdAt,
      revokedAt: null,
    },
    authority: {
      principal_id: principalId,
      principal_kind: "human",
      basis: "repository_owner",
      basis_ref: basisRef,
      attestation: "host_bound_local",
    },
  };
};

interface DecisionFixture {
  repository: string;
  snapshot: TicketLedgerSnapshot;
  decision: TicketLedgerDecision;
  signer: SignerFixture;
  now: number;
}

const setupDecision = (): DecisionFixture => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), "vibehub-durable-attestation-"),
  );
  git(repository, "init", "-b", "main");
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
  git(repository, "commit", "-m", "seed durable attestation fixture");

  const empty = loadTicketLedgerFromWorktree(repository);
  applyTicketWorktreePatch({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(empty),
      changes: [{
        op: "put",
        ticketId: "implement-api",
        expectedTicketRevision: null,
        document: ticketDocument(),
      }],
    },
  });
  const beforeDecision = loadTicketLedgerFromWorktree(repository);
  const now = Date.now();
  const signer = signerFixture(
    beforeDecision,
    new Date(now - 20_000).toISOString(),
  );
  const recorded = recordTicketDecision({
    worktreeRoot: repository,
    request: {
      expectedSource: expectedSource(beforeDecision),
      decision: {
        decision_type: "protected_boundary",
        subject: ticketSubject(beforeDecision),
        boundary: "Choose the public compatibility policy.",
        disposition: "resolve",
        selection: "Preserve backwards compatibility.",
        rationale: "This boundary requires explicit human intent.",
        resolution_refs: [],
      },
    },
    authority: signer.authority,
    decidedAt: new Date(now - 10_000).toISOString(),
  });
  const snapshot = loadTicketLedgerFromWorktree(repository);
  const decision = snapshot.decisions.find((candidate) =>
    candidate.documentPath === recorded.decision.documentPath);
  if (decision === undefined) throw new Error("missing fixture Decision");
  return { repository, snapshot, decision, signer, now };
};

const exactScope = (
  decision: TicketLedgerDecision,
): TicketDecisionAttestationScope => {
  if (decision.document.decision_type !== "protected_boundary") {
    throw new Error("expected protected Decision");
  }
  return {
    scope_type: "protected_boundary",
    ticket_id: decision.document.subject.ticket_id,
    ticket_revision: decision.document.subject.ticket_revision,
    boundary: decision.document.boundary,
    disposition: decision.document.disposition,
    ...(decision.document.selection === undefined
      ? {}
      : { selection: decision.document.selection }),
  };
};

const signAttestation = (
  snapshot: TicketLedgerSnapshot,
  decision: TicketLedgerDecision,
  signer: SignerFixture,
  issuedAt: string,
  nonce = crypto.randomBytes(24).toString("base64url"),
): TicketDecisionAttestationDocument => {
  const source = worktreeSource(snapshot);
  const envelope: TicketDecisionAttestationEnvelope = {
    schema_version: 1,
    kind: "ticket_decision_attestation",
    decision: {
      decision_id: decision.document.decision_id,
      document_path: decision.documentPath,
      document_digest: ticketDecisionDocumentDigest(decision.document),
    },
    authority: {
      principal_id: decision.document.authority.principal_id,
      principal_kind: decision.document.authority.principal_kind,
      basis: decision.document.authority.basis,
      basis_ref: decision.document.authority.basis_ref,
    },
    repository: {
      repository_incarnation: source.repositoryIncarnation,
      repository_root: source.repositoryRoot,
      worktree_identity: source.worktreeIdentity,
      worktree_root: source.worktreeRoot,
      checkout: {
        mode: "branch",
        branch: source.branch ?? "detached-not-supported",
      },
    },
    scope: exactScope(decision),
    signer: {
      key_id: signer.profile.keyId,
      key_fingerprint: signer.profile.keyFingerprint,
      algorithm: "Ed25519",
    },
    confirmation: { method: "plugin_host_click" },
    nonce,
    issued_at: issuedAt,
  };
  const payload: TicketDecisionAttestationDocumentPayload = {
    ...envelope,
    signature: crypto.sign(
      null,
      ticketDecisionAttestationSigningBytes(envelope),
      signer.privateKey,
    ).toString("base64url"),
  };
  return createTicketDecisionAttestationDocument(payload);
};

const resolver = (
  read: () => TicketDecisionLocalSignatureTrustProfileV0 | null,
): TicketDecisionLocalSignatureTrustProfileResolverV0 => ({
  resolveProfile(lookup) {
    const profile = read();
    return profile !== null
      && lookup.keyId === profile.keyId
      && lookup.keyFingerprint === profile.keyFingerprint
      && lookup.repositoryIncarnation === profile.repositoryIncarnation
      ? profile
      : null;
  },
});

const withAttestations = (
  snapshot: TicketLedgerSnapshot,
  documents: readonly TicketDecisionAttestationDocument[],
): TicketLedgerSnapshot => ({
  ...snapshot,
  attestations: documents.map((document) => ({
    document,
    documentPath: ticketDecisionAttestationDocumentPath(document),
  })),
});

const reidentify = (
  document: TicketDecisionAttestationDocument,
): TicketDecisionAttestationDocument => {
  const { attestation_id: _attestationId, ...payload } = document;
  return {
    ...payload,
    attestation_id: `tda-${crypto.createHash("sha256")
      .update(canonicalTicketLedgerValue(payload))
      .digest("hex")}`,
  };
};

const cloneAttestation = (
  document: TicketDecisionAttestationDocument,
  mutate: (copy: TicketDecisionAttestationDocument) => void,
): TicketDecisionAttestationDocument => {
  const copy = structuredClone(document);
  mutate(copy);
  return reidentify(copy);
};

const verification = (
  snapshot: TicketLedgerSnapshot,
  decision: TicketLedgerDecision,
  profile: () => TicketDecisionLocalSignatureTrustProfileV0 | null,
) => new DurableLocalSignatureTicketDecisionAttestationVerifierV0({
  trustProfiles: resolver(profile),
}).verify(snapshot, decision);

describe("durable local-signature Ticket Decision attestation", () => {
  const roots: string[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    roots.splice(0).forEach((root) =>
      fs.rmSync(root, { recursive: true, force: true }));
  });

  it("verifies one exact Ed25519 receipt and rejects material Decision mutations", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const snapshot = withAttestations(fixture.snapshot, [receipt]);
    expect(verification(
      snapshot,
      fixture.decision,
      () => fixture.signer.profile,
    )).toEqual({
      status: "verified",
      verificationRef: receipt.attestation_id,
      source: "durable_local_signature",
    });

    const mutations: Array<(value: TicketLedgerDecision) => void> = [
      (value) => {
        value.document.decision_id = `tdc-${"1".repeat(64)}`;
      },
      (value) => {
        value.documentPath = ".vibehub/tickets/decisions/other.yaml";
      },
      (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.subject.ticket_revision = "1".repeat(64);
        }
      },
      (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.boundary = "Choose a different policy.";
        }
      },
      (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.selection = "Break compatibility.";
        }
      },
      (value) => {
        value.document.rationale = "Changed rationale.";
      },
      (value) => {
        value.document.authority.basis_ref = "vibehub:other-installation";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(fixture.decision);
      mutate(changed);
      expect(verification(
        snapshot,
        changed,
        () => fixture.signer.profile,
      )).toMatchObject({ status: "unverified" });
    }
  });

  it("rejects tampering of every binding family and the detached signature", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const mutations: Array<
      (value: TicketDecisionAttestationDocument) => void
    > = [
      (value) => {
        value.decision.document_digest = "1".repeat(64);
      },
      (value) => {
        value.authority.basis_ref = "vibehub:other-installation";
      },
      (value) => {
        value.repository.repository_incarnation = `repo-${"1".repeat(64)}`;
      },
      (value) => {
        value.repository.worktree_identity = `worktree-${"1".repeat(64)}`;
      },
      (value) => {
        value.repository.repository_root = "/tmp/other-repository";
      },
      (value) => {
        if (value.repository.checkout.mode === "branch") {
          value.repository.checkout.branch = "other";
        }
      },
      (value) => {
        if (value.scope.scope_type === "protected_boundary") {
          value.scope.selection = "Break compatibility.";
        }
      },
      (value) => {
        value.nonce = crypto.randomBytes(24).toString("base64url");
      },
      (value) => {
        value.issued_at = new Date(fixture.now - 4_000).toISOString();
      },
      (value) => {
        const fingerprint = "1".repeat(64);
        value.signer.key_fingerprint = fingerprint;
        value.signer.key_id = `tdk-${fingerprint}`;
      },
      (value) => {
        value.signature = Buffer.alloc(64, 7).toString("base64url");
      },
    ];
    for (const mutate of mutations) {
      const changed = cloneAttestation(receipt, mutate);
      expect(verification(
        withAttestations(fixture.snapshot, [changed]),
        fixture.decision,
        () => fixture.signer.profile,
      )).toMatchObject({ status: "unverified" });
    }
  });

  it("fails closed for wrong keys, missing trust, and dynamic revocation without time validity windows", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const snapshot = withAttestations(fixture.snapshot, [receipt]);
    const { publicKey: wrongPublicKey } =
      crypto.generateKeyPairSync("ed25519");
    expect(verification(
      snapshot,
      fixture.decision,
      () => ({
        ...fixture.signer.profile,
        publicKeySpkiPem: wrongPublicKey.export({
          type: "spki",
          format: "pem",
        }).toString(),
      }),
    )).toMatchObject({
      status: "unverified",
      reason: "signing_key_invalid",
    });
    expect(verification(
      snapshot,
      fixture.decision,
      () => null,
    )).toMatchObject({
      status: "unverified",
      reason: "profile_unavailable",
    });

    let liveProfile = fixture.signer.profile;
    const verifier =
      new DurableLocalSignatureTicketDecisionAttestationVerifierV0({
        trustProfiles: resolver(() => liveProfile),
      });
    expect(verifier.verify(snapshot, fixture.decision))
      .toMatchObject({ status: "verified" });
    liveProfile = {
      ...liveProfile,
      revokedAt: new Date(fixture.now).toISOString(),
    };
    expect(verifier.verify(snapshot, fixture.decision)).toMatchObject({
      status: "unverified",
      reason: "profile_revoked",
    });

    const futureReceipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now + 10_000).toISOString(),
    );
    expect(verification(
      withAttestations(fixture.snapshot, [futureReceipt]),
      fixture.decision,
      () => fixture.signer.profile,
    )).toMatchObject({
      status: "verified",
      source: "durable_local_signature",
    });
  });

  it("selects a valid re-attestation even when another receipt is invalid", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const valid = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const invalid = cloneAttestation(valid, (value) => {
      value.signature = Buffer.alloc(64, 9).toString("base64url");
    });
    expect(verification(
      withAttestations(fixture.snapshot, [invalid, valid]),
      fixture.decision,
      () => fixture.signer.profile,
    )).toEqual({
      status: "verified",
      verificationRef: valid.attestation_id,
      source: "durable_local_signature",
    });
  });

  it("keeps raw Decisions unverified and lets a fresh dispatcher verify a Git receipt", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const verifier =
      new DurableLocalSignatureTicketDecisionAttestationVerifierV0({
        trustProfiles: resolver(() => fixture.signer.profile),
      });
    const raw = projectTicketLedgerForTrustedDecisionHostV0(
      fixture.snapshot,
      verifier,
    );
    expect(raw.traceRecords.find((record) =>
      record.recordRef === fixture.decision.document.decision_id))
      .toMatchObject({
        kind: "artifact",
        status: "current_unverified",
      });

    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const {
      attestation_id: _attestationId,
      ...payload
    } = receipt;
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(fixture.snapshot),
        attestation: payload,
      },
    });

    const db = openDb(path.join(fixture.repository, "runtime.sqlite"));
    dbs.push(db);
    const fresh = new OperationDispatcher(db, {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles:
        resolver(() => fixture.signer.profile),
    });
    const graph = fresh.dispatch("ticket.graph.snapshot", {
      repoId: 1,
      actor: "agent:fresh-reader",
      requestId: "fresh-graph",
      now: new Date().toISOString(),
    }, {});
    expect(graph).toMatchObject({ ok: true });
    if (!graph.ok) throw new Error("fresh graph read failed");
    const snapshotId = (graph.data as { snapshotId: string }).snapshotId;
    const trace = fresh.dispatch("ticket.trace.list", {
      repoId: 1,
      actor: "agent:fresh-reader",
      requestId: "fresh-trace",
      now: new Date().toISOString(),
    }, {
      snapshotId,
      subject: { kind: "ticket", ticketId: "implement-api" },
    });
    expect(trace).toMatchObject({
      ok: true,
      data: {
        records: [expect.objectContaining({
          recordRef: fixture.decision.document.decision_id,
          kind: "gate_decision",
          status: "current",
          producer: {
            kind: "authority_receipt",
            ref: receipt.attestation_id,
          },
        })],
      },
    });
    expect(projectTicketLedgerForReview(
      loadTicketLedgerFromWorktree(fixture.repository),
    ).traceRecords.find((record) =>
      record.recordRef === fixture.decision.document.decision_id))
      .toMatchObject({
        kind: "artifact",
        status: "current_unverified",
      });
  });
});
