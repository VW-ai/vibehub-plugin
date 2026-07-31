import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type TicketDecisionLocalSignatureTrustProfileResolverV0,
  type TicketDecisionLocalSignatureTrustProfileV0,
} from "./ticket-decision-attestation.js";

const REGISTRY_SCHEMA_VERSION = 1 as const;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PROFILES = 128;
const REGISTRY_FILE_MODE = 0o600;
const REGISTRY_DIRECTORY_MODE = 0o700;
const PROFILE_ID_PATTERN = /^tla-[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^tdk-[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROFILE_KEYS = [
  "profileId",
  "keyId",
  "keyFingerprint",
  "principalId",
  "principalKind",
  "authorityBasis",
  "authorityRef",
  "repositoryIncarnation",
  "algorithm",
  "publicKeySpkiPem",
  "createdAt",
  "revokedAt",
] as const;

interface TicketDecisionAuthorityRegistryProfileV1 {
  profileId: string;
  keyId: string;
  keyFingerprint: string;
  principalId: string;
  principalKind: "human";
  authorityBasis: "repository_owner" | "designated_human";
  authorityRef: string;
  repositoryIncarnation: string;
  algorithm: "Ed25519";
  publicKeySpkiPem: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface FileTicketDecisionLocalSignatureTrustProfileResolverOptionsV0 {
  registryPath?: string;
}

export class TicketDecisionAuthorityTrustStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TicketDecisionAuthorityTrustStoreError";
  }
}

export function defaultTicketDecisionLocalSignatureRegistryPath(
  homeDirectory = os.homedir(),
): string {
  return path.join(
    homeDirectory,
    ".vibehub",
    "trust",
    "decision-authority.v1",
    "registry.json",
  );
}

/**
 * Dynamically resolves Ticket Decision verification keys from the local,
 * OS-owned trust registry. The file is reread for every lookup so revocation
 * affects already-running CLI/MCP processes without a restart.
 */
export class FileTicketDecisionLocalSignatureTrustProfileResolverV0
implements TicketDecisionLocalSignatureTrustProfileResolverV0 {
  readonly registryPath: string;

  constructor(
    options:
    FileTicketDecisionLocalSignatureTrustProfileResolverOptionsV0 = {},
  ) {
    this.registryPath = path.resolve(
      options.registryPath
        ?? defaultTicketDecisionLocalSignatureRegistryPath(),
    );
  }

  resolveProfile(lookup: {
    keyId: string;
    keyFingerprint: string;
    repositoryIncarnation: string;
  }): TicketDecisionLocalSignatureTrustProfileV0 | null {
    const profiles = readRegistryProfiles(this.registryPath);
    const matches = profiles.filter((profile) =>
      profile.keyId === lookup.keyId
      && profile.keyFingerprint === lookup.keyFingerprint
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
          keyId: profile.keyId,
          keyFingerprint: profile.keyFingerprint,
          publicKeySpkiPem: profile.publicKeySpkiPem,
          principalId: profile.principalId,
          principalKind: "human",
          basis: profile.authorityBasis,
          basisRef: profile.authorityRef,
          repositoryIncarnation: profile.repositoryIncarnation,
          createdAt: profile.createdAt,
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
  const scopedKeys = new Set<string>();
  for (const profile of profiles) {
    const scopedKey =
      `${profile.repositoryIncarnation}\0${profile.keyId}`;
    if (
      profileIds.has(profile.profileId)
      || scopedKeys.has(scopedKey)
    ) {
      throw new TicketDecisionAuthorityTrustStoreError(
        "Ticket Decision authority registry contains duplicate profiles",
      );
    }
    profileIds.add(profile.profileId);
    scopedKeys.add(scopedKey);
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
  const keyId = text(profile.keyId, "keyId", 68);
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
  if (
    !PROFILE_ID_PATTERN.test(profileId)
    || !KEY_ID_PATTERN.test(keyId)
    || !SHA256_PATTERN.test(keyFingerprint)
    || !/^repo-[0-9a-f]{64}$/u.test(repositoryIncarnation)
    || profile.principalKind !== "human"
    || (
      profile.authorityBasis !== "repository_owner"
      && profile.authorityBasis !== "designated_human"
    )
    || profile.algorithm !== "Ed25519"
    || typeof profile.publicKeySpkiPem !== "string"
    || profile.publicKeySpkiPem.length < 1
    || profile.publicKeySpkiPem.length > 4_096
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority profile is invalid",
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
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority public key must be Ed25519",
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
  if (keyId !== `tdk-${keyFingerprint}`) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority key identity is invalid",
    );
  }
  const identity = {
    keyId,
    keyFingerprint,
    repositoryIncarnation,
    algorithm: "Ed25519",
  };
  const expectedProfileId = `tla-${crypto.createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
  if (profileId !== expectedProfileId) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority profile identity is invalid",
    );
  }
  if (
    principalId !== `local-installation:${profileId}`
    || authorityRef !== `vibehub:local-installation:${profileId}`
  ) {
    throw new TicketDecisionAuthorityTrustStoreError(
      "Ticket Decision authority local installation binding is invalid",
    );
  }
  return {
    profileId,
    keyId,
    keyFingerprint,
    principalId,
    principalKind: "human",
    authorityBasis: profile.authorityBasis,
    authorityRef,
    repositoryIncarnation,
    algorithm: "Ed25519",
    publicKeySpkiPem: profile.publicKeySpkiPem,
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
