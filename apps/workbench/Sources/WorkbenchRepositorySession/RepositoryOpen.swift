import Foundation

/// Opening a repository, minus the window.
///
/// Validation and remembered-list hygiene live together in one place so the
/// launch picker, the `Open Repository…` menu item, the recent-repositories
/// submenu, a `vibehub://` link, and the headless probes cannot drift into
/// several different answers about what a failure means.
public enum RepositoryOpen {
  /// Validates the exact worktree and keeps the remembered list honest.
  ///
  /// The validation is `GitMetadata.readSession` and nothing else: the same
  /// check a directory chosen in `NSOpenPanel` gets. What this adds is the one
  /// decision the remembered list needs — a failure that is a permanent property
  /// of the path drops the entry, and a transient failure keeps it. Neither
  /// branch reads or writes anything inside the repository.
  public static func attempt(
    repoRoot: String,
    preferences: WorkbenchPreferences
  ) -> Result<RepositorySession, WorktreeError> {
    do {
      return .success(try GitMetadata.readSession(repoRoot: repoRoot))
    } catch let error as WorktreeError {
      if error.isPermanent {
        // Exactly the string the user's remembered list holds, so the entry that
        // just failed is the entry that goes.
        preferences.forgetRepository(repoRoot)
      }
      return .failure(error)
    } catch {
      // `GitMetadata` throws nothing else; anything that reaches here is treated
      // as the transient class, because dropping a repository on an error this
      // code does not understand would be the worse mistake.
      return .failure(.gitFailed(error.localizedDescription))
    }
  }
}
