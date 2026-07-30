import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GitFacade } from "../git-facade.js";
import {
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_PATCH_CHANGES,
  TICKET_LEDGER_PROTOCOL_MAX_BYTES,
  TICKET_LEDGER_RELATIVE_PATH,
  TICKET_LEDGER_TICKET_MAX_BYTES,
  TicketLedgerError,
  ticketDocumentSchema,
  type TicketDocument,
  type TicketLedgerPatchChange,
  type TicketLedgerPatchRequest,
  type TicketLedgerPatchResult,
  type TicketLedgerPatchSource,
  type TicketLedgerPatchTicketResult,
  type TicketLedgerSnapshot,
} from "./contract.js";
import {
  canonicalTicketLedgerValue,
  encodeTicketDocument,
  normalizeTicketDocument,
  ticketDocumentPath,
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
    const maxBytes = documentPath.endsWith("/protocol.yaml")
      ? TICKET_LEDGER_PROTOCOL_MAX_BYTES
      : TICKET_LEDGER_TICKET_MAX_BYTES;
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
  });
  return {
    changes: prepared.sort((left, right) =>
      compareText(left.request.ticketId, right.request.ticketId)),
    targetGraphDigest: prospective.graphDigest,
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
