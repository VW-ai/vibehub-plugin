import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type {
  TicketDecisionAttestationTrustProfileResolverV0,
} from "@vw-ai/vibehub-core";
import {
  convertCOSEtoPKCS,
  cose,
  decodeCredentialPublicKey,
} from "@simplewebauthn/server/helpers";

export const TICKET_WEBAUTHN_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const TICKET_WEBAUTHN_RP_ID = "localhost" as const;
export const TICKET_WEBAUTHN_ALGORITHM = "ES256" as const;

const ES256_COSE_ALGORITHM = -7 as const;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PROFILES = 128;
const REGISTRY_FILE_MODE = 0o600;
const REGISTRY_DIRECTORY_MODE = 0o700;
const PROFILE_ID_PATTERN = /^twa-[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TRANSPORTS = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
] as const satisfies readonly AuthenticatorTransportFuture[];

type RandomBytes = (size: number) => Uint8Array;

interface TicketWebAuthnAuthorityRegistryDocumentV1 {
  schemaVersion: typeof TICKET_WEBAUTHN_AUTHORITY_SCHEMA_VERSION;
  profiles: TicketWebAuthnAuthorityProfileV1[];
}

export interface TicketWebAuthnAuthorityProfileV1 {
  profileId: string;
  keyFingerprint: string;
  principalId: string;
  principalKind: "human";
  authorityBasis: "repository_owner" | "designated_human";
  authorityRef: string;
  repositoryIncarnation: string;
  rpId: typeof TICKET_WEBAUTHN_RP_ID;
  algorithm: typeof TICKET_WEBAUTHN_ALGORITHM;
  credentialId: string;
  publicKeyCose: string;
  publicKeySpkiPem: string;
  transports: AuthenticatorTransportFuture[];
  counter: number;
  lastAssertionDigest: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface TicketWebAuthnAuthorityRegistryOptions {
  registryPath?: string;
  now?: () => string;
  randomBytes?: RandomBytes;
}

export interface TicketWebAuthnRegistrationRequest {
  principalId: string;
  authorityBasis: "repository_owner" | "designated_human";
  authorityRef: string;
  repositoryIncarnation: string;
  challenge: string;
  rpName?: string;
  timeoutMs?: number;
}

export interface TicketWebAuthnRegistrationVerification {
  principalId: string;
  authorityBasis: "repository_owner" | "designated_human";
  authorityRef: string;
  repositoryIncarnation: string;
  challenge: string;
  origin: string;
  response: RegistrationResponseJSON;
}

export interface TicketWebAuthnAuthenticationRequest {
  profileId: string;
  challenge: string;
  timeoutMs?: number;
}

export interface TicketWebAuthnAuthenticationVerification {
  profileId: string;
  challenge: string;
  origin: string;
  response: AuthenticationResponseJSON;
}

export interface TicketWebAuthnVerifiedPresenceV1 {
  profile: TicketWebAuthnAuthorityProfileV1;
  verifiedAt: string;
  challenge: string;
  origin: string;
  rpId: typeof TICKET_WEBAUTHN_RP_ID;
  userVerified: true;
  counter: number;
  assertionDigest: string;
  assertion: {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
}

export class TicketWebAuthnAuthorityError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_registry"
      | "registry_busy"
      | "not_found"
      | "revoked"
      | "verification_failed"
      | "concurrent_update",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TicketWebAuthnAuthorityError";
  }
}

export function defaultTicketWebAuthnAuthorityRegistryPath(
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    ".vibehub",
    "trust",
    "decision-authorities.v1.json",
  );
}

export class TicketWebAuthnAuthorityRegistry {
  readonly registryPath: string;
  private readonly now: () => string;
  private readonly randomBytes: RandomBytes;

  constructor(options: TicketWebAuthnAuthorityRegistryOptions = {}) {
    this.registryPath = path.resolve(
      options.registryPath
        ?? defaultTicketWebAuthnAuthorityRegistryPath(),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
  }

  listProfiles(): TicketWebAuthnAuthorityProfileV1[] {
    return readRegistryDocument(this.registryPath).profiles.map(cloneProfile);
  }

  getActiveProfile(profileId: string): TicketWebAuthnAuthorityProfileV1 {
    assertProfileId(profileId);
    const profile = readRegistryDocument(this.registryPath).profiles.find(
      (candidate) => candidate.profileId === profileId,
    );
    if (profile === undefined) {
      throw new TicketWebAuthnAuthorityError(
        "not_found",
        `WebAuthn authority profile not found: ${profileId}`,
      );
    }
    if (profile.revokedAt !== null) {
      throw new TicketWebAuthnAuthorityError(
        "revoked",
        `WebAuthn authority profile is revoked: ${profileId}`,
      );
    }
    return cloneProfile(profile);
  }

  async createRegistrationOptions(
    request: TicketWebAuthnRegistrationRequest,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const principalId = assertSafeText(
      request.principalId,
      "principalId",
      256,
    );
    const repositoryIncarnation = assertSafeText(
      request.repositoryIncarnation,
      "repositoryIncarnation",
      512,
    );
    const authorityBasis = assertAuthorityBasis(request.authorityBasis);
    const authorityRef = assertSafeText(
      request.authorityRef,
      "authorityRef",
      256,
    );
    const challenge = assertChallenge(request.challenge);
    const timeout = assertTimeout(request.timeoutMs);
    const existing = readRegistryDocument(this.registryPath).profiles;
    const userId = crypto.createHash("sha256").update(canonicalJson({
      principalId,
      authorityBasis,
      authorityRef,
      repositoryIncarnation,
    })).digest();
    return generateRegistrationOptions({
      rpName: request.rpName === undefined
        ? "Vibehub Ticket Decisions"
        : assertSafeText(request.rpName, "rpName", 128),
      rpID: TICKET_WEBAUTHN_RP_ID,
      userName: principalId,
      userDisplayName: principalId,
      userID: userId,
      challenge: Buffer.from(challenge, "base64url"),
      timeout,
      attestationType: "none",
      excludeCredentials: existing.map((profile) => ({
        id: profile.credentialId,
        transports: [...profile.transports],
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      supportedAlgorithmIDs: [ES256_COSE_ALGORITHM],
    });
  }

  async verifyRegistration(
    verification: TicketWebAuthnRegistrationVerification,
  ): Promise<TicketWebAuthnAuthorityProfileV1> {
    const principalId = assertSafeText(
      verification.principalId,
      "principalId",
      256,
    );
    const repositoryIncarnation = assertSafeText(
      verification.repositoryIncarnation,
      "repositoryIncarnation",
      512,
    );
    const authorityBasis = assertAuthorityBasis(
      verification.authorityBasis,
    );
    const authorityRef = assertSafeText(
      verification.authorityRef,
      "authorityRef",
      256,
    );
    const challenge = assertChallenge(verification.challenge);
    const origin = assertLocalhostOrigin(verification.origin);
    if (
      verification.response.response.publicKeyAlgorithm !== undefined
      && verification.response.response.publicKeyAlgorithm
        !== ES256_COSE_ALGORITHM
    ) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn registration credential must use ES256",
      );
    }

    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response: verification.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: TICKET_WEBAUTHN_RP_ID,
        expectedType: "webauthn.create",
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [ES256_COSE_ALGORITHM],
      });
    } catch (cause) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn registration verification failed",
        { cause },
      );
    }
    if (
      !result.verified
      || !result.registrationInfo.userVerified
      || result.registrationInfo.origin !== origin
      || result.registrationInfo.rpID !== TICKET_WEBAUTHN_RP_ID
    ) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn registration did not prove exact local user verification",
      );
    }

    const credential = result.registrationInfo.credential;
    if (
      verification.response.id !== credential.id
      || verification.response.rawId !== credential.id
    ) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn registration credential identity changed during verification",
      );
    }
    const publicKey = deriveEs256PublicKey(credential.publicKey);
    const credentialId = assertBase64Url(
      credential.id,
      "credentialId",
      1_024,
    );
    const identity = {
      principalId,
      principalKind: "human" as const,
      authorityBasis,
      authorityRef,
      repositoryIncarnation,
      rpId: TICKET_WEBAUTHN_RP_ID,
      algorithm: TICKET_WEBAUTHN_ALGORITHM,
      credentialId,
      keyFingerprint: publicKey.fingerprint,
    };
    const profileId = `twa-${sha256(canonicalJson(identity))}`;
    const profile: TicketWebAuthnAuthorityProfileV1 = {
      profileId,
      keyFingerprint: publicKey.fingerprint,
      principalId,
      principalKind: "human",
      authorityBasis,
      authorityRef,
      repositoryIncarnation,
      rpId: TICKET_WEBAUTHN_RP_ID,
      algorithm: TICKET_WEBAUTHN_ALGORITHM,
      credentialId,
      publicKeyCose: Buffer.from(credential.publicKey).toString("base64url"),
      publicKeySpkiPem: publicKey.pem,
      transports: normalizeTransports(credential.transports ?? []),
      counter: assertCounter(credential.counter),
      lastAssertionDigest: null,
      createdAt: assertTimestamp(this.now(), "clock"),
      revokedAt: null,
    };
    validateProfile(profile);

    return this.withRegistryLock(() => {
      const document = readRegistryDocument(this.registryPath);
      if (document.profiles.some((candidate) =>
        candidate.profileId === profile.profileId
        || candidate.credentialId === profile.credentialId
        || candidate.keyFingerprint === profile.keyFingerprint
      )) {
        throw new TicketWebAuthnAuthorityError(
          "invalid_input",
          "This WebAuthn authority credential is already registered",
        );
      }
      if (document.profiles.length >= MAX_PROFILES) {
        throw new TicketWebAuthnAuthorityError(
          "invalid_registry",
          `WebAuthn authority registry cannot exceed ${MAX_PROFILES} profiles`,
        );
      }
      document.profiles.push(profile);
      document.profiles.sort(compareProfiles);
      writeRegistryDocument(
        this.registryPath,
        document,
        this.randomBytes,
      );
      return cloneProfile(profile);
    });
  }

  async createAuthenticationOptions(
    request: TicketWebAuthnAuthenticationRequest,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const profile = this.getActiveProfile(request.profileId);
    const challenge = assertChallenge(request.challenge);
    return generateAuthenticationOptions({
      rpID: TICKET_WEBAUTHN_RP_ID,
      challenge: Buffer.from(challenge, "base64url"),
      timeout: assertTimeout(request.timeoutMs),
      allowCredentials: [{
        id: profile.credentialId,
        transports: [...profile.transports],
      }],
      userVerification: "required",
    });
  }

  async verifyAuthentication(
    verification: TicketWebAuthnAuthenticationVerification,
  ): Promise<TicketWebAuthnVerifiedPresenceV1> {
    return this.verifyPresenceAndMutate(verification, false);
  }

  async revoke(
    verification: TicketWebAuthnAuthenticationVerification,
  ): Promise<TicketWebAuthnAuthorityProfileV1> {
    const presence = await this.verifyPresenceAndMutate(verification, true);
    return presence.profile;
  }

  private async verifyPresenceAndMutate(
    verification: TicketWebAuthnAuthenticationVerification,
    revoke: boolean,
  ): Promise<TicketWebAuthnVerifiedPresenceV1> {
    const profile = this.getActiveProfile(verification.profileId);
    const challenge = assertChallenge(verification.challenge);
    const origin = assertLocalhostOrigin(verification.origin);
    assertAuthenticationCredential(
      verification.response,
      profile.credentialId,
    );

    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response: verification.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: TICKET_WEBAUTHN_RP_ID,
        expectedType: "webauthn.get",
        credential: {
          id: profile.credentialId,
          publicKey: Buffer.from(profile.publicKeyCose, "base64url"),
          counter: profile.counter,
          transports: [...profile.transports],
        },
        requireUserVerification: true,
        advancedFIDOConfig: {
          userVerification: "required",
        },
      });
    } catch (cause) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn authentication verification failed",
        { cause },
      );
    }
    if (
      !result.verified
      || !result.authenticationInfo.userVerified
      || result.authenticationInfo.credentialID !== profile.credentialId
      || result.authenticationInfo.origin !== origin
      || result.authenticationInfo.rpID !== TICKET_WEBAUTHN_RP_ID
    ) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn authentication did not prove exact local user verification",
      );
    }
    const newCounter = assertCounter(result.authenticationInfo.newCounter);
    if (newCounter < profile.counter) {
      throw new TicketWebAuthnAuthorityError(
        "verification_failed",
        "WebAuthn authenticator counter moved backwards",
      );
    }
    const rawAssertion = {
      credentialId: profile.credentialId,
      clientDataJSON: assertBase64Url(
        verification.response.response.clientDataJSON,
        "clientDataJSON",
        256 * 1024,
      ),
      authenticatorData: assertBase64Url(
        verification.response.response.authenticatorData,
        "authenticatorData",
        64 * 1024,
      ),
      signature: assertBase64Url(
        verification.response.response.signature,
        "signature",
        64 * 1024,
      ),
      userHandle: verification.response.response.userHandle === undefined
        ? null
        : assertBase64Url(
          verification.response.response.userHandle,
          "userHandle",
          1_024,
        ),
    };
    const assertionDigest = sha256(canonicalJson(rawAssertion));
    const verifiedAt = assertTimestamp(this.now(), "clock");

    const updatedProfile = this.withRegistryLock(() => {
      const document = readRegistryDocument(this.registryPath);
      const index = document.profiles.findIndex(
        (candidate) => candidate.profileId === profile.profileId,
      );
      const current = document.profiles[index];
      if (current === undefined) {
        throw new TicketWebAuthnAuthorityError(
          "concurrent_update",
          "WebAuthn authority profile disappeared during verification",
        );
      }
      if (current.revokedAt !== null) {
        throw new TicketWebAuthnAuthorityError(
          "revoked",
          `WebAuthn authority profile is revoked: ${profile.profileId}`,
        );
      }
      if (
        current.counter !== profile.counter
        || current.lastAssertionDigest !== profile.lastAssertionDigest
      ) {
        throw new TicketWebAuthnAuthorityError(
          "concurrent_update",
          "WebAuthn authority profile changed during verification",
        );
      }
      if (current.lastAssertionDigest === assertionDigest) {
        throw new TicketWebAuthnAuthorityError(
          "verification_failed",
          "WebAuthn assertion replay was rejected",
        );
      }
      const updated: TicketWebAuthnAuthorityProfileV1 = {
        ...current,
        counter: newCounter,
        lastAssertionDigest: assertionDigest,
        revokedAt: revoke ? verifiedAt : null,
      };
      validateProfile(updated);
      document.profiles[index] = updated;
      writeRegistryDocument(
        this.registryPath,
        document,
        this.randomBytes,
      );
      return cloneProfile(updated);
    });

    return {
      profile: updatedProfile,
      verifiedAt,
      challenge,
      origin,
      rpId: TICKET_WEBAUTHN_RP_ID,
      userVerified: true,
      counter: newCounter,
      assertionDigest,
      assertion: rawAssertion,
    };
  }

  private withRegistryLock<T>(operation: () => T): T {
    ensureSecureRegistryParent(this.registryPath, true);
    const lockPath = `${this.registryPath}.lock`;
    let descriptor: number | undefined;
    let ownsLock = false;
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | noFollowFlag(),
        REGISTRY_FILE_MODE,
      );
      ownsLock = true;
      fs.fchmodSync(descriptor, REGISTRY_FILE_MODE);
      fs.writeFileSync(
        descriptor,
        `${Buffer.from(this.randomBytes(16)).toString("hex")}\n`,
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return operation();
    } catch (cause) {
      if (
        cause instanceof TicketWebAuthnAuthorityError
        || !isNodeError(cause)
        || cause.code !== "EEXIST"
      ) {
        throw cause;
      }
      throw new TicketWebAuthnAuthorityError(
        "registry_busy",
        "WebAuthn authority registry is busy",
        { cause },
      );
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (ownsLock) {
        try {
          const stat = fs.lstatSync(lockPath);
          if (stat.isFile() && !stat.isSymbolicLink()) {
            fs.unlinkSync(lockPath);
          }
        } catch (cause) {
          if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
        }
      }
    }
  }
}

export function ticketDecisionAttestationTrustProfileResolver(
  registry: Pick<TicketWebAuthnAuthorityRegistry, "listProfiles">,
): TicketDecisionAttestationTrustProfileResolverV0 {
  return {
    resolveProfile(lookup) {
      const profile = registry.listProfiles().find((candidate) =>
        candidate.repositoryIncarnation
          === lookup.repositoryIncarnation
        && candidate.credentialId === lookup.credentialId
        && candidate.keyFingerprint === lookup.credentialFingerprint
      );
      return profile === undefined ? null : {
        credentialId: profile.credentialId,
        credentialFingerprint: profile.keyFingerprint,
        publicKeySpkiPem: profile.publicKeySpkiPem,
        principalId: profile.principalId,
        principalKind: "human",
        basis: profile.authorityBasis,
        basisRef: profile.authorityRef,
        repositoryIncarnation: profile.repositoryIncarnation,
        revokedAt: profile.revokedAt,
      };
    },
  };
}

const cloneProfile = (
  profile: TicketWebAuthnAuthorityProfileV1,
): TicketWebAuthnAuthorityProfileV1 => ({
  ...profile,
  transports: [...profile.transports],
});

const compareProfiles = (
  left: TicketWebAuthnAuthorityProfileV1,
  right: TicketWebAuthnAuthorityProfileV1,
): number => left.profileId.localeCompare(right.profileId);

const canonicalJson = (value: unknown): string => JSON.stringify(value);

const sha256 = (value: string | Uint8Array): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const noFollowFlag = (): number => fs.constants.O_NOFOLLOW ?? 0;

const isNodeError = (
  error: unknown,
): error is NodeJS.ErrnoException => error instanceof Error;

const assertPlainObject = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      `${label} must be a plain object`,
    );
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  object: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      `${label} contains unknown or missing fields`,
    );
  }
};

const assertSafeText = (
  value: unknown,
  label: string,
  maxLength: number,
): string => {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      `${label} is not a canonical safe string`,
    );
  }
  return value;
};

const assertBase64Url = (
  value: unknown,
  label: string,
  maxBytes: number,
): string => {
  if (
    typeof value !== "string"
    || !BASE64URL_PATTERN.test(value)
    || value.includes("=")
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      `${label} must be unpadded base64url`,
    );
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < 1
    || decoded.length > maxBytes
    || decoded.toString("base64url") !== value
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      `${label} must be canonical base64url`,
    );
  }
  return value;
};

const assertChallenge = (value: unknown): string => {
  const challenge = assertBase64Url(value, "challenge", 1_024);
  if (Buffer.from(challenge, "base64url").length < 32) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      "challenge must contain at least 32 bytes",
    );
  }
  return challenge;
};

const assertLocalhostOrigin = (value: unknown): string => {
  const origin = assertSafeText(value, "origin", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (cause) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      "origin must be an absolute URL",
      { cause },
    );
  }
  if (
    parsed.origin !== origin
    || parsed.hostname !== TICKET_WEBAUTHN_RP_ID
    || (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      "origin must be an exact http(s) localhost origin",
    );
  }
  return origin;
};

const assertTimeout = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 10 * 60_000) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      "timeoutMs must be an integer between 1000 and 600000",
    );
  }
  return value;
};

const assertAuthorityBasis = (
  value: unknown,
): "repository_owner" | "designated_human" => {
  if (value !== "repository_owner" && value !== "designated_human") {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      "authorityBasis must be repository_owner or designated_human",
    );
  }
  return value;
};

const assertCounter = (value: unknown): number => {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > 0xffff_ffff
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "WebAuthn counter must be an unsigned 32-bit integer",
    );
  }
  return value;
};

const assertTimestamp = (value: unknown, label: string): string => {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      `${label} must return a canonical UTC timestamp`,
    );
  }
  return value;
};

const normalizeTransports = (
  transports: readonly AuthenticatorTransportFuture[],
): AuthenticatorTransportFuture[] => {
  const unique = new Set<AuthenticatorTransportFuture>();
  for (const transport of transports) {
    if (!(TRANSPORTS as readonly string[]).includes(transport)) {
      throw new TicketWebAuthnAuthorityError(
        "invalid_registry",
        `Unsupported WebAuthn transport: ${transport}`,
      );
    }
    unique.add(transport);
  }
  return [...unique].sort();
};

const deriveEs256PublicKey = (
  publicKeyCose: Uint8Array,
): { pem: string; fingerprint: string } => {
  let decoded: { get(key: number): unknown };
  let rawPoint: Uint8Array;
  try {
    decoded = decodeCredentialPublicKey(
      Uint8Array.from(publicKeyCose),
    ) as unknown as { get(key: number): unknown };
    rawPoint = convertCOSEtoPKCS(Uint8Array.from(publicKeyCose));
  } catch (cause) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "Cannot decode WebAuthn COSE public key",
      { cause },
    );
  }
  if (
    decoded.get(cose.COSEKEYS.kty) !== cose.COSEKTY.EC2
    || decoded.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256
    || decoded.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256
    || rawPoint.length !== 65
    || rawPoint[0] !== 0x04
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "WebAuthn credential public key must be an ES256 P-256 key",
    );
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(rawPoint.subarray(1, 33)).toString("base64url"),
        y: Buffer.from(rawPoint.subarray(33, 65)).toString("base64url"),
      },
      format: "jwk",
    });
  } catch (cause) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "Cannot convert WebAuthn ES256 public key to SPKI",
      { cause },
    );
  }
  const der = Buffer.from(key.export({ format: "der", type: "spki" }));
  return {
    pem: key.export({ format: "pem", type: "spki" }).toString(),
    fingerprint: sha256(der),
  };
};

const profileIdentity = (
  profile: TicketWebAuthnAuthorityProfileV1,
): Record<string, unknown> => ({
  principalId: profile.principalId,
  principalKind: profile.principalKind,
  authorityBasis: profile.authorityBasis,
  authorityRef: profile.authorityRef,
  repositoryIncarnation: profile.repositoryIncarnation,
  rpId: profile.rpId,
  algorithm: profile.algorithm,
  credentialId: profile.credentialId,
  keyFingerprint: profile.keyFingerprint,
});

const validateProfile = (
  value: unknown,
): TicketWebAuthnAuthorityProfileV1 => {
  const profile = assertPlainObject(value, "authority profile");
  assertExactKeys(profile, [
    "profileId",
    "keyFingerprint",
    "principalId",
    "principalKind",
    "authorityBasis",
    "authorityRef",
    "repositoryIncarnation",
    "rpId",
    "algorithm",
    "credentialId",
    "publicKeyCose",
    "publicKeySpkiPem",
    "transports",
    "counter",
    "lastAssertionDigest",
    "createdAt",
    "revokedAt",
  ], "authority profile");
  if (
    typeof profile.profileId !== "string"
    || !PROFILE_ID_PATTERN.test(profile.profileId)
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority profileId is invalid",
    );
  }
  if (
    typeof profile.keyFingerprint !== "string"
    || !SHA256_PATTERN.test(profile.keyFingerprint)
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority keyFingerprint is invalid",
    );
  }
  const principalId = assertSafeText(
    profile.principalId,
    "principalId",
    256,
  );
  if (
    profile.principalKind !== "human"
    || (
      profile.authorityBasis !== "repository_owner"
      && profile.authorityBasis !== "designated_human"
    )
    || profile.rpId !== TICKET_WEBAUTHN_RP_ID
    || profile.algorithm !== TICKET_WEBAUTHN_ALGORITHM
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority profile trust constants are invalid",
    );
  }
  const repositoryIncarnation = assertSafeText(
    profile.repositoryIncarnation,
    "repositoryIncarnation",
    512,
  );
  const credentialId = assertBase64Url(
    profile.credentialId,
    "credentialId",
    1_024,
  );
  const publicKeyCose = assertBase64Url(
    profile.publicKeyCose,
    "publicKeyCose",
    4_096,
  );
  if (
    typeof profile.publicKeySpkiPem !== "string"
    || profile.publicKeySpkiPem.length > 4_096
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority publicKeySpkiPem is invalid",
    );
  }
  if (!Array.isArray(profile.transports)) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority transports must be an array",
    );
  }
  const transports = normalizeTransports(
    profile.transports as AuthenticatorTransportFuture[],
  );
  if (
    JSON.stringify(transports) !== JSON.stringify(profile.transports)
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority transports must be unique and sorted",
    );
  }
  const counter = assertCounter(profile.counter);
  if (
    profile.lastAssertionDigest !== null
    && (
      typeof profile.lastAssertionDigest !== "string"
      || !SHA256_PATTERN.test(profile.lastAssertionDigest)
    )
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority lastAssertionDigest is invalid",
    );
  }
  const createdAt = assertTimestamp(profile.createdAt, "createdAt");
  const revokedAt = profile.revokedAt === null
    ? null
    : assertTimestamp(profile.revokedAt, "revokedAt");
  if (revokedAt !== null && revokedAt < createdAt) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority revokedAt cannot precede createdAt",
    );
  }
  const derived = deriveEs256PublicKey(
    Buffer.from(publicKeyCose, "base64url"),
  );
  if (
    derived.fingerprint !== profile.keyFingerprint
    || derived.pem !== profile.publicKeySpkiPem
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority COSE, SPKI, and key fingerprint do not agree",
    );
  }
  const normalized: TicketWebAuthnAuthorityProfileV1 = {
    profileId: profile.profileId,
    keyFingerprint: profile.keyFingerprint,
    principalId,
    principalKind: "human",
    authorityBasis: profile.authorityBasis,
    authorityRef: assertSafeText(
      profile.authorityRef,
      "authorityRef",
      256,
    ),
    repositoryIncarnation,
    rpId: TICKET_WEBAUTHN_RP_ID,
    algorithm: TICKET_WEBAUTHN_ALGORITHM,
    credentialId,
    publicKeyCose,
    publicKeySpkiPem: profile.publicKeySpkiPem,
    transports,
    counter,
    lastAssertionDigest: profile.lastAssertionDigest,
    createdAt,
    revokedAt,
  };
  const expectedProfileId = `twa-${sha256(canonicalJson(
    profileIdentity(normalized),
  ))}`;
  if (normalized.profileId !== expectedProfileId) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority profile content identity is invalid",
    );
  }
  return normalized;
};

const validateRegistryDocument = (
  value: unknown,
): TicketWebAuthnAuthorityRegistryDocumentV1 => {
  const document = assertPlainObject(value, "authority registry");
  assertExactKeys(
    document,
    ["schemaVersion", "profiles"],
    "authority registry",
  );
  if (
    document.schemaVersion !== TICKET_WEBAUTHN_AUTHORITY_SCHEMA_VERSION
    || !Array.isArray(document.profiles)
    || document.profiles.length > MAX_PROFILES
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority registry schema is invalid",
    );
  }
  const profiles = document.profiles.map(validateProfile);
  if (
    profiles.some((profile, index) =>
      index > 0
      && compareProfiles(profiles[index - 1]!, profile) >= 0
    )
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority profiles must have unique sorted profile IDs",
    );
  }
  const credentialIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const profile of profiles) {
    if (
      credentialIds.has(profile.credentialId)
      || fingerprints.has(profile.keyFingerprint)
    ) {
      throw new TicketWebAuthnAuthorityError(
        "invalid_registry",
        "authority registry contains duplicate credentials",
      );
    }
    credentialIds.add(profile.credentialId);
    fingerprints.add(profile.keyFingerprint);
  }
  return {
    schemaVersion: TICKET_WEBAUTHN_AUTHORITY_SCHEMA_VERSION,
    profiles,
  };
};

const readRegistryDocument = (
  registryPath: string,
): TicketWebAuthnAuthorityRegistryDocumentV1 => {
  ensureSecureRegistryParent(registryPath, false);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(registryPath);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {
        schemaVersion: TICKET_WEBAUTHN_AUTHORITY_SCHEMA_VERSION,
        profiles: [],
      };
    }
    throw cause;
  }
  assertSecureFile(stat, registryPath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      registryPath,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor);
    assertSecureFile(opened, registryPath);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new TicketWebAuthnAuthorityError(
        "invalid_registry",
        "authority registry changed while opening",
      );
    }
    if (opened.size > MAX_REGISTRY_BYTES) {
      throw new TicketWebAuthnAuthorityError(
        "invalid_registry",
        "authority registry is too large",
      );
    }
    const content = fs.readFileSync(descriptor, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      throw new TicketWebAuthnAuthorityError(
        "invalid_registry",
        "authority registry is not valid JSON",
        { cause },
      );
    }
    return validateRegistryDocument(parsed);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const writeRegistryDocument = (
  registryPath: string,
  document: TicketWebAuthnAuthorityRegistryDocumentV1,
  randomBytes: RandomBytes,
): void => {
  const validated = validateRegistryDocument(document);
  ensureSecureRegistryParent(registryPath, true);
  try {
    const existing = fs.lstatSync(registryPath);
    assertSecureFile(existing, registryPath);
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
  }
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      "authority registry is too large",
    );
  }
  const temporaryPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${Buffer.from(
      randomBytes(16),
    ).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let temporaryExists = false;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | noFollowFlag(),
      REGISTRY_FILE_MODE,
    );
    temporaryExists = true;
    fs.fchmodSync(descriptor, REGISTRY_FILE_MODE);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, registryPath);
    temporaryExists = false;
    fs.chmodSync(registryPath, REGISTRY_FILE_MODE);
    const directoryDescriptor = fs.openSync(
      path.dirname(registryPath),
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryExists) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (cause) {
        if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
      }
    }
  }
};

const assertSecureFile = (stat: fs.Stats, filePath: string): void => {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (stat.mode & 0o777) !== REGISTRY_FILE_MODE
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      `authority registry must be an owned no-follow 0600 file: ${filePath}`,
    );
  }
};

const ensureSecureRegistryParent = (
  registryPath: string,
  create: boolean,
): void => {
  const parent = path.dirname(registryPath);
  const parsed = path.parse(parent);
  const relative = parent.slice(parsed.root.length);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (cause) {
      if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
      if (!create) return;
      try {
        fs.mkdirSync(cursor, { mode: REGISTRY_DIRECTORY_MODE });
      } catch (mkdirCause) {
        if (!isNodeError(mkdirCause) || mkdirCause.code !== "EEXIST") {
          throw mkdirCause;
        }
      }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TicketWebAuthnAuthorityError(
        "invalid_registry",
        `authority registry path contains a non-directory or symlink: ${cursor}`,
      );
    }
  }
  const stat = fs.lstatSync(parent);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || (stat.mode & 0o777) !== REGISTRY_DIRECTORY_MODE
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_registry",
      `authority registry parent must be an owned no-follow 0700 directory: ${parent}`,
    );
  }
};

const assertProfileId = (value: unknown): string => {
  if (typeof value !== "string" || !PROFILE_ID_PATTERN.test(value)) {
    throw new TicketWebAuthnAuthorityError(
      "invalid_input",
      "profileId is invalid",
    );
  }
  return value;
};

const assertAuthenticationCredential = (
  response: AuthenticationResponseJSON,
  expectedCredentialId: string,
): void => {
  if (
    response.type !== "public-key"
    || response.id !== expectedCredentialId
    || response.rawId !== expectedCredentialId
  ) {
    throw new TicketWebAuthnAuthorityError(
      "verification_failed",
      "WebAuthn authentication used the wrong credential",
    );
  }
};
