/**
 * Git-native Ticket definition/topology authority for the Ticket Review V0
 * read surface and its internal outline-generation publication substrate.
 *
 * Published files are canonical JSON with a `.yaml` extension, matching the
 * repository's existing semantic-store convention. Ticket definition
 * revisions and generation manifests are immutable. `latest.yaml` is the only
 * mutable pointer. The publisher in this module is the storage primitive below
 * Core's authorized proposal-application service; it is deliberately not an
 * authoring operation and grants no graph-mutation or human authority itself.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  TICKET_REVIEW_MAX_RELATIONS,
  TICKET_REVIEW_MAX_TICKETS,
  TICKET_REVIEW_SCHEMA_VERSION,
} from "./contract/ticket-review.js";
import { ticketReviewInstantV0Schema } from "./contract/ticket-review-schemas.js";
import { GitFacade } from "./git-facade.js";
import { deriveTicketReviewSnapshotIdV0 } from "./ticket-review-projector.js";
import {
  type ResolvedTicketReviewProjectionSourceProviderV0,
  type TicketReviewLatestSourceLoadV0,
  type TicketReviewRepositoryScopeV0,
  type TicketReviewSnapshotSourceLoadV0,
} from "./ticket-review-resolver.js";
import {
  type TicketReviewDirectUnlockFactV0,
  type TicketReviewProjectionSourceV0,
} from "./ticket-review-source.js";

export const GIT_TICKET_STORE_RELATIVE_PATH = ".vibehub/ticket-store";
export const GIT_TICKET_STORE_FORMAT = "vibehub.git-ticket-store";
export const GIT_TICKET_STORE_SCHEMA_VERSION = 1;

const PROTOCOL_FILE = "protocol.yaml";
const LATEST_FILE = "latest.yaml";
const WRITER_CONTROL_RELATIVE_PATH = "vibehub/ticket-publisher-v1";
const WRITER_LOCK_DIRECTORY = "lock";
const WRITER_LOCK_STAGE_PREFIX = ".lock-stage-";
const WRITER_LOCK_OWNER_PREFIX = "owner-";
const WRITER_LOCK_RELEASING_PREFIX = "releasing-";
const WRITER_LOCK_FILE_SUFFIX = ".json";
const MAX_PROTOCOL_BYTES = 64 * 1024;
const MAX_LATEST_BYTES = 64 * 1024;
const MAX_GENERATION_BYTES = 2 * 1024 * 1024;
const MAX_TICKET_REVISION_BYTES = 1024 * 1024;
const MAX_GENERATION_SOURCE_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_ID = /^tgs-[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORE_ID = /^ticket-store-[0-9a-f]{32}$/u;
const REVISION_MAX = 9_999_999_999;
const WRITER_LOCK_FORMAT = "vibehub.git-ticket-writer-lock";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

const boundedString = (maxLength: number) => z.string()
  .check(z.custom<string>(
    (value) => typeof value === "string" && [...value].length <= maxLength,
    { message: `must contain at most ${maxLength} Unicode characters` },
  ))
  .meta({ maxLength });
const canonicalString = (maxLength: number) => boundedString(maxLength)
  .min(1)
  .regex(/^(?!\s)[\s\S]*\S$(?![\s\S])/u);
const ticketId = canonicalString(200);
const revision = z.number().int().positive().max(REVISION_MAX);
const digest = z.string().regex(SHA256);
const storeId = z.string().regex(STORE_ID);
const snapshotId = z.string().regex(SNAPSHOT_ID);
const gitTicketPublicationFenceV0Schema = z.object({
  applicationIntentId: canonicalString(300),
  intentDigest: digest,
  candidateSnapshotId: snapshotId,
}).strict();

const ticketDependencyV0Schema = z.object({
  ticketId,
  rationale: boundedString(20_000).optional(),
}).strict();

const ticketCreationSourceV0Schema = z.object({
  kind: z.enum(["ticket", "run", "plan", "conversation", "other"]),
  ref: canonicalString(300),
}).strict();

export const gitTicketDefinitionRevisionV0Schema = z.object({
  schemaVersion: z.literal(GIT_TICKET_STORE_SCHEMA_VERSION),
  kind: z.literal("ticket_definition_revision"),
  ticketId,
  definitionRevision: revision,
  created: z.object({
    at: ticketReviewInstantV0Schema,
    by: canonicalString(200),
    reason: canonicalString(2_000),
    source: ticketCreationSourceV0Schema.nullable(),
  }).strict(),
  outcome: canonicalString(20_000),
  parentId: ticketId.nullable(),
  dependsOn: z.array(ticketDependencyV0Schema).max(TICKET_REVIEW_MAX_TICKETS),
  provenanceRefs: z.array(canonicalString(300)).max(20),
}).strict();

const generationEntryV0Schema = z.object({
  ticketId,
  definitionRevision: revision,
  file: canonicalString(1_000),
  sha256: digest,
}).strict();

export const gitTicketGenerationV0Schema = z.object({
  schemaVersion: z.literal(GIT_TICKET_STORE_SCHEMA_VERSION),
  kind: z.literal("ticket_generation"),
  storeId,
  snapshotId,
  generationDigest: digest,
  tickets: z.array(generationEntryV0Schema).max(TICKET_REVIEW_MAX_TICKETS),
}).strict();

export const gitTicketStoreProtocolV0Schema = z.object({
  schemaVersion: z.literal(GIT_TICKET_STORE_SCHEMA_VERSION),
  format: z.literal(GIT_TICKET_STORE_FORMAT),
  storeId,
  indexing: z.literal("stable-ticket-revision-paths"),
  integrity: z.literal("immutable-generations-pointer-v1"),
  projector: z.literal("ticket-review-v0"),
}).strict();

export const gitTicketLatestV0Schema = z.object({
  schemaVersion: z.literal(GIT_TICKET_STORE_SCHEMA_VERSION),
  kind: z.literal("ticket_latest"),
  storeId,
  snapshotId,
}).strict();

const gitTicketWriterLockV0Schema = z.object({
  schemaVersion: z.literal(GIT_TICKET_STORE_SCHEMA_VERSION),
  format: z.literal(WRITER_LOCK_FORMAT),
  token: z.uuid(),
  pid: z.number().int().positive(),
  hostname: canonicalString(300),
  acquiredAt: ticketReviewInstantV0Schema,
  fence: gitTicketPublicationFenceV0Schema.optional(),
}).strict();

export type GitTicketDefinitionRevisionV0 =
  z.infer<typeof gitTicketDefinitionRevisionV0Schema>;
export type GitTicketGenerationV0 =
  z.infer<typeof gitTicketGenerationV0Schema>;
export type GitTicketStoreProtocolV0 =
  z.infer<typeof gitTicketStoreProtocolV0Schema>;
export type GitTicketLatestV0 =
  z.infer<typeof gitTicketLatestV0Schema>;

export interface PreparedGitTicketDefinitionRevisionV0 {
  definition: GitTicketDefinitionRevisionV0;
  file: string;
  bytes: string;
  sha256: string;
}

export interface PreparedGitTicketGenerationV0 {
  storeId: string;
  definitions: GitTicketDefinitionRevisionV0[];
  revisions: PreparedGitTicketDefinitionRevisionV0[];
  generation: GitTicketGenerationV0;
  generationFile: string;
  generationBytes: string;
  latest: GitTicketLatestV0;
  latestBytes: string;
  source: TicketReviewProjectionSourceV0;
  relationCount: number;
  sourceBytes: number;
}

export interface GitTicketGenerationPublishRequestV0 {
  /**
   * Publication-head CAS only. This is not semantic graph-mutation authority.
   * `null` means that the caller expects no published generation.
   */
  expectedSnapshotId: string | null;
  definitions: ReadonlyArray<GitTicketDefinitionRevisionV0>;
}

export interface GitTicketGenerationPublishResultV0 {
  status: "published" | "unchanged";
  previousSnapshotId: string | null;
  snapshotId: string;
  ticketCount: number;
  directUnlockCount: number;
}

export interface GitTicketPublicationFenceV0 {
  applicationIntentId: string;
  intentDigest: string;
  candidateSnapshotId: string;
}

export interface GitTicketFencedGenerationPublishRequestV0 {
  /**
   * Exact publication base bound by the durable application intent.
   * `null` means that the intent was prepared against an empty Ticket store.
   */
  expectedSnapshotId: string | null;
  definitions: ReadonlyArray<GitTicketDefinitionRevisionV0>;
  /**
   * Deterministic store identity persisted by the application intent. It is
   * used only when bootstrapping; an existing store keeps its own identity.
   */
  bootstrapStoreId: string;
  fence: GitTicketPublicationFenceV0;
}

export interface GitTicketFencedGenerationPublishResultV0 {
  status: "published" | "reconciled";
  previousSnapshotId: string | null;
  snapshotId: string;
  ticketCount: number;
  directUnlockCount: number;
}

/**
 * Exact, read-only authoring base for proposal preparation.
 *
 * This is an internal Core seam, not a public authoring API. Loading a base
 * proves only that the caller observed the current publication head; it does
 * not grant graph-mutation authority.
 */
export interface GitTicketAuthoringBaseV0 {
  snapshotId: string | null;
  storeId: string | null;
  definitions: GitTicketDefinitionRevisionV0[];
  source: TicketReviewProjectionSourceV0 | null;
}

export interface GitTicketAuthoringScopeV0
extends TicketReviewRepositoryScopeV0 {
  /** Git common-directory identity resolved and later rechecked by Core. */
  repositoryIncarnation: string;
}

/**
 * A fenced filesystem publication whose writer lock remains durable until the
 * caller commits its matching application receipt.
 */
export class GitTicketFencedPublicationSessionV0 {
  private released = false;

  constructor(
    readonly result: GitTicketFencedGenerationPublishResultV0,
    private readonly control: GitTicketPublisherControlV0,
    private readonly writerLock: GitTicketWriterLockV0,
  ) {}

  /**
   * Release the exact fence after the caller's application transaction commits.
   * Cleanup is idempotent and fails closed by retaining a lock it cannot prove
   * it still owns.
   */
  release(): boolean {
    if (this.released) return true;
    this.released = releaseWriterLock(
      this.control,
      this.writerLock,
    );
    return this.released;
  }
}

export type GitTicketStoreErrorCodeV0 =
  | "ticket_store_corrupt"
  | "ticket_store_scope_mismatch"
  | "ticket_store_publish_invalid"
  | "ticket_store_cas_conflict"
  | "ticket_store_commit_uncertain"
  | "ticket_store_revision_conflict"
  | "ticket_store_writer_busy";

export class GitTicketStoreErrorV0 extends Error {
  constructor(
    readonly code: GitTicketStoreErrorCodeV0,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "GitTicketStoreErrorV0";
  }
}

interface ResolvedStore {
  worktreeRoot: string;
  storeRoot: string;
  protocol: GitTicketStoreProtocolV0;
}

interface LoadedGeneration {
  source: TicketReviewProjectionSourceV0;
  snapshotId: string;
  definitions: GitTicketDefinitionRevisionV0[];
}

interface GitTicketPublicationCommitStateV0 {
  canonicalMemberInstalled: boolean;
  visibilityCommitted: boolean;
}

export const compareGitTicketCanonicalTextV0 = (
  left: string,
  right: string,
): number =>
  left < right ? -1 : left > right ? 1 : 0;
const compare = compareGitTicketCanonicalTextV0;
const sha256 = (value: string | Buffer): string => crypto
  .createHash("sha256")
  .update(value)
  .digest("hex");

const canonicalize = (value: unknown): Json => {
  if (value === null || typeof value === "string"
    || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw corrupt("Ticket store contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw corrupt("Ticket store contains a non-JSON value");
};

export const serializeGitTicketStoreDocumentV0 = (value: unknown): string =>
  `${JSON.stringify(canonicalize(value), null, 2)}\n`;

export const gitTicketRevisionRelativePathV0 = (
  id: string,
  definitionRevision: number,
): string => {
  const parsedId = ticketId.parse(id);
  const parsedRevision = revision.parse(definitionRevision);
  return [
    "tickets",
    `sha256-${sha256(parsedId)}`,
    `revision-${String(parsedRevision).padStart(10, "0")}.yaml`,
  ].join("/");
};

export const gitTicketGenerationRelativePathV0 = (
  id: string,
): string => {
  const parsed = snapshotId.parse(id);
  return `generations/${parsed}.yaml`;
};

export const gitTicketGenerationDigestV0 = (
  store: string,
  entries: ReadonlyArray<z.infer<typeof generationEntryV0Schema>>,
): string => {
  const parsedStoreId = storeId.parse(store);
  const parsedEntries = z.array(generationEntryV0Schema)
    .max(TICKET_REVIEW_MAX_TICKETS)
    .parse(entries);
  return sha256(serializeGitTicketStoreDocumentV0({
    storeId: parsedStoreId,
    tickets: parsedEntries,
  }));
};

/**
 * Pure, authority-neutral compiler for one complete outline generation.
 *
 * It validates and deterministically prepares canonical immutable artifacts,
 * but performs no filesystem writes and advances no publication pointer.
 */
export const prepareGitTicketGenerationV0 = (
  rawStoreId: string,
  rawDefinitions: ReadonlyArray<GitTicketDefinitionRevisionV0>,
): PreparedGitTicketGenerationV0 => {
  const parsedStoreId = parsePublishValue(storeId, rawStoreId, "storeId");
  const parsedDefinitions = parsePublishValue(
    z.array(gitTicketDefinitionRevisionV0Schema)
      .min(1)
      .max(TICKET_REVIEW_MAX_TICKETS),
    rawDefinitions,
    "definitions",
  );
  const definitions = parsedDefinitions.slice()
    .sort((left, right) => compare(left.ticketId, right.ticketId));
  assertPublishSortedUnique(
    definitions.map((definition) => definition.ticketId),
    "generation Ticket IDs",
  );
  validateCurrentGraph(definitions, publishInvalid);

  let relationCount = 0;
  let sourceBytes = 0;
  const revisions = definitions.map((definition) => {
    assertPublishSortedUnique(
      definition.dependsOn.map((dependency) => dependency.ticketId),
      `dependencies of ${definition.ticketId}`,
    );
    relationCount += definition.dependsOn.length;
    if (relationCount > TICKET_REVIEW_MAX_RELATIONS) {
      throw publishInvalid(
        "Ticket generation exceeds the direct-unlock capacity",
        { relationCount, maximum: TICKET_REVIEW_MAX_RELATIONS },
      );
    }
    const file = gitTicketRevisionRelativePathV0(
      definition.ticketId,
      definition.definitionRevision,
    );
    const bytes = serializeGitTicketStoreDocumentV0(definition);
    const byteLength = Buffer.byteLength(bytes, "utf8");
    if (byteLength > MAX_TICKET_REVISION_BYTES) {
      throw publishInvalid("Ticket definition exceeds its byte capacity", {
        ticketId: definition.ticketId,
        size: byteLength,
        maximumBytes: MAX_TICKET_REVISION_BYTES,
      });
    }
    sourceBytes += byteLength;
    if (sourceBytes > MAX_GENERATION_SOURCE_BYTES) {
      throw publishInvalid(
        "Ticket generation exceeds its aggregate byte capacity",
        { sourceBytes, maximumBytes: MAX_GENERATION_SOURCE_BYTES },
      );
    }
    return {
      definition,
      file,
      bytes,
      sha256: sha256(bytes),
    };
  });
  const entries = revisions.map((prepared) => ({
    ticketId: prepared.definition.ticketId,
    definitionRevision: prepared.definition.definitionRevision,
    file: prepared.file,
    sha256: prepared.sha256,
  }));
  const generationDigest = gitTicketGenerationDigestV0(
    parsedStoreId,
    entries,
  );
  const source = projectionSourceForGeneration(
    parsedStoreId,
    generationDigest,
    definitions,
  );
  let preparedSnapshotId: string;
  try {
    preparedSnapshotId = deriveTicketReviewSnapshotIdV0(source);
  } catch (error) {
    throw publishInvalid(
      "Ticket generation cannot produce a valid review snapshot",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const generation: GitTicketGenerationV0 = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_generation",
    storeId: parsedStoreId,
    snapshotId: preparedSnapshotId,
    generationDigest,
    tickets: entries,
  };
  const generationFile = gitTicketGenerationRelativePathV0(
    preparedSnapshotId,
  );
  const generationBytes = serializeGitTicketStoreDocumentV0(generation);
  if (Buffer.byteLength(generationBytes, "utf8") > MAX_GENERATION_BYTES) {
    throw publishInvalid("Ticket generation manifest exceeds its byte capacity", {
      size: Buffer.byteLength(generationBytes, "utf8"),
      maximumBytes: MAX_GENERATION_BYTES,
    });
  }
  const latest: GitTicketLatestV0 = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_latest",
    storeId: parsedStoreId,
    snapshotId: preparedSnapshotId,
  };
  const latestBytes = serializeGitTicketStoreDocumentV0(latest);
  if (Buffer.byteLength(latestBytes, "utf8") > MAX_LATEST_BYTES) {
    throw publishInvalid("Ticket latest pointer exceeds its byte capacity", {
      size: Buffer.byteLength(latestBytes, "utf8"),
      maximumBytes: MAX_LATEST_BYTES,
    });
  }
  return {
    storeId: parsedStoreId,
    definitions,
    revisions,
    generation,
    generationFile,
    generationBytes,
    latest,
    latestBytes,
    source,
    relationCount,
    sourceBytes,
  };
};

/**
 * Internal storage-level publisher for an already-authorized, complete
 * outline generation. It is intentionally absent from the public operation
 * registry: proposal semantics, validation receipts, and authority live above
 * this primitive.
 */
export class GitTicketGenerationPublisherV0 {
  publish(
    scope: TicketReviewRepositoryScopeV0,
    request: GitTicketGenerationPublishRequestV0,
  ): GitTicketGenerationPublishResultV0 {
    const expectedSnapshotId = parsePublishValue(
      snapshotId.nullable(),
      request.expectedSnapshotId,
      "expectedSnapshotId",
    );
    const worktreeRoot = resolveScope(scope);
    const control = ensurePublisherControlRoot(worktreeRoot);
    const storeRoot = path.join(
      worktreeRoot,
      GIT_TICKET_STORE_RELATIVE_PATH,
    );
    const writerLock = acquireWriterLock(control);
    const commitState: GitTicketPublicationCommitStateV0 = {
      canonicalMemberInstalled: false,
      visibilityCommitted: false,
    };
    let releaseLock = true;
    try {
      const lockedWorktreeRoot = resolveScope(scope);
      if (lockedWorktreeRoot !== worktreeRoot) {
        throw scopeMismatch(
          "Ticket worktree scope changed while acquiring the writer lock",
        );
      }
      const state = resolveStore(worktreeRoot);
      const storeIdentity = state?.protocol.storeId
        ?? `ticket-store-${crypto.randomBytes(16).toString("hex")}`;
      const prepared = prepareGitTicketGenerationV0(
        storeIdentity,
        request.definitions,
      );
      const current = state === null
        ? null
        : loadLatestGeneration(state);
      const previousSnapshotId = current?.snapshotId ?? null;

      if (current?.snapshotId === prepared.generation.snapshotId) {
        return {
          status: "unchanged",
          previousSnapshotId,
          snapshotId: prepared.generation.snapshotId,
          ticketCount: prepared.definitions.length,
          directUnlockCount: prepared.relationCount,
        };
      }
      if (previousSnapshotId !== expectedSnapshotId) {
        throw casConflict(
          "Ticket publication head changed before the candidate could publish",
          {
            expectedSnapshotId,
            actualSnapshotId: previousSnapshotId,
            candidateSnapshotId: prepared.generation.snapshotId,
          },
        );
      }
      validateGitTicketRevisionTransitionV0(
        current?.definitions ?? [],
        prepared.definitions,
      );

      if (state === null) {
        installInitialStore(
          worktreeRoot,
          storeRoot,
          prepared,
          commitState,
        );
      } else {
        for (const revisionArtifact of prepared.revisions) {
          installImmutableDocument(
            state,
            revisionArtifact.file,
            revisionArtifact.bytes,
            MAX_TICKET_REVISION_BYTES,
            commitState,
            true,
          );
        }
        installImmutableDocument(
          state,
          prepared.generationFile,
          prepared.generationBytes,
          MAX_GENERATION_BYTES,
          commitState,
          true,
        );
        replaceLatestPointer(
          state,
          prepared.latestBytes,
          commitState,
          {
            previousSnapshotId,
            candidateSnapshotId: prepared.generation.snapshotId,
          },
        );
      }
      return {
        status: "published",
        previousSnapshotId,
        snapshotId: prepared.generation.snapshotId,
        ticketCount: prepared.definitions.length,
        directUnlockCount: prepared.relationCount,
      };
    } catch (error) {
      if (commitState.canonicalMemberInstalled
        || commitState.visibilityCommitted) {
        releaseLock = false;
      }
      throw error;
    } finally {
      if (releaseLock) releaseWriterLock(control, writerLock);
    }
  }

  /**
   * Publish one exact application intent while retaining its durable writer
   * fence. The caller MUST hold the matching SQLite `BEGIN IMMEDIATE`
   * application transaction from durable-intent lookup through this method's
   * return. That invariant is what makes adopting an exact, byte-valid stale
   * fence safe: two live callers cannot concurrently resume the same intent.
   *
   * After recording and committing the immutable application receipt, the
   * caller releases the returned session. Any thrown error deliberately keeps
   * an acquired/adopted fence in place for exact reconciliation.
   */
  publishFenced(
    scope: GitTicketAuthoringScopeV0,
    request: GitTicketFencedGenerationPublishRequestV0,
  ): GitTicketFencedPublicationSessionV0 {
    const expectedSnapshotId = parsePublishValue(
      snapshotId.nullable(),
      request.expectedSnapshotId,
      "expectedSnapshotId",
    );
    const bootstrapStoreId = parsePublishValue(
      storeId,
      request.bootstrapStoreId,
      "bootstrapStoreId",
    );
    const fence = parsePublishValue(
      gitTicketPublicationFenceV0Schema,
      request.fence,
      "fence",
    );
    const worktreeRoot = resolveScope(scope);
    assertRepositoryIncarnation(scope);
    const control = ensurePublisherControlRoot(worktreeRoot);
    const storeRoot = path.join(
      worktreeRoot,
      GIT_TICKET_STORE_RELATIVE_PATH,
    );
    const writerLock = acquireOrAdoptFencedWriterLock(control, fence);
    const commitState: GitTicketPublicationCommitStateV0 = {
      canonicalMemberInstalled: false,
      visibilityCommitted: false,
    };

    const lockedWorktreeRoot = resolveScope(scope);
    assertRepositoryIncarnation(scope);
    if (lockedWorktreeRoot !== worktreeRoot) {
      throw scopeMismatch(
        "Ticket worktree scope changed while acquiring the fenced writer lock",
      );
    }
    assertWriterLockHeld(control, writerLock);
    const state = resolveStore(worktreeRoot);
    const storeIdentity = state?.protocol.storeId ?? bootstrapStoreId;
    const prepared = prepareGitTicketGenerationV0(
      storeIdentity,
      request.definitions,
    );
    if (prepared.generation.snapshotId !== fence.candidateSnapshotId) {
      throw publishInvalid(
        "Fenced Ticket candidate does not match its application intent",
        {
          expectedCandidateSnapshotId: fence.candidateSnapshotId,
          actualCandidateSnapshotId: prepared.generation.snapshotId,
        },
      );
    }
    const current = state === null ? null : loadLatestGeneration(state);
    const currentSnapshotId = current?.snapshotId ?? null;

    if (currentSnapshotId === fence.candidateSnapshotId) {
      fsyncPublishedGeneration(
        worktreeRoot,
        prepared,
      );
      assertRepositoryIncarnation(scope);
      assertWriterLockHeld(control, writerLock);
      return new GitTicketFencedPublicationSessionV0(
        {
          status: "reconciled",
          previousSnapshotId: expectedSnapshotId,
          snapshotId: prepared.generation.snapshotId,
          ticketCount: prepared.definitions.length,
          directUnlockCount: prepared.relationCount,
        },
        control,
        writerLock,
      );
    }
    if (currentSnapshotId !== expectedSnapshotId) {
      throw casConflict(
        "Ticket publication head no longer matches the fenced application base",
        {
          expectedSnapshotId,
          actualSnapshotId: currentSnapshotId,
          candidateSnapshotId: prepared.generation.snapshotId,
        },
      );
    }
    validateGitTicketRevisionTransitionV0(
      current?.definitions ?? [],
      prepared.definitions,
    );

    if (state === null) {
      installInitialStore(
        worktreeRoot,
        storeRoot,
        prepared,
        commitState,
      );
    } else {
      for (const revisionArtifact of prepared.revisions) {
        installImmutableDocument(
          state,
          revisionArtifact.file,
          revisionArtifact.bytes,
          MAX_TICKET_REVISION_BYTES,
          commitState,
          true,
        );
      }
      installImmutableDocument(
        state,
        prepared.generationFile,
        prepared.generationBytes,
        MAX_GENERATION_BYTES,
        commitState,
        true,
      );
      replaceLatestPointer(
        state,
        prepared.latestBytes,
        commitState,
        {
          previousSnapshotId: currentSnapshotId,
          candidateSnapshotId: prepared.generation.snapshotId,
        },
      );
    }

    fsyncPublishedGeneration(
      worktreeRoot,
      prepared,
    );
    assertRepositoryIncarnation(scope);
    assertWriterLockHeld(control, writerLock);
    return new GitTicketFencedPublicationSessionV0(
      {
        status: "published",
        previousSnapshotId: expectedSnapshotId,
        snapshotId: prepared.generation.snapshotId,
        ticketCount: prepared.definitions.length,
        directUnlockCount: prepared.relationCount,
      },
      control,
      writerLock,
    );
  }

  /**
   * Remove a fence left behind after its immutable application receipt
   * committed but before the publishing process could release the lock.
   *
   * A missing lock or a different valid owner's lock is already safe. This
   * method releases only a byte-valid lock carrying the exact completed fence
   * while the exact candidate remains canonical. Malformed state or an exact
   * fence over a different head fails closed.
   */
  releaseCompletedFence(
    scope: GitTicketAuthoringScopeV0,
    rawFence: GitTicketPublicationFenceV0,
  ): boolean {
    const fence = parsePublishValue(
      gitTicketPublicationFenceV0Schema,
      rawFence,
      "fence",
    );
    const worktreeRoot = resolveScope(scope);
    assertRepositoryIncarnation(scope);
    const control = ensurePublisherControlRoot(worktreeRoot);
    let inspected: InspectedGitTicketWriterLockV0 | null;
    try {
      inspected = inspectWriterLock(control);
    } catch {
      return false;
    }
    if (inspected === null) return true;
    if (inspected.phase === "empty") {
      return removeEmptyWriterLockDirectory(control);
    }
    if (inspected.value.fence === undefined
      || serializeGitTicketStoreDocumentV0(inspected.value.fence)
        !== serializeGitTicketStoreDocumentV0(fence)) {
      return true;
    }
    try {
      const store = resolveStore(worktreeRoot);
      const current = store === null ? null : loadLatestGeneration(store);
      if (current?.snapshotId !== fence.candidateSnapshotId) return false;
    } catch {
      return false;
    }
    assertRepositoryIncarnation(scope);
    return releaseWriterLock(
      control,
      { token: inspected.token, bytes: inspected.bytes },
    );
  }
}

/**
 * Load the exact current generation used to prepare an immutable proposal.
 * The expected snapshot is a semantic compare-and-swap precondition:
 * `null` means that no Ticket generation may currently be published.
 */
export function loadCurrentGitTicketAuthoringBaseV0(
  scope: GitTicketAuthoringScopeV0,
  expectedSnapshotId: string | null,
): GitTicketAuthoringBaseV0 {
  const expected = parsePublishValue(
    snapshotId.nullable(),
    expectedSnapshotId,
    "expectedSnapshotId",
  );
  const worktreeRoot = resolveScope(scope);
  assertRepositoryIncarnation(scope);
  const store = resolveStore(worktreeRoot);
  const current = store === null ? null : loadLatestGeneration(store);
  assertRepositoryIncarnation(scope);
  const actualSnapshotId = current?.snapshotId ?? null;
  if (actualSnapshotId !== expected) {
    throw casConflict(
      "Ticket proposal base is no longer the current publication head",
      {
        expectedSnapshotId: expected,
        actualSnapshotId,
      },
    );
  }
  return {
    snapshotId: actualSnapshotId,
    storeId: store?.protocol.storeId ?? null,
    definitions: current === null
      ? []
      : cloneCanonical(current.definitions),
    source: current === null
      ? null
      : cloneCanonical(current.source),
  };
}

/**
 * Stable local repository-incarnation token. Kept internal to the Core
 * dispatcher/store seam; a path match alone is not a repository identity.
 */
export function gitTicketRepositoryIncarnationV0(
  repositoryRoot: string,
): string {
  let commonDirectory: string;
  let commonStat: fs.BigIntStats;
  try {
    commonDirectory = fs.realpathSync(path.join(repositoryRoot, ".git"));
    commonStat = fs.statSync(commonDirectory, { bigint: true });
  } catch {
    throw scopeMismatch(
      "Git common directory is unreadable while verifying Ticket scope",
    );
  }
  if (!commonStat.isDirectory()) {
    throw scopeMismatch(
      "Git common directory is not a directory while verifying Ticket scope",
    );
  }
  return [
    "git-common-dir",
    commonStat.dev.toString(),
    commonStat.ino.toString(),
    commonStat.birthtimeMs.toString(),
  ].join(":");
}

function assertRepositoryIncarnation(scope: GitTicketAuthoringScopeV0): void {
  const actual = gitTicketRepositoryIncarnationV0(scope.repositoryRoot);
  if (actual === scope.repositoryIncarnation) return;
  throw scopeMismatch(
    "Ticket repository incarnation changed while preparing the proposal",
    {
      expectedRepositoryIncarnation: scope.repositoryIncarnation,
      actualRepositoryIncarnation: actual,
    },
  );
}

/**
 * Default production provider once a repository publishes a Ticket store.
 * The class keeps no cache: every call is reconstructible in a fresh process.
 */
export class GitTicketReviewProjectionSourceProviderV0
implements ResolvedTicketReviewProjectionSourceProviderV0 {
  loadLatest(
    scope: TicketReviewRepositoryScopeV0,
  ): TicketReviewLatestSourceLoadV0 {
    const worktreeRoot = resolveScope(scope);
    const store = resolveStore(worktreeRoot);
    if (store === null) return { status: "no_ticket_graph" };
    const loaded = loadLatestGeneration(store);
    if (loaded === null) return { status: "no_ticket_graph" };
    return { status: "available", source: loaded.source };
  }

  loadSnapshot(
    scope: TicketReviewRepositoryScopeV0,
    requestedSnapshotId: string,
  ): TicketReviewSnapshotSourceLoadV0 {
    if (!SNAPSHOT_ID.test(requestedSnapshotId)) {
      return { status: "snapshot_expired" };
    }
    const worktreeRoot = resolveScope(scope);
    const store = resolveStore(worktreeRoot);
    if (store === null) return { status: "snapshot_expired" };
    const loaded = loadGeneration(store, requestedSnapshotId);
    return loaded === null
      ? { status: "snapshot_expired" }
      : { status: "available", source: loaded.source };
  }
}

function resolveScope(scope: TicketReviewRepositoryScopeV0): string {
  if (!Number.isInteger(scope.repoId) || scope.repoId <= 0) {
    throw scopeMismatch("Ticket repository scope has an invalid repoId");
  }
  let repositoryRoot: string;
  let worktreeRoot: string;
  try {
    repositoryRoot = fs.realpathSync(scope.repositoryRoot);
    worktreeRoot = fs.realpathSync(scope.worktreeRoot);
  } catch {
    throw scopeMismatch("Ticket repository scope points to a missing path");
  }
  const repositoryStat = fs.lstatSync(repositoryRoot);
  const worktreeStat = fs.lstatSync(worktreeRoot);
  if (!repositoryStat.isDirectory() || !worktreeStat.isDirectory()
    || repositoryStat.isSymbolicLink() || worktreeStat.isSymbolicLink()) {
    throw scopeMismatch("Ticket repository scope must name real directories");
  }
  let session: ReturnType<typeof GitFacade.sessionContextAt>;
  try {
    session = GitFacade.sessionContextAt(worktreeRoot);
  } catch {
    throw scopeMismatch("Ticket worktree scope is not a Git worktree");
  }
  let sessionRepositoryRoot: string;
  let sessionWorktreeRoot: string;
  try {
    sessionRepositoryRoot = fs.realpathSync(session.repoRoot);
    sessionWorktreeRoot = fs.realpathSync(session.toplevel);
  } catch {
    throw scopeMismatch("Git returned an unreadable Ticket repository scope");
  }
  if (sessionRepositoryRoot !== repositoryRoot
    || sessionWorktreeRoot !== worktreeRoot) {
    throw scopeMismatch(
      "Ticket worktree does not belong to the addressed repository",
      {
        repositoryRoot,
        worktreeRoot,
      },
    );
  }
  return worktreeRoot;
}

function resolveStore(worktreeRoot: string): ResolvedStore | null {
  const storeRoot = path.join(worktreeRoot, GIT_TICKET_STORE_RELATIVE_PATH);
  const storeStat = fs.lstatSync(storeRoot, { throwIfNoEntry: false });
  if (storeStat === undefined) return null;
  if (storeStat.isSymbolicLink() || !storeStat.isDirectory()) {
    throw corrupt("Ticket store root must be a real directory");
  }
  assertContained(worktreeRoot, fs.realpathSync(storeRoot), "ticket store root");
  const protocolPath = path.join(storeRoot, PROTOCOL_FILE);
  const protocolValue = readOptionalCanonicalDocument(
    protocolPath,
    worktreeRoot,
    MAX_PROTOCOL_BYTES,
    PROTOCOL_FILE,
  );
  if (protocolValue === null) {
    throw corrupt("Ticket store exists without its protocol", {
      file: PROTOCOL_FILE,
    });
  }
  return {
    worktreeRoot,
    storeRoot,
    protocol: parseDocument(
      gitTicketStoreProtocolV0Schema,
      protocolValue,
      PROTOCOL_FILE,
    ),
  };
}

function loadLatestGeneration(
  store: ResolvedStore,
): LoadedGeneration | null {
  const latestPath = path.join(store.storeRoot, LATEST_FILE);
  const latestValue = readOptionalCanonicalDocument(
    latestPath,
    store.worktreeRoot,
    MAX_LATEST_BYTES,
    LATEST_FILE,
    true,
  );
  if (latestValue === null) return null;
  const latest = parseDocument(
    gitTicketLatestV0Schema,
    latestValue,
    LATEST_FILE,
  );
  if (latest.storeId !== store.protocol.storeId) {
    throw corrupt("Ticket latest pointer belongs to another store", {
      file: LATEST_FILE,
    });
  }
  const loaded = loadGeneration(store, latest.snapshotId);
  if (loaded === null) {
    throw corrupt("Ticket latest pointer references a missing generation", {
      snapshotId: latest.snapshotId,
    });
  }
  return loaded;
}

function loadGeneration(
  store: ResolvedStore,
  requestedSnapshotId: string,
): LoadedGeneration | null {
  const relative = gitTicketGenerationRelativePathV0(requestedSnapshotId);
  const generationPath = path.join(store.storeRoot, relative);
  const generationValue = readOptionalCanonicalDocument(
    generationPath,
    store.worktreeRoot,
    MAX_GENERATION_BYTES,
    relative,
  );
  if (generationValue === null) return null;
  const generation = parseDocument(
    gitTicketGenerationV0Schema,
    generationValue,
    relative,
  );
  if (generation.storeId !== store.protocol.storeId
    || generation.snapshotId !== requestedSnapshotId) {
    throw corrupt("Ticket generation identity does not match its store/path", {
      file: relative,
      snapshotId: requestedSnapshotId,
    });
  }
  assertSortedUnique(
    generation.tickets.map((entry) => entry.ticketId),
    "generation Ticket IDs",
  );
  const expectedGenerationDigest = gitTicketGenerationDigestV0(
    generation.storeId,
    generation.tickets,
  );
  if (generation.generationDigest !== expectedGenerationDigest) {
    throw corrupt("Ticket generation digest does not match its inventory", {
      file: relative,
    });
  }

  const definitions: GitTicketDefinitionRevisionV0[] = [];
  let sourceBytes = 0;
  let relationCount = 0;
  for (const entry of generation.tickets) {
    const expectedFile = gitTicketRevisionRelativePathV0(
      entry.ticketId,
      entry.definitionRevision,
    );
    if (entry.file !== expectedFile) {
      throw corrupt("Ticket generation entry uses a non-canonical path", {
        ticketId: entry.ticketId,
        file: entry.file,
      });
    }
    const absolute = path.join(store.storeRoot, entry.file);
    const bytes = readRequiredCanonicalBytes(
      absolute,
      store.worktreeRoot,
      MAX_TICKET_REVISION_BYTES,
      entry.file,
    );
    sourceBytes += Buffer.byteLength(bytes, "utf8");
    if (sourceBytes > MAX_GENERATION_SOURCE_BYTES) {
      throw corrupt("Ticket generation exceeds its aggregate byte capacity", {
        sourceBytes,
        maximumBytes: MAX_GENERATION_SOURCE_BYTES,
      });
    }
    if (sha256(bytes) !== entry.sha256) {
      throw corrupt("Ticket revision checksum does not match its generation", {
        ticketId: entry.ticketId,
        file: entry.file,
      });
    }
    const document = parseDocument(
      gitTicketDefinitionRevisionV0Schema,
      parseCanonicalBytes(bytes, entry.file),
      entry.file,
    );
    if (document.ticketId !== entry.ticketId
      || document.definitionRevision !== entry.definitionRevision) {
      throw corrupt("Ticket revision identity does not match its generation", {
        ticketId: entry.ticketId,
        file: entry.file,
      });
    }
    relationCount += document.dependsOn.length;
    if (relationCount > TICKET_REVIEW_MAX_RELATIONS) {
      throw corrupt("Ticket generation exceeds the direct-unlock capacity", {
        relationCount,
        maximum: TICKET_REVIEW_MAX_RELATIONS,
      });
    }
    definitions.push(document);
  }
  validateCurrentGraph(definitions);

  const source = projectionSourceForGeneration(
    generation.storeId,
    generation.generationDigest,
    definitions,
  );
  let actualSnapshotId: string;
  try {
    actualSnapshotId = deriveTicketReviewSnapshotIdV0(source);
  } catch (error) {
    throw corrupt("Ticket generation cannot produce a valid review snapshot", {
      file: relative,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (actualSnapshotId !== requestedSnapshotId) {
    throw corrupt("Ticket generation content does not match its snapshot ID", {
      file: relative,
      expectedSnapshotId: requestedSnapshotId,
      actualSnapshotId,
    });
  }
  return { source, snapshotId: actualSnapshotId, definitions };
}

function projectionSourceForGeneration(
  generationStoreId: string,
  generationDigest: string,
  definitions: GitTicketDefinitionRevisionV0[],
): TicketReviewProjectionSourceV0 {
  const snapshotRevision = [
    "ticket-generation",
    generationStoreId,
    generationDigest,
  ].join(":");
  return {
    schemaVersion: TICKET_REVIEW_SCHEMA_VERSION,
    snapshotRevision,
    projectionWatermark: snapshotRevision,
    ticketDefinitions: definitions.map((definition) => ({
      ticketId: definition.ticketId,
      definitionRevision: definition.definitionRevision,
      outcome: definition.outcome,
      provenanceRefs: [
        `ticket-definition:${definition.ticketId}:revision:${definition.definitionRevision}`,
        ...definition.provenanceRefs,
      ],
    })),
    directUnlocks: buildDirectUnlocks(definitions, snapshotRevision),
    currentCapabilityProjections: [],
    traceRecords: [],
  };
}

function buildDirectUnlocks(
  definitions: GitTicketDefinitionRevisionV0[],
  snapshotRevision: string,
): TicketReviewDirectUnlockFactV0[] {
  return definitions.flatMap((definition) =>
    definition.dependsOn.map((dependency) => ({
      relationRef: `tur-${sha256(serializeGitTicketStoreDocumentV0({
        snapshotRevision,
        prerequisiteTicketId: dependency.ticketId,
        dependentTicketId: definition.ticketId,
      }))}`,
      prerequisiteTicketId: dependency.ticketId,
      dependentTicketId: definition.ticketId,
      ...(dependency.rationale === undefined
        ? {}
        : { rationale: dependency.rationale }),
      provenanceRefs: [
        `ticket-definition:${definition.ticketId}:revision:${definition.definitionRevision}`,
      ],
    })),
  );
}

function validateCurrentGraph(
  definitions: GitTicketDefinitionRevisionV0[],
  fail: (
    message: string,
    details?: unknown,
  ) => GitTicketStoreErrorV0 = corrupt,
): void {
  const byId = new Map(
    definitions.map((definition) => [definition.ticketId, definition]),
  );
  for (const definition of definitions) {
    if (definition.parentId === definition.ticketId) {
      throw fail("Ticket cannot contain itself", {
        ticketId: definition.ticketId,
      });
    }
    if (definition.parentId !== null && !byId.has(definition.parentId)) {
      throw fail("Ticket parent is absent from the published generation", {
        ticketId: definition.ticketId,
        parentId: definition.parentId,
      });
    }
    assertSortedUnique(
      definition.dependsOn.map((dependency) => dependency.ticketId),
      `dependencies of ${definition.ticketId}`,
      fail,
    );
    for (const dependency of definition.dependsOn) {
      if (dependency.ticketId === definition.ticketId) {
        throw fail("Ticket cannot depend on itself", {
          ticketId: definition.ticketId,
        });
      }
      if (!byId.has(dependency.ticketId)) {
        throw fail(
          "Ticket dependency is absent from the published generation",
          {
            ticketId: definition.ticketId,
            dependencyTicketId: dependency.ticketId,
          },
        );
      }
    }
  }
  const relationCount = definitions.reduce(
    (total, definition) => total + definition.dependsOn.length,
    0,
  );
  if (relationCount > TICKET_REVIEW_MAX_RELATIONS) {
    throw fail("Ticket generation exceeds the direct-unlock capacity", {
      relationCount,
      maximum: TICKET_REVIEW_MAX_RELATIONS,
    });
  }
  assertAcyclic(
    definitions.map((definition) => ({
      id: definition.ticketId,
      next: definition.parentId === null ? [] : [definition.parentId],
    })),
    "Ticket containment",
    fail,
  );
  assertAcyclic(
    definitions.map((definition) => ({
      id: definition.ticketId,
      next: definition.dependsOn.map((dependency) => dependency.ticketId),
    })),
    "Ticket dependency",
    fail,
  );
}

function assertAcyclic(
  rows: Array<{ id: string; next: string[] }>,
  label: string,
  fail: (
    message: string,
    details?: unknown,
  ) => GitTicketStoreErrorV0 = corrupt,
): void {
  const byId = new Map(rows.map((row) => [row.id, row.next]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw fail(`${label} graph contains a cycle`, { ticketId: id });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of byId.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const row of rows) visit(row.id);
}

function assertSortedUnique(
  values: string[],
  label: string,
  fail: (
    message: string,
    details?: unknown,
  ) => GitTicketStoreErrorV0 = corrupt,
): void {
  const sorted = values.slice().sort(compare);
  if (values.some((value, index) => value !== sorted[index])
    || new Set(values).size !== values.length) {
    throw fail(`${label} must be sorted and unique`);
  }
}

interface GitTicketWriterLockV0 {
  token: string;
  bytes: string;
}

interface GitTicketPublisherControlV0 {
  gitAdminRoot: string;
  root: string;
}

type InspectedGitTicketWriterLockV0 =
  | (GitTicketWriterLockV0 & {
    phase: "owner" | "releasing";
    value: z.infer<typeof gitTicketWriterLockV0Schema>;
  })
  | {
    phase: "empty";
    token: null;
    bytes: null;
    value: null;
  };

function parsePublishValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  field: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw publishInvalid("Ticket publish input violates its schema", {
    field,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function assertPublishSortedUnique(
  values: string[],
  label: string,
): void {
  assertSortedUnique(values, label, publishInvalid);
}

export function validateGitTicketRevisionTransitionV0(
  currentDefinitions: GitTicketDefinitionRevisionV0[],
  candidateDefinitions: GitTicketDefinitionRevisionV0[],
): void {
  const currentById = new Map(
    currentDefinitions.map((definition) => [
      definition.ticketId,
      definition,
    ]),
  );
  const candidateById = new Map(
    candidateDefinitions.map((definition) => [
      definition.ticketId,
      definition,
    ]),
  );
  for (const current of currentDefinitions) {
    if (!candidateById.has(current.ticketId)) {
      throw publishInvalid(
        "V0 publication cannot omit a currently published Ticket",
        { ticketId: current.ticketId },
      );
    }
  }
  for (const candidate of candidateDefinitions) {
    const current = currentById.get(candidate.ticketId);
    if (current === undefined) {
      if (candidate.definitionRevision !== 1) {
        throw revisionConflict(
          "A new Ticket must begin at definition revision 1",
          {
            ticketId: candidate.ticketId,
            candidateRevision: candidate.definitionRevision,
          },
        );
      }
      continue;
    }
    const currentBytes = serializeGitTicketStoreDocumentV0(current);
    const candidateBytes = serializeGitTicketStoreDocumentV0(candidate);
    if (currentBytes === candidateBytes) continue;
    if (serializeGitTicketStoreDocumentV0(current.created)
      !== serializeGitTicketStoreDocumentV0(candidate.created)) {
      throw revisionConflict(
        "An existing Ticket must preserve its creation provenance",
        { ticketId: candidate.ticketId },
      );
    }
    if (candidate.definitionRevision !== current.definitionRevision + 1) {
      throw revisionConflict(
        "A changed Ticket definition must advance exactly one revision",
        {
          ticketId: candidate.ticketId,
          currentRevision: current.definitionRevision,
          candidateRevision: candidate.definitionRevision,
        },
      );
    }
    const currentContent = definitionContentWithoutRevision(current);
    const candidateContent = definitionContentWithoutRevision(candidate);
    if (serializeGitTicketStoreDocumentV0(currentContent)
      === serializeGitTicketStoreDocumentV0(candidateContent)) {
      throw revisionConflict(
        "An unchanged Ticket definition must reuse its current revision",
        {
          ticketId: candidate.ticketId,
          currentRevision: current.definitionRevision,
          candidateRevision: candidate.definitionRevision,
        },
      );
    }
  }
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(serializeGitTicketStoreDocumentV0(value)) as T;
}

function definitionContentWithoutRevision(
  definition: GitTicketDefinitionRevisionV0,
): Omit<GitTicketDefinitionRevisionV0, "definitionRevision"> {
  const {
    definitionRevision: _definitionRevision,
    ...content
  } = definition;
  return content;
}

function ensurePublisherControlRoot(
  worktreeRoot: string,
): GitTicketPublisherControlV0 {
  let rawGitAdminRoot: string;
  let rawControlRoot: string;
  try {
    rawGitAdminRoot = GitFacade.gitPathAt(worktreeRoot, ".");
    rawControlRoot = GitFacade.gitPathAt(
      worktreeRoot,
      WRITER_CONTROL_RELATIVE_PATH,
    );
  } catch (error) {
    throw corrupt("Ticket publisher Git administrative path is unavailable", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const adminStat = fs.lstatSync(rawGitAdminRoot, { throwIfNoEntry: false });
  if (
    adminStat === undefined
    || adminStat.isSymbolicLink()
    || !adminStat.isDirectory()
  ) {
    throw corrupt(
      "Ticket publisher Git administrative root must be a real directory",
    );
  }
  const gitAdminRoot = fs.realpathSync(rawGitAdminRoot);
  assertLexicallyContained(
    gitAdminRoot,
    rawControlRoot,
    "Ticket publisher control root",
  );
  ensureSafeDirectoryPath(
    gitAdminRoot,
    rawControlRoot,
    "Ticket publisher control root",
  );
  return {
    gitAdminRoot,
    root: fs.realpathSync(rawControlRoot),
  };
}

function ensureSafeDirectoryPath(
  worktreeRoot: string,
  target: string,
  label: string,
): void {
  assertLexicallyContained(worktreeRoot, target, label);
  const relative = path.relative(worktreeRoot, target);
  if (relative === "" || relative === ".") return;
  let current = worktreeRoot;
  for (const segment of relative.split(path.sep)) {
    const parent = current;
    current = path.join(current, segment);
    let created = false;
    try {
      fs.mkdirSync(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw corrupt("Ticket store directory could not be created", {
          file: label,
          cause: nodeErrorCode(error),
        });
      }
    }
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw corrupt("Ticket store path contains an unsafe directory", {
        file: label,
      });
    }
    assertContained(worktreeRoot, fs.realpathSync(current), label);
    if (created) fsyncDirectory(parent, worktreeRoot, label);
  }
}

function acquireWriterLock(
  control: GitTicketPublisherControlV0,
  fence?: GitTicketPublicationFenceV0,
): GitTicketWriterLockV0 {
  const lock = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    format: WRITER_LOCK_FORMAT,
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
    ...(fence === undefined ? {} : { fence }),
  };
  const bytes = serializeGitTicketStoreDocumentV0(lock);
  const ownerFile = writerLockMemberName("owner", lock.token);
  const stageRoot = path.join(
    control.root,
    `${WRITER_LOCK_STAGE_PREFIX}${lock.token}`,
  );
  const stagedOwner = path.join(stageRoot, ownerFile);
  const lockRoot = path.join(control.root, WRITER_LOCK_DIRECTORY);
  let descriptor: number | null = null;
  let installed = false;
  try {
    fs.mkdirSync(stageRoot, { mode: 0o700 });
    descriptor = fs.openSync(
      stagedOwner,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(
      stageRoot,
      control.root,
      "staged Ticket writer lock",
    );
    try {
      fs.renameSync(stageRoot, lockRoot);
    } catch (error) {
      if (isNodeError(error, "EEXIST")
        || isNodeError(error, "ENOTEMPTY")) {
        throw writerBusy(
          "Another Ticket generation publisher owns the worktree lock",
          { file: writerLockDisplayPath() },
        );
      }
      throw error;
    }
    installed = true;
    fsyncDirectory(
      control.root,
      control.gitAdminRoot,
      "Ticket writer lock control root",
    );
    const inspected = inspectWriterLock(control);
    if (
      inspected === null
      || inspected.phase !== "owner"
      || inspected.token !== lock.token
      || inspected.bytes !== bytes
    ) {
      throw corrupt(
        "Ticket writer lock changed while it was being installed",
      );
    }
    return { token: lock.token, bytes };
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary failure.
      }
    }
    if (!installed) {
      removeOwnedWriterLockStage(control, stageRoot, ownerFile);
    }
    if (error instanceof GitTicketStoreErrorV0) throw error;
    throw corrupt("Ticket writer lock could not be acquired durably", {
      cause: nodeErrorCode(error),
    });
  }
}

function acquireOrAdoptFencedWriterLock(
  control: GitTicketPublisherControlV0,
  fence: GitTicketPublicationFenceV0,
): GitTicketWriterLockV0 {
  try {
    return acquireWriterLock(control, fence);
  } catch (error) {
    if (!(error instanceof GitTicketStoreErrorV0)
      || error.code !== "ticket_store_writer_busy") {
      throw error;
    }
  }

  let inspected: InspectedGitTicketWriterLockV0 | null;
  try {
    inspected = inspectWriterLock(control);
    if (inspected === null || inspected.phase !== "owner") {
      throw new Error("fenced writer lock disappeared during adoption");
    }
  } catch {
    throw writerBusy(
      "Existing Ticket writer lock is not an adoptable fenced publication",
      { file: writerLockDisplayPath() },
    );
  }
  if (inspected.value.fence === undefined
    || serializeGitTicketStoreDocumentV0(inspected.value.fence)
      !== serializeGitTicketStoreDocumentV0(fence)) {
    throw writerBusy(
      "Another Ticket application intent owns the worktree fence",
      {
        file: writerLockDisplayPath(),
        applicationIntentId: fence.applicationIntentId,
      },
    );
  }
  return { token: inspected.token, bytes: inspected.bytes };
}

function assertWriterLockHeld(
  control: GitTicketPublisherControlV0,
  lock: GitTicketWriterLockV0,
): void {
  try {
    const inspected = inspectWriterLock(control);
    if (
      inspected === null
      || inspected.phase !== "owner"
      || inspected.bytes !== lock.bytes
      || inspected.token !== lock.token
    ) {
      throw new Error("writer lock identity changed");
    }
  } catch {
    throw writerBusy(
      "Fenced Ticket publisher no longer owns the exact writer lock",
      { file: writerLockDisplayPath() },
    );
  }
}

function releaseWriterLock(
  control: GitTicketPublisherControlV0,
  lock: GitTicketWriterLockV0,
): boolean {
  try {
    const inspected = inspectWriterLock(control);
    if (inspected === null) {
      return true;
    }
    if (inspected.phase === "empty") {
      return removeEmptyWriterLockDirectory(control);
    }
    if (
      inspected.bytes !== lock.bytes
      || inspected.token !== lock.token
    ) {
      // Another valid owner can exist only after this owner ceased to be the
      // canonical directory. Never touch the successor.
      return true;
    }
    if (inspected.phase === "owner") {
      const lockRoot = path.join(control.root, WRITER_LOCK_DIRECTORY);
      const ownerPath = path.join(
        lockRoot,
        writerLockMemberName("owner", lock.token),
      );
      const releasingPath = path.join(
        lockRoot,
        writerLockMemberName("releasing", lock.token),
      );
      try {
        fs.renameSync(ownerPath, releasingPath);
        fsyncDirectory(
          lockRoot,
          control.root,
          "claimed Ticket writer lock release",
        );
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        const raced = inspectWriterLock(control);
        if (
          raced !== null
          && raced.phase !== "empty"
          && raced.bytes === lock.bytes
          && raced.token === lock.token
          && raced.phase === "releasing"
        ) {
          return removeReleasingWriterLockMember(control, lock);
        }
        return raced === null || raced.phase === "empty"
          ? removeEmptyWriterLockDirectory(control)
          : true;
      }
    }
    return removeReleasingWriterLockMember(control, lock);
  } catch {
    // The canonical pointer, not cleanup, defines publication success. Any
    // state not proven to be this exact owner is retained and fails closed.
    return false;
  }
}

function inspectWriterLock(
  control: GitTicketPublisherControlV0,
): InspectedGitTicketWriterLockV0 | null {
  const lockRoot = path.join(control.root, WRITER_LOCK_DIRECTORY);
  assertLexicallyContained(
    control.root,
    lockRoot,
    "Ticket writer lock directory",
  );
  const lockStat = fs.lstatSync(lockRoot, { throwIfNoEntry: false });
  if (lockStat === undefined) return null;
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw corrupt("Ticket writer lock must be a real directory", {
      file: writerLockDisplayPath(),
    });
  }
  assertContained(
    control.root,
    fs.realpathSync(lockRoot),
    "Ticket writer lock directory",
  );
  const entries = fs.readdirSync(lockRoot, { withFileTypes: true });
  if (entries.length === 0) {
    return {
      phase: "empty",
      token: null,
      bytes: null,
      value: null,
    };
  }
  if (entries.length !== 1) {
    throw corrupt("Ticket writer lock directory has an invalid shape", {
      file: writerLockDisplayPath(),
    });
  }
  const entry = entries[0]!;
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw corrupt("Ticket writer lock owner must be a regular file", {
      file: writerLockDisplayPath(),
    });
  }
  const phase = entry.name.startsWith(WRITER_LOCK_OWNER_PREFIX)
    ? "owner" as const
    : entry.name.startsWith(WRITER_LOCK_RELEASING_PREFIX)
      ? "releasing" as const
      : null;
  if (phase === null || !entry.name.endsWith(WRITER_LOCK_FILE_SUFFIX)) {
    throw corrupt("Ticket writer lock owner has an invalid name", {
      file: writerLockDisplayPath(),
    });
  }
  const ownerPath = path.join(lockRoot, entry.name);
  const bytes = readOptionalBytes(
    ownerPath,
    control.root,
    MAX_PROTOCOL_BYTES,
    `${WRITER_LOCK_DIRECTORY}/${entry.name}`,
  );
  if (bytes === null) {
    throw corrupt("Ticket writer lock owner disappeared during inspection", {
      file: writerLockDisplayPath(),
    });
  }
  const result = gitTicketWriterLockV0Schema.safeParse(
    parseCanonicalBytes(bytes, `${WRITER_LOCK_DIRECTORY}/${entry.name}`),
  );
  if (!result.success) {
    throw corrupt("Ticket writer lock violates its schema", {
      file: writerLockDisplayPath(),
    });
  }
  if (entry.name !== writerLockMemberName(phase, result.data.token)) {
    throw corrupt("Ticket writer lock filename does not bind its token", {
      file: writerLockDisplayPath(),
    });
  }
  return {
    token: result.data.token,
    bytes,
    phase,
    value: result.data,
  };
}

function writerLockMemberName(
  phase: "owner" | "releasing",
  token: string,
): string {
  const prefix = phase === "owner"
    ? WRITER_LOCK_OWNER_PREFIX
    : WRITER_LOCK_RELEASING_PREFIX;
  return `${prefix}${token}${WRITER_LOCK_FILE_SUFFIX}`;
}

function writerLockDisplayPath(): string {
  return path.join(
    "$GIT_DIR",
    WRITER_CONTROL_RELATIVE_PATH,
    WRITER_LOCK_DIRECTORY,
  );
}

function removeReleasingWriterLockMember(
  control: GitTicketPublisherControlV0,
  lock: GitTicketWriterLockV0,
): boolean {
  const lockRoot = path.join(control.root, WRITER_LOCK_DIRECTORY);
  const releasingPath = path.join(
    lockRoot,
    writerLockMemberName("releasing", lock.token),
  );
  try {
    fs.unlinkSync(releasingPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return false;
  }
  try {
    fsyncDirectory(
      lockRoot,
      control.root,
      "released Ticket writer lock directory",
    );
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) return false;
  }
  return removeEmptyWriterLockDirectory(control);
}

function removeEmptyWriterLockDirectory(
  control: GitTicketPublisherControlV0,
): boolean {
  const lockRoot = path.join(control.root, WRITER_LOCK_DIRECTORY);
  try {
    fs.rmdirSync(lockRoot);
    fsyncDirectory(
      control.root,
      control.gitAdminRoot,
      "Ticket writer lock release completion",
    );
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    if (isNodeError(error, "EEXIST")
      || isNodeError(error, "ENOTEMPTY")) {
      // A successor installed its complete, nonempty lock directory between
      // the token-specific unlink and this rmdir. Prove that shape before
      // treating the old owner's release as complete; malformed state remains
      // fail-closed.
      try {
        const successor = inspectWriterLock(control);
        return successor === null || successor.phase !== "empty";
      } catch {
        return false;
      }
    }
    return false;
  }
}

function removeOwnedWriterLockStage(
  control: GitTicketPublisherControlV0,
  stageRoot: string,
  ownerFile: string,
): void {
  try {
    assertLexicallyContained(
      control.root,
      stageRoot,
      "staged Ticket writer lock",
    );
    const stat = fs.lstatSync(stageRoot, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
      return;
    }
    assertContained(
      control.root,
      fs.realpathSync(stageRoot),
      "staged Ticket writer lock",
    );
    const entries = fs.readdirSync(stageRoot, { withFileTypes: true });
    if (
      entries.length === 1
      && entries[0]!.name === ownerFile
      && !entries[0]!.isSymbolicLink()
      && entries[0]!.isFile()
    ) {
      safeUnlinkKnownPath(path.join(stageRoot, ownerFile));
    }
    if (fs.readdirSync(stageRoot).length === 0) {
      fs.rmdirSync(stageRoot);
      fsyncDirectory(
        control.root,
        control.gitAdminRoot,
        "Ticket writer lock staging cleanup",
      );
    }
  } catch {
    // Unknown stage debris is retained rather than cleaned unsafely.
  }
}

function fsyncPublishedGeneration(
  worktreeRoot: string,
  prepared: PreparedGitTicketGenerationV0,
): void {
  const store = resolveStore(worktreeRoot);
  if (store === null || store.protocol.storeId !== prepared.storeId) {
    throw corrupt(
      "Fenced Ticket candidate is not visible in its expected store",
      { candidateSnapshotId: prepared.generation.snapshotId },
    );
  }
  const current = loadLatestGeneration(store);
  if (current?.snapshotId !== prepared.generation.snapshotId) {
    throw commitUncertain(
      "Fenced Ticket candidate is not the current publication head",
      {
        actualSnapshotId: current?.snapshotId ?? null,
        candidateSnapshotId: prepared.generation.snapshotId,
      },
    );
  }

  const protocol: GitTicketStoreProtocolV0 = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    format: GIT_TICKET_STORE_FORMAT,
    storeId: prepared.storeId,
    indexing: "stable-ticket-revision-paths",
    integrity: "immutable-generations-pointer-v1",
    projector: "ticket-review-v0",
  };
  fsyncExactPublishedDocument(
    store,
    PROTOCOL_FILE,
    serializeGitTicketStoreDocumentV0(protocol),
    MAX_PROTOCOL_BYTES,
  );
  for (const revisionArtifact of prepared.revisions) {
    fsyncExactPublishedDocument(
      store,
      revisionArtifact.file,
      revisionArtifact.bytes,
      MAX_TICKET_REVISION_BYTES,
    );
  }
  fsyncExactPublishedDocument(
    store,
    prepared.generationFile,
    prepared.generationBytes,
    MAX_GENERATION_BYTES,
  );
  fsyncExactPublishedDocument(
    store,
    LATEST_FILE,
    prepared.latestBytes,
    MAX_LATEST_BYTES,
  );
  fsyncDirectory(
    store.storeRoot,
    worktreeRoot,
    "fenced Ticket store root",
  );
  fsyncDirectory(
    path.dirname(store.storeRoot),
    worktreeRoot,
    "fenced Ticket store parent",
  );
}

function fsyncExactPublishedDocument(
  store: ResolvedStore,
  relative: string,
  expectedBytes: string,
  maximumBytes: number,
): void {
  const absolute = path.join(store.storeRoot, relative);
  const actual = readOptionalBytes(
    absolute,
    store.worktreeRoot,
    maximumBytes,
    relative,
  );
  if (actual !== expectedBytes) {
    throw corrupt(
      "Fenced Ticket store member does not match the exact candidate",
      { file: relative },
    );
  }
  fsyncExistingRegularFile(
    absolute,
    store.worktreeRoot,
    maximumBytes,
    relative,
  );
  fsyncDirectory(
    path.dirname(absolute),
    store.worktreeRoot,
    relative,
  );
}

function installInitialStore(
  worktreeRoot: string,
  finalStoreRoot: string,
  prepared: PreparedGitTicketGenerationV0,
  commitState: GitTicketPublicationCommitStateV0,
): void {
  const storeParent = path.dirname(finalStoreRoot);
  ensureSafeDirectoryPath(
    worktreeRoot,
    storeParent,
    "Ticket store parent",
  );
  const stageRoot = path.join(
    storeParent,
    `.ticket-store-stage-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  fsyncDirectory(storeParent, worktreeRoot, "ticket store staging root");
  const protocol: GitTicketStoreProtocolV0 = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    format: GIT_TICKET_STORE_FORMAT,
    storeId: prepared.storeId,
    indexing: "stable-ticket-revision-paths",
    integrity: "immutable-generations-pointer-v1",
    projector: "ticket-review-v0",
  };
  const stagedStore: ResolvedStore = {
    worktreeRoot,
    storeRoot: stageRoot,
    protocol,
  };
  let installed = false;
  try {
    installImmutableDocument(
      stagedStore,
      PROTOCOL_FILE,
      serializeGitTicketStoreDocumentV0(protocol),
      MAX_PROTOCOL_BYTES,
      commitState,
    );
    for (const revisionArtifact of prepared.revisions) {
      installImmutableDocument(
        stagedStore,
        revisionArtifact.file,
        revisionArtifact.bytes,
        MAX_TICKET_REVISION_BYTES,
        commitState,
      );
    }
    installImmutableDocument(
      stagedStore,
      prepared.generationFile,
      prepared.generationBytes,
      MAX_GENERATION_BYTES,
      commitState,
    );
    installImmutableDocument(
      stagedStore,
      LATEST_FILE,
      prepared.latestBytes,
      MAX_LATEST_BYTES,
      commitState,
    );
    fsyncDirectory(stageRoot, worktreeRoot, "ticket store staging root");
    try {
      fs.renameSync(stageRoot, finalStoreRoot);
    } catch (error) {
      if (isNodeError(error, "EEXIST")
        || isNodeError(error, "ENOTEMPTY")) {
        throw casConflict(
          "Ticket store appeared during initial publication",
          { actualSnapshotId: null },
        );
      }
      throw error;
    }
    installed = true;
    commitState.canonicalMemberInstalled = true;
    commitState.visibilityCommitted = true;
    try {
      fsyncDirectory(storeParent, worktreeRoot, "ticket store root");
    } catch (error) {
      throw commitUncertain(
        "Initial Ticket store became visible but its parent sync failed",
        {
          previousSnapshotId: null,
          candidateSnapshotId: prepared.generation.snapshotId,
          cause: nodeErrorCode(error),
        },
      );
    }
  } catch (error) {
    if (error instanceof GitTicketStoreErrorV0) throw error;
    throw corrupt("Initial Ticket store could not be installed atomically", {
      cause: nodeErrorCode(error),
    });
  } finally {
    if (!installed) removeOwnedStageDirectory(stageRoot, worktreeRoot);
  }
}

function installImmutableDocument(
  store: ResolvedStore,
  relative: string,
  bytes: string,
  maximumBytes: number,
  commitState?: GitTicketPublicationCommitStateV0,
  trackCanonicalInstall = false,
): void {
  const byteLength = Buffer.byteLength(bytes, "utf8");
  if (byteLength > maximumBytes) {
    throw publishInvalid("Prepared Ticket store member exceeds its capacity", {
      file: relative,
      size: byteLength,
      maximumBytes,
    });
  }
  const absolute = path.join(store.storeRoot, relative);
  assertLexicallyContained(store.storeRoot, absolute, relative);
  const parent = path.dirname(absolute);
  ensureSafeDirectoryPath(store.worktreeRoot, parent, relative);
  const existing = readOptionalBytes(
    absolute,
    store.worktreeRoot,
    maximumBytes,
    relative,
  );
  if (existing !== null) {
    if (existing === bytes) {
      fsyncExistingRegularFile(
        absolute,
        store.worktreeRoot,
        maximumBytes,
        relative,
      );
      fsyncDirectory(parent, store.worktreeRoot, relative);
      return;
    }
    throw revisionConflict(
      "An immutable Ticket store path already contains different bytes",
      { file: relative },
    );
  }
  const temporary = path.join(
    parent,
    `.install-${path.basename(relative)}-${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  let linked = false;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    try {
      fs.linkSync(temporary, absolute);
      linked = true;
      if (trackCanonicalInstall && commitState !== undefined) {
        commitState.canonicalMemberInstalled = true;
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const raced = readOptionalBytes(
        absolute,
        store.worktreeRoot,
        maximumBytes,
        relative,
      );
      if (raced !== bytes) {
        throw revisionConflict(
          "An immutable Ticket store path raced with different bytes",
          { file: relative },
        );
      }
      fsyncExistingRegularFile(
        absolute,
        store.worktreeRoot,
        maximumBytes,
        relative,
      );
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(parent, store.worktreeRoot, relative);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary failure.
      }
    }
    safeUnlinkKnownPath(temporary);
    if (error instanceof GitTicketStoreErrorV0) throw error;
    throw corrupt("Immutable Ticket store member could not be installed", {
      file: relative,
      linked,
      cause: nodeErrorCode(error),
    });
  }
}

function replaceLatestPointer(
  store: ResolvedStore,
  bytes: string,
  commitState: GitTicketPublicationCommitStateV0,
  publication: {
    previousSnapshotId: string | null;
    candidateSnapshotId: string;
  },
): void {
  const latestPath = path.join(store.storeRoot, LATEST_FILE);
  const temporary = path.join(
    store.storeRoot,
    `.latest-${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    writeAll(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, latestPath);
    commitState.visibilityCommitted = true;
    try {
      fsyncDirectory(store.storeRoot, store.worktreeRoot, LATEST_FILE);
    } catch (error) {
      throw commitUncertain(
        "Ticket latest pointer became visible but its directory sync failed",
        {
          file: LATEST_FILE,
          previousSnapshotId: publication.previousSnapshotId,
          candidateSnapshotId: publication.candidateSnapshotId,
          cause: nodeErrorCode(error),
        },
      );
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary failure.
      }
    }
    safeUnlinkKnownPath(temporary);
    if (error instanceof GitTicketStoreErrorV0) throw error;
    throw corrupt("Ticket latest pointer could not be replaced atomically", {
      cause: nodeErrorCode(error),
    });
  }
}

function fsyncExistingRegularFile(
  absolute: string,
  worktreeRoot: string,
  maximumBytes: number,
  label: string,
): void {
  assertLexicallyContained(worktreeRoot, absolute, label);
  assertExistingParentsAreReal(worktreeRoot, path.dirname(absolute), label);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw corrupt("Existing Ticket store member cannot be opened safely", {
      file: label,
      cause: nodeErrorCode(error),
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw corrupt("Existing Ticket store member must be one regular file", {
        file: label,
      });
    }
    if (stat.size > maximumBytes) {
      throw corrupt("Existing Ticket store member exceeds its byte capacity", {
        file: label,
        size: stat.size,
        maximumBytes,
      });
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof GitTicketStoreErrorV0) throw error;
    throw corrupt("Existing Ticket store member could not be synced", {
      file: label,
      cause: nodeErrorCode(error),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: string): void {
  const buffer = Buffer.from(bytes, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (count <= 0) {
      throw new Error("Ticket store write made no forward progress");
    }
    offset += count;
  }
}

function fsyncDirectory(
  directory: string,
  worktreeRoot: string,
  label: string,
): void {
  assertLexicallyContained(worktreeRoot, directory, label);
  assertExistingParentsAreReal(worktreeRoot, directory, label);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    throw corrupt("Ticket store directory cannot be opened safely", {
      file: label,
      cause: nodeErrorCode(error),
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory()) {
      throw corrupt("Ticket store fsync target is not a directory", {
        file: label,
      });
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeOwnedStageDirectory(
  stageRoot: string,
  worktreeRoot: string,
): void {
  try {
    assertLexicallyContained(worktreeRoot, stageRoot, "ticket store staging");
    const stat = fs.lstatSync(stageRoot, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    assertContained(
      worktreeRoot,
      fs.realpathSync(stageRoot),
      "ticket store staging",
    );
    fs.rmSync(stageRoot, { recursive: true, force: true });
  } catch {
    // Unknown staging debris is retained rather than cleaned unsafely.
  }
}

function safeUnlinkKnownPath(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      // Cleanup is best effort; the primary operation reports its own failure.
    }
  }
}

function parseDocument<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw corrupt("Ticket store document violates its schema", {
    file: label,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function readOptionalCanonicalDocument(
  absolute: string,
  worktreeRoot: string,
  maximumBytes: number,
  label: string,
  allowAtomicReplacement = false,
): unknown | null {
  const bytes = readOptionalBytes(
    absolute,
    worktreeRoot,
    maximumBytes,
    label,
    allowAtomicReplacement,
  );
  return bytes === null ? null : parseCanonicalBytes(bytes, label);
}

function readRequiredCanonicalBytes(
  absolute: string,
  worktreeRoot: string,
  maximumBytes: number,
  label: string,
): string {
  const bytes = readOptionalBytes(
    absolute,
    worktreeRoot,
    maximumBytes,
    label,
  );
  if (bytes === null) {
    throw corrupt("Ticket generation references a missing file", {
      file: label,
    });
  }
  parseCanonicalBytes(bytes, label);
  return bytes;
}

function readOptionalBytes(
  absolute: string,
  worktreeRoot: string,
  maximumBytes: number,
  label: string,
  allowAtomicReplacement = false,
): string | null {
  assertLexicallyContained(worktreeRoot, absolute, label);
  assertExistingParentsAreReal(worktreeRoot, path.dirname(absolute), label);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW
        | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw corrupt("Ticket store file cannot be opened safely", {
      file: label,
      cause: nodeErrorCode(error),
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const linkCountIsSafe = stat.nlink === 1
      || (allowAtomicReplacement && stat.nlink === 0);
    if (!stat.isFile() || !linkCountIsSafe) {
      throw corrupt("Ticket store member must be one regular file", {
        file: label,
      });
    }
    if (stat.size > maximumBytes) {
      throw corrupt("Ticket store member exceeds its byte capacity", {
        file: label,
        size: stat.size,
        maximumBytes,
      });
    }
    const real = fs.realpathSync(absolute);
    assertContained(worktreeRoot, real, label);
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        stat.size - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) {
      throw corrupt("Ticket store member changed while it was being read", {
        file: label,
        expectedBytes: stat.size,
        actualBytes: offset,
      });
    }
    return buffer.toString("utf8");
  } catch (error) {
    if (error instanceof GitTicketStoreErrorV0) throw error;
    throw corrupt("Ticket store member could not be read", {
      file: label,
      cause: nodeErrorCode(error),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseCanonicalBytes(bytes: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw corrupt("Ticket store member is not valid canonical JSON", {
      file: label,
    });
  }
  if (serializeGitTicketStoreDocumentV0(value) !== bytes) {
    throw corrupt("Ticket store member bytes are not canonical", {
      file: label,
    });
  }
  return value;
}

function assertExistingParentsAreReal(
  worktreeRoot: string,
  targetParent: string,
  label: string,
): void {
  const relative = path.relative(worktreeRoot, targetParent);
  if (relative === "" || relative === ".") return;
  const segments = relative.split(path.sep);
  let current = worktreeRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw corrupt("Ticket store path contains an unsafe parent", {
        file: label,
      });
    }
  }
}

function assertLexicallyContained(
  root: string,
  candidate: string,
  label: string,
): void {
  const relative = path.relative(root, path.resolve(candidate));
  if (relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw corrupt("Ticket store path escapes its worktree", { file: label });
  }
}

function assertContained(
  root: string,
  candidate: string,
  label: string,
): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw corrupt("Ticket store member resolves outside its worktree", {
      file: label,
    });
  }
}

function corrupt(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_corrupt",
    message,
    details,
  );
}

function scopeMismatch(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_scope_mismatch",
    message,
    details,
  );
}

function publishInvalid(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_publish_invalid",
    message,
    details,
  );
}

function casConflict(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_cas_conflict",
    message,
    details,
  );
}

function commitUncertain(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_commit_uncertain",
    message,
    details,
  );
}

function revisionConflict(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_revision_conflict",
    message,
    details,
  );
}

function writerBusy(
  message: string,
  details: unknown = null,
): GitTicketStoreErrorV0 {
  return new GitTicketStoreErrorV0(
    "ticket_store_writer_busy",
    message,
    details,
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function nodeErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "unknown";
}
