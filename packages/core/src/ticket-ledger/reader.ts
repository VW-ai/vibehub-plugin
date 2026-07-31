import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  GitError,
  GitFacade,
  type GitStatusPath,
} from "../git-facade.js";
import {
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_ATTESTATIONS,
  TICKET_LEDGER_MAX_CONTEXT_BINDINGS,
  TICKET_LEDGER_MAX_DECISIONS,
  TICKET_LEDGER_MAX_DIRTY_PATHS,
  TICKET_LEDGER_MAX_REVIEWS,
  TICKET_LEDGER_MAX_EVIDENCE,
  TICKET_LEDGER_MAX_OUTCOMES,
  TICKET_LEDGER_MAX_TICKETS,
  TICKET_LEDGER_RELATIVE_PATH,
  TICKET_LEDGER_STABLE_READ_ATTEMPTS,
  TicketLedgerError,
  type TicketLedgerContent,
  type TicketLedgerSnapshot,
} from "./contract.js";
import {
  decodeTicketLedger,
  isTicketLedgerDocumentPath,
  ticketLedgerCheckpointInventoryDigest,
  ticketLedgerDocumentMaxBytes,
  ticketLedgerInventoryDigest,
  ticketLedgerSourceToken,
  type TicketLedgerFile,
} from "./codec.js";
import { readTicketLedgerFileBounded } from "./file-io.js";

interface InventoryFile extends TicketLedgerFile {
  mode: number | string;
}

interface WorktreeCapture {
  head: string;
  status: readonly GitStatusPath[];
  inventory: readonly InventoryFile[];
}

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const canonicalPath = (value: string): string => {
  try {
    return fs.realpathSync.native(value);
  } catch (cause) {
    throw new TicketLedgerError(
      "io",
      `Cannot resolve canonical path ${value}`,
      { path: value },
      { cause },
    );
  }
};

const directoryIncarnation = (
  directoryPath: string,
): { canonicalDirectory: string; incarnation: string } => {
  const canonicalDirectory = canonicalPath(directoryPath);
  try {
    const stat = fs.statSync(canonicalDirectory, { bigint: true });
    return {
      canonicalDirectory,
      incarnation: [
        canonicalDirectory,
        stat.dev.toString(),
        stat.ino.toString(),
        stat.birthtimeNs.toString(),
      ].join("\0"),
    };
  } catch (cause) {
    throw new TicketLedgerError(
      "io",
      `Cannot resolve directory incarnation for ${canonicalDirectory}`,
      { path: canonicalDirectory },
      { cause },
    );
  }
};

const repositoryIdentity = (
  anyPath: string,
): { repositoryRoot: string; repositoryIncarnation: string } => {
  try {
    const repositoryRoot = canonicalPath(GitFacade.resolveRepoRoot(anyPath));
    const commonDir = canonicalPath(GitFacade.commonDirAt(anyPath));
    const commonDirStat = fs.statSync(commonDir);
    return {
      repositoryRoot,
      repositoryIncarnation: `repo-${sha256([
        commonDir,
        commonDirStat.dev,
        commonDirStat.ino,
      ].join("\0"))}`,
    };
  } catch (cause) {
    if (cause instanceof TicketLedgerError) throw cause;
    throw new TicketLedgerError(
      "git_error",
      `Cannot resolve Ticket ledger repository identity from ${anyPath}`,
      { path: anyPath },
      { cause },
    );
  }
};

const ensureDirectory = (directoryPath: string, missingIsLedger: boolean): void => {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (cause) {
    if (
      missingIsLedger
      && typeof cause === "object"
      && cause !== null
      && "code" in cause
      && cause.code === "ENOENT"
    ) {
      throw new TicketLedgerError(
        "ledger_missing",
        `Ticket ledger is missing at ${directoryPath}`,
        { path: directoryPath },
      );
    }
    throw new TicketLedgerError(
      "io",
      `Cannot inspect Ticket ledger directory ${directoryPath}`,
      { path: directoryPath },
      { cause },
    );
  }
  if (stat.isSymbolicLink()) {
    throw new TicketLedgerError(
      "symlink",
      `Ticket ledger directory cannot be a symlink: ${directoryPath}`,
      { path: directoryPath },
    );
  }
  if (!stat.isDirectory()) {
    throw new TicketLedgerError(
      "unsupported_file",
      `Ticket ledger path is not a directory: ${directoryPath}`,
      { path: directoryPath },
    );
  }
};

const readRegularFile = (
  absolutePath: string,
  documentPath: string,
): InventoryFile => {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  let descriptor: number | null = null;
  try {
    const before = fs.lstatSync(absolutePath);
    if (before.isSymbolicLink()) {
      throw new TicketLedgerError(
        "symlink",
        `Ticket ledger document cannot be a symlink: ${documentPath}`,
        { documentPath },
      );
    }
    if (!before.isFile()) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Ticket ledger document is not a regular file: ${documentPath}`,
        { documentPath },
      );
    }
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | noFollow | nonBlock,
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile()
      || stat.dev !== before.dev
      || stat.ino !== before.ino
    ) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Ticket ledger document changed type or identity while opening: ${documentPath}`,
        { documentPath },
      );
    }
    const maxBytes = ticketLedgerDocumentMaxBytes(documentPath);
    if (stat.size > maxBytes) {
      throw new TicketLedgerError(
        "file_too_large",
        `${documentPath} exceeds its ${maxBytes}-byte limit`,
        { documentPath, byteLength: stat.size, maxBytes },
      );
    }
    return {
      documentPath,
      mode: stat.mode & 0o7777,
      bytes: readTicketLedgerFileBounded(
        descriptor,
        documentPath,
        maxBytes,
      ),
    };
  } catch (cause) {
    if (cause instanceof TicketLedgerError) throw cause;
    if (
      typeof cause === "object"
      && cause !== null
      && "code" in cause
      && (cause.code === "ELOOP" || cause.code === "EMLINK")
    ) {
      throw new TicketLedgerError(
        "symlink",
        `Ticket ledger document cannot be a symlink: ${documentPath}`,
        { documentPath },
        { cause },
      );
    }
    throw new TicketLedgerError(
      "io",
      `Cannot read Ticket ledger document ${documentPath}`,
      { documentPath },
      { cause },
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
};

const unsupportedPath = (documentPath: string): never => {
  throw new TicketLedgerError(
    "unsupported_file",
    `Unsupported path inside Ticket ledger: ${documentPath}`,
    { documentPath },
  );
};

const readWorktreeInventory = (worktreeRoot: string): InventoryFile[] => {
  const vibehubDirectory = path.join(worktreeRoot, ".vibehub");
  const ledgerRoot = path.join(vibehubDirectory, "tickets");
  ensureDirectory(vibehubDirectory, true);
  ensureDirectory(ledgerRoot, true);

  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(ledgerRoot, { withFileTypes: true });
  } catch (cause) {
    throw new TicketLedgerError(
      "io",
      `Cannot list Ticket ledger at ${ledgerRoot}`,
      { path: ledgerRoot },
      { cause },
    );
  }

  const inventory: InventoryFile[] = [];
  let totalBytes = 0;
  const addFile = (file: InventoryFile): void => {
    totalBytes += file.bytes.byteLength;
    if (totalBytes > TICKET_LEDGER_MAX_BYTES) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger exceeds its ${TICKET_LEDGER_MAX_BYTES}-byte limit`,
        { totalBytes, maxBytes: TICKET_LEDGER_MAX_BYTES },
      );
    }
    inventory.push(file);
  };
  for (const entry of rootEntries) {
    if (entry.name === "protocol.yaml") {
      if (entry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          "Ticket ledger protocol cannot be a symlink",
          { documentPath: `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml` },
        );
      }
      addFile(readRegularFile(
        path.join(ledgerRoot, entry.name),
        `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`,
      ));
      continue;
    }
    if (
      entry.name === "tickets"
      || entry.name === "reviews"
      || entry.name === "decisions"
      || entry.name === "attestations"
      || entry.name === "context-bindings"
      || entry.name === "evidence"
      || entry.name === "outcomes"
    ) {
      if (entry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Ticket ledger ${entry.name} directory cannot be a symlink`,
          {
            documentPath:
              `${TICKET_LEDGER_RELATIVE_PATH}/${entry.name}`,
          },
        );
      }
      if (!entry.isDirectory()) {
        unsupportedPath(
          `${TICKET_LEDGER_RELATIVE_PATH}/${entry.name}`,
        );
      }
      continue;
    }
    unsupportedPath(`${TICKET_LEDGER_RELATIVE_PATH}/${entry.name}`);
  }

  const ticketsDirectory = path.join(ledgerRoot, "tickets");
  if (fs.existsSync(ticketsDirectory)) {
    ensureDirectory(ticketsDirectory, false);
    let ticketEntries: fs.Dirent[];
    try {
      ticketEntries = fs.readdirSync(ticketsDirectory, {
        withFileTypes: true,
      });
    } catch (cause) {
      throw new TicketLedgerError(
        "io",
        `Cannot list Ticket documents at ${ticketsDirectory}`,
        { path: ticketsDirectory },
        { cause },
      );
    }
    if (ticketEntries.length > TICKET_LEDGER_MAX_TICKETS) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} Ticket files`,
        { ticketCount: ticketEntries.length },
      );
    }
    for (const entry of ticketEntries) {
      const documentPath =
        `${TICKET_LEDGER_RELATIVE_PATH}/tickets/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Ticket document cannot be a symlink: ${documentPath}`,
          { documentPath },
        );
      }
      if (!entry.isFile() || !isTicketLedgerDocumentPath(documentPath)) {
        unsupportedPath(documentPath);
      }
      addFile(readRegularFile(
        path.join(ticketsDirectory, entry.name),
        documentPath,
      ));
    }
  }

  const reviewsDirectory = path.join(ledgerRoot, "reviews");
  if (fs.existsSync(reviewsDirectory)) {
    ensureDirectory(reviewsDirectory, false);
    let subjectEntries: fs.Dirent[];
    try {
      subjectEntries = fs.readdirSync(reviewsDirectory, {
        withFileTypes: true,
      });
    } catch (cause) {
      throw new TicketLedgerError(
        "io",
        `Cannot list Ticket review subjects at ${reviewsDirectory}`,
        { path: reviewsDirectory },
        { cause },
      );
    }
    if (subjectEntries.length > TICKET_LEDGER_MAX_REVIEWS) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger contains more than ${TICKET_LEDGER_MAX_REVIEWS} review subject directories`,
        { reviewSubjectCount: subjectEntries.length },
      );
    }
    let reviewCount = 0;
    for (const subjectEntry of subjectEntries) {
      const subjectPath =
        `${TICKET_LEDGER_RELATIVE_PATH}/reviews/${subjectEntry.name}`;
      if (subjectEntry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Ticket review subject directory cannot be a symlink: ${subjectPath}`,
          { documentPath: subjectPath },
        );
      }
      if (
        !subjectEntry.isDirectory()
        || !/^[0-9a-f]{64}$/u.test(subjectEntry.name)
      ) {
        unsupportedPath(subjectPath);
      }
      const subjectDirectory = path.join(
        reviewsDirectory,
        subjectEntry.name,
      );
      ensureDirectory(subjectDirectory, false);
      let reviewEntries: fs.Dirent[];
      try {
        reviewEntries = fs.readdirSync(subjectDirectory, {
          withFileTypes: true,
        });
      } catch (cause) {
        throw new TicketLedgerError(
          "io",
          `Cannot list Ticket reviews at ${subjectDirectory}`,
          { path: subjectDirectory },
          { cause },
        );
      }
      reviewCount += reviewEntries.length;
      if (reviewCount > TICKET_LEDGER_MAX_REVIEWS) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Ticket ledger contains more than ${TICKET_LEDGER_MAX_REVIEWS} review files`,
          { reviewCount },
        );
      }
      for (const entry of reviewEntries) {
        const documentPath = `${subjectPath}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw new TicketLedgerError(
            "symlink",
            `Ticket review cannot be a symlink: ${documentPath}`,
            { documentPath },
          );
        }
        if (!entry.isFile() || !isTicketLedgerDocumentPath(documentPath)) {
          unsupportedPath(documentPath);
        }
        addFile(readRegularFile(
          path.join(subjectDirectory, entry.name),
          documentPath,
        ));
      }
    }
  }

  const decisionsDirectory = path.join(ledgerRoot, "decisions");
  if (fs.existsSync(decisionsDirectory)) {
    ensureDirectory(decisionsDirectory, false);
    let decisionEntries: fs.Dirent[];
    try {
      decisionEntries = fs.readdirSync(decisionsDirectory, {
        withFileTypes: true,
      });
    } catch (cause) {
      throw new TicketLedgerError(
        "io",
        `Cannot list Ticket decisions at ${decisionsDirectory}`,
        { path: decisionsDirectory },
        { cause },
      );
    }
    if (decisionEntries.length > TICKET_LEDGER_MAX_DECISIONS) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger contains more than ${TICKET_LEDGER_MAX_DECISIONS} decision files`,
        { decisionCount: decisionEntries.length },
      );
    }
    for (const entry of decisionEntries) {
      const documentPath =
        `${TICKET_LEDGER_RELATIVE_PATH}/decisions/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Ticket decision cannot be a symlink: ${documentPath}`,
          { documentPath },
        );
      }
      if (!entry.isFile() || !isTicketLedgerDocumentPath(documentPath)) {
        unsupportedPath(documentPath);
      }
      addFile(readRegularFile(
        path.join(decisionsDirectory, entry.name),
        documentPath,
      ));
    }
  }

  const attestationsDirectory = path.join(ledgerRoot, "attestations");
  if (fs.existsSync(attestationsDirectory)) {
    ensureDirectory(attestationsDirectory, false);
    let decisionEntries: fs.Dirent[];
    try {
      decisionEntries = fs.readdirSync(attestationsDirectory, {
        withFileTypes: true,
      });
    } catch (cause) {
      throw new TicketLedgerError(
        "io",
        `Cannot list Ticket decision attestations at ${attestationsDirectory}`,
        { path: attestationsDirectory },
        { cause },
      );
    }
    if (decisionEntries.length > TICKET_LEDGER_MAX_ATTESTATIONS) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger contains more than ${TICKET_LEDGER_MAX_ATTESTATIONS} attestation Decision directories`,
        { attestationDecisionCount: decisionEntries.length },
      );
    }
    let attestationCount = 0;
    for (const decisionEntry of decisionEntries) {
      const decisionPath =
        `${TICKET_LEDGER_RELATIVE_PATH}/attestations/${decisionEntry.name}`;
      if (decisionEntry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Ticket attestation Decision directory cannot be a symlink: ${decisionPath}`,
          { documentPath: decisionPath },
        );
      }
      if (
        !decisionEntry.isDirectory()
        || !/^tdc-[0-9a-f]{64}$/u.test(decisionEntry.name)
      ) {
        unsupportedPath(decisionPath);
      }
      const decisionDirectory = path.join(
        attestationsDirectory,
        decisionEntry.name,
      );
      ensureDirectory(decisionDirectory, false);
      let attestationEntries: fs.Dirent[];
      try {
        attestationEntries = fs.readdirSync(decisionDirectory, {
          withFileTypes: true,
        });
      } catch (cause) {
        throw new TicketLedgerError(
          "io",
          `Cannot list Ticket attestations at ${decisionDirectory}`,
          { path: decisionDirectory },
          { cause },
        );
      }
      attestationCount += attestationEntries.length;
      if (attestationCount > TICKET_LEDGER_MAX_ATTESTATIONS) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Ticket ledger contains more than ${TICKET_LEDGER_MAX_ATTESTATIONS} attestation files`,
          { attestationCount },
        );
      }
      for (const entry of attestationEntries) {
        const documentPath = `${decisionPath}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw new TicketLedgerError(
            "symlink",
            `Ticket decision attestation cannot be a symlink: ${documentPath}`,
            { documentPath },
          );
        }
        if (!entry.isFile() || !isTicketLedgerDocumentPath(documentPath)) {
          unsupportedPath(documentPath);
        }
        addFile(readRegularFile(
          path.join(decisionDirectory, entry.name),
          documentPath,
        ));
      }
    }
  }

  const readTicketScopedDocuments = (
    directoryName: "context-bindings" | "evidence" | "outcomes",
    maximumDocuments: number,
  ): void => {
    const categoryDirectory = path.join(ledgerRoot, directoryName);
    if (!fs.existsSync(categoryDirectory)) return;
    ensureDirectory(categoryDirectory, false);
    let ticketEntries: fs.Dirent[];
    try {
      ticketEntries = fs.readdirSync(categoryDirectory, {
        withFileTypes: true,
      });
    } catch (cause) {
      throw new TicketLedgerError(
        "io",
        `Cannot list Ticket ${directoryName} subjects at ${categoryDirectory}`,
        { path: categoryDirectory },
        { cause },
      );
    }
    if (ticketEntries.length > TICKET_LEDGER_MAX_TICKETS) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} ${directoryName} subject directories`,
        { directoryName, subjectCount: ticketEntries.length },
      );
    }
    let documentCount = 0;
    for (const ticketEntry of ticketEntries) {
      const ticketPath =
        `${TICKET_LEDGER_RELATIVE_PATH}/${directoryName}/${ticketEntry.name}`;
      if (ticketEntry.isSymbolicLink()) {
        throw new TicketLedgerError(
          "symlink",
          `Ticket ${directoryName} subject directory cannot be a symlink: ${ticketPath}`,
          { documentPath: ticketPath },
        );
      }
      if (
        !ticketEntry.isDirectory()
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(ticketEntry.name)
      ) {
        unsupportedPath(ticketPath);
      }
      const ticketDirectory = path.join(
        categoryDirectory,
        ticketEntry.name,
      );
      ensureDirectory(ticketDirectory, false);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(ticketDirectory, {
          withFileTypes: true,
        });
      } catch (cause) {
        throw new TicketLedgerError(
          "io",
          `Cannot list Ticket ${directoryName} documents at ${ticketDirectory}`,
          { path: ticketDirectory },
          { cause },
        );
      }
      documentCount += entries.length;
      if (documentCount > maximumDocuments) {
        throw new TicketLedgerError(
          "ledger_too_large",
          `Ticket ledger contains more than ${maximumDocuments} ${directoryName} documents`,
          { directoryName, documentCount },
        );
      }
      for (const entry of entries) {
        const documentPath = `${ticketPath}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          throw new TicketLedgerError(
            "symlink",
            `Ticket ${directoryName} document cannot be a symlink: ${documentPath}`,
            { documentPath },
          );
        }
        if (!entry.isFile() || !isTicketLedgerDocumentPath(documentPath)) {
          unsupportedPath(documentPath);
        }
        addFile(readRegularFile(
          path.join(ticketDirectory, entry.name),
          documentPath,
        ));
      }
    }
  };

  readTicketScopedDocuments(
    "context-bindings",
    TICKET_LEDGER_MAX_CONTEXT_BINDINGS,
  );
  readTicketScopedDocuments("evidence", TICKET_LEDGER_MAX_EVIDENCE);
  readTicketScopedDocuments("outcomes", TICKET_LEDGER_MAX_OUTCOMES);

  return inventory.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.documentPath, "utf8"),
      Buffer.from(right.documentPath, "utf8"),
    ));
};

const treeInventoryAtCommit = (
  repositoryPath: string,
  commit: string,
): InventoryFile[] => {
  let entries;
  try {
    entries = GitFacade.listTreeFilesAt(
      repositoryPath,
      commit,
      TICKET_LEDGER_RELATIVE_PATH,
    );
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      `Cannot list Ticket ledger at commit ${commit}`,
      { commit },
      { cause },
    );
  }
  if (entries.length === 0) {
    let ancestors;
    try {
      ancestors = GitFacade.listTreeFilesAt(
        repositoryPath,
        commit,
        ".vibehub",
      );
    } catch (cause) {
      throw new TicketLedgerError(
        "git_error",
        `Cannot inspect Ticket ledger ancestors at commit ${commit}`,
        { commit },
        { cause },
      );
    }
    const invalidAncestor = ancestors.find((entry) =>
      entry.path === ".vibehub"
      || entry.path === TICKET_LEDGER_RELATIVE_PATH);
    if (invalidAncestor?.mode === "120000") {
      throw new TicketLedgerError(
        "symlink",
        `Ticket ledger ancestor cannot be a symlink: ${invalidAncestor.path}`,
        { documentPath: invalidAncestor.path, commit },
      );
    }
    if (invalidAncestor !== undefined) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Ticket ledger ancestor is not a directory: ${invalidAncestor.path}`,
        {
          documentPath: invalidAncestor.path,
          commit,
          mode: invalidAncestor.mode,
          objectType: invalidAncestor.objectType,
        },
      );
    }
    throw new TicketLedgerError(
      "ledger_missing",
      `Commit ${commit} has no Ticket ledger`,
      { commit },
    );
  }
  if (
    entries.length
    > TICKET_LEDGER_MAX_TICKETS
      + TICKET_LEDGER_MAX_REVIEWS
      + TICKET_LEDGER_MAX_DECISIONS
      + TICKET_LEDGER_MAX_ATTESTATIONS
      + TICKET_LEDGER_MAX_CONTEXT_BINDINGS
      + TICKET_LEDGER_MAX_EVIDENCE
      + TICKET_LEDGER_MAX_OUTCOMES
      + 1
  ) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} Ticket files`,
      { entryCount: entries.length, commit },
    );
  }

  const inventory: InventoryFile[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.mode === "120000") {
      throw new TicketLedgerError(
        "symlink",
        `Ticket ledger entry cannot be a symlink: ${entry.path}`,
        { documentPath: entry.path, commit },
      );
    }
    if (
      entry.objectType !== "blob"
      || (entry.mode !== "100644" && entry.mode !== "100755")
    ) {
      throw new TicketLedgerError(
        "unsupported_file",
        `Ticket ledger entry is not a regular blob: ${entry.path}`,
        {
          documentPath: entry.path,
          commit,
          mode: entry.mode,
          objectType: entry.objectType,
        },
      );
    }
    if (!isTicketLedgerDocumentPath(entry.path)) unsupportedPath(entry.path);
    const maxBytes = ticketLedgerDocumentMaxBytes(entry.path);
    if (entry.sizeBytes === null || entry.sizeBytes > maxBytes) {
      throw new TicketLedgerError(
        "file_too_large",
        `${entry.path} exceeds its ${maxBytes}-byte limit`,
        {
          documentPath: entry.path,
          commit,
          byteLength: entry.sizeBytes,
          maxBytes,
        },
      );
    }
    totalBytes += entry.sizeBytes;
    if (totalBytes > TICKET_LEDGER_MAX_BYTES) {
      throw new TicketLedgerError(
        "ledger_too_large",
        `Ticket ledger exceeds its ${TICKET_LEDGER_MAX_BYTES}-byte limit`,
        { totalBytes, maxBytes: TICKET_LEDGER_MAX_BYTES, commit },
      );
    }
    let bytes: Buffer;
    try {
      bytes = GitFacade.readFileAtCommit(repositoryPath, commit, entry.path);
    } catch (cause) {
      throw new TicketLedgerError(
        "git_error",
        `Cannot read ${entry.path} at commit ${commit}`,
        { documentPath: entry.path, commit },
        { cause },
      );
    }
    inventory.push({ documentPath: entry.path, mode: entry.mode, bytes });
  }
  return inventory;
};

const readContentAtCommit = (
  repositoryPath: string,
  commit: string,
): TicketLedgerContent =>
  decodeTicketLedger(treeInventoryAtCommit(repositoryPath, commit));

const compareStatus = (
  left: readonly GitStatusPath[],
  right: readonly GitStatusPath[],
): boolean =>
  left.length === right.length
  && left.every((value, index) => {
    const other = right[index];
    return other !== undefined
      && value.path === other.path
      && value.indexStatus === other.indexStatus
      && value.worktreeStatus === other.worktreeStatus
      && value.originalPath === other.originalPath
      && value.unmerged === other.unmerged;
  });

const compareInventory = (
  left: readonly InventoryFile[],
  right: readonly InventoryFile[],
): boolean =>
  left.length === right.length
  && left.every((value, index) => {
    const other = right[index];
    return other !== undefined
      && value.documentPath === other.documentPath
      && value.mode === other.mode
      && value.bytes.equals(other.bytes);
  });

const captureWorktree = (worktreeRoot: string): WorktreeCapture => {
  let head: string;
  let status: GitStatusPath[];
  try {
    head = GitFacade.headShaAt(worktreeRoot);
    status = GitFacade.statusPathsAt(
      worktreeRoot,
      TICKET_LEDGER_RELATIVE_PATH,
    );
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      `Cannot capture Ticket ledger Git state at ${worktreeRoot}`,
      { worktreeRoot },
      { cause },
    );
  }
  const conflicts = status.filter((item) => item.unmerged);
  if (conflicts.length > 0) {
    throw new TicketLedgerError(
      "unmerged",
      "Ticket ledger contains unmerged paths",
      { paths: conflicts.map((item) => item.path) },
    );
  }
  return {
    head,
    status,
    inventory: readWorktreeInventory(worktreeRoot),
  };
};

const readStableWorktree = (worktreeRoot: string): WorktreeCapture => {
  for (
    let attempt = 1;
    attempt <= TICKET_LEDGER_STABLE_READ_ATTEMPTS;
    attempt += 1
  ) {
    const first = captureWorktree(worktreeRoot);
    const second = captureWorktree(worktreeRoot);
    if (
      first.head === second.head
      && compareStatus(first.status, second.status)
      && compareInventory(first.inventory, second.inventory)
    ) {
      return second;
    }
  }
  throw new TicketLedgerError(
    "source_changed_during_read",
    `Ticket ledger changed during ${TICKET_LEDGER_STABLE_READ_ATTEMPTS} stable-read attempts`,
    { worktreeRoot, attempts: TICKET_LEDGER_STABLE_READ_ATTEMPTS },
  );
};

const dirtyPaths = (
  status: readonly GitStatusPath[],
): { paths: string[]; truncated: boolean } => {
  const all = [...new Set(status.flatMap((item) =>
    item.originalPath === undefined
      ? [item.path]
      : [item.path, item.originalPath]))]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return {
    paths: all.slice(0, TICKET_LEDGER_MAX_DIRTY_PATHS),
    truncated: all.length > TICKET_LEDGER_MAX_DIRTY_PATHS,
  };
};

export const loadTicketLedgerFromWorktree = (
  worktreePath: string,
): TicketLedgerSnapshot => {
  let session;
  try {
    session = GitFacade.sessionContextAt(worktreePath);
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      `Cannot resolve Ticket ledger worktree from ${worktreePath}`,
      { worktreePath },
      { cause },
    );
  }
  const worktreeRoot = canonicalPath(session.toplevel);
  const repository = repositoryIdentity(worktreeRoot);
  const stable = readStableWorktree(worktreeRoot);
  const content = decodeTicketLedger(stable.inventory);

  let committedGraphDigest: string | null;
  let committedSemanticLedgerDigest: string | null;
  try {
    const committed = readContentAtCommit(worktreeRoot, stable.head);
    committedGraphDigest = committed.graphDigest;
    committedSemanticLedgerDigest = committed.semanticLedgerDigest;
  } catch (cause) {
    if (
      cause instanceof TicketLedgerError
      && cause.code === "ledger_missing"
    ) {
      committedGraphDigest = null;
      committedSemanticLedgerDigest = null;
    } else {
      throw cause;
    }
  }

  let worktreeIdentity: string;
  try {
    const administrativeHead = GitFacade.gitPathAt(worktreeRoot, "HEAD");
    const administrativeDirectory =
      directoryIncarnation(path.dirname(administrativeHead));
    worktreeIdentity =
      `worktree-${sha256(administrativeDirectory.incarnation)}`;
  } catch (cause) {
    if (cause instanceof TicketLedgerError) throw cause;
    throw new TicketLedgerError(
      "git_error",
      `Cannot resolve worktree identity for ${worktreeRoot}`,
      { worktreeRoot },
      { cause },
    );
  }
  const dirty = dirtyPaths(stable.status);
  const checkpointInventoryDigest =
    ticketLedgerCheckpointInventoryDigest(stable.inventory);
  const sourceToken = ticketLedgerSourceToken({
    mode: "worktree",
    repositoryIncarnation: repository.repositoryIncarnation,
    worktreeIdentity,
    resolvedCommit: stable.head,
    graphDigest: content.graphDigest,
    semanticLedgerDigest: content.semanticLedgerDigest,
    inventoryDigest: ticketLedgerInventoryDigest(stable.inventory),
  });

  return {
    ...content,
    source: {
      mode: "worktree",
      ...repository,
      worktreeIdentity,
      worktreeRoot,
      branch: GitFacade.currentBranchAt(worktreeRoot),
      resolvedCommit: stable.head,
      graphDigest: content.graphDigest,
      semanticLedgerDigest: content.semanticLedgerDigest,
      committedGraphDigest,
      committedSemanticLedgerDigest,
      checkpointInventoryDigest,
      semanticDirty:
        committedSemanticLedgerDigest !== content.semanticLedgerDigest,
      dirtyPaths: dirty.paths,
      dirtyPathsTruncated: dirty.truncated,
      sourceToken,
    },
  };
};

export const loadTicketLedgerAtRef = (
  repositoryPath: string,
  ref: string,
): TicketLedgerSnapshot => {
  const repository = repositoryIdentity(repositoryPath);
  let resolvedCommit: string;
  try {
    resolvedCommit = GitFacade.resolveCommitAt(repositoryPath, ref);
  } catch (cause) {
    if (cause instanceof GitError) {
      throw new TicketLedgerError(
        "ref_not_found",
        `Cannot resolve Ticket ledger ref ${ref}`,
        { requestedRef: ref },
        { cause },
      );
    }
    throw cause;
  }
  const inventory = treeInventoryAtCommit(repositoryPath, resolvedCommit);
  const content = decodeTicketLedger(inventory);
  const checkpointInventoryDigest =
    ticketLedgerCheckpointInventoryDigest(inventory);
  const sourceToken = ticketLedgerSourceToken({
    mode: "ref",
    repositoryIncarnation: repository.repositoryIncarnation,
    resolvedCommit,
    graphDigest: content.graphDigest,
    semanticLedgerDigest: content.semanticLedgerDigest,
    inventoryDigest: ticketLedgerInventoryDigest(inventory),
  });
  return {
    ...content,
    source: {
      mode: "ref",
      ...repository,
      requestedRef: ref,
      resolvedCommit,
      graphDigest: content.graphDigest,
      semanticLedgerDigest: content.semanticLedgerDigest,
      checkpointInventoryDigest,
      sourceToken,
    },
  };
};
