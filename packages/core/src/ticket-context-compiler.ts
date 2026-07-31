import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  type TicketContextRef,
} from "./ticket-ledger/contract.js";

export const TICKET_CONTEXT_MAX_FILES = 256;
export const TICKET_CONTEXT_MAX_FILE_BYTES = 256 * 1024;
export const TICKET_CONTEXT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface TicketContextManifestFile {
  path: string;
  digest: string;
  byteLength: number;
}

export interface CompiledTicketContextFile
  extends TicketContextManifestFile {
  content: string;
}

export interface TicketContextManifestEntry {
  ref: string;
  purpose: string;
  kind: "file" | "directory";
  files: TicketContextManifestFile[];
}

export interface CompiledTicketContextEntry
  extends TicketContextManifestEntry {
  files: CompiledTicketContextFile[];
}

export interface TicketContextFileCompilation {
  entries: CompiledTicketContextEntry[];
  fileCount: number;
  totalBytes: number;
  contentDigest: string;
}

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

const digest = (value: string | Buffer): string =>
  `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

export const ticketContextManifestDigest = (
  entries: readonly TicketContextManifestEntry[],
): string => digest(JSON.stringify(canonicalize(
  entries.map((entry) => ({
    ref: entry.ref,
    purpose: entry.purpose,
    kind: entry.kind,
    files: entry.files.map((file) => ({
      path: file.path,
      digest: file.digest,
      byteLength: file.byteLength,
    })),
  })),
)));

export const assertRepositoryPathExcludesGitAdministration = (
  value: string,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  if (value.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw new TicketLedgerError(
      "invalid_path",
      `Repository path cannot reference Git administration data: ${value}`,
      {
        ...details,
        repositoryPath: value,
        excludedSegment: ".git",
      },
    );
  }
};

const isTicketLedgerPath = (value: string): boolean => {
  const foldedSegments = value
    .split("/")
    .map((segment) => segment.toLowerCase());
  const foldedSemanticRoot = TICKET_LEDGER_RELATIVE_PATH
    .split("/")
    .map((segment) => segment.toLowerCase());
  const sharedLength = Math.min(
    foldedSegments.length,
    foldedSemanticRoot.length,
  );
  return Array.from({ length: sharedLength }).every((_, index) =>
    foldedSegments[index] === foldedSemanticRoot[index]);
};

const assertRepositoryPathExcludesTicketLedger = (
  value: string,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  if (!isTicketLedgerPath(value)) return;
  throw new TicketLedgerError(
    "invalid_path",
    `Ticket context cannot reference the semantic Ticket ledger: ${value}`,
    {
      ...details,
      ref: details.ref ?? value,
      path: value,
      excludedRoot: TICKET_LEDGER_RELATIVE_PATH,
    },
  );
};

const safeRepoPath = (value: string): string => {
  const segments = value.split("/");
  if (
    value.length === 0
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TicketLedgerError(
      "invalid_path",
      `Ticket context reference is not a safe repository path: ${value}`,
      { ref: value },
    );
  }
  assertRepositoryPathExcludesGitAdministration(value, { ref: value });
  assertRepositoryPathExcludesTicketLedger(value, { ref: value });
  return value;
};

export const assertTicketContextRefsExecutable = (
  contextRefs: readonly TicketContextRef[],
): void => {
  for (const contextRef of contextRefs) {
    safeRepoPath(contextRef.ref);
  }
};

const assertRealDirectoryPath = (
  worktreeRoot: string,
  relativePath: string,
): fs.Stats => {
  let current = worktreeRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (cause) {
      throw new TicketLedgerError(
        "invalid_path",
        `Required Ticket context is missing: ${relativePath}`,
        { ref: relativePath, path: current },
        { cause },
      );
    }
    if (stat.isSymbolicLink()) {
      throw new TicketLedgerError(
        "symlink",
        `Required Ticket context cannot traverse a symlink: ${relativePath}`,
        { ref: relativePath, path: current },
      );
    }
  }
  return fs.lstatSync(path.join(worktreeRoot, ...relativePath.split("/")));
};

const collectFiles = (
  worktreeRoot: string,
  relativePath: string,
  rootKind: "file" | "directory",
): string[] => {
  if (rootKind === "file") return [relativePath];
  const files: string[] = [];
  const visit = (directoryPath: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(
        path.join(worktreeRoot, ...directoryPath.split("/")),
        { withFileTypes: true },
      );
    } catch (cause) {
      throw new TicketLedgerError(
        "io",
        `Cannot enumerate required Ticket context: ${directoryPath}`,
        { ref: relativePath, path: directoryPath },
        { cause },
      );
    }
    for (const entry of entries.sort((left, right) =>
      compareText(left.name, right.name))) {
      const child = `${directoryPath}/${entry.name}`;
      assertRepositoryPathExcludesGitAdministration(child, {
        ref: relativePath,
        path: child,
      });
      assertRepositoryPathExcludesTicketLedger(child, {
        ref: relativePath,
        path: child,
      });
      if (entry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Required Ticket context cannot contain a symlink: ${child}`,
          { ref: relativePath, path: child },
        );
      }
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        files.push(child);
      } else {
        throw new TicketLedgerError(
          "unsupported_file",
          `Required Ticket context contains a non-regular path: ${child}`,
          { ref: relativePath, path: child },
        );
      }
      if (files.length > TICKET_CONTEXT_MAX_FILES) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Ticket context exceeds its ${TICKET_CONTEXT_MAX_FILES}-file limit`,
          {
            ref: relativePath,
            fileCount: files.length,
            maxFiles: TICKET_CONTEXT_MAX_FILES,
          },
        );
      }
    }
  };
  visit(relativePath);
  if (files.length === 0) {
    throw new TicketLedgerError(
      "invalid_document",
      `Required Ticket context directory is empty: ${relativePath}`,
      { ref: relativePath },
    );
  }
  return files;
};

const readContextFile = (
  worktreeRoot: string,
  relativePath: string,
): CompiledTicketContextFile => {
  const absolutePath = path.join(
    worktreeRoot,
    ...relativePath.split("/"),
  );
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(absolutePath);
    if (before.isSymbolicLink()) {
      throw new TicketLedgerError(
        "symlink",
        `Required Ticket context cannot be a symlink: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (!before.isFile()) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Required Ticket context is not a regular file: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (before.size > TICKET_CONTEXT_MAX_FILE_BYTES) {
      throw new TicketLedgerError(
        "file_too_large",
        `${relativePath} exceeds the Ticket context per-file limit`,
        {
          path: relativePath,
          byteLength: before.size,
          maxBytes: TICKET_CONTEXT_MAX_FILE_BYTES,
        },
      );
    }
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | noFollow,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Required Ticket context changed identity while opening: ${relativePath}`,
        { path: relativePath },
      );
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) {
        throw new TicketLedgerError(
          "source_changed_during_read",
          `Required Ticket context ended during read: ${relativePath}`,
          { path: relativePath },
        );
      }
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      throw new TicketLedgerError(
        "source_changed_during_read",
        `Required Ticket context changed during read: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (bytes.includes(0)) {
      throw new TicketLedgerError(
        "invalid_document",
        `Required Ticket context is binary: ${relativePath}`,
        { path: relativePath },
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new TicketLedgerError(
        "invalid_document",
        `Required Ticket context is not valid UTF-8: ${relativePath}`,
        { path: relativePath },
        { cause },
      );
    }
    return {
      path: relativePath,
      digest: digest(bytes),
      byteLength: bytes.byteLength,
      content,
    };
  } catch (cause) {
    if (cause instanceof TicketLedgerError) throw cause;
    throw new TicketLedgerError(
      "io",
      `Cannot read required Ticket context: ${relativePath}`,
      { path: relativePath },
      { cause },
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
};

const compileOnce = (
  worktreeRoot: string,
  contextRefs: readonly TicketContextRef[],
): TicketContextFileCompilation => {
  const entries: CompiledTicketContextEntry[] = [];
  const observedPaths = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  for (const contextRef of [...contextRefs].sort((left, right) =>
    compareText(left.ref, right.ref))) {
    const ref = safeRepoPath(contextRef.ref);
    const stat = assertRealDirectoryPath(worktreeRoot, ref);
    const kind = stat.isFile()
      ? "file" as const
      : stat.isDirectory()
        ? "directory" as const
        : null;
    if (kind === null) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Required Ticket context is not a regular file or directory: ${ref}`,
        { ref },
      );
    }
    const files = collectFiles(worktreeRoot, ref, kind).map((filePath) => {
      if (observedPaths.has(filePath)) {
        throw new TicketLedgerError(
          "invalid_document",
          `Ticket context references overlap at ${filePath}`,
          { ref, path: filePath },
        );
      }
      observedPaths.add(filePath);
      const file = readContextFile(worktreeRoot, filePath);
      fileCount += 1;
      totalBytes += file.byteLength;
      if (fileCount > TICKET_CONTEXT_MAX_FILES) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Ticket context exceeds its ${TICKET_CONTEXT_MAX_FILES}-file limit`,
          { fileCount, maxFiles: TICKET_CONTEXT_MAX_FILES },
        );
      }
      if (totalBytes > TICKET_CONTEXT_MAX_TOTAL_BYTES) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Ticket context exceeds its ${TICKET_CONTEXT_MAX_TOTAL_BYTES}-byte limit`,
          {
            totalBytes,
            maxBytes: TICKET_CONTEXT_MAX_TOTAL_BYTES,
          },
        );
      }
      return file;
    });
    entries.push({
      ref,
      purpose: contextRef.purpose,
      kind,
      files,
    });
  }
  return {
    entries,
    fileCount,
    totalBytes,
    contentDigest: ticketContextManifestDigest(entries),
  };
};

export const compileTicketContextFiles = (
  worktreeRoot: string,
  contextRefs: readonly TicketContextRef[],
): TicketContextFileCompilation => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = compileOnce(worktreeRoot, contextRefs);
    const second = compileOnce(worktreeRoot, contextRefs);
    if (
      first.contentDigest === second.contentDigest
      && first.fileCount === second.fileCount
      && first.totalBytes === second.totalBytes
    ) {
      return second;
    }
  }
  throw new TicketLedgerError(
    "source_changed_during_read",
    "Required Ticket context changed during compilation",
    { worktreeRoot },
  );
};
