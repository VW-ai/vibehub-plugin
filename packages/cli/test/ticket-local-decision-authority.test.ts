import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalTicketLedgerValue } from "@vw-ai/vibehub-core";
import {
  TICKET_LOCAL_DECISION_AUTHORITY_SIGNING_DOMAIN,
  TicketLocalDecisionAuthority,
  ticketLocalDecisionAttestationTrustProfileResolver,
  ticketLocalDecisionAuthoritySigningMessage,
  type TicketLocalDecisionAuthorityProfileV1,
} from "../src/ticket-local-decision-authority.js";

const CREATED_AT = "2026-07-30T12:00:00.000Z";
const REVOKED_AT = "2026-07-30T13:00:00.000Z";
const REPOSITORY = `repo-${"a".repeat(64)}`;

describe("Ticket Local Decision authority", () => {
  let root: string;
  let registryPath: string;
  let clock: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      "vh-ticket-local-authority-",
    ));
    registryPath = path.join(
      root,
      "decision-authority.v1",
      "registry.json",
    );
    clock = CREATED_AT;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("automatically creates one content-bound repo profile and private key outside the repo", () => {
    const authority = createAuthority(registryPath, () => clock);
    const profile = authority.ensureProfile(REPOSITORY);
    const expectedKeyId = `tdk-${profile.keyFingerprint}`;
    const expectedProfileId = `tla-${sha256(JSON.stringify({
      keyId: expectedKeyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: REPOSITORY,
      algorithm: "Ed25519",
    }))}`;
    expect(profile).toEqual({
      profileId: expectedProfileId,
      keyId: expectedKeyId,
      keyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      principalId: `local-installation:${expectedProfileId}`,
      principalKind: "human",
      authorityBasis: "designated_human",
      authorityRef: `vibehub:local-installation:${expectedProfileId}`,
      repositoryIncarnation: REPOSITORY,
      algorithm: "Ed25519",
      publicKeySpkiPem: expect.stringContaining("BEGIN PUBLIC KEY"),
      createdAt: CREATED_AT,
      revokedAt: null,
    });
    expect(authority.ensureProfile(REPOSITORY)).toEqual(profile);
    expect(authority.listProfiles()).toEqual([profile]);

    const storeRoot = path.dirname(registryPath);
    const keyPath = path.join(
      storeRoot,
      "keys",
      `${profile.keyId}.pk8.pem`,
    );
    expect(fs.statSync(storeRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(storeRoot, ".authority-write-lock.sqlite")).mode
        & 0o777,
    ).toBe(0o600);
    expect(fs.readFileSync(keyPath, "utf8")).toContain(
      "BEGIN PRIVATE KEY",
    );

    const persisted = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual([
      "profiles",
      "schemaVersion",
    ]);
    expect(persisted.profiles).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE KEY");
  });

  it("signs only the domain-separated canonical envelope with Ed25519", () => {
    const authority = createAuthority(registryPath, () => clock);
    const envelope = {
      scope: { disposition: "accept", ticket_id: "ticket-a" },
      decision: { decision_id: "decision-a", document_digest: "abc" },
    };
    const signed = authority.signEnvelope({
      repositoryIncarnation: REPOSITORY,
      envelope,
    });
    const publicKey = crypto.createPublicKey(
      signed.profile.publicKeySpkiPem,
    );
    expect(crypto.verify(
      null,
      ticketLocalDecisionAuthoritySigningMessage(envelope),
      publicKey,
      Buffer.from(signed.signature, "base64url"),
    )).toBe(true);
    expect(crypto.verify(
      null,
      Buffer.from(canonicalTicketLedgerValue(envelope), "utf8"),
      publicKey,
      Buffer.from(signed.signature, "base64url"),
    )).toBe(false);
    expect(crypto.verify(
      null,
      ticketLocalDecisionAuthoritySigningMessage({
        ...envelope,
        scope: { disposition: "reject", ticket_id: "ticket-a" },
      }),
      publicKey,
      Buffer.from(signed.signature, "base64url"),
    )).toBe(false);
    expect(
      ticketLocalDecisionAuthoritySigningMessage(envelope).subarray(
        0,
        Buffer.byteLength(TICKET_LOCAL_DECISION_AUTHORITY_SIGNING_DOMAIN),
      ).toString(),
    ).toBe(TICKET_LOCAL_DECISION_AUTHORITY_SIGNING_DOMAIN);
  });

  it("dynamically revokes a repository, preserves history, and rotates to one new active profile", () => {
    const authority = createAuthority(registryPath, () => clock);
    const profile = authority.ensureProfile(REPOSITORY);
    const resolver = ticketLocalDecisionAttestationTrustProfileResolver(
      authority,
    );
    expect(resolver.resolveProfile({
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: REPOSITORY,
    })).toMatchObject({
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      principalId: profile.principalId,
      basis: "designated_human",
      basisRef: profile.authorityRef,
      algorithm: "Ed25519",
      revokedAt: null,
    });

    clock = REVOKED_AT;
    expect(authority.revokeRepository(REPOSITORY)).toEqual([{
      ...profile,
      revokedAt: REVOKED_AT,
    }]);
    expect(resolver.resolveProfile({
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: REPOSITORY,
    })).toMatchObject({
      keyId: profile.keyId,
      revokedAt: REVOKED_AT,
    });
    const replacement = authority.ensureProfile(REPOSITORY);
    expect(replacement).toMatchObject({
      repositoryIncarnation: REPOSITORY,
      revokedAt: null,
      createdAt: REVOKED_AT,
    });
    expect(replacement.profileId).not.toBe(profile.profileId);
    expect(authority.listProfiles()).toEqual(expect.arrayContaining([
      { ...profile, revokedAt: REVOKED_AT },
      replacement,
    ]));
    expect(authority.signEnvelope({
      repositoryIncarnation: REPOSITORY,
      envelope: { decision: "after-revocation" },
    }).profile).toEqual(replacement);
  });

  it("accepts a structural profile reader for deterministic host tests", () => {
    const profile = createAuthority(
      registryPath,
      () => clock,
    ).ensureProfile(REPOSITORY);
    const reader = {
      listProfiles: (): TicketLocalDecisionAuthorityProfileV1[] => [
        { ...profile },
      ],
    };
    const resolver = ticketLocalDecisionAttestationTrustProfileResolver(
      reader,
    );
    expect(resolver.resolveProfile({
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: REPOSITORY,
    })).toMatchObject({
      publicKeySpkiPem: profile.publicKeySpkiPem,
      principalKind: "human",
    });
    expect(resolver.resolveProfile({
      keyId: profile.keyId,
      keyFingerprint: "b".repeat(64),
      repositoryIncarnation: REPOSITORY,
    })).toBeNull();
  });

  it("fails closed on schema and public-key identity tampering", () => {
    const authority = createAuthority(registryPath, () => clock);
    authority.ensureProfile(REPOSITORY);
    const original = fs.readFileSync(registryPath, "utf8");

    const unknown = JSON.parse(original);
    unknown.untrusted = true;
    writeRegistryFixture(registryPath, unknown);
    expect(() => authority.listProfiles()).toThrow(
      /unknown or missing fields/u,
    );

    const rebound = JSON.parse(original);
    rebound.profiles[0].repositoryIncarnation = `repo-${"b".repeat(64)}`;
    writeRegistryFixture(registryPath, rebound);
    expect(() => authority.listProfiles()).toThrow(/content identity/u);

    const fingerprint = JSON.parse(original);
    fingerprint.profiles[0].keyFingerprint = "c".repeat(64);
    fingerprint.profiles[0].keyId = `tdk-${"c".repeat(64)}`;
    writeRegistryFixture(registryPath, fingerprint);
    expect(() => authority.listProfiles()).toThrow(/content identity/u);
  });

  it("fails closed on insecure modes and symlinks for registry and key", () => {
    const authority = createAuthority(registryPath, () => clock);
    const profile = authority.ensureProfile(REPOSITORY);
    const originalRegistry = fs.readFileSync(registryPath, "utf8");
    const keyPath = path.join(
      path.dirname(registryPath),
      "keys",
      `${profile.keyId}.pk8.pem`,
    );
    const originalKey = fs.readFileSync(keyPath, "utf8");

    fs.chmodSync(registryPath, 0o644);
    expect(() => authority.listProfiles()).toThrow(/0600/u);
    fs.chmodSync(registryPath, 0o600);

    fs.chmodSync(keyPath, 0o644);
    expect(() => authority.signEnvelope({
      repositoryIncarnation: REPOSITORY,
      envelope: { decision: "mode" },
    })).toThrow(/0600/u);
    fs.chmodSync(keyPath, 0o600);

    const keyTarget = path.join(root, "attacker-key.pem");
    fs.writeFileSync(keyTarget, originalKey, { mode: 0o600 });
    fs.unlinkSync(keyPath);
    fs.symlinkSync(keyTarget, keyPath);
    expect(() => authority.signEnvelope({
      repositoryIncarnation: REPOSITORY,
      envelope: { decision: "key-symlink" },
    })).toThrow(/0600|symlink/u);
    fs.unlinkSync(keyPath);
    fs.writeFileSync(keyPath, originalKey, { mode: 0o600 });

    const registryTarget = path.join(root, "attacker-registry.json");
    fs.writeFileSync(registryTarget, originalRegistry, { mode: 0o600 });
    fs.unlinkSync(registryPath);
    fs.symlinkSync(registryTarget, registryPath);
    expect(() => authority.listProfiles()).toThrow(/0600|symlink/u);
  });

  it("does not remove or bypass a competing writer lock", () => {
    const authorityRoot = path.dirname(registryPath);
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(authorityRoot, 0o700);
    const lockPath = path.join(authorityRoot, ".authority.lock");
    fs.writeFileSync(lockPath, "other-writer\n", { mode: 0o600 });
    const authority = createAuthority(registryPath, () => clock);
    expect(() => authority.ensureProfile(REPOSITORY)).toThrowError(
      expect.objectContaining({ code: "store_busy" }),
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe("other-writer\n");
  });

  it("recovers a well-formed lock whose owning process no longer exists", () => {
    const authorityRoot = path.dirname(registryPath);
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(authorityRoot, 0o700);
    const lockPath = path.join(authorityRoot, ".authority.lock");
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      nonce: "a".repeat(32),
    })}\n`, { mode: 0o600 });
    const authority = createAuthority(registryPath, () => clock);
    expect(authority.ensureProfile(REPOSITORY)).toMatchObject({
      repositoryIncarnation: REPOSITORY,
      revokedAt: null,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("publishes only a complete owner record through atomic no-replace linking", () => {
    const originalLink = fs.linkSync;
    let publishedRecord = "";
    const link = vi.spyOn(fs, "linkSync").mockImplementation(
      (existingPath, newPath) => {
        if (String(newPath).endsWith(".authority.lock")) {
          publishedRecord = fs.readFileSync(existingPath, "utf8");
        }
        return originalLink(existingPath, newPath);
      },
    );
    try {
      const authority = createAuthority(registryPath, () => clock);
      expect(authority.ensureProfile(REPOSITORY)).toMatchObject({
        repositoryIncarnation: REPOSITORY,
      });
    } finally {
      link.mockRestore();
    }
    expect(JSON.parse(publishedRecord)).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
  });

  it("repairs a non-semantic coordination file left before mode hardening", () => {
    const authorityRoot = path.dirname(registryPath);
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(authorityRoot, 0o700);
    const coordinationPath = path.join(
      authorityRoot,
      ".authority-write-lock.sqlite",
    );
    fs.writeFileSync(coordinationPath, "", { mode: 0o644 });
    fs.chmodSync(coordinationPath, 0o644);

    const authority = createAuthority(registryPath, () => clock);
    expect(authority.ensureProfile(REPOSITORY)).toMatchObject({
      repositoryIncarnation: REPOSITORY,
    });
    expect(fs.statSync(coordinationPath).mode & 0o777).toBe(0o600);
  });

  it("does not race stale-owner recovery past a concurrent authority writer", () => {
    const authorityRoot = path.dirname(registryPath);
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(authorityRoot, 0o700);
    const lockPath = path.join(authorityRoot, ".authority.lock");
    const staleRecord = `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      nonce: "b".repeat(32),
    })}\n`;
    fs.writeFileSync(lockPath, staleRecord, { mode: 0o600 });

    const coordinationPath = path.join(
      authorityRoot,
      ".authority-write-lock.sqlite",
    );
    const competingWriter = new Database(coordinationPath);
    fs.chmodSync(coordinationPath, 0o600);
    competingWriter.exec("BEGIN IMMEDIATE");
    try {
      const authority = createAuthority(registryPath, () => clock);
      expect(() => authority.ensureProfile(REPOSITORY)).toThrowError(
        expect.objectContaining({ code: "store_busy" }),
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(staleRecord);
    } finally {
      competingWriter.exec("ROLLBACK");
      competingWriter.close();
    }

    const authority = createAuthority(registryPath, () => clock);
    expect(authority.ensureProfile(REPOSITORY)).toMatchObject({
      repositoryIncarnation: REPOSITORY,
      revokedAt: null,
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects malformed repository identities before touching the store", () => {
    const authority = createAuthority(registryPath, () => clock);
    expect(() => authority.ensureProfile("repo-not-a-digest")).toThrow(
      /repositoryIncarnation/u,
    );
    expect(fs.existsSync(path.dirname(registryPath))).toBe(false);
  });
});

const createAuthority = (
  registryPath: string,
  now: () => string,
): TicketLocalDecisionAuthority =>
  new TicketLocalDecisionAuthority({
    registryPath,
    now,
    randomBytes: (size) => Buffer.alloc(size, 0x5a),
  });

const writeRegistryFixture = (
  registryPath: string,
  value: unknown,
): void => {
  fs.writeFileSync(registryPath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(registryPath, 0o600);
};

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");
