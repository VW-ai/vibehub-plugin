import fs from "node:fs";
import { GitFacade } from "../git-facade.js";
import {
  commitGitCheckpoint,
  prepareGitCheckpoint,
  type GitCheckpointReceipt,
  type GitCheckpointScope,
} from "../git-checkpoint.js";
import {
  TICKET_LEDGER_MAX_PATCH_CHANGES,
  TICKET_LEDGER_RELATIVE_PATH,
  TicketLedgerError,
  type TicketLedgerCheckpointSelection,
  type TicketLedgerPatchSource,
  type TicketLedgerSnapshot,
} from "./contract.js";
import { isTicketLedgerDocumentPath } from "./codec.js";
import {
  loadTicketLedgerAtRef,
  loadTicketLedgerFromWorktree,
} from "./reader.js";

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GRAPH_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_TOKEN = /^tls-[0-9a-f]{64}$/u;
const WORKTREE_IDENTITY = /^worktree-[0-9a-f]{64}$/u;
const TICKET_PROTOCOL_PATH = `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`;

export interface TicketCheckpointReceipt {
  schemaVersion: 1;
  branch: string;
  headSha: string;
  sourceToken: string;
  worktreeIdentity: string;
  graphDigest: string;
  semanticLedgerDigest: string;
  checkpointInventoryDigest: string;
  changedPaths: string[];
}

export interface TicketCheckpointResult {
  status: "committed" | "noop";
  branch: string;
  beforeHeadSha: string;
  commitSha: string;
  graphDigest: string;
  semanticLedgerDigest: string;
  changedPaths: string[];
}

export interface PrepareTicketCheckpointOptions {
  repoRoot: string;
  checkpointSelection: TicketLedgerCheckpointSelection;
  protectedBranches?: string[];
}

export interface TicketCheckpointCommitOptions {
  repoRoot: string;
  receipt: TicketCheckpointReceipt;
  actor: string;
  taskId?: string;
  requestId: string;
  now: string;
  protectedBranches?: string[];
}

const sha256Ref = (digest: string): string => `sha256:${digest}`;

const patchSource = (
  snapshot: TicketLedgerSnapshot,
): TicketLedgerPatchSource => {
  if (snapshot.source.mode !== "worktree") {
    throw new TicketLedgerError(
      "invalid_path",
      "Ticket checkpoint requires a worktree source",
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

const canonicalWorktreeRoot = (repoRoot: string): string => {
  try {
    return fs.realpathSync(GitFacade.sessionContextAt(repoRoot).toplevel);
  } catch (cause) {
    throw new TicketLedgerError(
      "git_error",
      "Ticket checkpoint scope is not a readable Git worktree",
      { repoRoot },
      { cause },
    );
  }
};

const comparePaths = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const parseSelection = (
  selection: TicketLedgerCheckpointSelection,
): TicketLedgerCheckpointSelection => {
  if (
    selection === null
    || typeof selection !== "object"
    || selection.source === null
    || typeof selection.source !== "object"
    || !Array.isArray(selection.changedPaths)
  ) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket checkpoint selection is invalid",
    );
  }
  const source = selection.source;
  if (
    !SOURCE_TOKEN.test(source.sourceToken)
    || !WORKTREE_IDENTITY.test(source.worktreeIdentity)
    || !COMMIT_ID.test(source.resolvedCommit)
    || !GRAPH_DIGEST.test(source.graphDigest)
    || !GRAPH_DIGEST.test(source.semanticLedgerDigest)
  ) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket checkpoint source is invalid",
      { source },
    );
  }
  if (selection.changedPaths.length > TICKET_LEDGER_MAX_PATCH_CHANGES) {
    throw new TicketLedgerError(
      "invalid_document",
      "Ticket checkpoint selection contains too many paths",
      {
        pathCount: selection.changedPaths.length,
        maximum: TICKET_LEDGER_MAX_PATCH_CHANGES,
      },
    );
  }
  const changedPaths = selection.changedPaths.map((documentPath) => {
    if (
      typeof documentPath !== "string"
      || !isTicketLedgerDocumentPath(documentPath)
      || documentPath === TICKET_PROTOCOL_PATH
    ) {
      throw new TicketLedgerError(
        "invalid_path",
        `Ticket checkpoint path is not a mutable semantic document: ${String(documentPath)}`,
        { documentPath },
      );
    }
    return documentPath;
  });
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new TicketLedgerError(
      "duplicate_change",
      "Ticket checkpoint selection contains a duplicate path",
      { changedPaths },
    );
  }
  return {
    source: { ...source },
    changedPaths: changedPaths.sort(comparePaths),
  };
};

const assertSource = (
  expected: TicketLedgerPatchSource,
  actual: TicketLedgerPatchSource,
): void => {
  const mismatches = (
    Object.keys(actual) as Array<keyof TicketLedgerPatchSource>
  ).filter((field) => expected[field] !== actual[field]);
  if (mismatches.length > 0) {
    throw new TicketLedgerError(
      "stale_source",
      "Ticket checkpoint selection no longer matches the worktree",
      { expected, actual, mismatches },
    );
  }
};

const ticketCheckpointScope: GitCheckpointScope = {
  label: "ticket checkpoint",
  relativeRoot: TICKET_LEDGER_RELATIVE_PATH,
  commitSubject: "chore(vibehub): ticket checkpoint",
  reflogMessage: "vibehub ticket checkpoint",
  digestTrailer: "VibeHub-Ticket-Semantic-Ledger-Digest",
  inspectWorktree(repoRoot) {
    const snapshot = loadTicketLedgerFromWorktree(repoRoot);
    if (snapshot.source.mode !== "worktree") {
      throw new TicketLedgerError(
        "invalid_path",
        "Ticket checkpoint requires a worktree source",
      );
    }
    return {
      digest: sha256Ref(snapshot.semanticLedgerDigest),
      sourceIdentity: sha256Ref(
        snapshot.source.checkpointInventoryDigest,
      ),
    };
  },
  inspectCommit(repoRoot, commitSha) {
    const snapshot = loadTicketLedgerAtRef(repoRoot, commitSha);
    return {
      digest: sha256Ref(snapshot.semanticLedgerDigest),
      sourceIdentity: sha256Ref(
        snapshot.source.checkpointInventoryDigest,
      ),
    };
  },
};

const prepareAtWorktree = (
  worktreeRoot: string,
  selectionValue: TicketLedgerCheckpointSelection,
  protectedBranches: readonly string[],
): TicketCheckpointReceipt => {
  const selection = parseSelection(selectionValue);
  const snapshot = loadTicketLedgerFromWorktree(worktreeRoot);
  const actual = patchSource(snapshot);
  assertSource(selection.source, actual);
  const receipt = prepareGitCheckpoint({
    repoRoot: worktreeRoot,
    scope: ticketCheckpointScope,
    protectedBranches,
    expectedHeadSha: selection.source.resolvedCommit,
    expectedDigest: selection.source.semanticLedgerDigest,
    expectedSourceIdentity: sha256Ref(
      snapshot.source.checkpointInventoryDigest,
    ),
    expectedChangedPaths: selection.changedPaths,
  });
  return {
    schemaVersion: 1,
    branch: receipt.branch,
    headSha: receipt.headSha,
    sourceToken: selection.source.sourceToken,
    checkpointInventoryDigest:
      receipt.sourceIdentity
      ?? sha256Ref(snapshot.source.checkpointInventoryDigest),
    worktreeIdentity: selection.source.worktreeIdentity,
    graphDigest: selection.source.graphDigest,
    semanticLedgerDigest: receipt.digest,
    changedPaths: receipt.changedPaths,
  };
};

export function prepareTicketCheckpoint(
  options: PrepareTicketCheckpointOptions,
): TicketCheckpointReceipt {
  return prepareAtWorktree(
    canonicalWorktreeRoot(options.repoRoot),
    options.checkpointSelection,
    options.protectedBranches ?? [],
  );
}

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length
  && left.every((value, index) => value === right[index]);

const sameTicketReceipt = (
  expected: TicketCheckpointReceipt,
  actual: TicketCheckpointReceipt,
): boolean =>
  expected.schemaVersion === 1
  && expected.branch === actual.branch
  && expected.headSha === actual.headSha
  && expected.sourceToken === actual.sourceToken
  && expected.checkpointInventoryDigest
    === actual.checkpointInventoryDigest
  && expected.worktreeIdentity === actual.worktreeIdentity
  && expected.graphDigest === actual.graphDigest
  && expected.semanticLedgerDigest === actual.semanticLedgerDigest
  && sameStrings(expected.changedPaths, actual.changedPaths);

const selectionFromReceipt = (
  receipt: TicketCheckpointReceipt,
): TicketLedgerCheckpointSelection => ({
  source: {
    sourceToken: receipt.sourceToken,
    worktreeIdentity: receipt.worktreeIdentity,
    resolvedCommit: receipt.headSha,
    graphDigest: receipt.graphDigest,
    semanticLedgerDigest: receipt.semanticLedgerDigest,
  },
  changedPaths: receipt.changedPaths,
});

const gitReceipt = (
  receipt: TicketCheckpointReceipt,
): GitCheckpointReceipt => ({
  schemaVersion: receipt.schemaVersion,
  branch: receipt.branch,
  headSha: receipt.headSha,
  digest: receipt.semanticLedgerDigest,
  sourceIdentity: receipt.checkpointInventoryDigest,
  changedPaths: receipt.changedPaths,
});

export function commitTicketCheckpoint(
  options: TicketCheckpointCommitOptions,
): TicketCheckpointResult {
  const worktreeRoot = canonicalWorktreeRoot(options.repoRoot);
  const selection = parseSelection(selectionFromReceipt(options.receipt));
  const current = prepareAtWorktree(
    worktreeRoot,
    selection,
    options.protectedBranches ?? [],
  );
  if (!sameTicketReceipt(options.receipt, current)) {
    throw new Error("ticket checkpoint: receipt is stale");
  }
  const result = commitGitCheckpoint({
    repoRoot: worktreeRoot,
    scope: ticketCheckpointScope,
    receipt: gitReceipt(current),
    actor: options.actor,
    taskId: options.taskId,
    requestId: options.requestId,
    now: options.now,
    protectedBranches: options.protectedBranches,
    expectedHeadSha: selection.source.resolvedCommit,
    expectedDigest: selection.source.semanticLedgerDigest,
    expectedSourceIdentity: current.checkpointInventoryDigest,
    expectedChangedPaths: selection.changedPaths,
  });
  const { digest, ...checkpoint } = result;
  return {
    ...checkpoint,
    graphDigest: current.graphDigest,
    semanticLedgerDigest: digest,
  };
}
