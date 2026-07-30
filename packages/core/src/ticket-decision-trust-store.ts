import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type TicketDecisionAttestationTrustProfileResolverV0,
  type TicketDecisionAttestationTrustProfileV0,
} from "./ticket-decision-attestation.js";

const REGISTRY_SCHEMA_VERSION = 1 as const;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PROFILES = 128;
const REGISTRY_FILE_MODE = 0o600;
const REGISTRY_DIRECTORY_MODE = 0o700;
const PROFILE_ID_PATTERN = /^twa-[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PROFILE_KEYS = [
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
] as const;
const TRANSPORTS = new Set([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

interface TicketDecisionAuthorityRegistryProfileV1 {
  profileId: string;
  keyFingerprint: string;
  principalId: string;
  principalKind: "human";
  authorityBasis: "repository_owner" | "designated_human";
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

export interface FileTicketDecisionAttestationTrustProfileResolverOptionsV0 {
  registryPath?: string;
}

export class TicketDecisionAuthorityTrustStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TicketDecisionAuthorityTrustStoreError";
  }
}

export function defaultTicketDecisionAuthorityRegistryPath(
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    ".vibehub",
    "trust",
    "decision-authorities.v1.json",
  );
}

/**
 * Dynamically resolves Ticket Decision verification keys from the local,
 * OS-owned trust registry. The file is reread for every lookup so revocation
 * affects already-running CLI/MCP processes without a restart.
 */
export class FileTicketDecisionAttestationTrustProfileResolverV0
implements TicketDecisionAttestationTrustProfileResolverV0 {
  readonly registryPath: string;

  constructor(
    options:
    FileTicketDecisionAttestationTrustProfileResolverOptionsV0 = {},
  ) {
    this.registryPath = path.resolve(
      options.registryPath ?? defaultTicketDecisionAuthorityRegistryPath(),
    );
  }

  resolveProfile(lookup: {
    credentialId: string;
    credentialFingerprint: string;
    repositoryIncarnation: string;
  }): TicketDecisionAttestationTrustProfileV0 | null {
    const profiles = readRegistryProfiles(this.registryPath);
    const matches = profiles.filter((profile) =>
      profile.credentialId === lookup.credentialId
      && profile.keyFingerprint === lookup.credentialFingerprint
      && profile.repositoryIncarnation === lookup.repositoryIncarnation
    );
    if (matches.length > 1) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry contains ambiguous profiles",
      );
    }
    const profile = matches[0];
    return profile === undefined
      ? null
      : {
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
  }
}

const readRegistryProfiles = (
  registryPath: string,
): TicketDecisionAuthorityRegistryProfileV1[] => {
  assertNoSymlinkAncestors(registryPath);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(registryPath);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return [];
    throw new TicketDecisionAuthorityTrustStoreError(
      "Cannot inspect Ticket Decision authority registry",
      { cause },
    );
  }
  assertSecureRegistryFile(before, registryPath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      registryPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    assertSecureRegistryFile(opened, registryPath);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry changed while opening",
      );
    }
    if (opened.size > MAX_REGISTRY_BYTES) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry is too large",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch (cause) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry is not valid JSON",
        { cause },
      );
    }
    return validateRegistry(parsed);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const validateRegistry = (
  value: unknown,
): TicketDecisionAuthorityRegistryProfileV1[] => {
  const document = plainObject(value, "authority registry");
  exactKeys(document, ["schemaVersion", "profiles"], "authority registry");
  if (
    document.schemaVersion !== REGISTRY_SCHEMA_VERSION
    || !Array.isArray(document.profiles)
    || document.profiles.length > MAX_PROFILES
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority registry schema is invalid",
    );
  }
  const profiles = document.profiles.map(validateProfile);
  const profileIds = new Set<string>();
  const credentialIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const profile of profiles) {
    if (
      profileIds.has(profile.profileId)
      || credentialIds.has(profile.credentialId)
      || fingerprints.has(profile.keyFingerprint)
    ) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry contains duplicate profiles",
      );
    }
    profileIds.add(profile.profileId);
    credentialIds.add(profile.credentialId);
    fingerprints.add(profile.keyFingerprint);
  }
  if (
    profiles.some((profile, index) =>
      index > 0 && profiles[index - 1]!.profileId >= profile.profileId
    )
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority profiles must be sorted",
    );
  }
  return profiles;
};

const validateProfile = (
  value: unknown,
): TicketDecisionAuthorityRegistryProfileV1 => {
  const profile = plainObject(value, "authority profile");
  exactKeys(profile, PROFILE_KEYS, "authority profile");
  const profileId = text(profile.profileId, "profileId", 68);
  const keyFingerprint = text(
    profile.keyFingerprint,
    "keyFingerprint",
    64,
  );
  const principalId = text(profile.principalId, "principalId", 256);
  const authorityRef = text(profile.authorityRef, "authorityRef", 256);
  const repositoryIncarnation = text(
    profile.repositoryIncarnation,
    "repositoryIncarnation",
    512,
  );
  const credentialId = base64url(
    profile.credentialId,
    "credentialId",
    1_024,
  );
  const publicKeyCose = base64url(
    profile.publicKeyCose,
    "publicKeyCose",
    4_096,
  );
  if (
    !PROFILE_ID_PATTERN.test(profileId)
    || !SHA256_PATTERN.test(keyFingerprint)
    || profile.principalKind !== "human"
    || (
      profile.authorityBasis !== "repository_owner"
      && profile.authorityBasis !== "designated_human"
    )
    || profile.rpId !== "localhost"
    || profile.algorithm !== "ES256"
    || typeof profile.publicKeySpkiPem !== "string"
    || profile.publicKeySpkiPem.length < 1
    || profile.publicKeySpkiPem.length > 4_096
    || !Array.isArray(profile.transports)
    || !Number.isSafeInteger(profile.counter)
    || (profile.counter as number) < 0
    || (profile.counter as number) > 0xffff_ffff
    || (
      profile.lastAssertionDigest !== null
      && (
        typeof profile.lastAssertionDigest !== "string"
        || !SHA256_PATTERN.test(profile.lastAssertionDigest)
      )
    )
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority profile is invalid",
    );
  }
  const transports = profile.transports.map((transport) => {
    if (typeof transport !== "string" || !TRANSPORTS.has(transport)) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority profile has an invalid transport",
      );
    }
    return transport;
  });
  if (
    new Set(transports).size !== transports.length
    || transports.some((transport, index) =>
      index > 0 && transports[index - 1]! >= transport
    )
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority transports must be unique and sorted",
    );
  }
  const createdAt = timestamp(profile.createdAt, "createdAt");
  const revokedAt = profile.revokedAt === null
    ? null
    : timestamp(profile.revokedAt, "revokedAt");
  if (revokedAt !== null && revokedAt < createdAt) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority revocation predates enrollment",
    );
  }
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(profile.publicKeySpkiPem);
  } catch (cause) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority public key is invalid",
      { cause },
    );
  }
  if (
    publicKey.asymmetricKeyType !== "ec"
    || (
      publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      && publicKey.asymmetricKeyDetails?.namedCurve !== "P-256"
    )
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority public key must be P-256",
    );
  }
  const fingerprint = crypto.createHash("sha256").update(
    publicKey.export({ type: "spki", format: "der" }),
  ).digest("hex");
  if (fingerprint !== keyFingerprint) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority fingerprint does not match its public key",
    );
  }
  const identity = {
    principalId,
    principalKind: "human",
    authorityBasis: profile.authorityBasis,
    authorityRef,
    repositoryIncarnation,
    rpId: "localhost",
    algorithm: "ES256",
    credentialId,
    keyFingerprint,
  };
  const expectedProfileId = `twa-${crypto.createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
  if (profileId !== expectedProfileId) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority profile identity is invalid",
    );
  }
  return {
    profileId,
    keyFingerprint,
    principalId,
    principalKind: "human",
    authorityBasis: profile.authorityBasis,
    authorityRef,
    repositoryIncarnation,
    rpId: "localhost",
    algorithm: "ES256",
    credentialId,
    publicKeyCose,
    publicKeySpkiPem: profile.publicKeySpkiPem,
    transports,
    counter: profile.counter as number,
    lastAssertionDigest: profile.lastAssertionDigest,
    createdAt,
    revokedAt,
  };
};

const plainObject = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision ${label} must be a plain object`,
    );
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision ${label} contains unknown or missing fields`,
    );
  }
};

const text = (
  value: unknown,
  label: string,
  maximumLength: number,
): string => {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximumLength
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision authority ${label} is invalid`,
    );
  }
  return value;
};

const base64url = (
  value: unknown,
  label: string,
  maximumBytes: number,
): string => {
  const encoded = text(value, label, maximumBytes * 2);
  if (!BASE64URL_PATTERN.test(encoded) || encoded.includes("=")) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision authority ${label} is not base64url`,
    );
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.length < 1
    || decoded.length > maximumBytes
    || decoded.toString("base64url") !== encoded
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision authority ${label} is not canonical base64url`,
    );
  }
  return encoded;
};

const timestamp = (value: unknown, label: string): string => {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision authority ${label} is invalid`,
    );
  }
  return value;
};

const assertNoSymlinkAncestors = (registryPath: string): void => {
  const parent = path.dirname(registryPath);
  const parsed = path.parse(parent);
  const segments = parent.slice(parsed.root.length).split(path.sep)
    .filter((segment) => segment !== "");
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return;
      throw new TicketDecisionAuthorityTrustStoreError(
        "Cannot inspect Ticket Decision authority registry path",
        { cause },
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry path is not trusted",
      );
    }
  }
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return;
    throw cause;
  }
  if (
    (parentStat.mode & 0o777) !== REGISTRY_DIRECTORY_MODE
    || (
      typeof process.getuid === "function"
      && parentStat.uid !== process.getuid()
    )
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority registry parent must be owned 0700",
    );
  }
};

const assertSecureRegistryFile = (
  stat: fs.Stats,
  registryPath: string,
): void => {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (stat.mode & 0o777) !== REGISTRY_FILE_MODE
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      `Ticket Decision authority registry must be an owned 0600 file: ${registryPath}`,
    );
  }
};

const isNodeError = (
  error: unknown,
): error is NodeJS.ErrnoException => error instanceof Error;
