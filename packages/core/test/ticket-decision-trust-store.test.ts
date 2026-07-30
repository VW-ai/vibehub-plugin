import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileTicketDecisionAttestationTrustProfileResolverV0,
  TicketDecisionAuthorityTrustStoreError,
} from "../src/ticket-decision-trust-store.js";
import { afterEach, describe, expect, it } from "vitest";

const CREATED_AT = "2026-07-30T18:00:00.000Z";
const REVOKED_AT = "2026-07-30T19:00:00.000Z";

interface RegistryFixture {
  profileId: string;
  keyFingerprint: string;
  principalId: string;
  principalKind: "human";
  authorityBasis: "repository_owner";
  authorityRef: string;
  repositoryIncarnation: string;
  rpId: "localhost";
  algorithm: "ES256";
  credentialId: string;
  publicKeyCose: string;
  publicKeySpkiPem: string;
  transports: string[];
  counter: number;
  lastAssertionDigest: string | null;
  createdAt: string;
  revokedAt: string | null;
}

describe("file Ticket Decision authority trust resolver", () => {
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
    const registryPath = path.join(trust, "authorities.json");
    const { publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicKeySpkiPem = publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const keyFingerprint = crypto.createHash("sha256").update(
      publicKey.export({ type: "spki", format: "der" }),
    ).digest("hex");
    const credentialId = Buffer.from(
      crypto.randomBytes(32),
    ).toString("base64url");
    const identity = {
      principalId: "wayne",
      principalKind: "human",
      authorityBasis: "repository_owner",
      authorityRef: "repo-owner:wayne",
      repositoryIncarnation: "repo-incarnation-1",
      rpId: "localhost",
      algorithm: "ES256",
      credentialId,
      keyFingerprint,
    };
    const profile: RegistryFixture = {
      profileId: `twa-${crypto.createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex")}`,
      keyFingerprint,
      principalId: "wayne",
      principalKind: "human",
      authorityBasis: "repository_owner",
      authorityRef: "repo-owner:wayne",
      repositoryIncarnation: "repo-incarnation-1",
      rpId: "localhost",
      algorithm: "ES256",
      credentialId,
      publicKeyCose: Buffer.from("fixture-cose").toString("base64url"),
      publicKeySpkiPem,
      transports: ["internal"],
      counter: 0,
      lastAssertionDigest: null,
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

  it("returns null when the external registry does not exist", () => {
    const { registryPath } = fixture();
    const resolver =
      new FileTicketDecisionAttestationTrustProfileResolverV0({
        registryPath,
      });
    expect(resolver.resolveProfile({
      credentialId: "missing",
      credentialFingerprint: "0".repeat(64),
      repositoryIncarnation: "repo-incarnation-1",
    })).toBeNull();
  });

  it("resolves exact trust and rereads revocation dynamically", () => {
    const { registryPath, profile } = fixture();
    writeRegistry(registryPath, [profile]);
    const resolver =
      new FileTicketDecisionAttestationTrustProfileResolverV0({
        registryPath,
      });
    const lookup = {
      credentialId: profile.credentialId,
      credentialFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    };
    expect(resolver.resolveProfile(lookup)).toEqual({
      credentialId: profile.credentialId,
      credentialFingerprint: profile.keyFingerprint,
      publicKeySpkiPem: profile.publicKeySpkiPem,
      principalId: profile.principalId,
      principalKind: "human",
      basis: "repository_owner",
      basisRef: profile.authorityRef,
      repositoryIncarnation: profile.repositoryIncarnation,
      revokedAt: null,
    });
    writeRegistry(registryPath, [{ ...profile, revokedAt: REVOKED_AT }]);
    expect(resolver.resolveProfile(lookup)).toMatchObject({
      revokedAt: REVOKED_AT,
    });
  });

  it("fails closed when authorityRef changes without a new identity", () => {
    const { registryPath, profile } = fixture();
    writeRegistry(registryPath, [{
      ...profile,
      authorityRef: "repo-owner:attacker",
    }]);
    const resolver =
      new FileTicketDecisionAttestationTrustProfileResolverV0({
        registryPath,
      });
    expect(() => resolver.resolveProfile({
      credentialId: profile.credentialId,
      credentialFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    })).toThrow(TicketDecisionAuthorityTrustStoreError);
  });

  it("rejects broad permissions, symlink ancestors, and schema ambiguity", () => {
    const { root, registryPath, profile } = fixture();
    const lookup = {
      credentialId: profile.credentialId,
      credentialFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    };
    const resolver =
      new FileTicketDecisionAttestationTrustProfileResolverV0({
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
      new FileTicketDecisionAttestationTrustProfileResolverV0({
        registryPath: path.join(linkedTrust, path.basename(registryPath)),
      });
    expect(() => linkedResolver.resolveProfile(lookup)).toThrow(
      /path is not trusted/,
    );
  });
});
