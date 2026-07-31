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
  upsertRepo,
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
  CompositeTicketDecisionAttestationVerifierV0,
  DurableLocalSignatureTicketDecisionAttestationVerifierV0,
  InMemoryTicketDecisionSessionAttestationRegistryV0,
  projectTicketLedgerForTrustedDecisionHostV0,
  verifyTicketExecutionDecisionAuthorityV0,
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

const dependentTicketDocument = (): TicketDocument => ({
  schema_version: 1,
  kind: "ticket",
  ticket_id: "publish-client",
  outcome: "Publish the client after the reviewed API is complete",
  context: "Proceed only from a currently authorized API Outcome.",
  acceptance: [{
    acceptance_id: "client-published",
    criterion: "The client is published against the reviewed API.",
  }],
  constraints: ["Do not bypass Decision revocation through an old Outcome."],
  context_refs: [],
  relations: [{
    type: "depends_on",
    target_ticket_id: "implement-api",
  }],
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

const setupDecision = (
  decisionForm:
    | "resolved_boundary"
    | "request_changes_plan" = "resolved_boundary",
): DecisionFixture => {
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
      decision: decisionForm === "resolved_boundary"
        ? {
            decision_type: "protected_boundary",
            subject: ticketSubject(beforeDecision),
            boundary: "Choose the public compatibility policy.",
            disposition: "resolve",
            selection: "Preserve backwards compatibility.",
            rationale: "This boundary requires explicit human intent.",
            resolution_refs: [],
          }
        : {
            decision_type: "plan_review",
            subject: {
              kind: "graph",
              graph_digest: beforeDecision.graphDigest,
            },
            disposition: "request_changes",
            rationale: "The graph needs another planning pass.",
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
  if (decision.document.decision_type === "plan_review") {
    return {
      scope_type: "plan_review",
      graph_digest: decision.document.subject.graph_digest,
      disposition: decision.document.disposition,
      ...(decision.document.delegated_boundaries === undefined
        ? {}
        : {
            delegated_boundaries:
              decision.document.delegated_boundaries,
          }),
    };
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

  it("fails Ticket context compilation closed for raw, revoked, and tampered Decision authority", () => {
    const cases: Array<{
      name: string;
      prepare: (
        fixture: DecisionFixture,
      ) => {
        profile: () => TicketDecisionLocalSignatureTrustProfileV0 | null;
      };
      reason: string;
    }> = [
      {
        name: "raw",
        prepare: () => ({ profile: () => null }),
        reason: "attestation_not_found",
      },
      {
        name: "revoked",
        prepare: (fixture) => {
          const receipt = signAttestation(
            fixture.snapshot,
            fixture.decision,
            fixture.signer,
            new Date(fixture.now - 5_000).toISOString(),
          );
          const { attestation_id: _attestationId, ...payload } = receipt;
          appendTicketDecisionAttestation({
            worktreeRoot: fixture.repository,
            request: {
              expectedSource: expectedSource(fixture.snapshot),
              attestation: payload,
            },
          });
          return {
            profile: () => ({
              ...fixture.signer.profile,
              revokedAt: new Date(fixture.now).toISOString(),
            }),
          };
        },
        reason: "profile_revoked",
      },
      {
        name: "tampered",
        prepare: (fixture) => {
          const receipt = cloneAttestation(signAttestation(
            fixture.snapshot,
            fixture.decision,
            fixture.signer,
            new Date(fixture.now - 5_000).toISOString(),
          ), (value) => {
            value.signature = Buffer.alloc(64, 11).toString("base64url");
          });
          const { attestation_id: _attestationId, ...payload } = receipt;
          appendTicketDecisionAttestation({
            worktreeRoot: fixture.repository,
            request: {
              expectedSource: expectedSource(fixture.snapshot),
              attestation: payload,
            },
          });
          return { profile: () => fixture.signer.profile };
        },
        reason: "signature_invalid",
      },
    ];

    for (const testCase of cases) {
      const fixture = setupDecision();
      roots.push(fixture.repository);
      const prepared = testCase.prepare(fixture);
      const db = openDb(path.join(
        fixture.repository,
        `${testCase.name}-runtime.sqlite`,
      ));
      dbs.push(db);
      const repo = upsertRepo(
        db,
        fixture.repository,
        `fixture/${testCase.name}`,
        "main",
        new Date(fixture.now).toISOString(),
      );
      const dispatcher = new OperationDispatcher(db, {
        repoRoot: fixture.repository,
        ...(testCase.name === "raw"
          ? {}
          : {
              ticketDecisionAttestationTrustProfiles:
                resolver(prepared.profile),
            }),
      });
      const frontier = dispatcher.dispatch("ticket.frontier.read", {
        repoId: repo.id,
        actor: "agent:executor",
        requestId: `${testCase.name}:frontier`,
        now: new Date(fixture.now).toISOString(),
      }, {});
      if (!frontier.ok) throw new Error(JSON.stringify(frontier));
      const data = frontier.data as {
        source: TicketLedgerPatchExpectedSource;
        tickets: Array<{
          ticketId: string;
          ticketRevision: string;
          status: string;
          semanticStatus: string;
          decisionBlocker: {
            reason: string;
            decisionId: string;
          } | null;
        }>;
      };
      const ticket = data.tickets[0];
      if (ticket === undefined) throw new Error("missing frontier Ticket");
      expect(ticket, testCase.name).toMatchObject({
        status: "BLOCKED",
        semanticStatus: "READY",
        decisionBlocker: {
          decisionId: fixture.decision.document.decision_id,
          reason: testCase.reason,
        },
      });
      const compiled = dispatcher.dispatch("ticket.context.compile", {
        repoId: repo.id,
        actor: "agent:executor",
        requestId: `${testCase.name}:compile`,
        now: new Date(fixture.now + 1_000).toISOString(),
      }, {
        expectedSource: data.source,
        ticketId: ticket.ticketId,
        expectedTicketRevision: ticket.ticketRevision,
      });
      expect(compiled, testCase.name).toMatchObject({
        ok: false,
        error: {
          code: "ticket_not_ready",
          details: {
            decisionId: fixture.decision.document.decision_id,
            reason: testCase.reason,
          },
        },
      });
      expect(loadTicketLedgerFromWorktree(fixture.repository).contextBindings)
        .toEqual([]);
    }
  });

  it("keeps a verified request-changes Decision as an explicit frontier blocker", () => {
    const fixture = setupDecision("request_changes_plan");
    roots.push(fixture.repository);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const { attestation_id: _AttestationId, ...payload } = receipt;
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(fixture.snapshot),
        attestation: payload,
      },
    });
    const db = openDb(path.join(fixture.repository, "request-changes.sqlite"));
    dbs.push(db);
    const repo = upsertRepo(
      db,
      fixture.repository,
      "fixture/request-changes",
      "main",
      new Date(fixture.now).toISOString(),
    );
    const dispatcher = new OperationDispatcher(db, {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles:
        resolver(() => fixture.signer.profile),
    });
    const frontier = dispatcher.dispatch("ticket.frontier.read", {
      repoId: repo.id,
      actor: "agent:executor",
      requestId: "request-changes:frontier",
      now: new Date(fixture.now).toISOString(),
    }, {});
    expect(frontier).toMatchObject({
      ok: true,
      data: {
        counts: { BLOCKED: 1, READY: 0 },
        tickets: [{
          ticketId: "implement-api",
          status: "BLOCKED",
          semanticStatus: "READY",
          decisionBlocker: {
            kind: "decision_authority",
            decisionId: fixture.decision.document.decision_id,
            decisionType: "plan_review",
            reason: "non_authorizing_disposition",
            disposition: "request_changes",
          },
        }],
      },
    });
  });

  it("binds an exact durable verification into the packet and remains claimable by a fresh dispatcher", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const { attestation_id: _attestationId, ...payload } = receipt;
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(fixture.snapshot),
        attestation: payload,
      },
    });
    const db = openDb(path.join(fixture.repository, "execution.sqlite"));
    dbs.push(db);
    const repo = upsertRepo(
      db,
      fixture.repository,
      "fixture/fresh-execution",
      "main",
      new Date(fixture.now).toISOString(),
    );
    const options = {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles:
        resolver(() => fixture.signer.profile),
    };
    const compiler = new OperationDispatcher(db, options);
    const frontier = compiler.dispatch("ticket.frontier.read", {
      repoId: repo.id,
      actor: "agent:compiler",
      requestId: "durable:frontier",
      now: new Date(fixture.now).toISOString(),
    }, {});
    if (!frontier.ok) throw new Error(JSON.stringify(frontier));
    const data = frontier.data as {
      source: TicketLedgerPatchExpectedSource;
      tickets: Array<{ ticketId: string; ticketRevision: string }>;
    };
    const ticket = data.tickets[0];
    if (ticket === undefined) throw new Error("missing frontier Ticket");
    const compiled = compiler.dispatch("ticket.context.compile", {
      repoId: repo.id,
      actor: "agent:compiler",
      requestId: "durable:compile",
      now: new Date(fixture.now + 1_000).toISOString(),
    }, {
      expectedSource: data.source,
      ticketId: ticket.ticketId,
      expectedTicketRevision: ticket.ticketRevision,
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled));
    const compilation = compiled.data as {
      packet: {
        decisions: Array<{
          decisionDigest: string;
          verification: {
            source: string;
            verificationRef: string;
          };
        }>;
      };
      contextBinding: {
        documentDigest: string;
        document: {
          context_binding_id: string;
          relevant_decisions: Array<{
            decision_id: string;
            decision_digest: string;
            verification: {
              source: string;
              verification_ref: string;
            };
          }>;
        };
      };
    };
    const decisionDigest =
      ticketDecisionDocumentDigest(fixture.decision.document);
    expect(compilation.packet.decisions).toEqual([expect.objectContaining({
      decisionDigest: `sha256:${decisionDigest}`,
      verification: {
        source: "durable_local_signature",
        verificationRef: receipt.attestation_id,
      },
    })]);
    expect(
      compilation.contextBinding.document.relevant_decisions,
    ).toEqual([{
      decision_id: fixture.decision.document.decision_id,
      decision_digest: decisionDigest,
      verification: {
        source: "durable_local_signature",
        verification_ref: receipt.attestation_id,
      },
    }]);

    const afterCompilation =
      loadTicketLedgerFromWorktree(fixture.repository);
    let reattestation: TicketDecisionAttestationDocument | undefined;
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const candidate = signAttestation(
        afterCompilation,
        fixture.decision,
        fixture.signer,
        new Date(fixture.now + 1_500).toISOString(),
      );
      if (candidate.attestation_id < receipt.attestation_id) {
        reattestation = candidate;
        break;
      }
    }
    if (reattestation === undefined) {
      throw new Error("could not derive an earlier re-attestation id");
    }
    const {
      attestation_id: _ReattestationId,
      ...reattestationPayload
    } = reattestation;
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(afterCompilation),
        attestation: reattestationPayload,
      },
    });

    const fresh = new OperationDispatcher(db, options);
    const current = fresh.dispatch("ticket.frontier.read", {
      repoId: repo.id,
      actor: "agent:fresh-executor",
      requestId: "durable:fresh-frontier",
      now: new Date(fixture.now + 2_000).toISOString(),
    }, {});
    if (!current.ok) throw new Error(JSON.stringify(current));
    const claimed = fresh.dispatch("ticket.run.claim", {
      repoId: repo.id,
      actor: "agent:fresh-executor",
      requestId: "durable:fresh-claim",
      now: new Date(fixture.now + 2_000).toISOString(),
    }, {
      expectedSource: (current.data as { source: unknown }).source,
      ticketId: ticket.ticketId,
      expectedTicketRevision: ticket.ticketRevision,
      contextBindingId:
        compilation.contextBinding.document.context_binding_id,
      contextBindingDigest: compilation.contextBinding.documentDigest,
      leaseSeconds: 300,
    });
    expect(claimed).toMatchObject({
      ok: true,
      data: {
        ticketId: "implement-api",
        actor: "agent:fresh-executor",
      },
    });
  });

  it("invalidates an already-compiled binding when durable authority is revoked", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const { attestation_id: _attestationId, ...payload } = receipt;
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(fixture.snapshot),
        attestation: payload,
      },
    });
    let liveProfile = fixture.signer.profile;
    const db = openDb(path.join(fixture.repository, "revocation.sqlite"));
    dbs.push(db);
    const repo = upsertRepo(
      db,
      fixture.repository,
      "fixture/revocation",
      "main",
      new Date(fixture.now).toISOString(),
    );
    const options = {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles:
        resolver(() => liveProfile),
    };
    const compiler = new OperationDispatcher(db, options);
    const frontier = compiler.dispatch("ticket.frontier.read", {
      repoId: repo.id,
      actor: "agent:compiler",
      requestId: "revocation:frontier",
      now: new Date(fixture.now).toISOString(),
    }, {});
    if (!frontier.ok) throw new Error(JSON.stringify(frontier));
    const data = frontier.data as {
      source: TicketLedgerPatchExpectedSource;
      tickets: Array<{ ticketId: string; ticketRevision: string }>;
    };
    const ticket = data.tickets[0];
    if (ticket === undefined) throw new Error("missing frontier Ticket");
    const compiled = compiler.dispatch("ticket.context.compile", {
      repoId: repo.id,
      actor: "agent:compiler",
      requestId: "revocation:compile",
      now: new Date(fixture.now + 1_000).toISOString(),
    }, {
      expectedSource: data.source,
      ticketId: ticket.ticketId,
      expectedTicketRevision: ticket.ticketRevision,
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled));
    const binding = compiled.data as {
      contextBinding: {
        documentDigest: string;
        document: { context_binding_id: string };
      };
    };

    liveProfile = {
      ...liveProfile,
      revokedAt: new Date(fixture.now + 2_000).toISOString(),
    };
    const fresh = new OperationDispatcher(db, options);
    const current = fresh.dispatch("ticket.frontier.read", {
      repoId: repo.id,
      actor: "agent:executor",
      requestId: "revocation:current",
      now: new Date(fixture.now + 2_000).toISOString(),
    }, {});
    if (!current.ok) throw new Error(JSON.stringify(current));
    const claimed = fresh.dispatch("ticket.run.claim", {
      repoId: repo.id,
      actor: "agent:executor",
      requestId: "revocation:claim",
      now: new Date(fixture.now + 2_000).toISOString(),
    }, {
      expectedSource: (current.data as { source: unknown }).source,
      ticketId: ticket.ticketId,
      expectedTicketRevision: ticket.ticketRevision,
      contextBindingId:
        binding.contextBinding.document.context_binding_id,
      contextBindingDigest: binding.contextBinding.documentDigest,
      leaseSeconds: 300,
    });
    expect(claimed).toMatchObject({
      ok: false,
      error: {
        code: "ticket_run_stale",
        details: {
          decisionId: fixture.decision.document.decision_id,
          reason: "profile_revoked",
        },
      },
    });
  });

  it("requires the exact live host-session receipt for an operational Decision binding", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    let now = fixture.now;
    const registry =
      new InMemoryTicketDecisionSessionAttestationRegistryV0({
        now: () => now,
        ttlMs: 1_000,
      });
    expect(registry.attest(fixture.snapshot, fixture.decision)).toBe(true);
    const live = registry.verify(fixture.snapshot, fixture.decision);
    if (live.status !== "verified") {
      throw new Error("missing live host-session receipt");
    }
    const ticket = fixture.snapshot.tickets[0];
    if (ticket === undefined) throw new Error("missing fixture Ticket");
    const bound = [{
      decision_id: fixture.decision.document.decision_id,
      decision_digest:
        ticketDecisionDocumentDigest(fixture.decision.document),
      verification: {
        source: "host_session" as const,
        verification_ref: live.verificationRef,
      },
    }];
    const verifier = new CompositeTicketDecisionAttestationVerifierV0([
      new DurableLocalSignatureTicketDecisionAttestationVerifierV0({
        trustProfiles: resolver(() => null),
      }),
      registry,
    ]);
    expect(verifyTicketExecutionDecisionAuthorityV0(
      fixture.snapshot,
      ticket,
      verifier,
      bound,
    )).toMatchObject({ status: "verified" });
    expect(verifyTicketExecutionDecisionAuthorityV0(
      fixture.snapshot,
      ticket,
      verifier,
      [{
        ...bound[0]!,
        verification: {
          source: "host_session",
          verification_ref: `tdsa-${"0".repeat(64)}`,
        },
      }],
    )).toMatchObject({
      status: "unverified",
      issue: { reason: "attestation_identity_mismatch" },
    });

    now += 1_001;
    expect(verifyTicketExecutionDecisionAuthorityV0(
      fixture.snapshot,
      ticket,
      verifier,
      bound,
    )).toMatchObject({
      status: "unverified",
      issue: { reason: "expired" },
    });
    const freshRegistry =
      new InMemoryTicketDecisionSessionAttestationRegistryV0();
    expect(verifyTicketExecutionDecisionAuthorityV0(
      fixture.snapshot,
      ticket,
      freshRegistry,
      bound,
    )).toMatchObject({
      status: "unverified",
      issue: { reason: "attestation_not_found" },
    });
  });

  it("withdraws DONE and downstream readiness after Decision revocation while preserving the Git Outcome trace", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    applyTicketWorktreePatch({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(fixture.snapshot),
        changes: [{
          op: "put",
          ticketId: "publish-client",
          expectedTicketRevision: null,
          document: dependentTicketDocument(),
        }],
      },
    });
    const expanded = loadTicketLedgerFromWorktree(fixture.repository);
    const decision = expanded.decisions.find((candidate) =>
      candidate.document.decision_id
        === fixture.decision.document.decision_id);
    if (decision === undefined) throw new Error("missing expanded Decision");
    const receipt = signAttestation(
      expanded,
      decision,
      fixture.signer,
      new Date(fixture.now - 5_000).toISOString(),
    );
    const { attestation_id: _attestationId, ...payload } = receipt;
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(expanded),
        attestation: payload,
      },
    });

    let liveProfile = fixture.signer.profile;
    const trustProfiles = resolver(() => liveProfile);
    const db = openDb(path.join(
      fixture.repository,
      "outcome-revocation.sqlite",
    ));
    dbs.push(db);
    const repo = upsertRepo(
      db,
      fixture.repository,
      "fixture/outcome-revocation",
      "main",
      new Date(fixture.now).toISOString(),
    );
    const dispatcher = new OperationDispatcher(db, {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles: trustProfiles,
    });
    const dispatch = (
      operation: string,
      requestId: string,
      actor: string,
      nowOffset: number,
      input: unknown,
    ) => dispatcher.dispatch(operation, {
      repoId: repo.id,
      actor,
      requestId,
      now: new Date(fixture.now + nowOffset).toISOString(),
    }, input);
    const successful = <T>(result: ReturnType<typeof dispatch>): T => {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data as T;
    };

    const initial = successful<{
      source: TicketLedgerPatchExpectedSource;
      tickets: Array<{
        ticketId: string;
        ticketRevision: string;
        status: string;
      }>;
    }>(dispatch(
      "ticket.frontier.read",
      "outcome-revocation:frontier",
      "agent:executor",
      0,
      {},
    ));
    const root = initial.tickets.find((ticket) =>
      ticket.ticketId === "implement-api");
    if (root === undefined) throw new Error("missing root Ticket");
    expect(root.status).toBe("READY");
    const compiled = successful<{
      contextBinding: {
        documentDigest: string;
        document: { context_binding_id: string };
      };
    }>(dispatch(
      "ticket.context.compile",
      "outcome-revocation:compile",
      "agent:executor",
      1_000,
      {
        expectedSource: initial.source,
        ticketId: root.ticketId,
        expectedTicketRevision: root.ticketRevision,
      },
    ));
    const afterCompile = successful<{
      source: TicketLedgerPatchExpectedSource;
    }>(dispatch(
      "ticket.frontier.read",
      "outcome-revocation:after-compile",
      "agent:executor",
      2_000,
      {},
    ));
    const run = successful<{
      runId: string;
      generation: number;
      leaseToken: string;
    }>(dispatch(
      "ticket.run.claim",
      "outcome-revocation:claim",
      "agent:executor",
      2_000,
      {
        expectedSource: afterCompile.source,
        ticketId: root.ticketId,
        expectedTicketRevision: root.ticketRevision,
        contextBindingId:
          compiled.contextBinding.document.context_binding_id,
        contextBindingDigest: compiled.contextBinding.documentDigest,
        leaseSeconds: 300,
      },
    ));
    const runCredentials = {
      runId: run.runId,
      generation: run.generation,
      leaseToken: run.leaseToken,
    };
    const evidenceSource = successful<{
      source: TicketLedgerPatchExpectedSource;
    }>(dispatch(
      "ticket.frontier.read",
      "outcome-revocation:evidence-source",
      "agent:executor",
      3_000,
      {},
    ));
    const evidence = successful<{
      evidence: { document: { evidence_id: string } };
    }>(dispatch(
      "ticket.evidence.append",
      "outcome-revocation:evidence",
      "agent:executor",
      3_000,
      {
        expectedSource: evidenceSource.source,
        run: runCredentials,
        acceptanceId: "api-observable",
        evidenceType: "inspection",
        summary: "The reviewed API is observable in the fixture.",
        references: [{
          kind: "repo_path",
          label: "Fixture API",
          target: "README.md",
        }],
      },
    ));
    successful(dispatch(
      "ticket.run.release",
      "outcome-revocation:release",
      "agent:executor",
      4_000,
      {
        ...runCredentials,
        reason: "lease_released",
      },
    ));
    const closeoutSource = successful<{
      source: TicketLedgerPatchExpectedSource;
    }>(dispatch(
      "ticket.frontier.read",
      "outcome-revocation:closeout-source",
      "agent:verifier",
      5_000,
      {},
    ));
    successful(dispatch(
      "ticket.closeout.append",
      "outcome-revocation:closeout",
      "agent:verifier",
      5_000,
      {
        expectedSource: closeoutSource.source,
        runId: run.runId,
        generation: run.generation,
        terminalForm: "successful",
        executorReport: "Implemented the exact reviewed API.",
        acceptance: [{
          acceptanceId: "api-observable",
          disposition: "accepted",
          evidenceRefs: [evidence.evidence.document.evidence_id],
          rationale: "The independent verifier inspected the API.",
        }],
        followUpTicketRefs: [],
        semanticCloseoutRefs: [],
      },
    ));

    const completed = successful<{
      tickets: Array<{
        ticketId: string;
        status: string;
      }>;
    }>(dispatch(
      "ticket.frontier.read",
      "outcome-revocation:completed",
      "agent:reader",
      6_000,
      {},
    ));
    expect(completed.tickets.find((ticket) =>
      ticket.ticketId === "implement-api")).toMatchObject({
        status: "DONE",
      });
    expect(completed.tickets.find((ticket) =>
      ticket.ticketId === "publish-client")).toMatchObject({
        status: "READY",
      });

    liveProfile = {
      ...liveProfile,
      revokedAt: new Date(fixture.now + 7_000).toISOString(),
    };
    db.close();
    dbs.splice(dbs.indexOf(db), 1);
    const freshDb = openDb(path.join(
      fixture.repository,
      "outcome-revocation-fresh.sqlite",
    ));
    dbs.push(freshDb);
    const freshRepo = upsertRepo(
      freshDb,
      fixture.repository,
      "fixture/outcome-revocation",
      "main",
      new Date(fixture.now + 8_000).toISOString(),
    );
    const fresh = new OperationDispatcher(freshDb, {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles: trustProfiles,
    });
    const revoked = fresh.dispatch("ticket.frontier.read", {
      repoId: freshRepo.id,
      actor: "agent:fresh-reader",
      requestId: "outcome-revocation:fresh-frontier",
      now: new Date(fixture.now + 8_000).toISOString(),
    }, {});
    if (!revoked.ok) throw new Error(JSON.stringify(revoked.error));
    const revokedFrontier = revoked.data as {
      source: TicketLedgerPatchExpectedSource;
      tickets: Array<{
        ticketId: string;
        ticketRevision: string;
        status: string;
        semanticStatus: string;
        blockingTicketIds: string[];
        currentOutcomeId: string | null;
        decisionBlocker: {
          reason: string;
          decisionId: string;
        } | null;
      }>;
    };
    expect(revokedFrontier.tickets.find((ticket) =>
      ticket.ticketId === "implement-api")).toMatchObject({
        status: "BLOCKED",
        semanticStatus: "DONE",
        currentOutcomeId: null,
        decisionBlocker: {
          decisionId: decision.document.decision_id,
          reason: "profile_revoked",
        },
      });
    const dependent = revokedFrontier.tickets.find((ticket) =>
      ticket.ticketId === "publish-client");
    expect(dependent).toMatchObject({
      status: "BLOCKED",
      semanticStatus: "READY",
      blockingTicketIds: ["implement-api"],
      currentOutcomeId: null,
      decisionBlocker: null,
    });
    if (dependent === undefined) throw new Error("missing dependent Ticket");

    expect(fresh.dispatch("ticket.context.compile", {
      repoId: freshRepo.id,
      actor: "agent:fresh-reader",
      requestId: "outcome-revocation:dependent-compile",
      now: new Date(fixture.now + 9_000).toISOString(),
    }, {
      expectedSource: revokedFrontier.source,
      ticketId: dependent.ticketId,
      expectedTicketRevision: dependent.ticketRevision,
    })).toMatchObject({
      ok: false,
      error: {
        code: "ticket_not_ready",
        details: {
          blockingTicketIds: ["implement-api"],
        },
      },
    });
    expect(fresh.dispatch("ticket.run.claim", {
      repoId: freshRepo.id,
      actor: "agent:fresh-reader",
      requestId: "outcome-revocation:old-binding-claim",
      now: new Date(fixture.now + 9_000).toISOString(),
    }, {
      expectedSource: revokedFrontier.source,
      ticketId: root.ticketId,
      expectedTicketRevision: root.ticketRevision,
      contextBindingId:
        compiled.contextBinding.document.context_binding_id,
      contextBindingDigest: compiled.contextBinding.documentDigest,
      leaseSeconds: 300,
    })).toMatchObject({
      ok: false,
      error: {
        code: "ticket_run_stale",
        details: {
          decisionId: decision.document.decision_id,
          reason: "profile_revoked",
        },
      },
    });

    const durableVerifier =
      new DurableLocalSignatureTicketDecisionAttestationVerifierV0({
        trustProfiles,
      });
    const snapshot =
      loadTicketLedgerFromWorktree(fixture.repository);
    expect(snapshot.outcomes).toEqual([
      expect.objectContaining({
        document: expect.objectContaining({
          terminal_form: "successful",
        }),
      }),
    ]);
    const trusted = projectTicketLedgerForTrustedDecisionHostV0(
      snapshot,
      durableVerifier,
    );
    expect(trusted.currentCapabilityProjections.find((projection) =>
      projection.capability === "operational"
      && projection.subject.kind === "ticket"
      && projection.subject.ticketId === "implement-api"))
      .toMatchObject({
        summary: {
          label: "BLOCKED",
          detail: "Recorded Outcome is not operational: profile_revoked",
        },
      });
    expect(trusted.currentCapabilityProjections.find((projection) =>
      projection.capability === "operational"
      && projection.subject.kind === "ticket"
      && projection.subject.ticketId === "publish-client"))
      .toMatchObject({
        summary: {
          label: "BLOCKED",
          detail: "Waiting for 1 prerequisite",
        },
      });
    expect(trusted.traceRecords.find((record) =>
      record.kind === "outcome"
      && record.subkind === "successful")).toBeDefined();
    const mechanical = projectTicketLedgerForReview(snapshot);
    expect(mechanical.currentCapabilityProjections.find((projection) =>
      projection.capability === "operational"
      && projection.subject.kind === "ticket"
      && projection.subject.ticketId === "implement-api"))
      .toMatchObject({ summary: { label: "DONE" } });
  });
});
