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
  ticketDecisionAttestationChallenge,
  ticketDecisionAttestationDocumentPath,
  ticketDecisionDocumentDigest,
  type Db,
  type TicketDecisionAttestationDocument,
  type TicketDecisionAttestationDocumentPayload,
  type TicketDecisionAttestationEnvelope,
  type TicketDecisionAttestationScope,
  type TicketDecisionAuthorityContext,
  type TicketDocument,
  type TicketLedgerDecision,
  type TicketLedgerDecisionAttestation,
  type TicketLedgerPatchExpectedSource,
  type TicketLedgerSnapshot,
  type TicketLedgerWorktreeSource,
  type TicketReviewSubject,
} from "../src/index.js";
import {
  DurableWebAuthnTicketDecisionAttestationVerifierV0,
  projectTicketLedgerForTrustedDecisionHostV0,
  type TicketDecisionAttestationTrustProfileResolverV0,
  type TicketDecisionAttestationTrustProfileV0,
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

const authority: TicketDecisionAuthorityContext = {
  principal_id: "human:repository-owner",
  principal_kind: "human",
  basis: "repository_owner",
  basis_ref: "webauthn-profile:owner",
  attestation: "host_bound_local",
};

interface DecisionFixture {
  repository: string;
  snapshot: TicketLedgerSnapshot;
  decision: TicketLedgerDecision;
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
    authority,
    decidedAt: new Date(now - 10_000).toISOString(),
  });
  const snapshot = loadTicketLedgerFromWorktree(repository);
  const decision = snapshot.decisions.find((candidate) =>
    candidate.documentPath === recorded.decision.documentPath);
  if (decision === undefined) throw new Error("missing fixture Decision");
  return { repository, snapshot, decision, now };
};

interface CredentialFixture {
  credentialId: string;
  fingerprint: string;
  privateKey: crypto.KeyObject;
  profile: TicketDecisionAttestationTrustProfileV0;
}

const credential = (
  snapshot: TicketLedgerSnapshot,
): CredentialFixture => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  });
  const fingerprint = crypto
    .createHash("sha256")
    .update(publicKeyDer)
    .digest("hex");
  const credentialId = crypto.randomBytes(32).toString("base64url");
  return {
    credentialId,
    fingerprint,
    privateKey,
    profile: {
      credentialId,
      credentialFingerprint: fingerprint,
      publicKeySpkiPem: publicKey.export({
        type: "spki",
        format: "pem",
      }).toString(),
      principalId: authority.principal_id,
      principalKind: "human",
      basis: authority.basis,
      basisRef: authority.basis_ref,
      repositoryIncarnation:
        snapshot.source.repositoryIncarnation,
      revokedAt: null,
    },
  };
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

const worktreeSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerWorktreeSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new Error("expected worktree source");
  }
  return snapshot.source;
};

interface AttestationTimes {
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
}

const defaultTimes = (now: number): AttestationTimes => ({
  issuedAt: new Date(now - 5_000).toISOString(),
  notBefore: new Date(now - 5_000).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(),
});

const signAttestation = (
  snapshot: TicketLedgerSnapshot,
  decision: TicketLedgerDecision,
  signer: CredentialFixture,
  times = defaultTimes(Date.now()),
): TicketDecisionAttestationDocument => {
  const source = worktreeSource(snapshot);
  const envelope: TicketDecisionAttestationEnvelope = {
    schema_version: 1,
    kind: "ticket_decision_attestation",
    decision: {
      decision_id: decision.document.decision_id,
      document_path: decision.documentPath,
      document_digest: ticketDecisionDocumentDigest(
        decision.document,
      ),
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
      checkout: source.branch === null
        ? {
            mode: "detached",
            commit: source.resolvedCommit,
          }
        : {
            mode: "branch",
            branch: source.branch,
          },
    },
    scope: exactScope(decision),
    credential: {
      credential_id: signer.credentialId,
      fingerprint: signer.fingerprint,
    },
    webauthn: {
      rp_id: "localhost",
      origin: "http://localhost:43123",
      algorithm: "ES256",
    },
    nonce: crypto.randomBytes(24).toString("base64url"),
    issued_at: times.issuedAt,
    not_before: times.notBefore,
    expires_at: times.expiresAt,
  };
  const clientDataBytes = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: ticketDecisionAttestationChallenge(envelope),
    origin: envelope.webauthn.origin,
    crossOrigin: false,
  }), "utf8");
  const authenticatorData = Buffer.alloc(37);
  crypto.createHash("sha256")
    .update("localhost")
    .digest()
    .copy(authenticatorData, 0);
  authenticatorData[32] = 0x05;
  const signedBytes = Buffer.concat([
    authenticatorData,
    crypto.createHash("sha256").update(clientDataBytes).digest(),
  ]);
  const payload: TicketDecisionAttestationDocumentPayload = {
    ...envelope,
    webauthn: {
      ...envelope.webauthn,
      client_data_json: clientDataBytes.toString("base64url"),
      authenticator_data: authenticatorData.toString("base64url"),
      signature: crypto.sign(
        "sha256",
        signedBytes,
        signer.privateKey,
      ).toString("base64url"),
    },
  };
  return createTicketDecisionAttestationDocument(payload);
};

const resolver = (
  read: () => TicketDecisionAttestationTrustProfileV0 | null,
): TicketDecisionAttestationTrustProfileResolverV0 => ({
  resolveProfile(lookup) {
    const profile = read();
    return profile !== null
      && lookup.credentialId === profile.credentialId
      && lookup.credentialFingerprint
        === profile.credentialFingerprint
      && lookup.repositoryIncarnation
        === profile.repositoryIncarnation
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
  const {
    attestation_id: _attestationId,
    ...payload
  } = document;
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
  profile: () => TicketDecisionAttestationTrustProfileV0 | null,
  now: number,
) => new DurableWebAuthnTicketDecisionAttestationVerifierV0({
  trustProfiles: resolver(profile),
  now: () => now,
}).verify(snapshot, decision);

describe("durable WebAuthn Ticket Decision attestation", () => {
  const roots: string[] = [];
  const dbs: Db[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    roots.splice(0).forEach((root) =>
      fs.rmSync(root, { recursive: true, force: true }));
  });

  it("verifies an exact receipt and rejects every material Decision mutation", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const signer = credential(fixture.snapshot);
    const attestation = signAttestation(
      fixture.snapshot,
      fixture.decision,
      signer,
      defaultTimes(fixture.now),
    );
    const snapshot = withAttestations(
      fixture.snapshot,
      [attestation],
    );
    expect(verification(
      snapshot,
      fixture.decision,
      () => signer.profile,
      fixture.now,
    )).toMatchObject({
      status: "verified",
      verificationRef: attestation.attestation_id,
      source: "durable_webauthn",
    });

    const mutations: Array<[
      string,
      (decision: TicketLedgerDecision) => void,
    ]> = [
      ["decision id", (value) => {
        value.document.decision_id = `tdc-${"1".repeat(64)}`;
      }],
      ["document path", (value) => {
        value.documentPath =
          ".vibehub/tickets/decisions/other.yaml";
      }],
      ["subject revision", (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.subject.ticket_revision = "1".repeat(64);
        }
      }],
      ["boundary", (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.boundary = "A different boundary.";
        }
      }],
      ["disposition", (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.disposition = "decline";
          delete value.document.selection;
        }
      }],
      ["selection", (value) => {
        if (value.document.decision_type === "protected_boundary") {
          value.document.selection = "Break compatibility.";
        }
      }],
      ["rationale", (value) => {
        value.document.rationale = "Repository-edited rationale.";
      }],
      ["resolution refs", (value) => {
        value.document.resolution_refs = ["repo-edited-ref"];
      }],
      ["authority principal", (value) => {
        value.document.authority.principal_id = "human:other";
      }],
      ["authority kind", (value) => {
        (value.document.authority as { principal_kind: string })
          .principal_kind = "agent";
      }],
      ["authority basis", (value) => {
        value.document.authority.basis = "designated_human";
      }],
      ["authority basis ref", (value) => {
        value.document.authority.basis_ref = "other-profile";
      }],
      ["authority attestation", (value) => {
        (value.document.authority as { attestation: string })
          .attestation = "claimed";
      }],
      ["decided at", (value) => {
        value.document.decided_at =
          new Date(fixture.now - 9_000).toISOString();
      }],
    ];
    for (const [name, mutate] of mutations) {
      const changed = structuredClone(fixture.decision);
      mutate(changed);
      const changedSnapshot = {
        ...snapshot,
        decisions: [changed],
      };
      expect(
        verification(
          changedSnapshot,
          changed,
          () => signer.profile,
          fixture.now,
        ),
        name,
      ).toMatchObject({ status: "unverified" });
    }
  });

  it("rejects tampering of every durable receipt claim and WebAuthn proof field", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const signer = credential(fixture.snapshot);
    const original = signAttestation(
      fixture.snapshot,
      fixture.decision,
      signer,
      defaultTimes(fixture.now),
    );
    const alternateDigest = "1".repeat(64);
    const alternateId = `tdc-${"2".repeat(64)}`;
    const alternateWorktree = `worktree-${"3".repeat(64)}`;
    const alternateRepo = `repo-${"4".repeat(64)}`;
    const clientData = Buffer.from(JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.alloc(32, 7).toString("base64url"),
      origin: original.webauthn.origin,
      crossOrigin: false,
    })).toString("base64url");
    const mutations: Array<[
      string,
      (value: TicketDecisionAttestationDocument) => void,
    ]> = [
      ["decision id", (value) => {
        value.decision.decision_id = alternateId;
      }],
      ["decision path", (value) => {
        value.decision.document_path =
          ".vibehub/tickets/decisions/other.yaml";
      }],
      ["decision digest", (value) => {
        value.decision.document_digest = alternateDigest;
      }],
      ["principal", (value) => {
        value.authority.principal_id = "human:other";
      }],
      ["principal kind", (value) => {
        (value.authority as { principal_kind: string })
          .principal_kind = "agent";
      }],
      ["basis", (value) => {
        value.authority.basis = "designated_human";
      }],
      ["basis ref", (value) => {
        value.authority.basis_ref = "webauthn-profile:other";
      }],
      ["repository incarnation", (value) => {
        value.repository.repository_incarnation = alternateRepo;
      }],
      ["repository root", (value) => {
        value.repository.repository_root = "/other/repository";
      }],
      ["worktree identity", (value) => {
        value.repository.worktree_identity = alternateWorktree;
      }],
      ["worktree root", (value) => {
        value.repository.worktree_root = "/other/worktree";
      }],
      ["checkout", (value) => {
        value.repository.checkout = {
          mode: "branch",
          branch: "other",
        };
      }],
      ["scope ticket", (value) => {
        if (value.scope.scope_type === "protected_boundary") {
          value.scope.ticket_id = "other-ticket";
        }
      }],
      ["scope revision", (value) => {
        if (value.scope.scope_type === "protected_boundary") {
          value.scope.ticket_revision = alternateDigest;
        }
      }],
      ["scope boundary", (value) => {
        if (value.scope.scope_type === "protected_boundary") {
          value.scope.boundary = "Other boundary.";
        }
      }],
      ["scope disposition", (value) => {
        if (value.scope.scope_type === "protected_boundary") {
          value.scope.disposition = "decline";
          delete value.scope.selection;
        }
      }],
      ["scope selection", (value) => {
        if (value.scope.scope_type === "protected_boundary") {
          value.scope.selection = "Other selection.";
        }
      }],
      ["credential id", (value) => {
        value.credential.credential_id =
          crypto.randomBytes(32).toString("base64url");
      }],
      ["credential fingerprint", (value) => {
        value.credential.fingerprint = alternateDigest;
      }],
      ["rp id", (value) => {
        (value.webauthn as { rp_id: string }).rp_id = "example.test";
      }],
      ["origin", (value) => {
        value.webauthn.origin = "http://localhost:43124";
      }],
      ["algorithm", (value) => {
        (value.webauthn as { algorithm: string }).algorithm = "RS256";
      }],
      ["client data", (value) => {
        value.webauthn.client_data_json = clientData;
      }],
      ["authenticator data", (value) => {
        const bytes = Buffer.from(
          value.webauthn.authenticator_data,
          "base64url",
        );
        bytes[0] = bytes[0]! ^ 0xff;
        value.webauthn.authenticator_data =
          bytes.toString("base64url");
      }],
      ["signature", (value) => {
        const bytes = Buffer.from(
          value.webauthn.signature,
          "base64url",
        );
        bytes[bytes.length - 1] =
          bytes[bytes.length - 1]! ^ 0x01;
        value.webauthn.signature = bytes.toString("base64url");
      }],
      ["nonce", (value) => {
        value.nonce = crypto.randomBytes(24).toString("base64url");
      }],
      ["issued at", (value) => {
        value.issued_at =
          new Date(fixture.now - 4_000).toISOString();
      }],
      ["not before", (value) => {
        value.not_before =
          new Date(fixture.now - 4_000).toISOString();
      }],
      ["expires at", (value) => {
        value.expires_at =
          new Date(fixture.now + 61_000).toISOString();
      }],
    ];
    for (const [name, mutate] of mutations) {
      const changed = cloneAttestation(original, mutate);
      const snapshot = withAttestations(
        fixture.snapshot,
        [changed],
      );
      expect(
        verification(
          snapshot,
          fixture.decision,
          () => signer.profile,
          fixture.now,
        ),
        name,
      ).toMatchObject({ status: "unverified" });
    }

    const wrongIdentity = structuredClone(original);
    wrongIdentity.attestation_id = `tda-${"9".repeat(64)}`;
    const wrongIdentitySnapshot: TicketLedgerSnapshot = {
      ...fixture.snapshot,
      attestations: [{
        documentPath: ticketDecisionAttestationDocumentPath(original),
        document: wrongIdentity,
      }],
    };
    expect(verification(
      wrongIdentitySnapshot,
      fixture.decision,
      () => signer.profile,
      fixture.now,
    )).toMatchObject({
      status: "unverified",
      reason: "attestation_identity_mismatch",
    });
  });

  it("fails closed for replay, profile substitution, revocation, and validity boundaries", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const signer = credential(fixture.snapshot);
    const times = defaultTimes(fixture.now);
    const receipt = signAttestation(
      fixture.snapshot,
      fixture.decision,
      signer,
      times,
    );
    const snapshot = withAttestations(fixture.snapshot, [receipt]);

    const sourceMutations: Array<[
      string,
      (source: TicketLedgerWorktreeSource) => void,
    ]> = [
      ["repository", (source) => {
        source.repositoryIncarnation = `repo-${"7".repeat(64)}`;
      }],
      ["repository root", (source) => {
        source.repositoryRoot = "/replayed/repository";
      }],
      ["worktree", (source) => {
        source.worktreeIdentity = `worktree-${"8".repeat(64)}`;
      }],
      ["worktree root", (source) => {
        source.worktreeRoot = "/replayed/worktree";
      }],
      ["branch", (source) => {
        source.branch = "other";
      }],
    ];
    for (const [name, mutate] of sourceMutations) {
      const replay = structuredClone(snapshot);
      if (replay.source.mode !== "worktree") {
        throw new Error("expected worktree source");
      }
      mutate(replay.source);
      expect(
        verification(
          replay,
          fixture.decision,
          () => signer.profile,
          fixture.now,
        ),
        name,
      ).toMatchObject({ status: "unverified" });
    }

    const detached = structuredClone(fixture.snapshot);
    if (detached.source.mode !== "worktree") {
      throw new Error("expected worktree source");
    }
    detached.source.branch = null;
    const detachedReceipt = signAttestation(
      detached,
      fixture.decision,
      signer,
      times,
    );
    expect(verification(
      withAttestations(detached, [detachedReceipt]),
      fixture.decision,
      () => signer.profile,
      fixture.now,
    )).toMatchObject({ status: "verified" });
    const detachedReplay = structuredClone(detached);
    if (detachedReplay.source.mode !== "worktree") {
      throw new Error("expected worktree source");
    }
    detachedReplay.source.resolvedCommit = "f".repeat(40);
    expect(verification(
      withAttestations(detachedReplay, [detachedReceipt]),
      fixture.decision,
      () => signer.profile,
      fixture.now,
    )).toMatchObject({
      status: "unverified",
      reason: "checkout_binding_mismatch",
    });

    expect(verification(
      snapshot,
      fixture.decision,
      () => null,
      fixture.now,
    )).toMatchObject({
      status: "unverified",
      reason: "profile_unavailable",
    });
    const substituted = credential(fixture.snapshot);
    expect(verification(
      snapshot,
      fixture.decision,
      () => ({
        ...signer.profile,
        publicKeySpkiPem: substituted.profile.publicKeySpkiPem,
      }),
      fixture.now,
    )).toMatchObject({
      status: "unverified",
      reason: "credential_public_key_invalid",
    });
    expect(verification(
      snapshot,
      fixture.decision,
      () => ({
        ...signer.profile,
        principalId: "human:other",
      }),
      fixture.now,
    )).toMatchObject({
      status: "unverified",
      reason: "profile_mismatch",
    });

    let liveProfile: TicketDecisionAttestationTrustProfileV0 = {
      ...signer.profile,
    };
    let resolverCalls = 0;
    const dynamicVerifier =
      new DurableWebAuthnTicketDecisionAttestationVerifierV0({
        trustProfiles: {
          resolveProfile() {
            resolverCalls += 1;
            return liveProfile;
          },
        },
        now: () => fixture.now,
      });
    expect(dynamicVerifier.verify(snapshot, fixture.decision))
      .toMatchObject({ status: "verified" });
    liveProfile = {
      ...liveProfile,
      revokedAt: new Date(fixture.now).toISOString(),
    };
    expect(dynamicVerifier.verify(snapshot, fixture.decision))
      .toMatchObject({
        status: "unverified",
        reason: "profile_revoked",
      });
    liveProfile = {
      ...liveProfile,
      revokedAt: new Date(fixture.now + 60_000).toISOString(),
    };
    expect(dynamicVerifier.verify(snapshot, fixture.decision))
      .toMatchObject({
        status: "unverified",
        reason: "profile_revoked",
      });
    liveProfile = {
      ...liveProfile,
      revokedAt: "malformed-revocation-marker",
    };
    expect(dynamicVerifier.verify(snapshot, fixture.decision))
      .toMatchObject({
        status: "unverified",
        reason: "profile_revoked",
      });
    expect(resolverCalls).toBe(4);

    const issuedAt = Date.parse(times.issuedAt);
    const expiresAt = Date.parse(times.expiresAt);
    expect(verification(
      snapshot,
      fixture.decision,
      () => signer.profile,
      issuedAt - 1,
    )).toMatchObject({
      status: "unverified",
      reason: "not_yet_valid",
    });
    expect(verification(
      snapshot,
      fixture.decision,
      () => signer.profile,
      issuedAt,
    )).toMatchObject({ status: "verified" });
    expect(verification(
      snapshot,
      fixture.decision,
      () => signer.profile,
      expiresAt - 1,
    )).toMatchObject({ status: "verified" });
    expect(verification(
      snapshot,
      fixture.decision,
      () => signer.profile,
      expiresAt,
    )).toMatchObject({
      status: "unverified",
      reason: "expired",
    });
  });

  it("requires UP+UV, verifies signatures, and selects receipts deterministically", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const signer = credential(fixture.snapshot);
    const first = signAttestation(
      fixture.snapshot,
      fixture.decision,
      signer,
      defaultTimes(fixture.now),
    );
    const second = signAttestation(
      fixture.snapshot,
      fixture.decision,
      signer,
      defaultTimes(fixture.now),
    );
    const ordered = [first, second].sort((left, right) =>
      left.attestation_id.localeCompare(right.attestation_id));
    expect(verification(
      withAttestations(fixture.snapshot, [second, first]),
      fixture.decision,
      () => signer.profile,
      fixture.now,
    )).toMatchObject({
      status: "verified",
      verificationRef: ordered[0]!.attestation_id,
    });

    const flagsCases: Array<[number, string]> = [
      [0x04, "user_presence_required"],
      [0x01, "user_verification_required"],
    ];
    for (const [flags, reason] of flagsCases) {
      const changed = cloneAttestation(first, (document) => {
        const bytes = Buffer.from(
          document.webauthn.authenticator_data,
          "base64url",
        );
        bytes[32] = flags;
        document.webauthn.authenticator_data =
          bytes.toString("base64url");
      });
      expect(verification(
        withAttestations(fixture.snapshot, [changed]),
        fixture.decision,
        () => signer.profile,
        fixture.now,
      )).toMatchObject({ status: "unverified", reason });
    }
  });

  it("keeps raw Decisions unverified and lets a fresh dispatcher verify a durable receipt", () => {
    const fixture = setupDecision();
    roots.push(fixture.repository);
    const signer = credential(fixture.snapshot);
    const verifier =
      new DurableWebAuthnTicketDecisionAttestationVerifierV0({
        trustProfiles: resolver(() => signer.profile),
        now: () => fixture.now,
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
      signer,
      defaultTimes(fixture.now),
    );
    appendTicketDecisionAttestation({
      worktreeRoot: fixture.repository,
      request: {
        expectedSource: expectedSource(fixture.snapshot),
        attestation: (() => {
          const {
            attestation_id: _attestationId,
            ...payload
          } = receipt;
          return payload;
        })(),
      },
    });

    const db = openDb(path.join(fixture.repository, "runtime.sqlite"));
    dbs.push(db);
    const fresh = new OperationDispatcher(db, {
      repoRoot: fixture.repository,
      ticketDecisionAttestationTrustProfiles:
        resolver(() => signer.profile),
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
      subject: {
        kind: "ticket",
        ticketId: "implement-api",
      },
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
