import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTicketDecisionLocalSignatureTrustProfileResolverV0,
  TicketDecisionAuthorityTrustStoreError,
  defaultTicketDecisionLocalSignatureRegistryPath,
} from "../src/ticket-decision-trust-store.js";

const CREATED_AT = "2026-07-30T18:00:00.000Z";
const REVOKED_AT = "2026-07-30T19:00:00.000Z";

interface RegistryFixture {
  profileId: string;
  keyId: string;
  keyFingerprint: string;
  principalId: string;
  principalKind: "human";
  authorityBasis: "repository_owner";
  authorityRef: string;
  repositoryIncarnation: string;
  algorithm: "Ed25519";
  publicKeySpkiPem: string;
  createdAt: string;
  revokedAt: string | null;
}

describe("file Ticket Decision local-signature trust resolver", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const fixture = (): {
    root: string;
    registryPath: string;
    profile: RegistryFixture;
  } => {
    const root = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      "vibehub-ticket-trust-",
    ));
    roots.push(root);
    const trust = path.join(root, "trust");
    fs.mkdirSync(trust, { mode: 0o700 });
    fs.chmodSync(trust, 0o700);
    const registryPath = path.join(trust, "registry.json");
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeySpkiPem = publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const keyFingerprint = crypto.createHash("sha256").update(
      publicKey.export({ type: "spki", format: "der" }),
    ).digest("hex");
    const keyId = `tdk-${keyFingerprint}`;
    const repositoryIncarnation = `repo-${"a".repeat(64)}`;
    const identity = {
      keyId,
      keyFingerprint,
      repositoryIncarnation,
      algorithm: "Ed25519",
    };
    const profileId = `tla-${crypto.createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")}`;
    const profile: RegistryFixture = {
      profileId,
      keyId,
      keyFingerprint,
      principalId: `local-installation:${profileId}`,
      principalKind: "human",
      authorityBasis: "repository_owner",
      authorityRef: `vibehub:local-installation:${profileId}`,
      repositoryIncarnation,
      algorithm: "Ed25519",
      publicKeySpkiPem,
      createdAt: CREATED_AT,
      revokedAt: null,
    };
    return { root, registryPath, profile };
  };

  const writeRegistry = (
    registryPath: string,
    profiles: unknown[],
    extra: Record<string, unknown> = {},
  ): void => {
    fs.writeFileSync(
      registryPath,
      `${JSON.stringify({ schemaVersion: 1, profiles, ...extra })}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(registryPath, 0o600);
  };

  it("uses the install-local registry path and returns null when absent", () => {
    expect(defaultTicketDecisionLocalSignatureRegistryPath("/tmp/home"))
      .toBe("/tmp/home/.vibehub/trust/decision-authority.v1/registry.json");
    const { registryPath, profile } = fixture();
    const resolver =
      new FileTicketDecisionLocalSignatureTrustProfileResolverV0({
        registryPath,
      });
    expect(resolver.resolveProfile({
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    })).toBeNull();
  });

  it("resolves exact Ed25519 trust and rereads revocation dynamically", () => {
    const { registryPath, profile } = fixture();
    writeRegistry(registryPath, [profile]);
    const resolver =
      new FileTicketDecisionLocalSignatureTrustProfileResolverV0({
        registryPath,
      });
    const lookup = {
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    };
    expect(resolver.resolveProfile(lookup)).toEqual({
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      publicKeySpkiPem: profile.publicKeySpkiPem,
      principalId: profile.principalId,
      principalKind: "human",
      basis: "repository_owner",
      basisRef: profile.authorityRef,
      repositoryIncarnation: profile.repositoryIncarnation,
      createdAt: CREATED_AT,
      revokedAt: null,
    });
    writeRegistry(registryPath, [{ ...profile, revokedAt: REVOKED_AT }]);
    expect(resolver.resolveProfile(lookup)).toMatchObject({
      revokedAt: REVOKED_AT,
    });
  });

  it("rejects key, profile, principal, and authority identity substitution", () => {
    const { registryPath, profile } = fixture();
    const resolver =
      new FileTicketDecisionLocalSignatureTrustProfileResolverV0({
        registryPath,
      });
    for (const changed of [
      { ...profile, keyId: `tdk-${"1".repeat(64)}` },
      { ...profile, profileId: `tla-${"1".repeat(64)}` },
      { ...profile, principalId: "local-installation:attacker" },
      { ...profile, authorityRef: "vibehub:local-installation:attacker" },
    ]) {
      writeRegistry(registryPath, [changed]);
      expect(() => resolver.resolveProfile({
        keyId: profile.keyId,
        keyFingerprint: profile.keyFingerprint,
        repositoryIncarnation: profile.repositoryIncarnation,
      })).toThrow(TicketDecisionAuthorityTrustStoreError);
    }
  });

  it("rejects broad permissions, symlink ancestors, and schema ambiguity", () => {
    const { root, registryPath, profile } = fixture();
    const lookup = {
      keyId: profile.keyId,
      keyFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    };
    const resolver =
      new FileTicketDecisionLocalSignatureTrustProfileResolverV0({
        registryPath,
      });
    writeRegistry(registryPath, [profile]);
    fs.chmodSync(registryPath, 0o644);
    expect(() => resolver.resolveProfile(lookup)).toThrow(/owned 0600/);

    writeRegistry(registryPath, [profile, profile]);
    expect(() => resolver.resolveProfile(lookup)).toThrow(/duplicate/);

    writeRegistry(registryPath, [profile], { attacker: true });
    expect(() => resolver.resolveProfile(lookup)).toThrow(
      /unknown or missing fields/,
    );

    writeRegistry(registryPath, [profile]);
    const linkedTrust = path.join(root, "linked-trust");
    fs.symlinkSync(path.dirname(registryPath), linkedTrust, "dir");
    const linkedResolver =
      new FileTicketDecisionLocalSignatureTrustProfileResolverV0({
        registryPath: path.join(linkedTrust, path.basename(registryPath)),
      });
    expect(() => linkedResolver.resolveProfile(lookup)).toThrow(
      /path is not trusted/,
    );
  });
});
