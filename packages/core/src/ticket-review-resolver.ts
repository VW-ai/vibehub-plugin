import {
  TicketLedgerError,
  loadTicketLedgerFromWorktree,
  projectTicketLedgerForReview,
  type TicketLedgerSnapshot,
} from "./ticket-ledger/index.js";
import {
  projectTicketLedgerForTrustedDecisionHostV0,
  type TicketDecisionAttestationVerifierV0,
} from "./ticket-decision-attestation.js";
import { deriveTicketReviewSnapshotIdV0 } from "./ticket-review-projector.js";
import {
  type TicketReviewProjectionSourceV0,
} from "./ticket-review-source.js";

/**
 * Storage-agnostic source boundary for Ticket Review V0.
 *
 * A provider is not allowed to infer Ticket identity, graph semantics, or
 * capability currentness. It must return one atomic source whose
 * `currentCapabilityProjections` have already been selected for the exact
 * snapshot revision and projection watermark.
 *
 * The default production implementation reads `.vibehub/tickets` directly
 * from the trusted worktree supplied by the host. SQLite repository/task rows,
 * legacy generations, META specs, prototypes, and test fixtures are forbidden
 * as production fallbacks.
 */

export interface TicketReviewRepositoryScopeV0 {
  /** Canonical trusted checkout/worktree bound by the host adapter. */
  worktreeRoot: string;
}

export type TicketReviewLatestSourceLoadV0 =
  | {
      status: "available";
      /**
       * Kept `unknown` deliberately: provider implementations are outside the
       * projector's trust boundary and every returned source is revalidated.
       */
      source: unknown;
    }
  | {
      status: "no_ticket_graph";
    };

export type TicketReviewSnapshotSourceLoadV0 =
  | {
      status: "available";
      source: unknown;
    }
  | {
      status: "snapshot_expired";
    };

export interface ResolvedTicketReviewProjectionSourceProviderV0 {
  /**
   * Load the provider's default coherent whole-project graph.
   *
   * The Git-native authority defines this as one coherent read of the current
   * worktree ledger, including uncommitted Ticket semantics.
   */
  loadLatest(
    scope: TicketReviewRepositoryScopeV0,
  ): TicketReviewLatestSourceLoadV0;

  /**
   * Reconstruct the exact source named by a previously returned snapshot.
   *
   * Implementations must not rely on process-local object identity or daemon
   * affinity. If the exact source cannot be reconstructed, return
   * `snapshot_expired` rather than substituting the latest graph.
   *
   * Snapshot lookup MUST be partitioned by the complete repository scope as
   * well as `snapshotId`; a globally keyed snapshot cache can transplant valid
   * facts and repo-path targets into the wrong checkout. The source shape is
   * structurally validated but does not self-authenticate repository
   * provenance. The production provider reloads the addressed worktree and
   * succeeds only while the complete source token still derives the requested
   * public snapshot.
   */
  loadSnapshot(
    scope: TicketReviewRepositoryScopeV0,
    snapshotId: string,
  ): TicketReviewSnapshotSourceLoadV0;
}

type TicketLedgerReviewProjectorV0 = (
  snapshot: TicketLedgerSnapshot,
) => TicketReviewProjectionSourceV0;

const loadLatestTicketLedgerSource = (
  scope: TicketReviewRepositoryScopeV0,
  projector: TicketLedgerReviewProjectorV0,
): TicketReviewLatestSourceLoadV0 => {
  try {
    return {
      status: "available",
      source: projector(
        loadTicketLedgerFromWorktree(scope.worktreeRoot),
      ),
    };
  } catch (error) {
    if (error instanceof TicketLedgerError
      && error.code === "ledger_missing") {
      return { status: "no_ticket_graph" };
    }
    throw error;
  }
};

const loadTicketLedgerSnapshotSource = (
  scope: TicketReviewRepositoryScopeV0,
  snapshotId: string,
  projector: TicketLedgerReviewProjectorV0,
): TicketReviewSnapshotSourceLoadV0 => {
  let source: TicketReviewProjectionSourceV0;
  try {
    source = projector(
      loadTicketLedgerFromWorktree(scope.worktreeRoot),
    );
  } catch (error) {
    if (error instanceof TicketLedgerError
      && error.code === "ledger_missing") {
      return { status: "snapshot_expired" };
    }
    throw error;
  }
  return deriveTicketReviewSnapshotIdV0(source) === snapshotId
    ? { status: "available", source }
    : { status: "snapshot_expired" };
};

/**
 * Current-worktree production provider. Exact historical reads are explicit
 * ledger ref loads; the review API reloads the current worktree and expires an
 * old snapshot as soon as its complete source changes.
 */
export class GitTicketLedgerReviewProjectionSourceProviderV0
implements ResolvedTicketReviewProjectionSourceProviderV0 {
  loadLatest(
    scope: TicketReviewRepositoryScopeV0,
  ): TicketReviewLatestSourceLoadV0 {
    return loadLatestTicketLedgerSource(
      scope,
      projectTicketLedgerForReview,
    );
  }

  loadSnapshot(
    scope: TicketReviewRepositoryScopeV0,
    snapshotId: string,
  ): TicketReviewSnapshotSourceLoadV0 {
    return loadTicketLedgerSnapshotSource(
      scope,
      snapshotId,
      projectTicketLedgerForReview,
    );
  }
}

/**
 * Internal trusted-host construction path. This factory is intentionally not
 * exported from the Core package root.
 */
export function createTrustedTicketLedgerReviewProjectionSourceProviderV0(
  verifier: TicketDecisionAttestationVerifierV0,
): ResolvedTicketReviewProjectionSourceProviderV0 {
  const projector = (snapshot: TicketLedgerSnapshot) =>
    projectTicketLedgerForTrustedDecisionHostV0(snapshot, verifier);
  return {
    loadLatest: (scope) =>
      loadLatestTicketLedgerSource(scope, projector),
    loadSnapshot: (scope, snapshotId) =>
      loadTicketLedgerSnapshotSource(scope, snapshotId, projector),
  };
}
