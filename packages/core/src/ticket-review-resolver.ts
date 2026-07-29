/**
 * Storage-agnostic source boundary for Ticket Review V0.
 *
 * A provider is not allowed to infer Ticket identity, graph semantics, or
 * capability currentness. It must return one atomic source whose
 * `currentCapabilityProjections` have already been selected for the exact
 * snapshot revision and projection watermark.
 *
 * The default production implementation is the independent Git-native Ticket
 * store. META specs, legacy Task rows, prototypes, and test fixtures remain
 * forbidden as production fallbacks when that store is absent.
 */

export interface TicketReviewRepositoryScopeV0 {
  /** Repository identity resolved by Core, never selected by operation input. */
  repoId: number;
  /** Canonical root of the registered repository. */
  repositoryRoot: string;
  /** Checkout/worktree whose repository identity Core already verified. */
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
   * The Git-native V0 authority defines this as the latest published,
   * whole-project generation in the verified worktree. Other providers must
   * define an equally explicit lifecycle rather than letting the projector
   * infer one.
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
   * provenance. The production provider therefore verifies the complete Git
   * scope and reconstructs immutable generations from the addressed worktree.
   */
  loadSnapshot(
    scope: TicketReviewRepositoryScopeV0,
    snapshotId: string,
  ): TicketReviewSnapshotSourceLoadV0;
}
