import crypto, {
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  FileTicketDecisionAttestationTrustProfileResolverV0,
} from "@vw-ai/vibehub-core";
import {
  TICKET_WEBAUTHN_RP_ID,
  TicketWebAuthnAuthorityError,
  TicketWebAuthnAuthorityRegistry,
  ticketDecisionAttestationTrustProfileResolver,
} from "../src/ticket-webauthn-authority.js";

const NOW = "2026-07-30T12:00:00.000Z";
const ORIGIN = "http://localhost:4321";
const PRINCIPAL_ID = "human:owner";
const REPOSITORY_INCARNATION = `repo-${"a".repeat(64)}`;

describe("Ticket WebAuthn authority registry", () => {
  let root: string;
  let registryPath: string;
  let authenticator: SoftwareAuthenticator;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(
      fs.realpathSync(os.tmpdir()),
      "vh-ticket-webauthn-",
    ));
    registryPath = path.join(root, "trust", "authorities.json");
    authenticator = createSoftwareAuthenticator();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers one UV ES256 credential in an external strict 0700/0600 registry", async () => {
    const registry = createRegistry(registryPath);
    const challenge = challengeFor("register");
    const options = await registry.createRegistrationOptions({
      principalId: PRINCIPAL_ID,
      authorityBasis: "repository_owner",
      authorityRef: "local-owner-enrollment",
      repositoryIncarnation: REPOSITORY_INCARNATION,
      challenge,
    });
    expect(options).toMatchObject({
      challenge,
      rp: { id: TICKET_WEBAUTHN_RP_ID },
      authenticatorSelection: { userVerification: "required" },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    });

    const profile = await registry.verifyRegistration({
      principalId: PRINCIPAL_ID,
      authorityBasis: "repository_owner",
      authorityRef: "local-owner-enrollment",
      repositoryIncarnation: REPOSITORY_INCARNATION,
      challenge,
      origin: ORIGIN,
      response: registrationResponse(authenticator, challenge, ORIGIN),
    });
    expect(profile).toMatchObject({
      profileId: expect.stringMatching(/^twa-[0-9a-f]{64}$/u),
      keyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      principalId: PRINCIPAL_ID,
      principalKind: "human",
      authorityBasis: "repository_owner",
      authorityRef: "local-owner-enrollment",
      repositoryIncarnation: REPOSITORY_INCARNATION,
      rpId: "localhost",
      algorithm: "ES256",
      credentialId: authenticator.credentialId,
      transports: ["internal"],
      counter: 0,
      lastAssertionDigest: null,
      createdAt: NOW,
      revokedAt: null,
    });
    expect(fs.statSync(path.dirname(registryPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);
    expect(registry.getActiveProfile(profile.profileId)).toEqual(profile);

    const persisted = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual([
      "profiles",
      "schemaVersion",
    ]);
    expect(persisted.profiles).toHaveLength(1);
    expect(
      new FileTicketDecisionAttestationTrustProfileResolverV0({
        registryPath,
      }).resolveProfile({
        credentialId: profile.credentialId,
        credentialFingerprint: profile.keyFingerprint,
        repositoryIncarnation: profile.repositoryIncarnation,
      }),
    ).toMatchObject({
      principalId: PRINCIPAL_ID,
      basis: "repository_owner",
      basisRef: "local-owner-enrollment",
      revokedAt: null,
    });
  });

  it("rejects registration responses with the wrong challenge or exact origin", async () => {
    const registry = createRegistry(registryPath);
    const expected = challengeFor("expected-registration");
    const base = {
      principalId: PRINCIPAL_ID,
      authorityBasis: "designated_human" as const,
      authorityRef: "designated-by-owner",
      repositoryIncarnation: REPOSITORY_INCARNATION,
      challenge: expected,
      origin: ORIGIN,
    };
    await expect(registry.verifyRegistration({
      ...base,
      response: registrationResponse(
        authenticator,
        challengeFor("wrong-registration"),
        ORIGIN,
      ),
    })).rejects.toMatchObject({
      code: "verification_failed",
    });
    await expect(registry.verifyRegistration({
      ...base,
      response: registrationResponse(
        authenticator,
        expected,
        "http://localhost:9876",
      ),
    })).rejects.toMatchObject({
      code: "verification_failed",
    });
    expect(registry.listProfiles()).toEqual([]);
  });

  it("verifies exact authentication, returns raw assertion fields, and advances the counter", async () => {
    const registry = createRegistry(registryPath);
    const profile = await register(registry, authenticator);
    const challenge = challengeFor("authenticate");
    const options = await registry.createAuthenticationOptions({
      profileId: profile.profileId,
      challenge,
    });
    expect(options).toMatchObject({
      challenge,
      rpId: "localhost",
      userVerification: "required",
      allowCredentials: [{
        id: authenticator.credentialId,
        type: "public-key",
        transports: ["internal"],
      }],
    });
    const response = authenticationResponse(
      authenticator,
      challenge,
      ORIGIN,
      1,
    );
    const presence = await registry.verifyAuthentication({
      profileId: profile.profileId,
      challenge,
      origin: ORIGIN,
      response,
    });
    expect(presence).toMatchObject({
      profile: {
        profileId: profile.profileId,
        counter: 1,
        lastAssertionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      verifiedAt: NOW,
      challenge,
      origin: ORIGIN,
      rpId: "localhost",
      userVerified: true,
      counter: 1,
      assertion: {
        credentialId: authenticator.credentialId,
        clientDataJSON: response.response.clientDataJSON,
        authenticatorData: response.response.authenticatorData,
        signature: response.response.signature,
        userHandle: null,
      },
    });
    expect(registry.getActiveProfile(profile.profileId).counter).toBe(1);
    await expect(registry.verifyAuthentication({
      profileId: profile.profileId,
      challenge,
      origin: ORIGIN,
      response,
    })).rejects.toMatchObject({
      code: "verification_failed",
    });
  });

  it("rejects authentication with the wrong origin, challenge, or credential", async () => {
    const registry = createRegistry(registryPath);
    const profile = await register(registry, authenticator);
    const expected = challengeFor("expected-authentication");

    await expect(registry.verifyAuthentication({
      profileId: profile.profileId,
      challenge: expected,
      origin: ORIGIN,
      response: authenticationResponse(
        authenticator,
        challengeFor("wrong-authentication"),
        ORIGIN,
        1,
      ),
    })).rejects.toMatchObject({ code: "verification_failed" });
    await expect(registry.verifyAuthentication({
      profileId: profile.profileId,
      challenge: expected,
      origin: ORIGIN,
      response: authenticationResponse(
        authenticator,
        expected,
        "http://localhost:9876",
        1,
      ),
    })).rejects.toMatchObject({ code: "verification_failed" });
    const wrongCredential = authenticationResponse(
      authenticator,
      expected,
      ORIGIN,
      1,
    );
    wrongCredential.id = challengeFor("other-credential");
    wrongCredential.rawId = wrongCredential.id;
    await expect(registry.verifyAuthentication({
      profileId: profile.profileId,
      challenge: expected,
      origin: ORIGIN,
      response: wrongCredential,
    })).rejects.toMatchObject({ code: "verification_failed" });
    expect(registry.getActiveProfile(profile.profileId).counter).toBe(0);
  });

  it("only revokes after a fresh verified presence assertion and removes resolver authority", async () => {
    const registry = createRegistry(registryPath);
    const profile = await register(registry, authenticator);
    const resolver = ticketDecisionAttestationTrustProfileResolver(registry);
    expect(resolver.resolveProfile({
      credentialId: profile.credentialId,
      credentialFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    })).toMatchObject({
      principalId: PRINCIPAL_ID,
      principalKind: "human",
      basis: "repository_owner",
      basisRef: "local-owner-enrollment",
      revokedAt: null,
    });

    const challenge = challengeFor("revoke");
    const revoked = await registry.revoke({
      profileId: profile.profileId,
      challenge,
      origin: ORIGIN,
      response: authenticationResponse(
        authenticator,
        challenge,
        ORIGIN,
        1,
      ),
    });
    expect(revoked.revokedAt).toBe(NOW);
    expect(() => registry.getActiveProfile(profile.profileId)).toThrowError(
      TicketWebAuthnAuthorityError,
    );
    await expect(registry.createAuthenticationOptions({
      profileId: profile.profileId,
      challenge: challengeFor("after-revoke"),
    })).rejects.toMatchObject({ code: "revoked" });
    expect(resolver.resolveProfile({
      credentialId: profile.credentialId,
      credentialFingerprint: profile.keyFingerprint,
      repositoryIncarnation: profile.repositoryIncarnation,
    })).toMatchObject({
      credentialId: profile.credentialId,
      revokedAt: NOW,
    });
  });

  it("fails closed on unknown schema fields, insecure mode, and registry symlinks", async () => {
    const registry = createRegistry(registryPath);
    await register(registry, authenticator);
    const original = fs.readFileSync(registryPath, "utf8");
    const identityMutation = JSON.parse(original);
    identityMutation.profiles[0].authorityRef = "repo-edit-must-not-rebind";
    fs.writeFileSync(
      registryPath,
      `${JSON.stringify(identityMutation)}\n`,
      { mode: 0o600 },
    );
    expect(() => registry.listProfiles()).toThrow(/content identity/u);

    const parsed = JSON.parse(original);
    parsed.untrusted = true;
    fs.writeFileSync(registryPath, `${JSON.stringify(parsed)}\n`, {
      mode: 0o600,
    });
    expect(() => registry.listProfiles()).toThrow(/unknown or missing/u);

    fs.writeFileSync(registryPath, original, { mode: 0o600 });
    fs.chmodSync(registryPath, 0o644);
    expect(() => registry.listProfiles()).toThrow(/0600/u);

    fs.chmodSync(registryPath, 0o600);
    const target = path.join(root, "attacker.json");
    fs.writeFileSync(target, original, { mode: 0o600 });
    fs.unlinkSync(registryPath);
    fs.symlinkSync(target, registryPath);
    expect(() => registry.listProfiles()).toThrow(/0600|symlink/u);
  });

  it("fails closed when any parent path component is a symlink", () => {
    const realParent = path.join(root, "real-trust");
    const linkedParent = path.join(root, "linked-trust");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, linkedParent);
    const registry = createRegistry(
      path.join(linkedParent, "authorities.json"),
    );
    expect(() => registry.listProfiles()).toThrow(/symlink/u);
  });
});

interface SoftwareAuthenticator {
  credentialId: string;
  credentialIdBytes: Buffer;
  cosePublicKey: Buffer;
  privateKey: KeyObject;
}

const createRegistry = (
  target: string,
): TicketWebAuthnAuthorityRegistry =>
  new TicketWebAuthnAuthorityRegistry({
    registryPath: target,
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 0x5a),
  });

const register = async (
  registry: TicketWebAuthnAuthorityRegistry,
  softwareAuthenticator: SoftwareAuthenticator,
) => {
  const challenge = challengeFor("register-happy");
  return registry.verifyRegistration({
    principalId: PRINCIPAL_ID,
    authorityBasis: "repository_owner",
    authorityRef: "local-owner-enrollment",
    repositoryIncarnation: REPOSITORY_INCARNATION,
    challenge,
    origin: ORIGIN,
    response: registrationResponse(
      softwareAuthenticator,
      challenge,
      ORIGIN,
    ),
  });
};

const challengeFor = (label: string): string =>
  crypto.createHash("sha256").update(label).digest("base64url");

const createSoftwareAuthenticator = (): SoftwareAuthenticator => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error("P-256 JWK is missing coordinates");
  }
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const cosePublicKey = cborMap([
    [cborInteger(1), cborInteger(2)],
    [cborInteger(3), cborInteger(-7)],
    [cborInteger(-1), cborInteger(1)],
    [cborInteger(-2), cborBytes(x)],
    [cborInteger(-3), cborBytes(y)],
  ]);
  const credentialIdBytes = crypto.createHash("sha256")
    .update(Buffer.concat([x, y]))
    .digest();
  return {
    credentialId: credentialIdBytes.toString("base64url"),
    credentialIdBytes,
    cosePublicKey,
    privateKey,
  };
};

const registrationResponse = (
  authenticator: SoftwareAuthenticator,
  challenge: string,
  origin: string,
): RegistrationResponseJSON => {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create",
    challenge,
    origin,
    crossOrigin: false,
  }));
  const authenticatorData = Buffer.concat([
    crypto.createHash("sha256").update(TICKET_WEBAUTHN_RP_ID).digest(),
    Buffer.from([0x45]),
    uint32(0),
    Buffer.alloc(16),
    uint16(authenticator.credentialIdBytes.length),
    authenticator.credentialIdBytes,
    authenticator.cosePublicKey,
  ]);
  const attestationObject = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborMap([])],
    [cborText("authData"), cborBytes(authenticatorData)],
  ]);
  return {
    id: authenticator.credentialId,
    rawId: authenticator.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      attestationObject: attestationObject.toString("base64url"),
      transports: ["internal"],
      publicKeyAlgorithm: -7,
    },
  };
};

const authenticationResponse = (
  authenticator: SoftwareAuthenticator,
  challenge: string,
  origin: string,
  counter: number,
): AuthenticationResponseJSON => {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false,
  }));
  const authenticatorData = Buffer.concat([
    crypto.createHash("sha256").update(TICKET_WEBAUTHN_RP_ID).digest(),
    Buffer.from([0x05]),
    uint32(counter),
  ]);
  const signatureBase = Buffer.concat([
    authenticatorData,
    crypto.createHash("sha256").update(clientDataJSON).digest(),
  ]);
  return {
    id: authenticator.credentialId,
    rawId: authenticator.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: crypto.sign(
        "sha256",
        signatureBase,
        authenticator.privateKey,
      ).toString("base64url"),
    },
  };
};

const uint16 = (value: number): Buffer => {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(value);
  return output;
};

const uint32 = (value: number): Buffer => {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
};

const cborInteger = (value: number): Buffer => value >= 0
  ? cborMajor(0, value)
  : cborMajor(1, -1 - value);

const cborBytes = (value: Uint8Array): Buffer =>
  Buffer.concat([cborMajor(2, value.byteLength), Buffer.from(value)]);

const cborText = (value: string): Buffer => {
  const encoded = Buffer.from(value, "utf8");
  return Buffer.concat([cborMajor(3, encoded.length), encoded]);
};

const cborMap = (entries: Array<[Buffer, Buffer]>): Buffer =>
  Buffer.concat([
    cborMajor(5, entries.length),
    ...entries.flatMap(([key, value]) => [key, value]),
  ]);

const cborMajor = (major: number, value: number): Buffer => {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value <= 0xff) return Buffer.from([(major << 5) | 24, value]);
  if (value <= 0xffff) {
    return Buffer.concat([Buffer.from([(major << 5) | 25]), uint16(value)]);
  }
  return Buffer.concat([Buffer.from([(major << 5) | 26]), uint32(value)]);
};
