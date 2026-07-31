import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalTicketLedgerValue } from "@vw-ai/vibehub-core";

export const TICKET_LOCAL_DECISION_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM = "Ed25519" as const;
export const TICKET_LOCAL_DECISION_AUTHORITY_SIGNING_DOMAIN =
  "vibehub.ticket-decision-attestation.v1\0" as const;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PROFILES = 128;
const PROFILE_PATTERN = /^tla-[0-9a-f]{64}$/u;
const KEY_PATTERN = /^tdk-[0-9a-f]{64}$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^repo-[0-9a-f]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/u;

interface TicketLocalDecisionAuthorityRegistryV1 {
  schemaVersion: typeof TICKET_LOCAL_DECISION_AUTHORITY_SCHEMA_VERSION;
  profiles: TicketLocalDecisionAuthorityProfileV1[];
}

export interface TicketLocalDecisionAuthorityProfileV1 {
  profileId: string;
  keyId: string;
  keyFingerprint: string;
  principalId: string;
  principalKind: "human";
  authorityBasis: "designated_human";
  authorityRef: string;
  repositoryIncarnation: string;
  algorithm: typeof TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM;
  publicKeySpkiPem: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface TicketLocalDecisionAuthorityOptions {
  registryPath?: string;
  now?: () => string;
  randomBytes?: (size: number) => Uint8Array;
}

export interface TicketLocalDecisionSignatureV1 {
  profile: TicketLocalDecisionAuthorityProfileV1;
  signature: string;
}

export interface TicketLocalDecisionAuthorityProfileReader {
  listProfiles(): TicketLocalDecisionAuthorityProfileV1[];
}

export interface TicketLocalDecisionTrustProfileLookupV1 {
  keyId: string;
  keyFingerprint: string;
  repositoryIncarnation: string;
}

export interface TicketLocalDecisionTrustProfileV1 {
  keyId: string;
  keyFingerprint: string;
  publicKeySpkiPem: string;
  principalId: string;
  principalKind: "human";
  basis: "designated_human";
  basisRef: string;
  repositoryIncarnation: string;
  algorithm: typeof TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM;
  createdAt: string;
  revokedAt: string | null;
}

export interface TicketLocalDecisionTrustProfileResolverV1 {
  resolveProfile(
    lookup: TicketLocalDecisionTrustProfileLookupV1,
  ): TicketLocalDecisionTrustProfileV1 | null;
}

export class TicketLocalDecisionAuthorityError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_store"
      | "store_busy"
      | "ambiguous_profile"
      | "profile_revoked",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TicketLocalDecisionAuthorityError";
  }
}

export function defaultTicketLocalDecisionAuthorityRegistryPath(
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

export class TicketLocalDecisionAuthority {
  readonly registryPath: string;
  private readonly now: () => string;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(options: TicketLocalDecisionAuthorityOptions = {}) {
    this.registryPath = path.resolve(
      options.registryPath
        ?? defaultTicketLocalDecisionAuthorityRegistryPath(),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomBytes = options.randomBytes ?? crypto.randomBytes;
  }

  listProfiles(): TicketLocalDecisionAuthorityProfileV1[] {
    return readRegistry(this.registryPath).profiles.map(cloneProfile);
  }

  ensureProfile(
    repositoryIncarnation: string,
  ): TicketLocalDecisionAuthorityProfileV1 {
    const repository = assertRepositoryIncarnation(repositoryIncarnation);
    const initialRegistry = readRegistry(this.registryPath);
    const existing = activeProfilesForRepository(initialRegistry, repository);
    if (existing.length === 1) return cloneProfile(existing[0]!);
    if (existing.length > 1) throw ambiguousProfile(repository);

    return this.withLock(() => {
      const registry = readRegistry(this.registryPath);
      const lockedExisting = activeProfilesForRepository(
        registry,
        repository,
      );
      if (lockedExisting.length === 1) {
        return cloneProfile(lockedExisting[0]!);
      }
      if (lockedExisting.length > 1) throw ambiguousProfile(repository);
      if (registry.profiles.length >= MAX_PROFILES) {
        throw new TicketLocalDecisionAuthorityError(
          "invalid_store",
          `Local Decision authority cannot exceed ${MAX_PROFILES} profiles`,
        );
      }

      const generated = crypto.generateKeyPairSync("ed25519");
      const publicKeySpkiPem = generated.publicKey.export({
        format: "pem",
        type: "spki",
      }).toString();
      const publicKeySpkiDer = Buffer.from(generated.publicKey.export({
        format: "der",
        type: "spki",
      }));
      const keyFingerprint = sha256(publicKeySpkiDer);
      const keyId = `tdk-${keyFingerprint}`;
      const profileId = deriveProfileId({
        keyId,
        keyFingerprint,
        repositoryIncarnation: repository,
      });
      const profile: TicketLocalDecisionAuthorityProfileV1 = {
        profileId,
        keyId,
        keyFingerprint,
        principalId: `local-installation:${profileId}`,
        principalKind: "human",
        authorityBasis: "designated_human",
        authorityRef: `vibehub:local-installation:${profileId}`,
        repositoryIncarnation: repository,
        algorithm: TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM,
        publicKeySpkiPem,
        createdAt: assertTimestamp(this.now(), "clock"),
        revokedAt: null,
      };
      validateProfile(profile);

      writePrivateKey(
        this.keyPath(keyId),
        generated.privateKey.export({
          format: "pem",
          type: "pkcs8",
        }).toString(),
        this.randomBytes,
      );
      registry.profiles.push(profile);
      registry.profiles.sort(compareProfiles);
      writeRegistry(this.registryPath, registry, this.randomBytes);
      return cloneProfile(profile);
    });
  }

  signEnvelope(input: {
    repositoryIncarnation: string;
    envelope: unknown;
    expectedProfileId?: string;
  }): TicketLocalDecisionSignatureV1 {
    const repository = assertRepositoryIncarnation(
      input.repositoryIncarnation,
    );
    const expectedProfileId = input.expectedProfileId
      ?? this.ensureProfile(repository).profileId;
    return this.withLock(() => {
      const registry = readRegistry(this.registryPath);
      const active = activeProfilesForRepository(registry, repository);
      if (active.length > 1) throw ambiguousProfile(repository);
      const current = active[0];
      if (
        current === undefined
        || current.profileId !== expectedProfileId
      ) {
        throw revokedProfile(repository);
      }
      const privateKey = readPrivateKey(this.keyPath(current.keyId));
      const derivedPublicKey = crypto.createPublicKey(privateKey);
      const derivedDer = Buffer.from(derivedPublicKey.export({
        format: "der",
        type: "spki",
      }));
      const fingerprint = sha256(derivedDer);
      if (
        fingerprint !== current.keyFingerprint
        || current.keyId !== `tdk-${fingerprint}`
        || derivedPublicKey.export({
          format: "pem",
          type: "spki",
        }).toString() !== current.publicKeySpkiPem
      ) {
        throw new TicketLocalDecisionAuthorityError(
          "invalid_store",
          "Local Decision private key does not match its trust profile",
        );
      }
      const message = signingMessage(input.envelope);
      const signature = crypto.sign(null, message, privateKey)
        .toString("base64url");
      if (!SIGNATURE_PATTERN.test(signature)) {
        throw new TicketLocalDecisionAuthorityError(
          "invalid_store",
          "Local Decision signature is not canonical base64url",
        );
      }
      return {
        profile: cloneProfile(current),
        signature,
      };
    });
  }

  revokeRepository(
    repositoryIncarnation: string,
  ): TicketLocalDecisionAuthorityProfileV1[] {
    const repository = assertRepositoryIncarnation(repositoryIncarnation);
    return this.withLock(() => {
      const registry = readRegistry(this.registryPath);
      const timestamp = assertTimestamp(this.now(), "clock");
      let changed = false;
      registry.profiles = registry.profiles.map((profile) => {
        if (
          profile.repositoryIncarnation !== repository
          || profile.revokedAt !== null
        ) {
          return profile;
        }
        changed = true;
        return { ...profile, revokedAt: timestamp };
      });
      if (changed) {
        writeRegistry(this.registryPath, registry, this.randomBytes);
      }
      return registry.profiles
        .filter((profile) =>
          profile.repositoryIncarnation === repository
        )
        .map(cloneProfile);
    });
  }

  private keyPath(keyId: string): string {
    return path.join(path.dirname(this.registryPath), "keys", `${keyId}.pk8.pem`);
  }

  private withLock<T>(operation: () => T): T {
    const root = path.dirname(this.registryPath);
    ensureSecureDirectory(root, true);
    const coordinationPath = path.join(
      root,
      ".authority-write-lock.sqlite",
    );
    return withAuthorityCoordinationLock(coordinationPath, () =>
      this.withOwnerRecordLock(root, operation)
    );
  }

  private withOwnerRecordLock<T>(
    root: string,
    operation: () => T,
  ): T {
    const lockPath = path.join(root, ".authority.lock");
    const nonce = Buffer.from(this.randomBytes(16)).toString("hex");
    const lockRecord = `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      nonce,
    })}\n`;
    const preparationPath = path.join(
      root,
      `.authority.lock.prepare-${process.pid}-${nonce}`,
    );
    let descriptor: number | undefined;
    let preparationExists = false;
    let ownsLock = false;
    try {
      descriptor = fs.openSync(
        preparationPath,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | noFollowFlag(),
        FILE_MODE,
      );
      preparationExists = true;
      fs.fchmodSync(descriptor, FILE_MODE);
      fs.writeFileSync(descriptor, lockRecord);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          fs.linkSync(preparationPath, lockPath);
          ownsLock = true;
          fsyncDirectory(root);
          break;
        } catch (cause) {
          if (
            !isNodeError(cause)
            || cause.code !== "EEXIST"
            || attempt > 0
            || !recoverStaleAuthorityLock(lockPath)
          ) {
            throw cause;
          }
        }
      }
      if (!ownsLock) {
        throw new TicketLocalDecisionAuthorityError(
          "store_busy",
          "Local Decision authority store is busy",
        );
      }
      fs.unlinkSync(preparationPath);
      preparationExists = false;
      fsyncDirectory(root);
      return operation();
    } catch (cause) {
      if (
        isNodeError(cause)
        && cause.code === "EEXIST"
        && !ownsLock
      ) {
        throw new TicketLocalDecisionAuthorityError(
          "store_busy",
          "Local Decision authority store is busy",
          { cause },
        );
      }
      throw cause;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (preparationExists) {
        try {
          fs.unlinkSync(preparationPath);
        } catch (cause) {
          if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
        }
      }
      if (ownsLock) {
        removeOwnedAuthorityLock(lockPath, lockRecord);
      }
    }
  }
}

export function ticketLocalDecisionAttestationTrustProfileResolver(
  reader: TicketLocalDecisionAuthorityProfileReader,
): TicketLocalDecisionTrustProfileResolverV1 {
  return {
    resolveProfile(lookup): TicketLocalDecisionTrustProfileV1 | null {
      const matches = reader.listProfiles().filter((profile) =>
        profile.keyId === lookup.keyId
        && profile.keyFingerprint === lookup.keyFingerprint
        && profile.repositoryIncarnation
          === lookup.repositoryIncarnation
      );
      if (matches.length > 1) {
        throw new TicketLocalDecisionAuthorityError(
          "ambiguous_profile",
          "Local Decision authority resolver found ambiguous profiles",
        );
      }
      const profile = matches[0];
      return profile === undefined ? null : {
        keyId: profile.keyId,
        keyFingerprint: profile.keyFingerprint,
        publicKeySpkiPem: profile.publicKeySpkiPem,
        principalId: profile.principalId,
        principalKind: "human",
        basis: profile.authorityBasis,
        basisRef: profile.authorityRef,
        repositoryIncarnation: profile.repositoryIncarnation,
        algorithm: profile.algorithm,
        createdAt: profile.createdAt,
        revokedAt: profile.revokedAt,
      };
    },
  };
}

export const ticketDecisionAttestationTrustProfileResolver =
  ticketLocalDecisionAttestationTrustProfileResolver;

export function ticketLocalDecisionAuthoritySigningMessage(
  envelope: unknown,
): Buffer {
  return signingMessage(envelope);
}

const signingMessage = (envelope: unknown): Buffer =>
  Buffer.concat([
    Buffer.from(TICKET_LOCAL_DECISION_AUTHORITY_SIGNING_DOMAIN, "utf8"),
    Buffer.from(canonicalTicketLedgerValue(envelope), "utf8"),
  ]);

const activeProfilesForRepository = (
  registry: TicketLocalDecisionAuthorityRegistryV1,
  repositoryIncarnation: string,
): TicketLocalDecisionAuthorityProfileV1[] =>
  registry.profiles.filter((profile) =>
    profile.repositoryIncarnation === repositoryIncarnation
    && profile.revokedAt === null
  );

const ambiguousProfile = (
  repositoryIncarnation: string,
): TicketLocalDecisionAuthorityError =>
  new TicketLocalDecisionAuthorityError(
    "ambiguous_profile",
    `Multiple active Local Decision authorities exist for ${repositoryIncarnation}`,
  );

const revokedProfile = (
  repositoryIncarnation: string,
): TicketLocalDecisionAuthorityError =>
  new TicketLocalDecisionAuthorityError(
    "profile_revoked",
    `Local Decision authority is revoked for ${repositoryIncarnation}`,
  );

const deriveProfileId = (identity: {
  keyId: string;
  keyFingerprint: string;
  repositoryIncarnation: string;
}): string => `tla-${sha256(JSON.stringify({
  keyId: identity.keyId,
  keyFingerprint: identity.keyFingerprint,
  repositoryIncarnation: identity.repositoryIncarnation,
  algorithm: TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM,
}))}`;

const cloneProfile = (
  profile: TicketLocalDecisionAuthorityProfileV1,
): TicketLocalDecisionAuthorityProfileV1 => ({ ...profile });

const compareProfiles = (
  left: TicketLocalDecisionAuthorityProfileV1,
  right: TicketLocalDecisionAuthorityProfileV1,
): number => Buffer.compare(
  Buffer.from(left.profileId, "utf8"),
  Buffer.from(right.profileId, "utf8"),
);

const sha256 = (value: string | Uint8Array): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const noFollowFlag = (): number => fs.constants.O_NOFOLLOW ?? 0;

const readAuthorityLock = (
  lockPath: string,
): { stat: fs.Stats; content: string } | null => {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(lockPath);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return null;
    throw cause;
  }
  assertSecureFile(before, lockPath);
  if (before.size > 4_096) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority lock is too large",
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor);
    assertSecureFile(opened, lockPath);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      return null;
    }
    return {
      stat: opened,
      content: fs.readFileSync(descriptor, "utf8"),
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const authorityLockOwnerPid = (content: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) return null;
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "nonce,pid,schemaVersion"
    || record.schemaVersion !== 1
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || typeof record.nonce !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.nonce)
  ) return null;
  return record.pid as number;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isNodeError(cause) || cause.code !== "ESRCH";
  }
};

const withAuthorityCoordinationLock = <T>(
  coordinationPath: string,
  operation: () => T,
): T => {
  assertNoSymlinkAncestors(coordinationPath);
  const before = prepareAuthorityCoordinationFile(coordinationPath);

  let database: Database.Database | undefined;
  let transactionOpen = false;
  try {
    database = new Database(coordinationPath, {
      timeout: 0,
      fileMustExist: true,
    });
    const opened = fs.lstatSync(coordinationPath);
    assertSecureFile(opened, coordinationPath);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision authority coordination file changed while opening",
      );
    }
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
    } catch (cause) {
      if (isSqliteBusy(cause)) {
        throw new TicketLocalDecisionAuthorityError(
          "store_busy",
          "Local Decision authority store is busy",
          { cause },
        );
      }
      throw cause;
    }
    return operation();
  } finally {
    if (database !== undefined) {
      if (transactionOpen) {
        database.exec("ROLLBACK");
      }
      database.close();
    }
  }
};

const prepareAuthorityCoordinationFile = (
  coordinationPath: string,
): fs.Stats => {
  let descriptor: number | undefined;
  let created = false;
  try {
    try {
      descriptor = fs.openSync(
        coordinationPath,
        fs.constants.O_RDWR
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | noFollowFlag(),
        FILE_MODE,
      );
      created = true;
    } catch (cause) {
      if (!isNodeError(cause) || cause.code !== "EEXIST") throw cause;
      const before = fs.lstatSync(coordinationPath);
      assertOwnedRegularFile(before, coordinationPath);
      descriptor = fs.openSync(
        coordinationPath,
        fs.constants.O_RDWR | noFollowFlag(),
      );
      const opened = fs.fstatSync(descriptor);
      assertOwnedRegularFile(opened, coordinationPath);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new TicketLocalDecisionAuthorityError(
          "invalid_store",
          "Local Decision authority coordination file changed while opening",
        );
      }
    }
    fs.fchmodSync(descriptor, FILE_MODE);
    fs.fsyncSync(descriptor);
    const prepared = fs.fstatSync(descriptor);
    assertSecureFile(prepared, coordinationPath);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (created) fsyncDirectory(path.dirname(coordinationPath));
    return prepared;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const recoverStaleAuthorityLock = (lockPath: string): boolean => {
  const first = readAuthorityLock(lockPath);
  if (first === null) return true;
  const pid = authorityLockOwnerPid(first.content);
  if (pid === null || processIsAlive(pid)) return false;
  const current = readAuthorityLock(lockPath);
  if (
    current === null
    || current.stat.dev !== first.stat.dev
    || current.stat.ino !== first.stat.ino
    || current.content !== first.content
  ) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return true;
    throw cause;
  }
};

const removeOwnedAuthorityLock = (
  lockPath: string,
  expectedContent: string,
): void => {
  const current = readAuthorityLock(lockPath);
  if (current === null || current.content !== expectedContent) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
  }
};

const isNodeError = (
  error: unknown,
): error is NodeJS.ErrnoException => error instanceof Error;

const isSqliteBusy = (
  error: unknown,
): error is Error & { code: string } =>
  error instanceof Error
  && "code" in error
  && (
    (error as { code?: unknown }).code === "SQLITE_BUSY"
    || (error as { code?: unknown }).code === "SQLITE_LOCKED"
  );

const assertRepositoryIncarnation = (value: unknown): string => {
  if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_input",
      "repositoryIncarnation must be repo- followed by 64 lowercase hex characters",
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
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `${label} must be a canonical UTC timestamp`,
    );
  }
  return value;
};

const assertExactKeys = (
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
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `${label} contains unknown or missing fields`,
    );
  }
};

const asPlainObject = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `${label} must be a plain object`,
    );
  }
  return value as Record<string, unknown>;
};

const validateProfile = (
  value: unknown,
): TicketLocalDecisionAuthorityProfileV1 => {
  const profile = asPlainObject(value, "Local Decision authority profile");
  assertExactKeys(profile, [
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
  ], "Local Decision authority profile");
  if (
    typeof profile.profileId !== "string"
    || !PROFILE_PATTERN.test(profile.profileId)
    || typeof profile.keyId !== "string"
    || !KEY_PATTERN.test(profile.keyId)
    || typeof profile.keyFingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(profile.keyFingerprint)
    || profile.keyId !== `tdk-${profile.keyFingerprint}`
    || profile.principalId !== `local-installation:${profile.profileId}`
    || profile.principalKind !== "human"
    || profile.authorityBasis !== "designated_human"
    || profile.authorityRef
      !== `vibehub:local-installation:${profile.profileId}`
    || profile.algorithm !== TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM
    || typeof profile.publicKeySpkiPem !== "string"
    || profile.publicKeySpkiPem.length > 4_096
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority profile identity is invalid",
    );
  }
  const repositoryIncarnation = assertRepositoryIncarnation(
    profile.repositoryIncarnation,
  );
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(profile.publicKeySpkiPem);
  } catch (cause) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority SPKI public key is invalid",
      { cause },
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority key must be Ed25519",
    );
  }
  const normalizedPem = publicKey.export({
    format: "pem",
    type: "spki",
  }).toString();
  const fingerprint = sha256(Buffer.from(publicKey.export({
    format: "der",
    type: "spki",
  })));
  const identity = {
    keyId: profile.keyId,
    keyFingerprint: fingerprint,
    repositoryIncarnation,
  };
  if (
    normalizedPem !== profile.publicKeySpkiPem
    || fingerprint !== profile.keyFingerprint
    || deriveProfileId(identity) !== profile.profileId
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority profile content identity is invalid",
    );
  }
  const createdAt = assertTimestamp(profile.createdAt, "createdAt");
  const revokedAt = profile.revokedAt === null
    ? null
    : assertTimestamp(profile.revokedAt, "revokedAt");
  if (revokedAt !== null && revokedAt < createdAt) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority revokedAt cannot precede createdAt",
    );
  }
  return {
    profileId: profile.profileId,
    keyId: profile.keyId,
    keyFingerprint: profile.keyFingerprint,
    principalId: profile.principalId,
    principalKind: "human",
    authorityBasis: "designated_human",
    authorityRef: profile.authorityRef,
    repositoryIncarnation,
    algorithm: TICKET_LOCAL_DECISION_AUTHORITY_ALGORITHM,
    publicKeySpkiPem: normalizedPem,
    createdAt,
    revokedAt,
  };
};

const validateRegistry = (
  value: unknown,
): TicketLocalDecisionAuthorityRegistryV1 => {
  const registry = asPlainObject(value, "Local Decision authority registry");
  assertExactKeys(
    registry,
    ["schemaVersion", "profiles"],
    "Local Decision authority registry",
  );
  if (
    registry.schemaVersion
      !== TICKET_LOCAL_DECISION_AUTHORITY_SCHEMA_VERSION
    || !Array.isArray(registry.profiles)
    || registry.profiles.length > MAX_PROFILES
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority registry schema is invalid",
    );
  }
  const profiles = registry.profiles.map(validateProfile);
  for (let index = 1; index < profiles.length; index += 1) {
    if (compareProfiles(profiles[index - 1]!, profiles[index]!) >= 0) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision authority profiles must have unique sorted IDs",
      );
    }
  }
  const keys = new Set<string>();
  for (const profile of profiles) {
    if (keys.has(profile.keyId)) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision authority registry contains duplicate keys",
      );
    }
    keys.add(profile.keyId);
  }
  return {
    schemaVersion: TICKET_LOCAL_DECISION_AUTHORITY_SCHEMA_VERSION,
    profiles,
  };
};

const readRegistry = (
  registryPath: string,
): TicketLocalDecisionAuthorityRegistryV1 => {
  assertNoSymlinkAncestors(registryPath);
  ensureSecureDirectory(path.dirname(registryPath), false);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(registryPath);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {
        schemaVersion: TICKET_LOCAL_DECISION_AUTHORITY_SCHEMA_VERSION,
        profiles: [],
      };
    }
    throw cause;
  }
  assertSecureFile(before, registryPath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      registryPath,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor);
    assertSecureFile(opened, registryPath);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision authority registry changed while opening",
      );
    }
    if (opened.size > MAX_REGISTRY_BYTES) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision authority registry is too large",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch (cause) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision authority registry is not valid JSON",
        { cause },
      );
    }
    return validateRegistry(parsed);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const writeRegistry = (
  registryPath: string,
  registry: TicketLocalDecisionAuthorityRegistryV1,
  randomBytes: (size: number) => Uint8Array,
): void => {
  const validated = validateRegistry(registry);
  ensureSecureDirectory(path.dirname(registryPath), true);
  try {
    assertSecureFile(fs.lstatSync(registryPath), registryPath);
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
  }
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_REGISTRY_BYTES) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Local Decision authority registry is too large",
    );
  }
  atomicWriteFile(
    registryPath,
    content,
    randomBytes,
    false,
  );
};

const writePrivateKey = (
  keyPath: string,
  privateKeyPem: string,
  randomBytes: (size: number) => Uint8Array,
): void => {
  ensureSecureDirectory(path.dirname(keyPath), true);
  try {
    fs.lstatSync(keyPath);
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `Local Decision private key already exists: ${keyPath}`,
    );
  } catch (cause) {
    if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
  }
  atomicWriteFile(keyPath, privateKeyPem, randomBytes, true);
};

const readPrivateKey = (keyPath: string): crypto.KeyObject => {
  assertNoSymlinkAncestors(keyPath);
  ensureSecureDirectory(path.dirname(keyPath), false);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(keyPath);
  } catch (cause) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Cannot inspect Local Decision private key",
      { cause },
    );
  }
  assertSecureFile(before, keyPath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      keyPath,
      fs.constants.O_RDONLY | noFollowFlag(),
    );
    const opened = fs.fstatSync(descriptor);
    assertSecureFile(opened, keyPath);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision private key changed while opening",
      );
    }
    const content = fs.readFileSync(descriptor, "utf8");
    const key = crypto.createPrivateKey(content);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        "Local Decision private key must be Ed25519",
      );
    }
    return key;
  } catch (cause) {
    if (cause instanceof TicketLocalDecisionAuthorityError) throw cause;
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      "Cannot decode Local Decision private key",
      { cause },
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const atomicWriteFile = (
  targetPath: string,
  content: string,
  randomBytes: (size: number) => Uint8Array,
  refuseExisting: boolean,
): void => {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${Buffer.from(
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
      FILE_MODE,
    );
    temporaryExists = true;
    fs.fchmodSync(descriptor, FILE_MODE);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (refuseExisting) {
      try {
        fs.lstatSync(targetPath);
        throw new TicketLocalDecisionAuthorityError(
          "invalid_store",
          `Refusing to replace existing Local Decision authority file: ${targetPath}`,
        );
      } catch (cause) {
        if (!isNodeError(cause) || cause.code !== "ENOENT") throw cause;
      }
    }
    fs.renameSync(temporaryPath, targetPath);
    temporaryExists = false;
    fs.chmodSync(targetPath, FILE_MODE);
    fsyncDirectory(path.dirname(targetPath));
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

const ensureSecureDirectory = (
  directoryPath: string,
  create: boolean,
): void => {
  const absolute = path.resolve(directoryPath);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep)
    .filter((segment) => segment !== "");
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
        fs.mkdirSync(cursor, { mode: DIRECTORY_MODE });
      } catch (mkdirCause) {
        if (!isNodeError(mkdirCause) || mkdirCause.code !== "EEXIST") {
          throw mkdirCause;
        }
      }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TicketLocalDecisionAuthorityError(
        "invalid_store",
        `Local Decision authority path contains a symlink or non-directory: ${cursor}`,
      );
    }
  }
  const final = fs.lstatSync(absolute);
  if (
    (final.mode & 0o777) !== DIRECTORY_MODE
    || (
      typeof process.getuid === "function"
      && final.uid !== process.getuid()
    )
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `Local Decision authority directory must be owned 0700: ${absolute}`,
    );
  }
};

const assertNoSymlinkAncestors = (targetPath: string): void => {
  const parent = path.dirname(path.resolve(targetPath));
  const parsed = path.parse(parent);
  const segments = parent.slice(parsed.root.length).split(path.sep)
    .filter((segment) => segment !== "");
  let cursor = parsed.root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TicketLocalDecisionAuthorityError(
          "invalid_store",
          `Local Decision authority path contains a symlink or non-directory: ${cursor}`,
        );
      }
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return;
      throw cause;
    }
  }
};

const assertSecureFile = (stat: fs.Stats, filePath: string): void => {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (stat.mode & 0o777) !== FILE_MODE
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `Local Decision authority file must be owned no-follow 0600: ${filePath}`,
    );
  }
};

const assertOwnedRegularFile = (
  stat: fs.Stats,
  filePath: string,
): void => {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || (
      typeof process.getuid === "function"
      && stat.uid !== process.getuid()
    )
  ) {
    throw new TicketLocalDecisionAuthorityError(
      "invalid_store",
      `Local Decision authority coordination file must be owned and regular: ${filePath}`,
    );
  }
};

const fsyncDirectory = (directoryPath: string): void => {
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | noFollowFlag(),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};
