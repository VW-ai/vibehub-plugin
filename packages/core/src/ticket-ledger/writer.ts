import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GitFacade } from "../git-facade.js";
import {
  assertRepositoryPathExcludesGitAdministration,
} from "../ticket-context-compiler.js";
import {
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_PATCH_CHANGES,
  TICKET_LEDGER_RELATIVE_PATH,
  TICKET_LEDGER_SCHEMA_VERSION,
  TICKET_LEDGER_TICKET_MAX_BYTES,
  TicketLedgerError,
  ticketDecisionDocumentSchema,
  ticketDecisionAttestationDocumentPayloadSchema,
  ticketContextBindingDocumentSchema,
  ticketEvidenceDocumentSchema,
  ticketOutcomeDocumentSchema,
  ticketDocumentSchema,
  ticketReviewSubjectSchema,
  type TicketDecisionDocument,
  type TicketDecisionDocumentPayload,
  type TicketDecisionAttestationDocument,
  type TicketDecisionAttestationDocumentPayload,
  type TicketContextBindingDocument,
  type TicketContextBindingDocumentPayload,
  type TicketEvidenceDocument,
  type TicketEvidenceDocumentPayload,
  type TicketOutcomeDocument,
  type TicketOutcomeDocumentPayload,
  type TicketDocument,
  type TicketLedgerPatchChange,
  type TicketLedgerPatchRequest,
  type TicketLedgerPatchResult,
  type TicketLedgerPatchSource,
  type TicketLedgerPatchTicketResult,
  type TicketLedgerSnapshot,
  type TicketReviewDocument,
  type TicketReviewDocumentPayload,
  type TicketReviewSubject,
} from "./contract.js";
import {
  canonicalTicketLedgerValue,
  currentSuccessfulOutcomeForTicket,
  createTicketDecisionDocument,
  createTicketDecisionAttestationDocument,
  createTicketContextBindingDocument,
  createTicketEvidenceDocument,
  createTicketOutcomeDocument,
  createTicketReviewDocument,
  encodeTicketDecisionDocument,
  encodeTicketDecisionAttestationDocument,
  encodeTicketContextBindingDocument,
  encodeTicketEvidenceDocument,
  encodeTicketOutcomeDocument,
  encodeTicketDocument,
  encodeTicketReviewDocument,
  normalizeTicketDocument,
  ticketDecisionDocumentPath,
  ticketDecisionAttestationDocumentPath,
  ticketContextBindingDocumentPath,
  ticketContextBindingDocumentDigest,
  ticketAcceptanceCriterionDigest,
  ticketEvidenceDocumentPath,
  ticketEvidenceDocumentDigest,
  ticketOutcomeDocumentPath,
  ticketOutcomeDocumentDigest,
  ticketDecisionDocumentDigest,
  ticketDocumentPath,
  ticketLedgerDocumentMaxBytes,
  ticketRelationId,
  ticketReviewDocumentPath,
  ticketRevision,
  validateTicketLedger,
} from "./codec.js";
import { readTicketLedgerFileBounded } from "./file-io.js";
import { loadTicketLedgerFromWorktree } from "./reader.js";

const sha256RefSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const patchRequestSchema = z.object({
  expectedSource: z.object({
    sourceToken: z.string().regex(/^tls-[0-9a-f]{64}$/u),
    worktreeIdentity: z.string().regex(/^worktree-[0-9a-f]{64}$/u),
    resolvedCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    graphDigest: sha256RefSchema,
    semanticLedgerDigest: sha256RefSchema,
  }).strict(),
  changes: z.array(z.discriminatedUnion("op", [
    z.object({
      op: z.literal("put"),
      ticketId: z.string().min(1).max(96),
      expectedTicketRevision: sha256RefSchema.nullable(),
      document: ticketDocumentSchema,
    }).strict(),
    z.object({
      op: z.literal("delete"),
      ticketId: z.string().min(1).max(96),
      expectedTicketRevision: sha256RefSchema,
    }).strict(),
  ])).min(1).max(TICKET_LEDGER_MAX_PATCH_CHANGES),
}).strict();

interface PreparedChange {
  request: TicketLedgerPatchChange;
  documentPath: string;
  beforeDocument: TicketDocument | null;
  afterDocument: TicketDocument | null;
  beforeRevision: string | null;
  afterRevision: string | null;
  changed: boolean;
  replacementBytes: Buffer | null;
}

interface PhysicalFile {
  revision: string;
  bytes: Buffer;
  mode: number;
}

interface InstalledChange {
  prepared: PreparedChange;
  beforePhysical: PhysicalFile | null;
  candidatePhysicalRevision: string | null;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");
const TICKET_LEDGER_REFERENCED_FILE_MAX_BYTES = 4 * 1024 * 1024;

const repositoryAbsolutePath = (
  worktreeRoot: string,
  repositoryPath: string,
): string => {
  if (
    path.posix.normalize(repositoryPath) !== repositoryPath
    || repositoryPath.startsWith("/")
    || repositoryPath.endsWith("/")
    || repositoryPath.includes("\\")
    || repositoryPath.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TicketLedgerError(
      "invalid_path",
      `Repository path is not one normalized relative POSIX path: ${repositoryPath}`,
      { repositoryPath },
    );
  }
  let current = worktreeRoot;
  for (const segment of repositoryPath.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (cause) {
      throw new TicketLedgerError(
        "invalid_document",
        `Repository path does not resolve: ${repositoryPath}`,
        { repositoryPath },
        { cause },
      );
    }
    if (stat.isSymbolicLink()) {
      throw new TicketLedgerError(
        "symlink",
        `Repository path cannot traverse a symlink: ${repositoryPath}`,
        { repositoryPath },
      );
    }
  }
  return current;
};

const sha256Ref = (value: string): string => `sha256:${value}`;
const rawSha256 = (value: string): string => value.slice("sha256:".length);

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const physicalRevision = (mode: number, bytes: Buffer): string =>
  sha256(canonicalTicketLedgerValue({
    kind: "ticket_ledger_physical_file",
    mode: mode & 0o7777,
    byte_digest: sha256(bytes),
  }));

const readPhysicalFile = (
  absolutePath: string,
  documentPath: string,
): PhysicalFile | null => {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(absolutePath);
  } catch (cause) {
    if (
      typeof cause === "object"
      && cause !== null
      && "code" in cause
      && cause.code === "ENOENT"
    ) {
      return null;
    }
    throw new TicketLedgerError(
      "io",
      `Cannot inspect Ticket patch target ${documentPath}`,
      { documentPath },
      { cause },
    );
  }
  if (before.isSymbolicLink()) {
    throw new TicketLedgerError(
      "symlink",
      `Ticket patch target cannot be a symlink: ${documentPath}`,
      { documentPath },
    );
  }
  if (!before.isFile()) {
    throw new TicketLedgerError(
      "unsupported_file",
      `Ticket patch target is not a regular file: ${documentPath}`,
      { documentPath },
    );
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Ticket patch target changed while opening: ${documentPath}`,
        { documentPath },
      );
    }
    const maxBytes = ticketLedgerDocumentMaxBytes(documentPath);
    if (opened.size > maxBytes) {
      throw new TicketLedgerError(
        "file_too_large",
        `${documentPath} exceeds its ${maxBytes}-byte limit`,
        { documentPath, byteLength: opened.size, maxBytes },
      );
    }
    const bytes = readTicketLedgerFileBounded(
      descriptor,
      documentPath,
      maxBytes,
    );
    const mode = opened.mode & 0o7777;
    return {
      revision: physicalRevision(mode, bytes),
      bytes,
      mode,
    };
  } catch (cause) {
    if (cause instanceof TicketLedgerError) throw cause;
    throw new TicketLedgerError(
      "io",
      `Cannot read Ticket patch target ${documentPath}`,
      { documentPath },
      { cause },
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
};

const patchSource = (snapshot: TicketLedgerSnapshot): TicketLedgerPatchSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new TicketLedgerError(
      "invalid_path",
      "Ticket worktree patch requires a worktree source",
    );
  }
  return {
    sourceToken: snapshot.source.sourceToken,
    worktreeIdentity: snapshot.source.worktreeIdentity,
    resolvedCommit: snapshot.source.resolvedCommit,
    graphDigest: sha256Ref(snapshot.graphDigest),
    semanticLedgerDigest: sha256Ref(snapshot.semanticLedgerDigest),
  };
};

const assertExpectedSource = (
  snapshot: TicketLedgerSnapshot,
  expected: TicketLedgerPatchRequest["expectedSource"],
): void => {
  const actual = patchSource(snapshot);
  const mismatches = (
    Object.keys(actual) as Array<keyof TicketLedgerPatchSource>
  ).filter((field) => actual[field] !== expected[field]);
  if (mismatches.length > 0) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket worktree source changed before the patch could be applied",
      { expected, actual, mismatches },
    );
  }
};

const parseRequest = (value: TicketLedgerPatchRequest): TicketLedgerPatchRequest => {
  const parsed = patchRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket worktree patch request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  const seen = new Set<string>();
  for (const change of parsed.data.changes) {
    ticketDocumentPath(change.ticketId);
    if (seen.has(change.ticketId)) {
      throw new TicketLedgerError(
        "duplicate_change",
        `Ticket patch targets ${change.ticketId} more than once`,
        { ticketId: change.ticketId },
      );
    }
    seen.add(change.ticketId);
  }
  return parsed.data;
};

const prepareChanges = (
  snapshot: TicketLedgerSnapshot,
  changes: readonly TicketLedgerPatchChange[],
): {
  changes: PreparedChange[];
  targetGraphDigest: string;
  targetSemanticLedgerDigest: string;
} => {
  const current = new Map(snapshot.tickets.map((ticket) => [
    ticket.document.ticket_id,
    ticket.document,
  ]));
  const prepared: PreparedChange[] = [];
  let replacementByteFloor = 0;
  for (const request of changes) {
    const beforeDocument = current.get(request.ticketId) ?? null;
    const beforeRevision = beforeDocument === null
      ? null
      : ticketRevision(beforeDocument);
    const expectedRevision = request.expectedTicketRevision === null
      ? null
      : rawSha256(request.expectedTicketRevision);
    if (beforeRevision !== expectedRevision) {
      throw new TicketLedgerError(
        "stale_ticket_revision",
        `Ticket ${request.ticketId} changed before the patch could be applied`,
        {
          ticketId: request.ticketId,
          expectedTicketRevision: request.expectedTicketRevision,
          actualTicketRevision: beforeRevision === null
            ? null
            : sha256Ref(beforeRevision),
        },
      );
    }

    let afterDocument: TicketDocument | null = null;
    if (request.op === "put") {
      afterDocument = normalizeTicketDocument(
        request.document,
        `Ticket patch document ${request.ticketId}`,
      );
      if (afterDocument.ticket_id !== request.ticketId) {
        throw new TicketLedgerError(
          "invalid_path",
          `Ticket patch key ${request.ticketId} does not match document ID ${afterDocument.ticket_id}`,
          {
            ticketId: request.ticketId,
            documentTicketId: afterDocument.ticket_id,
          },
        );
      }
      current.set(request.ticketId, afterDocument);
    } else {
      current.delete(request.ticketId);
    }
    const afterRevision = afterDocument === null
      ? null
      : ticketRevision(afterDocument);
    const changed = beforeRevision !== afterRevision;
    const replacementBytes = changed && afterDocument !== null
      ? encodeTicketDocument(afterDocument)
      : null;
    if (
      replacementBytes !== null
      && replacementBytes.byteLength > TICKET_LEDGER_TICKET_MAX_BYTES
    ) {
      throw new TicketLedgerError(
        "file_too_large",
        `${ticketDocumentPath(request.ticketId)} exceeds its ${TICKET_LEDGER_TICKET_MAX_BYTES}-byte limit`,
        {
          documentPath: ticketDocumentPath(request.ticketId),
          byteLength: replacementBytes.byteLength,
          maxBytes: TICKET_LEDGER_TICKET_MAX_BYTES,
        },
      );
    }
    if (replacementBytes !== null) {
      replacementByteFloor += replacementBytes.byteLength;
      if (replacementByteFloor > TICKET_LEDGER_MAX_BYTES) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Prospective Ticket replacements exceed the ${TICKET_LEDGER_MAX_BYTES}-byte ledger limit`,
          {
            replacementBytes: replacementByteFloor,
            maxBytes: TICKET_LEDGER_MAX_BYTES,
          },
        );
      }
    }
    prepared.push({
      request,
      documentPath: ticketDocumentPath(request.ticketId),
      beforeDocument,
      afterDocument,
      beforeRevision,
      afterRevision,
      changed,
      replacementBytes,
    });
  }

  const prospective = validateTicketLedger({
    protocol: snapshot.protocol,
    tickets: [...current.values()].map((document) => ({
      documentPath: ticketDocumentPath(document.ticket_id),
      document,
    })),
    reviews: snapshot.reviews,
    decisions: snapshot.decisions,
    attestations: snapshot.attestations,
    contextBindings: snapshot.contextBindings,
    evidence: snapshot.evidence,
    outcomes: snapshot.outcomes,
  });
  return {
    changes: prepared.sort((left, right) =>
      compareText(left.request.ticketId, right.request.ticketId)),
    targetGraphDigest: prospective.graphDigest,
    targetSemanticLedgerDigest: prospective.semanticLedgerDigest,
  };
};

const assertProspectiveByteCapacity = (
  worktreeRoot: string,
  snapshot: TicketLedgerSnapshot,
  changes: readonly PreparedChange[],
): void => {
  const protocolPath = `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`;
  const protocol = readPhysicalFile(
    path.join(worktreeRoot, ...protocolPath.split("/")),
    protocolPath,
  );
  if (protocol === null) {
    throw new TicketLedgerError(
      "source_changed_during_read",
      "Ticket protocol disappeared during patch capacity validation",
      { documentPath: protocolPath },
    );
  }
  const byTicketId = new Map(changes.map((change) => [
    change.request.ticketId,
    change,
  ]));
  let totalBytes = protocol.bytes.byteLength;
  for (const ticket of snapshot.tickets) {
    const ticketId = ticket.document.ticket_id;
    const change = byTicketId.get(ticketId);
    if (change?.changed) {
      if (change.replacementBytes !== null) {
        totalBytes += change.replacementBytes.byteLength;
      }
      continue;
    }
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...ticket.documentPath.split("/")),
      ticket.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Ticket ${ticketId} disappeared during patch capacity validation`,
        { ticketId, documentPath: ticket.documentPath },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  for (const change of changes) {
    if (
      change.beforeDocument === null
      && change.replacementBytes !== null
    ) {
      totalBytes += change.replacementBytes.byteLength;
    }
  }
  for (const review of snapshot.reviews) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...review.documentPath.split("/")),
      review.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Review ${review.document.review_id} disappeared during patch capacity validation`,
        {
          reviewId: review.document.review_id,
          documentPath: review.documentPath,
        },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  for (const decision of snapshot.decisions) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...decision.documentPath.split("/")),
      decision.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Decision ${decision.document.decision_id} disappeared during patch capacity validation`,
        {
          decisionId: decision.document.decision_id,
          documentPath: decision.documentPath,
        },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  for (const attestation of snapshot.attestations) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...attestation.documentPath.split("/")),
      attestation.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Attestation ${attestation.document.attestation_id} disappeared during patch capacity validation`,
        {
          attestationId: attestation.document.attestation_id,
          documentPath: attestation.documentPath,
        },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  for (const binding of snapshot.contextBindings) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...binding.documentPath.split("/")),
      binding.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Context binding ${binding.document.context_binding_id} disappeared during patch capacity validation`,
        {
          contextBindingId: binding.document.context_binding_id,
          documentPath: binding.documentPath,
        },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  for (const item of snapshot.evidence) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...item.documentPath.split("/")),
      item.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Evidence ${item.document.evidence_id} disappeared during patch capacity validation`,
        {
          evidenceId: item.document.evidence_id,
          documentPath: item.documentPath,
        },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  for (const outcome of snapshot.outcomes) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...outcome.documentPath.split("/")),
      outcome.documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Outcome ${outcome.document.outcome_id} disappeared during patch capacity validation`,
        {
          outcomeId: outcome.document.outcome_id,
          documentPath: outcome.documentPath,
        },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  if (totalBytes > TICKET_LEDGER_MAX_BYTES) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Prospective Ticket ledger exceeds its ${TICKET_LEDGER_MAX_BYTES}-byte limit`,
      { totalBytes, maxBytes: TICKET_LEDGER_MAX_BYTES },
    );
  }
};

const acquireWriterLock = (worktreeRoot: string): (() => void) => {
  let lockPath: string;
  try {
    lockPath = GitFacade.gitPathAt(
      worktreeRoot,
      "vibehub-ticket-ledger-patch.lock",
    );
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      "Cannot resolve the Ticket writer lock for this worktree",
      { worktreeRoot },
      { cause },
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
  } catch (cause) {
    if (
      typeof cause === "object"
      && cause !== null
      && "code" in cause
      && cause.code === "EEXIST"
    ) {
      throw new TicketLedgerError(
        "writer_busy",
        "Another Ticket patch is active in this worktree",
        { lockPath },
      );
    }
    throw new TicketLedgerError(
      "io",
      "Cannot acquire the Ticket worktree writer lock",
      { lockPath },
      { cause },
    );
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = -1;
  } catch (cause) {
    if (descriptor !== -1) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The initialization error remains authoritative.
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Best effort: report the exact lock path for manual recovery.
    }
    throw new TicketLedgerError(
      "io",
      "Cannot initialize the Ticket worktree writer lock",
      { lockPath },
      { cause },
    );
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // A failed cleanup must not hide a verified patch result.
    }
  };
};

const ensureTicketsDirectory = (
  worktreeRoot: string,
): { absolutePath: string; created: boolean } => {
  const absolutePath = path.join(
    worktreeRoot,
    ...`${TICKET_LEDGER_RELATIVE_PATH}/tickets`.split("/"),
  );
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TicketLedgerError(
        stat.isSymbolicLink() ? "symlink" : "unsupported_file",
        "Ticket document parent must be a real directory",
        { documentPath: `${TICKET_LEDGER_RELATIVE_PATH}/tickets` },
      );
    }
    return { absolutePath, created: false };
  } catch (cause) {
    if (cause instanceof TicketLedgerError) throw cause;
    if (
      typeof cause !== "object"
      || cause === null
      || !("code" in cause)
      || cause.code !== "ENOENT"
    ) {
      throw new TicketLedgerError(
        "io",
        "Cannot inspect the Ticket document directory",
        { path: absolutePath },
        { cause },
      );
    }
  }
  try {
    fs.mkdirSync(absolutePath, { mode: 0o755 });
    return { absolutePath, created: true };
  } catch (cause) {
    throw new TicketLedgerError(
      "io",
      "Cannot create the Ticket document directory",
      { path: absolutePath },
      { cause },
    );
  }
};

const writeStagedFile = (
  destination: string,
  bytes: Buffer,
  mode = 0o644,
): string => {
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, mode & 0o7777);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return physicalRevision(mode, bytes);
};

const rollbackInstalled = (
  installed: readonly InstalledChange[],
  worktreeRoot: string,
  stagingRoot: string,
): boolean => {
  try {
    for (const item of [...installed].reverse()) {
      const target = path.join(
        worktreeRoot,
        ...item.prepared.documentPath.split("/"),
      );
      const current = readPhysicalFile(target, item.prepared.documentPath);
      if (
        (current?.revision ?? null) !== item.candidatePhysicalRevision
      ) {
        return false;
      }
      if (item.beforePhysical === null) {
        fs.unlinkSync(target);
        continue;
      }
      const restore = path.join(
        stagingRoot,
        `rollback-${crypto.randomUUID()}.yaml`,
      );
      writeStagedFile(
        restore,
        item.beforePhysical.bytes,
        item.beforePhysical.mode,
      );
      fs.renameSync(restore, target);
    }
    return true;
  } catch {
    return false;
  }
};

export function applyTicketWorktreePatch(options: {
  worktreeRoot: string;
  request: TicketLedgerPatchRequest;
}): TicketLedgerPatchResult {
  const request = parseRequest(options.request);
  let worktreeRoot: string;
  try {
    worktreeRoot = fs.realpathSync(
      GitFacade.sessionContextAt(options.worktreeRoot).toplevel,
    );
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      "Ticket patch scope is not a readable Git worktree",
      { worktreeRoot: options.worktreeRoot },
      { cause },
    );
  }
  const releaseLock = acquireWriterLock(worktreeRoot);
  let stagingRoot: string | null = null;
  let createdTicketsDirectory = false;
  const installed: InstalledChange[] = [];
  try {
    const beforeSnapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(beforeSnapshot, request.expectedSource);
    const before = patchSource(beforeSnapshot);
    const prepared = prepareChanges(beforeSnapshot, request.changes);
    assertProspectiveByteCapacity(
      worktreeRoot,
      beforeSnapshot,
      prepared.changes,
    );
    const changed = prepared.changes.filter((change) => change.changed);
    const ticketResults: TicketLedgerPatchTicketResult[] =
      prepared.changes.map((change) => ({
        op: change.request.op,
        ticketId: change.request.ticketId,
        documentPath: change.documentPath,
        beforeTicketRevision: change.beforeRevision === null
          ? null
          : sha256Ref(change.beforeRevision),
        afterTicketRevision: change.afterRevision === null
          ? null
          : sha256Ref(change.afterRevision),
        changed: change.changed,
      }));
    if (changed.length === 0) {
      return {
        status: "noop",
        before,
        after: before,
        changedPaths: [],
        tickets: ticketResults,
        checkpointSelection: { source: before, changedPaths: [] },
      };
    }

    const vibehubRoot = path.join(worktreeRoot, ".vibehub");
    stagingRoot = fs.mkdtempSync(path.join(vibehubRoot, ".ticket-patch-"));
    fs.chmodSync(stagingRoot, 0o700);
    const staged = new Map<string, {
      path: string;
      physicalRevision: string;
    }>();
    for (const change of changed) {
      if (change.replacementBytes === null) continue;
      const stagedPath = path.join(
        stagingRoot,
        `${change.request.ticketId}.yaml`,
      );
      staged.set(change.request.ticketId, {
        path: stagedPath,
        physicalRevision: writeStagedFile(
          stagedPath,
          change.replacementBytes,
        ),
      });
    }

    const rechecked = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(rechecked, request.expectedSource);
    const recheckedPrepared = prepareChanges(rechecked, request.changes);
    assertProspectiveByteCapacity(
      worktreeRoot,
      rechecked,
      recheckedPrepared.changes,
    );
    const targetPreimages = new Map<string, PhysicalFile | null>();
    for (const change of changed) {
      const absolutePath = path.join(
        worktreeRoot,
        ...change.documentPath.split("/"),
      );
      targetPreimages.set(
        change.request.ticketId,
        readPhysicalFile(absolutePath, change.documentPath),
      );
    }
    const preimageBound = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(preimageBound, request.expectedSource);

    if (changed.some((change) => change.afterDocument !== null)) {
      const ticketsDirectory = ensureTicketsDirectory(worktreeRoot);
      createdTicketsDirectory = ticketsDirectory.created;
    }
    for (const change of changed) {
      const target = path.join(
        worktreeRoot,
        ...change.documentPath.split("/"),
      );
      const expectedPhysical = targetPreimages.get(change.request.ticketId)
        ?? null;
      const immediate = readPhysicalFile(target, change.documentPath);
      if (immediate?.revision !== expectedPhysical?.revision) {
        throw new TicketLedgerError(
          "stale_source",
          `Ticket ${change.request.ticketId} changed during patch installation`,
          { ticketId: change.request.ticketId },
        );
      }
      const replacement = staged.get(change.request.ticketId);
      if (replacement === undefined) {
        fs.unlinkSync(target);
        installed.push({
          prepared: change,
          beforePhysical: expectedPhysical,
          candidatePhysicalRevision: null,
        });
      } else {
        fs.renameSync(replacement.path, target);
        installed.push({
          prepared: change,
          beforePhysical: expectedPhysical,
          candidatePhysicalRevision: replacement.physicalRevision,
        });
      }
    }

    const afterSnapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    if (
      afterSnapshot.graphDigest !== prepared.targetGraphDigest
      || afterSnapshot.semanticLedgerDigest
        !== prepared.targetSemanticLedgerDigest
      || afterSnapshot.source.mode !== "worktree"
      || afterSnapshot.source.resolvedCommit !== before.resolvedCommit
      || afterSnapshot.source.worktreeIdentity !== before.worktreeIdentity
    ) {
      throw new TicketLedgerError(
        "write_verification_failed",
        "Ticket patch did not produce its validated target graph",
        {
          expectedGraphDigest: sha256Ref(prepared.targetGraphDigest),
          actualGraphDigest: sha256Ref(afterSnapshot.graphDigest),
          expectedSemanticLedgerDigest:
            sha256Ref(prepared.targetSemanticLedgerDigest),
          actualSemanticLedgerDigest:
            sha256Ref(afterSnapshot.semanticLedgerDigest),
          installedPaths: installed.map((item) =>
            item.prepared.documentPath),
        },
      );
    }
    const after = patchSource(afterSnapshot);
    const changedPaths = changed.map((change) => change.documentPath);
    return {
      status: "applied",
      before,
      after,
      changedPaths,
      tickets: ticketResults,
      checkpointSelection: { source: after, changedPaths },
    };
  } catch (cause) {
    if (installed.length > 0 && stagingRoot !== null) {
      const rolledBack = rollbackInstalled(installed, worktreeRoot, stagingRoot);
      if (!rolledBack) {
        throw new TicketLedgerError(
          "write_verification_failed",
          "Ticket patch failed and its partial worktree change could not be safely rolled back",
          {
            installedPaths: installed.map((item) =>
              item.prepared.documentPath),
            recovery: "Inspect `git diff -- .vibehub/tickets` before retrying.",
          },
          { cause },
        );
      }
    }
    if (cause instanceof TicketLedgerError) throw cause;
    throw new TicketLedgerError(
      "io",
      "Ticket patch failed before its target graph was verified",
      {
        installedPaths: installed.map((item) =>
          item.prepared.documentPath),
      },
      { cause },
    );
  } finally {
    if (stagingRoot !== null) {
      try {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      } catch {
        // Temporary cleanup is operational and does not change Ticket truth.
      }
    }
    if (createdTicketsDirectory) {
      try {
        fs.rmdirSync(path.join(
          worktreeRoot,
          ...`${TICKET_LEDGER_RELATIVE_PATH}/tickets`.split("/"),
        ));
      } catch {
        // Keep a non-empty or concurrently used canonical directory.
      }
    }
    releaseLock();
  }
}

const semanticMutationSourceSchema = z.object({
  sourceToken: z.string().regex(/^tls-[0-9a-f]{64}$/u),
  worktreeIdentity: z.string().regex(/^worktree-[0-9a-f]{64}$/u),
  resolvedCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  graphDigest: sha256RefSchema,
  semanticLedgerDigest: sha256RefSchema,
}).strict();

const reviewAppendRequestSchema = z.object({
  expectedSource: semanticMutationSourceSchema,
  review: z.discriminatedUnion("review_type", [
    z.object({
      review_type: z.literal("comment"),
      subject: ticketReviewSubjectSchema,
      body: z.string(),
    }).strict(),
    z.object({
      review_type: z.literal("ticket_edit"),
      subject: ticketReviewSubjectSchema,
      body: z.string(),
      replacement_ticket: ticketDocumentSchema,
      rationale: z.string(),
    }).strict(),
  ]),
}).strict();

const decisionRecordRequestSchema = z.object({
  expectedSource: semanticMutationSourceSchema,
  decision: z.discriminatedUnion("decision_type", [
    z.object({
      decision_type: z.literal("plan_review"),
      subject: ticketReviewSubjectSchema.options[0],
      disposition: z.enum([
        "approve_execution",
        "delegate_within_boundaries",
        "request_changes",
      ]),
      delegated_boundaries: z.array(z.string()).optional(),
      rationale: z.string(),
      resolution_refs: z.array(z.string()),
    }).strict(),
    z.object({
      decision_type: z.literal("protected_boundary"),
      subject: ticketReviewSubjectSchema.options[1],
      boundary: z.string(),
      disposition: z.enum(["resolve", "decline"]),
      selection: z.string().optional(),
      rationale: z.string(),
      resolution_refs: z.array(z.string()),
    }).strict(),
  ]),
}).strict();

const decisionAttestationAppendRequestSchema = z.object({
  expectedSource: semanticMutationSourceSchema,
  attestation: ticketDecisionAttestationDocumentPayloadSchema,
}).strict();

const contextBindingAppendRequestSchema = z.object({
  expectedSource: semanticMutationSourceSchema,
  contextBinding: ticketContextBindingDocumentSchema.omit({
    context_binding_id: true,
    compiled_at: true,
  }),
}).strict();

const evidenceAppendRequestSchema = z.object({
  expectedSource: semanticMutationSourceSchema,
  evidence: ticketEvidenceDocumentSchema.omit({
    evidence_id: true,
    produced_at: true,
  }),
}).strict();

const outcomeAppendRequestSchema = z.object({
  expectedSource: semanticMutationSourceSchema,
  outcome: ticketOutcomeDocumentSchema.omit({
    outcome_id: true,
    closed_at: true,
  }),
}).strict();

export type TicketReviewAuthorContext = TicketReviewDocument["author"];
export type TicketDecisionAuthorityContext =
  TicketDecisionDocument["authority"];

export type TicketReviewAppendRequest = z.input<
  typeof reviewAppendRequestSchema
>;
export type TicketDecisionRecordRequest = z.input<
  typeof decisionRecordRequestSchema
>;
export type TicketDecisionAttestationAppendRequest = z.input<
  typeof decisionAttestationAppendRequestSchema
>;
export type TicketContextBindingAppendRequest = z.input<
  typeof contextBindingAppendRequestSchema
>;
export type TicketEvidenceAppendRequest = z.input<
  typeof evidenceAppendRequestSchema
>;
export type TicketOutcomeAppendRequest = z.input<
  typeof outcomeAppendRequestSchema
>;

export interface TicketReviewAppendResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  review: {
    documentPath: string;
    document: TicketReviewDocument;
  };
  checkpointSelection: {
    source: TicketLedgerPatchSource;
    changedPaths: readonly string[];
  };
}

export interface TicketDecisionRecordResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  decision: {
    documentPath: string;
    document: TicketDecisionDocument;
  };
  checkpointSelection: {
    source: TicketLedgerPatchSource;
    changedPaths: readonly string[];
  };
}

export interface TicketDecisionAttestationAppendResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  attestation: {
    documentPath: string;
    document: TicketDecisionAttestationDocument;
  };
  checkpointSelection: {
    source: TicketLedgerPatchSource;
    changedPaths: readonly string[];
  };
}

export interface TicketContextBindingAppendResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  contextBinding: {
    documentPath: string;
    document: TicketContextBindingDocument;
  };
  checkpointSelection: {
    source: TicketLedgerPatchSource;
    changedPaths: readonly string[];
  };
}

export interface TicketEvidenceAppendResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  evidence: {
    documentPath: string;
    document: TicketEvidenceDocument;
  };
  checkpointSelection: {
    source: TicketLedgerPatchSource;
    changedPaths: readonly string[];
  };
}

export interface TicketOutcomeAppendResult {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  outcome: {
    documentPath: string;
    document: TicketOutcomeDocument;
  };
  checkpointSelection: {
    source: TicketLedgerPatchSource;
    changedPaths: readonly string[];
  };
}

type SemanticAppendDocument =
  | TicketReviewDocument
  | TicketDecisionDocument
  | TicketDecisionAttestationDocument
  | TicketContextBindingDocument
  | TicketEvidenceDocument
  | TicketOutcomeDocument;

interface PreparedSemanticAppend {
  documentPath: string;
  document: SemanticAppendDocument;
  bytes: Buffer;
}

interface InstalledSemanticAppend {
  documentPath: string;
  candidatePhysicalRevision: string;
}

const parseReviewAppendRequest = (
  value: TicketReviewAppendRequest,
): z.output<typeof reviewAppendRequestSchema> => {
  const parsed = reviewAppendRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket review append request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
};

const parseDecisionRecordRequest = (
  value: TicketDecisionRecordRequest,
): z.output<typeof decisionRecordRequestSchema> => {
  const parsed = decisionRecordRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket decision record request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
};

const parseDecisionAttestationAppendRequest = (
  value: TicketDecisionAttestationAppendRequest,
): z.output<typeof decisionAttestationAppendRequestSchema> => {
  const parsed = decisionAttestationAppendRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket decision attestation append request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
};

const parseContextBindingAppendRequest = (
  value: TicketContextBindingAppendRequest,
): z.output<typeof contextBindingAppendRequestSchema> => {
  const parsed = contextBindingAppendRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket context binding append request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
};

const parseEvidenceAppendRequest = (
  value: TicketEvidenceAppendRequest,
): z.output<typeof evidenceAppendRequestSchema> => {
  const parsed = evidenceAppendRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket evidence append request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
};

const parseOutcomeAppendRequest = (
  value: TicketOutcomeAppendRequest,
): z.output<typeof outcomeAppendRequestSchema> => {
  const parsed = outcomeAppendRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket outcome append request is invalid",
      {
        issues: parsed.error.issues.slice(0, 16).map((issue) => ({
          path: issue.path.map(String),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
};

const assertCurrentReviewSubject = (
  snapshot: TicketLedgerSnapshot,
  subject: TicketReviewSubject,
): void => {
  if (subject.kind === "graph") {
    if (subject.graph_digest !== snapshot.graphDigest) {
      throw new TicketLedgerError(
        "stale_subject",
        "Ticket graph review subject is no longer current",
        {
          expectedGraphDigest: sha256Ref(subject.graph_digest),
          actualGraphDigest: sha256Ref(snapshot.graphDigest),
        },
      );
    }
    return;
  }

  const ticketId = subject.kind === "ticket"
    ? subject.ticket_id
    : subject.dependent_ticket_id;
  const expectedRevision = subject.kind === "ticket"
    ? subject.ticket_revision
    : subject.dependent_ticket_revision;
  const ticket = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === ticketId);
  if (ticket === undefined || ticket.ticketRevision !== expectedRevision) {
    throw new TicketLedgerError(
      "stale_subject",
      `Ticket review subject ${ticketId} is no longer current`,
      {
        ticketId,
        expectedTicketRevision: sha256Ref(expectedRevision),
        actualTicketRevision: ticket === undefined
          ? null
          : sha256Ref(ticket.ticketRevision),
      },
    );
  }
  if (subject.kind === "ticket") return;

  const relation = ticket.document.relations.find((candidate) =>
    candidate.target_ticket_id === subject.prerequisite_ticket_id
    && ticketRelationId(ticket.document.ticket_id, candidate)
      === subject.relation_ref);
  if (relation === undefined) {
    throw new TicketLedgerError(
      "stale_subject",
      `Ticket relation review subject ${subject.relation_ref} is no longer current`,
      {
        relationRef: subject.relation_ref,
        prerequisiteTicketId: subject.prerequisite_ticket_id,
        dependentTicketId: subject.dependent_ticket_id,
      },
    );
  }
};

const semanticAppendAtPath = (
  snapshot: TicketLedgerSnapshot,
  documentPath: string,
): SemanticAppendDocument | null =>
  snapshot.reviews.find((review) =>
    review.documentPath === documentPath)?.document
  ?? snapshot.decisions.find((decision) =>
    decision.documentPath === documentPath)?.document
  ?? snapshot.attestations.find((attestation) =>
    attestation.documentPath === documentPath)?.document
  ?? snapshot.contextBindings.find((binding) =>
    binding.documentPath === documentPath)?.document
  ?? snapshot.evidence.find((item) =>
    item.documentPath === documentPath)?.document
  ?? snapshot.outcomes.find((outcome) =>
    outcome.documentPath === documentPath)?.document
  ?? null;

const sameCanonicalDocument = (
  left: SemanticAppendDocument,
  right: SemanticAppendDocument,
): boolean =>
  canonicalTicketLedgerValue(left) === canonicalTicketLedgerValue(right);

const withoutDecisionTime = (
  document: TicketDecisionDocument,
): Omit<TicketDecisionDocument, "decided_at"> => {
  const { decided_at: _decidedAt, ...intent } = document;
  return intent;
};

const sameDecisionIntent = (
  left: TicketDecisionDocument,
  right: TicketDecisionDocument,
): boolean =>
  canonicalTicketLedgerValue(withoutDecisionTime(left))
  === canonicalTicketLedgerValue(withoutDecisionTime(right));

const validateProspectiveSemanticAppend = (
  snapshot: TicketLedgerSnapshot,
  prepared: PreparedSemanticAppend,
): string => {
  const content = validateTicketLedger({
    protocol: snapshot.protocol,
    tickets: snapshot.tickets,
    reviews: "review_id" in prepared.document
      ? [
          ...snapshot.reviews,
          {
            documentPath: prepared.documentPath,
            document: prepared.document,
          },
        ]
      : snapshot.reviews,
    decisions: "decision_id" in prepared.document
      ? [
          ...snapshot.decisions,
          {
            documentPath: prepared.documentPath,
            document: prepared.document,
          },
        ]
      : snapshot.decisions,
    attestations: "attestation_id" in prepared.document
      ? [
          ...snapshot.attestations,
          {
            documentPath: prepared.documentPath,
            document: prepared.document,
          },
        ]
      : snapshot.attestations,
    contextBindings: "context_binding_id" in prepared.document
      ? [
          ...snapshot.contextBindings,
          {
            documentPath: prepared.documentPath,
            document: prepared.document,
          },
        ]
      : snapshot.contextBindings,
    evidence: "evidence_id" in prepared.document
      ? [
          ...snapshot.evidence,
          {
            documentPath: prepared.documentPath,
            document: prepared.document,
          },
        ]
      : snapshot.evidence,
    outcomes: "outcome_id" in prepared.document
      ? [
          ...snapshot.outcomes,
          {
            documentPath: prepared.documentPath,
            document: prepared.document,
          },
        ]
      : snapshot.outcomes,
  });
  if (content.graphDigest !== snapshot.graphDigest) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "A semantic fact unexpectedly changed Ticket graph identity",
      {
        beforeGraphDigest: sha256Ref(snapshot.graphDigest),
        afterGraphDigest: sha256Ref(content.graphDigest),
      },
    );
  }
  return content.semanticLedgerDigest;
};

const assertProspectiveSemanticAppendByteCapacity = (
  worktreeRoot: string,
  snapshot: TicketLedgerSnapshot,
  replacementBytes: Buffer,
): void => {
  const documentPaths = [
    `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`,
    ...snapshot.tickets.map((ticket) => ticket.documentPath),
    ...snapshot.reviews.map((review) => review.documentPath),
    ...snapshot.decisions.map((decision) => decision.documentPath),
    ...snapshot.attestations.map((attestation) =>
      attestation.documentPath),
    ...snapshot.contextBindings.map((binding) => binding.documentPath),
    ...snapshot.evidence.map((item) => item.documentPath),
    ...snapshot.outcomes.map((outcome) => outcome.documentPath),
  ];
  let totalBytes = replacementBytes.byteLength;
  for (const documentPath of documentPaths) {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...documentPath.split("/")),
      documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Ticket semantic document disappeared during capacity validation: ${documentPath}`,
        { documentPath },
      );
    }
    totalBytes += physical.bytes.byteLength;
  }
  if (totalBytes > TICKET_LEDGER_MAX_BYTES) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Prospective Ticket ledger exceeds its ${TICKET_LEDGER_MAX_BYTES}-byte limit`,
      { totalBytes, maxBytes: TICKET_LEDGER_MAX_BYTES },
    );
  }
};

const semanticSnapshotDocumentPaths = (
  snapshot: TicketLedgerSnapshot,
): string[] => [
  `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`,
  ...snapshot.tickets.map((ticket) => ticket.documentPath),
  ...snapshot.reviews.map((review) => review.documentPath),
  ...snapshot.decisions.map((decision) => decision.documentPath),
  ...snapshot.attestations.map((attestation) =>
    attestation.documentPath),
  ...snapshot.contextBindings.map((binding) => binding.documentPath),
  ...snapshot.evidence.map((item) => item.documentPath),
  ...snapshot.outcomes.map((outcome) => outcome.documentPath),
];

const captureSemanticPhysicalInventory = (
  worktreeRoot: string,
  snapshot: TicketLedgerSnapshot,
): Map<string, string> => new Map(
  semanticSnapshotDocumentPaths(snapshot).map((documentPath) => {
    const physical = readPhysicalFile(
      path.join(worktreeRoot, ...documentPath.split("/")),
      documentPath,
    );
    if (physical === null) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Ticket semantic document disappeared during inventory capture: ${documentPath}`,
        { documentPath },
      );
    }
    return [documentPath, physical.revision];
  }),
);

const assertExactSemanticAppendInventory = (
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  installed: InstalledSemanticAppend,
): void => {
  if (
    after.size !== before.size + 1
    || after.get(installed.documentPath)
      !== installed.candidatePhysicalRevision
  ) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket semantic append changed an unexpected physical ledger path",
      {
        documentPath: installed.documentPath,
        beforeCount: before.size,
        afterCount: after.size,
      },
    );
  }
  for (const [documentPath, revision] of before) {
    if (after.get(documentPath) !== revision) {
      throw new TicketLedgerError(
        "write_verification_failed",
        "A pre-existing Ticket semantic document changed during append",
        { documentPath },
      );
    }
  }
};

const ensureSemanticDocumentParent = (
  worktreeRoot: string,
  documentPath: string,
): string[] => {
  const parentSegments = path.posix.dirname(documentPath).split("/");
  const created: string[] = [];
  let current = worktreeRoot;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new TicketLedgerError(
          stat.isSymbolicLink() ? "symlink" : "unsupported_file",
          `Ticket semantic document parent must be a real directory: ${documentPath}`,
          { documentPath, parentPath: current },
        );
      }
    } catch (cause) {
      if (cause instanceof TicketLedgerError) throw cause;
      if (
        typeof cause !== "object"
        || cause === null
        || !("code" in cause)
        || cause.code !== "ENOENT"
      ) {
        throw new TicketLedgerError(
          "io",
          `Cannot inspect Ticket semantic document parent: ${documentPath}`,
          { documentPath, parentPath: current },
          { cause },
        );
      }
      try {
        fs.mkdirSync(current, { mode: 0o755 });
        created.push(current);
      } catch (mkdirCause) {
        if (
          typeof mkdirCause === "object"
          && mkdirCause !== null
          && "code" in mkdirCause
          && mkdirCause.code === "EEXIST"
        ) {
          const stat = fs.lstatSync(current);
          if (!stat.isSymbolicLink() && stat.isDirectory()) continue;
        }
        throw new TicketLedgerError(
          "io",
          `Cannot create Ticket semantic document parent: ${documentPath}`,
          { documentPath, parentPath: current },
          { cause: mkdirCause },
        );
      }
    }
  }
  return created;
};

const removeEmptyDirectories = (directories: readonly string[]): void => {
  for (const directory of [...directories].reverse()) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // Keep non-empty or concurrently adopted canonical directories.
    }
  }
};

const semanticAppend = (options: {
  worktreeRoot: string;
  expectedSource: TicketLedgerPatchSource;
  assertCurrent: (
    snapshot: TicketLedgerSnapshot,
    transientSourceExclusions?: readonly string[],
  ) => void;
  prepare: (snapshot: TicketLedgerSnapshot) => PreparedSemanticAppend;
  equivalent: (
    existing: SemanticAppendDocument,
    candidate: SemanticAppendDocument,
  ) => boolean;
}): {
  status: "applied" | "noop";
  before: TicketLedgerPatchSource;
  after: TicketLedgerPatchSource;
  changedPaths: readonly string[];
  prepared: PreparedSemanticAppend;
} => {
  let worktreeRoot: string;
  try {
    worktreeRoot = fs.realpathSync(
      GitFacade.sessionContextAt(options.worktreeRoot).toplevel,
    );
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      "Ticket semantic write scope is not a readable Git worktree",
      { worktreeRoot: options.worktreeRoot },
      { cause },
    );
  }
  const releaseLock = acquireWriterLock(worktreeRoot);
  let stagingRoot: string | null = null;
  let installed: InstalledSemanticAppend | null = null;
  let createdDirectories: string[] = [];
  try {
    const beforeSnapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(beforeSnapshot, options.expectedSource);
    options.assertCurrent(beforeSnapshot, []);
    const before = patchSource(beforeSnapshot);
    const prepared = options.prepare(beforeSnapshot);
    const existing = semanticAppendAtPath(
      beforeSnapshot,
      prepared.documentPath,
    );
    if (existing !== null) {
      if (!options.equivalent(existing, prepared.document)) {
        throw new TicketLedgerError(
          "document_conflict",
          `A different Ticket semantic document already occupies ${prepared.documentPath}`,
          { documentPath: prepared.documentPath },
        );
      }
      return {
        status: "noop",
        before,
        after: before,
        changedPaths: [],
        prepared: {
          ...prepared,
          document: existing,
        },
      };
    }

    const documentMaxBytes =
      ticketLedgerDocumentMaxBytes(prepared.documentPath);
    if (prepared.bytes.byteLength > documentMaxBytes) {
      throw new TicketLedgerError(
        "file_too_large",
        `${prepared.documentPath} exceeds its ${documentMaxBytes}-byte limit`,
        {
          documentPath: prepared.documentPath,
          byteLength: prepared.bytes.byteLength,
          maxBytes: documentMaxBytes,
        },
      );
    }
    const targetSemanticLedgerDigest =
      validateProspectiveSemanticAppend(beforeSnapshot, prepared);
    assertProspectiveSemanticAppendByteCapacity(
      worktreeRoot,
      beforeSnapshot,
      prepared.bytes,
    );

    const vibehubRoot = path.join(worktreeRoot, ".vibehub");
    stagingRoot = fs.mkdtempSync(
      path.join(vibehubRoot, ".ticket-semantic-append-"),
    );
    fs.chmodSync(stagingRoot, 0o700);
    const stagedPath = path.join(stagingRoot, "candidate.yaml");
    const candidatePhysicalRevision = writeStagedFile(
      stagedPath,
      prepared.bytes,
    );

    const rechecked = loadTicketLedgerFromWorktree(worktreeRoot);
    assertExpectedSource(rechecked, options.expectedSource);
    const transientSourcePath = path.relative(
      worktreeRoot,
      stagingRoot,
    ).split(path.sep).join("/");
    options.assertCurrent(rechecked, [transientSourcePath]);
    const recheckedPrepared = options.prepare(rechecked);
    if (
      recheckedPrepared.documentPath !== prepared.documentPath
      || !sameCanonicalDocument(
        recheckedPrepared.document,
        prepared.document,
      )
    ) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        "Ticket semantic write changed while its exact source was rechecked",
        { documentPath: prepared.documentPath },
      );
    }
    const recheckedExisting = semanticAppendAtPath(
      rechecked,
      prepared.documentPath,
    );
    if (recheckedExisting !== null) {
      throw new TicketLedgerError(
        "stale_source",
        `Ticket semantic document appeared during write: ${prepared.documentPath}`,
        { documentPath: prepared.documentPath },
      );
    }
    validateProspectiveSemanticAppend(rechecked, prepared);
    assertProspectiveSemanticAppendByteCapacity(
      worktreeRoot,
      rechecked,
      prepared.bytes,
    );
    const beforePhysicalInventory = captureSemanticPhysicalInventory(
      worktreeRoot,
      rechecked,
    );

    createdDirectories = ensureSemanticDocumentParent(
      worktreeRoot,
      prepared.documentPath,
    );
    const target = path.join(
      worktreeRoot,
      ...prepared.documentPath.split("/"),
    );
    if (readPhysicalFile(target, prepared.documentPath) !== null) {
      throw new TicketLedgerError(
        "stale_source",
        `Ticket semantic document appeared during installation: ${prepared.documentPath}`,
        { documentPath: prepared.documentPath },
      );
    }
    try {
      fs.linkSync(stagedPath, target);
    } catch (cause) {
      if (
        typeof cause === "object"
        && cause !== null
        && "code" in cause
        && cause.code === "EEXIST"
      ) {
        throw new TicketLedgerError(
          "stale_source",
          `Ticket semantic document appeared during installation: ${prepared.documentPath}`,
          { documentPath: prepared.documentPath },
          { cause },
        );
      }
      throw cause;
    }
    installed = {
      documentPath: prepared.documentPath,
      candidatePhysicalRevision,
    };

    const afterSnapshot = loadTicketLedgerFromWorktree(worktreeRoot);
    const installedDocument = semanticAppendAtPath(
      afterSnapshot,
      prepared.documentPath,
    );
    const afterPhysicalInventory = captureSemanticPhysicalInventory(
      worktreeRoot,
      afterSnapshot,
    );
    assertExactSemanticAppendInventory(
      beforePhysicalInventory,
      afterPhysicalInventory,
      installed,
    );
    const afterBound = loadTicketLedgerFromWorktree(worktreeRoot);
    if (
      afterSnapshot.graphDigest !== beforeSnapshot.graphDigest
      || afterSnapshot.semanticLedgerDigest
        !== targetSemanticLedgerDigest
      || afterSnapshot.source.mode !== "worktree"
      || afterSnapshot.source.resolvedCommit !== before.resolvedCommit
      || afterSnapshot.source.worktreeIdentity !== before.worktreeIdentity
      || installedDocument === null
      || !sameCanonicalDocument(installedDocument, prepared.document)
      || afterBound.source.sourceToken
        !== afterSnapshot.source.sourceToken
      || afterBound.semanticLedgerDigest
        !== afterSnapshot.semanticLedgerDigest
    ) {
      throw new TicketLedgerError(
        "write_verification_failed",
        "Ticket semantic append did not produce its validated target ledger",
        {
          documentPath: prepared.documentPath,
          expectedGraphDigest: before.graphDigest,
          actualGraphDigest: sha256Ref(afterSnapshot.graphDigest),
          expectedSemanticLedgerDigest:
            sha256Ref(targetSemanticLedgerDigest),
          actualSemanticLedgerDigest:
            sha256Ref(afterSnapshot.semanticLedgerDigest),
        },
      );
    }
    const after = patchSource(afterBound);
    return {
      status: "applied",
      before,
      after,
      changedPaths: [prepared.documentPath],
      prepared,
    };
  } catch (cause) {
    if (installed !== null) {
      throw new TicketLedgerError(
        "write_verification_failed",
        "Ticket semantic append installed one complete document but could not verify exclusive ownership of the final ledger state",
        {
          documentPath: installed.documentPath,
          recovery:
            "Inspect the reported Git document and `git diff -- .vibehub/tickets`; keep or remove it explicitly before retrying.",
        },
        { cause },
      );
    }
    if (cause instanceof TicketLedgerError) throw cause;
    throw new TicketLedgerError(
      "io",
      "Ticket semantic append failed before its target ledger was verified",
      {
        documentPath: null,
      },
      { cause },
    );
  } finally {
    if (stagingRoot !== null) {
      try {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      } catch {
        // Temporary cleanup is operational and does not change Ticket truth.
      }
    }
    removeEmptyDirectories(createdDirectories);
    releaseLock();
  }
};

export function appendTicketReview(options: {
  worktreeRoot: string;
  request: TicketReviewAppendRequest;
  author: TicketReviewAuthorContext;
  occurredAt: string;
}): TicketReviewAppendResult {
  const request = parseReviewAppendRequest(options.request);
  const subject = request.review.subject;
  const result = semanticAppend({
    worktreeRoot: options.worktreeRoot,
    expectedSource: request.expectedSource,
    assertCurrent(snapshot) {
      assertCurrentReviewSubject(snapshot, subject);
    },
    prepare(snapshot) {
      const common = {
        schema_version: TICKET_LEDGER_SCHEMA_VERSION,
        kind: "ticket_review" as const,
        subject,
        observed: {
          resolved_commit: snapshot.source.resolvedCommit,
          graph_digest: snapshot.graphDigest,
        },
        author: options.author,
        body: request.review.body,
        occurred_at: options.occurredAt,
      };
      const payload: TicketReviewDocumentPayload =
        request.review.review_type === "comment"
          ? {
              ...common,
              review_type: "comment",
            }
          : {
              ...common,
              review_type: "ticket_edit",
              expected_ticket_revision:
                request.review.subject.kind === "ticket"
                  ? request.review.subject.ticket_revision
                  : "",
              replacement_ticket: request.review.replacement_ticket,
              rationale: request.review.rationale,
            };
      const document = createTicketReviewDocument(payload);
      const documentPath = ticketReviewDocumentPath(
        document.subject,
        document.review_id,
      );
      return {
        documentPath,
        document,
        bytes: encodeTicketReviewDocument(document),
      };
    },
    equivalent(existing, candidate) {
      return "review_id" in existing
        && "review_id" in candidate
        && sameCanonicalDocument(existing, candidate);
    },
  });
  const document = result.prepared.document;
  if (!("review_id" in document)) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket review append returned a non-review document",
    );
  }
  return {
    status: result.status,
    before: result.before,
    after: result.after,
    changedPaths: result.changedPaths,
    review: {
      documentPath: result.prepared.documentPath,
      document,
    },
    checkpointSelection: {
      source: result.after,
      changedPaths: result.changedPaths,
    },
  };
}

export interface PreparedTicketDecision {
  documentPath: string;
  document: TicketDecisionDocument;
  digest: string;
}

export function prepareTicketDecisionForSnapshot(options: {
  snapshot: TicketLedgerSnapshot;
  request: TicketDecisionRecordRequest;
  authority: TicketDecisionAuthorityContext;
  decidedAt: string;
}): PreparedTicketDecision {
  const request = parseDecisionRecordRequest(options.request);
  assertExpectedSource(options.snapshot, request.expectedSource);
  assertCurrentReviewSubject(options.snapshot, request.decision.subject);
  const common = {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket_decision" as const,
    rationale: request.decision.rationale,
    resolution_refs: request.decision.resolution_refs,
    authority: options.authority,
    decided_at: options.decidedAt,
  };
  const payload: TicketDecisionDocumentPayload =
    request.decision.decision_type === "plan_review"
      ? {
          ...common,
          decision_type: "plan_review",
          subject: request.decision.subject,
          disposition: request.decision.disposition,
          ...(request.decision.delegated_boundaries === undefined
            ? {}
            : {
                delegated_boundaries:
                  request.decision.delegated_boundaries,
              }),
        }
      : {
          ...common,
          decision_type: "protected_boundary",
          subject: request.decision.subject,
          boundary: request.decision.boundary,
          disposition: request.decision.disposition,
          ...(request.decision.selection === undefined
            ? {}
            : { selection: request.decision.selection }),
        };
  const candidate = createTicketDecisionDocument(payload);
  const documentPath = ticketDecisionDocumentPath(candidate);
  const existing = options.snapshot.decisions.find((decision) =>
    decision.documentPath === documentPath)?.document;
  if (existing !== undefined) {
    if (!sameDecisionIntent(existing, candidate)) {
      throw new TicketLedgerError(
        "document_conflict",
        `A different Ticket Decision already occupies ${documentPath}`,
        { documentPath, decisionId: candidate.decision_id },
      );
    }
    return {
      documentPath,
      document: existing,
      digest: ticketDecisionDocumentDigest(existing),
    };
  }
  return {
    documentPath,
    document: candidate,
    digest: ticketDecisionDocumentDigest(candidate),
  };
}

export function recordTicketDecision(options: {
  worktreeRoot: string;
  request: TicketDecisionRecordRequest;
  authority: TicketDecisionAuthorityContext;
  decidedAt: string;
}): TicketDecisionRecordResult {
  const request = parseDecisionRecordRequest(options.request);
  const subject = request.decision.subject;
  const result = semanticAppend({
    worktreeRoot: options.worktreeRoot,
    expectedSource: request.expectedSource,
    assertCurrent(snapshot) {
      assertCurrentReviewSubject(snapshot, subject);
    },
    prepare(snapshot) {
      const prepared = prepareTicketDecisionForSnapshot({
        snapshot,
        request,
        authority: options.authority,
        decidedAt: options.decidedAt,
      });
      return {
        documentPath: prepared.documentPath,
        document: prepared.document,
        bytes: encodeTicketDecisionDocument(prepared.document),
      };
    },
    equivalent(existing, candidate) {
      return "decision_id" in existing
        && "decision_id" in candidate
        && sameDecisionIntent(existing, candidate);
    },
  });
  const document = result.prepared.document;
  if (!("decision_id" in document)) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket decision record returned a non-decision document",
    );
  }
  return {
    status: result.status,
    before: result.before,
    after: result.after,
    changedPaths: result.changedPaths,
    decision: {
      documentPath: result.prepared.documentPath,
      document,
    },
    checkpointSelection: {
      source: result.after,
      changedPaths: result.changedPaths,
    },
  };
}

const assertAttestationDecisionBinding = (
  snapshot: TicketLedgerSnapshot,
  attestation: TicketDecisionAttestationDocument,
): void => {
  if (snapshot.source.mode !== "worktree") {
    throw new TicketLedgerError(
      "invalid_path",
      "Ticket decision attestation requires a worktree source",
    );
  }
  const decision = snapshot.decisions.find((candidate) =>
    candidate.document.decision_id === attestation.decision.decision_id
    && candidate.documentPath === attestation.decision.document_path);
  if (decision === undefined) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket decision attestation does not reference a current Decision document",
      {
        decisionId: attestation.decision.decision_id,
        documentPath: attestation.decision.document_path,
      },
    );
  }
  const decisionDigest = ticketDecisionDocumentDigest(decision.document);
  if (attestation.decision.document_digest !== decisionDigest) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket decision attestation digest does not match the complete canonical Decision",
      {
        decisionId: decision.document.decision_id,
        expectedDecisionDigest: decisionDigest,
        actualDecisionDigest: attestation.decision.document_digest,
      },
    );
  }
  assertCurrentReviewSubject(snapshot, decision.document.subject);

  const expectedAuthority = {
    principal_id: decision.document.authority.principal_id,
    principal_kind: decision.document.authority.principal_kind,
    basis: decision.document.authority.basis,
    basis_ref: decision.document.authority.basis_ref,
  };
  if (
    canonicalTicketLedgerValue(attestation.authority)
    !== canonicalTicketLedgerValue(expectedAuthority)
  ) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket decision attestation authority does not match the Decision",
      { decisionId: decision.document.decision_id },
    );
  }

  if (snapshot.source.branch === null) {
    throw new TicketLedgerError(
      "stale_source",
      "Durable Ticket decision attestations require a named branch checkout",
      { decisionId: decision.document.decision_id },
    );
  }
  const expectedCheckout = {
    mode: "branch" as const,
    branch: snapshot.source.branch,
  };
  const expectedRepository = {
    repository_incarnation: snapshot.source.repositoryIncarnation,
    repository_root: snapshot.source.repositoryRoot,
    worktree_identity: snapshot.source.worktreeIdentity,
    worktree_root: snapshot.source.worktreeRoot,
    checkout: expectedCheckout,
  };
  if (
    canonicalTicketLedgerValue(attestation.repository)
    !== canonicalTicketLedgerValue(expectedRepository)
  ) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket decision attestation repository or checkout binding is not current",
      {
        decisionId: decision.document.decision_id,
        expectedRepository,
        actualRepository: attestation.repository,
      },
    );
  }

  const expectedScope = decision.document.decision_type === "plan_review"
    ? {
        scope_type: "plan_review" as const,
        graph_digest: decision.document.subject.graph_digest,
        disposition: decision.document.disposition,
        ...(decision.document.delegated_boundaries === undefined
          ? {}
          : {
              delegated_boundaries:
                decision.document.delegated_boundaries,
            }),
      }
    : {
        scope_type: "protected_boundary" as const,
        ticket_id: decision.document.subject.ticket_id,
        ticket_revision: decision.document.subject.ticket_revision,
        boundary: decision.document.boundary,
        disposition: decision.document.disposition,
        ...(decision.document.selection === undefined
          ? {}
          : { selection: decision.document.selection }),
      };
  if (
    canonicalTicketLedgerValue(attestation.scope)
    !== canonicalTicketLedgerValue(expectedScope)
  ) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket decision attestation scope does not match the complete Decision",
      {
        decisionId: decision.document.decision_id,
        expectedScope,
        actualScope: attestation.scope,
      },
    );
  }
  if (
    Date.parse(attestation.issued_at)
    < Date.parse(decision.document.decided_at)
  ) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket decision attestation cannot predate its Decision",
      {
        decisionId: decision.document.decision_id,
        decidedAt: decision.document.decided_at,
        issuedAt: attestation.issued_at,
      },
    );
  }
};

export function appendTicketDecisionAttestation(options: {
  worktreeRoot: string;
  request: TicketDecisionAttestationAppendRequest;
}): TicketDecisionAttestationAppendResult {
  const request = parseDecisionAttestationAppendRequest(options.request);
  const normalized =
    createTicketDecisionAttestationDocument(request.attestation);
  const result = semanticAppend({
    worktreeRoot: options.worktreeRoot,
    expectedSource: request.expectedSource,
    assertCurrent(snapshot) {
      assertAttestationDecisionBinding(snapshot, normalized);
    },
    prepare(snapshot) {
      const document =
        createTicketDecisionAttestationDocument(request.attestation);
      assertAttestationDecisionBinding(snapshot, document);
      return {
        documentPath: ticketDecisionAttestationDocumentPath(document),
        document,
        bytes: encodeTicketDecisionAttestationDocument(document),
      };
    },
    equivalent(existing, candidate) {
      return "attestation_id" in existing
        && "attestation_id" in candidate
        && sameCanonicalDocument(existing, candidate);
    },
  });
  const document = result.prepared.document;
  if (!("attestation_id" in document)) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket decision attestation append returned another document kind",
    );
  }
  return {
    status: result.status,
    before: result.before,
    after: result.after,
    changedPaths: result.changedPaths,
    attestation: {
      documentPath: result.prepared.documentPath,
      document,
    },
    checkpointSelection: {
      source: result.after,
      changedPaths: result.changedPaths,
    },
  };
}

const assertCurrentExecutionSubject = (
  snapshot: TicketLedgerSnapshot,
  subject: { ticket_id: string; ticket_revision: string },
): TicketDocument => {
  const ticket = snapshot.tickets.find((candidate) =>
    candidate.document.ticket_id === subject.ticket_id);
  if (
    ticket === undefined
    || ticket.ticketRevision !== subject.ticket_revision
  ) {
    throw new TicketLedgerError(
      "stale_subject",
      `Ticket execution subject ${subject.ticket_id} is no longer current`,
      {
        ticketId: subject.ticket_id,
        expectedTicketRevision: sha256Ref(subject.ticket_revision),
        actualTicketRevision: ticket === undefined
          ? null
          : sha256Ref(ticket.ticketRevision),
      },
    );
  }
  return ticket.document;
};

const assertContextBindingCurrent = (
  snapshot: TicketLedgerSnapshot,
  binding: TicketContextBindingDocument,
  transientSourceExclusions: readonly string[] = [],
): void => {
  if (snapshot.source.mode !== "worktree") {
    throw new TicketLedgerError(
      "invalid_path",
      "Ticket context binding requires a worktree source",
    );
  }
  if (snapshot.source.branch === null) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket execution requires a named branch checkout",
      { ticketId: binding.subject.ticket_id },
    );
  }
  const ticket = assertCurrentExecutionSubject(snapshot, binding.subject);
  if (binding.graph_digest !== snapshot.graphDigest) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket context binding graph is no longer current",
      {
        expectedGraphDigest: sha256Ref(binding.graph_digest),
        actualGraphDigest: sha256Ref(snapshot.graphDigest),
      },
    );
  }
  const expectedRepository = {
    repository_incarnation: snapshot.source.repositoryIncarnation,
    worktree_identity: snapshot.source.worktreeIdentity,
    branch: snapshot.source.branch,
    resolved_commit: snapshot.source.resolvedCommit,
  };
  const actualRepository = {
    repository_incarnation:
      binding.repository.repository_incarnation,
    worktree_identity: binding.repository.worktree_identity,
    branch: binding.repository.branch,
    resolved_commit: binding.repository.resolved_commit,
  };
  if (
    canonicalTicketLedgerValue(expectedRepository)
    !== canonicalTicketLedgerValue(actualRepository)
  ) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket context binding repository identity is no longer current",
      { expectedRepository, actualRepository },
    );
  }
  const currentRepositorySource = GitFacade.worktreeSourceSnapshotAt(
    snapshot.source.worktreeRoot,
    [TICKET_LEDGER_RELATIVE_PATH, ...transientSourceExclusions],
  );
  if (
    currentRepositorySource.headSha !== binding.repository.resolved_commit
    || currentRepositorySource.branch !== binding.repository.branch
    || currentRepositorySource.sourceDigest
      !== binding.repository.repository_source_digest
  ) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket context binding repository source digest is no longer current",
      {
        expected: {
          branch: binding.repository.branch,
          headSha: binding.repository.resolved_commit,
          sourceDigest: binding.repository.repository_source_digest,
        },
        actual: currentRepositorySource,
      },
    );
  }

  const expectedAcceptance = ticket.acceptance.map((acceptance) => ({
    acceptance_id: acceptance.acceptance_id,
    criterion_digest:
      ticketAcceptanceCriterionDigest(acceptance.criterion),
  })).sort((left, right) => compareText(
    left.acceptance_id,
    right.acceptance_id,
  ));
  if (
    canonicalTicketLedgerValue(binding.acceptance)
    !== canonicalTicketLedgerValue(expectedAcceptance)
  ) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket context binding acceptance snapshot does not match the current Ticket",
      { ticketId: binding.subject.ticket_id },
    );
  }
  const expectedContextRefs = ticket.context_refs.map((reference) => ({
    ref: reference.ref,
    purpose: reference.purpose,
  })).sort((left, right) => compareText(left.ref, right.ref));
  const actualContextRefs = binding.context_entries.map((entry) => ({
    ref: entry.ref,
    purpose: entry.purpose,
  }));
  if (
    canonicalTicketLedgerValue(actualContextRefs)
    !== canonicalTicketLedgerValue(expectedContextRefs)
  ) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket context binding entries do not exactly cover current context_refs",
      { ticketId: binding.subject.ticket_id },
    );
  }

  for (const entry of binding.context_entries) {
    const refPath = repositoryAbsolutePath(
      snapshot.source.worktreeRoot,
      entry.ref,
    );
    let refStat: fs.Stats;
    try {
      refStat = fs.lstatSync(refPath);
    } catch (cause) {
      throw new TicketLedgerError(
        "invalid_document",
        `Context reference ${entry.ref} does not resolve`,
        { ticketId: binding.subject.ticket_id, ref: entry.ref },
        { cause },
      );
    }
    if (refStat.isSymbolicLink()) {
      throw new TicketLedgerError(
        "symlink",
        `Context reference cannot be a symlink: ${entry.ref}`,
        { ticketId: binding.subject.ticket_id, ref: entry.ref },
      );
    }
    const expectedKind = refStat.isFile()
      ? "repo_file"
      : refStat.isDirectory()
        ? "repo_directory"
        : null;
    if (expectedKind === null || expectedKind !== entry.source_kind) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Context reference ${entry.ref} does not match its declared source kind`,
        {
          ticketId: binding.subject.ticket_id,
          ref: entry.ref,
          expectedKind,
          actualKind: entry.source_kind,
        },
      );
    }
    for (const file of entry.files) {
      if (
        entry.source_kind === "repo_file"
          ? file.repository_path !== entry.ref
          : !file.repository_path.startsWith(`${entry.ref}/`)
      ) {
        throw new TicketLedgerError(
          "invalid_document",
          `Compiled context file ${file.repository_path} is outside ${entry.ref}`,
          { ref: entry.ref, repositoryPath: file.repository_path },
        );
      }
      const absolutePath = repositoryAbsolutePath(
        snapshot.source.worktreeRoot,
        file.repository_path,
      );
      let stat: fs.Stats;
      let bytes: Buffer;
      try {
        stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new TicketLedgerError(
            stat.isSymbolicLink() ? "symlink" : "unsupported_file",
            `Compiled context path is not a regular file: ${file.repository_path}`,
            { repositoryPath: file.repository_path },
          );
        }
        if (
          stat.size !== file.byte_length
          || stat.size > 256 * 1024
        ) {
          throw new TicketLedgerError(
            "stale_source",
            `Compiled context file size changed or exceeds its bound: ${file.repository_path}`,
            {
              repositoryPath: file.repository_path,
              expectedByteLength: file.byte_length,
              actualByteLength: stat.size,
              maxBytes: 256 * 1024,
            },
          );
        }
        bytes = fs.readFileSync(absolutePath);
      } catch (cause) {
        if (cause instanceof TicketLedgerError) throw cause;
        throw new TicketLedgerError(
          "invalid_document",
          `Compiled context file does not resolve: ${file.repository_path}`,
          { repositoryPath: file.repository_path },
          { cause },
        );
      }
      const actualDigest = `sha256:${sha256(bytes)}`;
      if (
        bytes.byteLength !== file.byte_length
        || actualDigest !== file.file_digest
      ) {
        throw new TicketLedgerError(
          "stale_source",
          `Compiled context file changed: ${file.repository_path}`,
          {
            repositoryPath: file.repository_path,
            expectedByteLength: file.byte_length,
            actualByteLength: bytes.byteLength,
            expectedDigest: file.file_digest,
            actualDigest,
          },
        );
      }
    }
  }

  const expectedPrerequisites = ticket.relations.map((relation) => {
    const outcome = currentSuccessfulOutcomeForTicket(
      snapshot,
      relation.target_ticket_id,
    );
    if (outcome === null) {
      throw new TicketLedgerError(
        "stale_subject",
        `Ticket ${ticket.ticket_id} has an incomplete prerequisite`,
        {
          ticketId: ticket.ticket_id,
          prerequisiteTicketId: relation.target_ticket_id,
        },
      );
    }
    return {
      ticket_id: relation.target_ticket_id,
      outcome_id: outcome.document.outcome_id,
      outcome_digest: ticketOutcomeDocumentDigest(outcome.document),
    };
  }).sort((left, right) => compareText(left.ticket_id, right.ticket_id));
  if (
    canonicalTicketLedgerValue(
      binding.successful_prerequisite_outcomes,
    )
    !== canonicalTicketLedgerValue(expectedPrerequisites)
  ) {
    throw new TicketLedgerError(
      "stale_subject",
      "Ticket context binding does not bind the exact current successful prerequisite Outcomes",
      { ticketId: ticket.ticket_id },
    );
  }
};

const assertEvidenceReferencesResolve = (
  worktreeRoot: string,
  evidence: TicketEvidenceDocument,
): void => {
  for (const reference of evidence.references) {
    if (reference.reference_type === "git_commit") {
      let resolved: string;
      try {
        resolved = GitFacade.resolveCommitAt(worktreeRoot, reference.target);
      } catch (cause) {
        throw new TicketLedgerError(
          "invalid_document",
          `Evidence commit does not resolve: ${reference.target}`,
          { evidenceId: evidence.evidence_id, target: reference.target },
          { cause },
        );
      }
      if (resolved !== reference.target) {
        throw new TicketLedgerError(
          "invalid_document",
          `Evidence commit must be one exact resolved commit: ${reference.target}`,
          {
            evidenceId: evidence.evidence_id,
            target: reference.target,
            resolved,
          },
        );
      }
      continue;
    }
    assertRepositoryPathExcludesGitAdministration(reference.target, {
      evidenceId: evidence.evidence_id,
      target: reference.target,
    });
    const absolutePath = repositoryAbsolutePath(
      worktreeRoot,
      reference.target,
    );
    let stat: fs.Stats;
    let bytes: Buffer | null = null;
    try {
      stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new TicketLedgerError(
          stat.isSymbolicLink() ? "symlink" : "unsupported_file",
          `Evidence repository path is not a regular file: ${reference.target}`,
          { evidenceId: evidence.evidence_id, target: reference.target },
        );
      }
      if (
        reference.digest !== undefined
        && stat.size > TICKET_LEDGER_REFERENCED_FILE_MAX_BYTES
      ) {
        throw new TicketLedgerError(
          "file_too_large",
          `Evidence repository path exceeds its digest verification bound: ${reference.target}`,
          {
            evidenceId: evidence.evidence_id,
            target: reference.target,
            byteLength: stat.size,
            maxBytes: TICKET_LEDGER_REFERENCED_FILE_MAX_BYTES,
          },
        );
      }
      if (reference.digest !== undefined) {
        bytes = fs.readFileSync(absolutePath);
      }
    } catch (cause) {
      if (cause instanceof TicketLedgerError) throw cause;
      throw new TicketLedgerError(
        "invalid_document",
        `Evidence repository path does not resolve: ${reference.target}`,
        { evidenceId: evidence.evidence_id, target: reference.target },
        { cause },
      );
    }
    if (
      reference.digest !== undefined
      && bytes !== null
      && reference.digest !== `sha256:${sha256(bytes)}`
    ) {
      throw new TicketLedgerError(
        "stale_source",
        `Evidence repository path digest changed: ${reference.target}`,
        {
          evidenceId: evidence.evidence_id,
          target: reference.target,
          expectedDigest: reference.digest,
          actualDigest: `sha256:${sha256(bytes)}`,
        },
      );
    }
  }
};

const withoutTimestamp = (
  document: SemanticAppendDocument,
): Record<string, unknown> => {
  const timestampField = document.kind === "ticket_context_binding"
    ? "compiled_at"
    : document.kind === "ticket_evidence"
      ? "produced_at"
      : document.kind === "ticket_outcome"
        ? "closed_at"
        : null;
  return Object.fromEntries(Object.entries(document).filter(([key]) =>
    key !== timestampField));
};

const sameTimestampIndependentIntent = (
  left: SemanticAppendDocument,
  right: SemanticAppendDocument,
): boolean =>
  left.kind === right.kind
  && canonicalTicketLedgerValue(withoutTimestamp(left))
    === canonicalTicketLedgerValue(withoutTimestamp(right));

export function appendTicketContextBinding(options: {
  worktreeRoot: string;
  request: TicketContextBindingAppendRequest;
  compiledAt: string;
}): TicketContextBindingAppendResult {
  const request = parseContextBindingAppendRequest(options.request);
  const payload = {
    ...request.contextBinding,
    compiled_at: options.compiledAt,
  } as TicketContextBindingDocumentPayload;
  const preparedDocument = createTicketContextBindingDocument(payload);
  const result = semanticAppend({
    worktreeRoot: options.worktreeRoot,
    expectedSource: request.expectedSource,
    assertCurrent(snapshot, transientSourceExclusions = []) {
      assertContextBindingCurrent(
        snapshot,
        preparedDocument,
        transientSourceExclusions,
      );
    },
    prepare(snapshot) {
      const document = createTicketContextBindingDocument(payload);
      return {
        documentPath: ticketContextBindingDocumentPath(document),
        document,
        bytes: encodeTicketContextBindingDocument(document),
      };
    },
    equivalent: sameTimestampIndependentIntent,
  });
  if (!("context_binding_id" in result.prepared.document)) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket context binding append returned another document kind",
    );
  }
  return {
    status: result.status,
    before: result.before,
    after: result.after,
    changedPaths: result.changedPaths,
    contextBinding: {
      documentPath: result.prepared.documentPath,
      document: result.prepared.document,
    },
    checkpointSelection: {
      source: result.after,
      changedPaths: result.changedPaths,
    },
  };
}

export function appendTicketEvidence(options: {
  worktreeRoot: string;
  request: TicketEvidenceAppendRequest;
  producedAt: string;
}): TicketEvidenceAppendResult {
  const request = parseEvidenceAppendRequest(options.request);
  const payload = {
    ...request.evidence,
    produced_at: options.producedAt,
  } as TicketEvidenceDocumentPayload;
  const preparedDocument = createTicketEvidenceDocument(payload);
  const assertCurrent = (snapshot: TicketLedgerSnapshot): void => {
    assertCurrentExecutionSubject(snapshot, preparedDocument.subject);
    if (snapshot.source.mode !== "worktree") {
      throw new TicketLedgerError(
        "invalid_path",
        "Ticket evidence append requires a worktree source",
      );
    }
    assertEvidenceReferencesResolve(
      snapshot.source.worktreeRoot,
      preparedDocument,
    );
  };
  const result = semanticAppend({
    worktreeRoot: options.worktreeRoot,
    expectedSource: request.expectedSource,
    assertCurrent,
    prepare(snapshot) {
      const document = createTicketEvidenceDocument(payload);
      assertCurrent(snapshot);
      return {
        documentPath: ticketEvidenceDocumentPath(document),
        document,
        bytes: encodeTicketEvidenceDocument(document),
      };
    },
    equivalent: sameTimestampIndependentIntent,
  });
  if (!("evidence_id" in result.prepared.document)) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket evidence append returned another document kind",
    );
  }
  return {
    status: result.status,
    before: result.before,
    after: result.after,
    changedPaths: result.changedPaths,
    evidence: {
      documentPath: result.prepared.documentPath,
      document: result.prepared.document,
    },
    checkpointSelection: {
      source: result.after,
      changedPaths: result.changedPaths,
    },
  };
}

export function appendTicketOutcome(options: {
  worktreeRoot: string;
  request: TicketOutcomeAppendRequest;
  closedAt: string;
}): TicketOutcomeAppendResult {
  const request = parseOutcomeAppendRequest(options.request);
  const payload = {
    ...request.outcome,
    closed_at: options.closedAt,
  } as TicketOutcomeDocumentPayload;
  const preparedDocument = createTicketOutcomeDocument(payload);
  const result = semanticAppend({
    worktreeRoot: options.worktreeRoot,
    expectedSource: request.expectedSource,
    assertCurrent(snapshot) {
      if (preparedDocument.terminal_form !== "stale") {
        assertCurrentExecutionSubject(snapshot, preparedDocument.subject);
      }
    },
    prepare(snapshot) {
      const document = createTicketOutcomeDocument(payload);
      if (document.terminal_form !== "stale") {
        assertCurrentExecutionSubject(snapshot, document.subject);
      }
      return {
        documentPath: ticketOutcomeDocumentPath(document),
        document,
        bytes: encodeTicketOutcomeDocument(document),
      };
    },
    equivalent: sameTimestampIndependentIntent,
  });
  if (!("outcome_id" in result.prepared.document)) {
    throw new TicketLedgerError(
      "write_verification_failed",
      "Ticket outcome append returned another document kind",
    );
  }
  return {
    status: result.status,
    before: result.before,
    after: result.after,
    changedPaths: result.changedPaths,
    outcome: {
      documentPath: result.prepared.documentPath,
      document: result.prepared.document,
    },
    checkpointSelection: {
      source: result.after,
      changedPaths: result.changedPaths,
    },
  };
}
