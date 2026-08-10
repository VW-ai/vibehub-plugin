import Foundation

/// The complete §8.2 persistence allowlist. Nothing else is ever written.
///
/// Deliberately absent, and never written under any name:
/// - the bearer token (it lives only in the app session's memory),
/// - Ticket states, the READY frontier, Outcomes,
/// - any projected snapshot or cache of `.vibehub/`.
///
/// `viewport` (graph pan/zoom) is permitted by §8.2 but is **not** persisted:
/// the shared frontend keeps pan/zoom in a closure and accepts only
/// `?ticket=<id>&view=<execution|contract|log>`, so the shell has no honest way
/// to restore a viewport without forking the frontend. Restoring an
/// approximation would be a false claim, so the shell restores nothing here.
public enum PreferenceKey: String, CaseIterable, Sendable {
  case recentRepositories
  case windowFrame
  case lastTicketId
  case lastInspectorTab

  public static var allowlist: [String] { allCases.map(\.rawValue) }
}

/// Preference-only persistence for the Workbench shell.
///
/// Every Ticket state is recomputed from Git YAML by the read-only host on each
/// launch; this store holds interface preference and nothing authoritative.
public final class WorkbenchPreferences {
  /// A suite of its own, deliberately not the application's bundle domain:
  /// AppKit stores its own panel and window geometry in the bundle domain, and
  /// keeping VibeHub's preferences separate makes the §8.2 allowlist exactly
  /// auditable instead of mixed with framework state.
  public static let suiteName = "dev.vibehub.workbench.preferences"
  public static let recentLimit = 8

  private let defaults: UserDefaults

  public init(defaults: UserDefaults? = nil) {
    self.defaults = defaults ?? UserDefaults(suiteName: WorkbenchPreferences.suiteName)
      ?? .standard
  }

  // MARK: recent repositories

  public var recentRepositories: [String] {
    (defaults.array(forKey: PreferenceKey.recentRepositories.rawValue) as? [String]) ?? []
  }

  public func rememberRepository(_ path: String) {
    var recents = recentRepositories.filter { $0 != path }
    recents.insert(path, at: 0)
    defaults.set(
      Array(recents.prefix(WorkbenchPreferences.recentLimit)),
      forKey: PreferenceKey.recentRepositories.rawValue
    )
  }

  public func forgetRepository(_ path: String) {
    defaults.set(
      recentRepositories.filter { $0 != path },
      forKey: PreferenceKey.recentRepositories.rawValue
    )
  }

  // MARK: window frame

  public var windowFrame: String? {
    get { defaults.string(forKey: PreferenceKey.windowFrame.rawValue) }
    set { defaults.set(newValue, forKey: PreferenceKey.windowFrame.rawValue) }
  }

  // MARK: last selection, keyed by exact worktree

  public func lastTicketId(forRepository repoRoot: String) -> String? {
    dictionary(.lastTicketId)[repoRoot]
  }

  public func lastInspectorTab(forRepository repoRoot: String) -> InspectorTab? {
    dictionary(.lastInspectorTab)[repoRoot].flatMap(InspectorTab.init(rawValue:))
  }

  public func rememberSelection(
    ticketId: String?,
    tab: InspectorTab?,
    forRepository repoRoot: String
  ) {
    var tickets = dictionary(.lastTicketId)
    var tabs = dictionary(.lastInspectorTab)
    if let ticketId, isCanonicalTicketId(ticketId) {
      tickets[repoRoot] = ticketId
      tabs[repoRoot] = (tab ?? .execution).rawValue
    } else {
      tickets.removeValue(forKey: repoRoot)
      tabs.removeValue(forKey: repoRoot)
    }
    defaults.set(tickets, forKey: PreferenceKey.lastTicketId.rawValue)
    defaults.set(tabs, forKey: PreferenceKey.lastInspectorTab.rawValue)
  }

  private func dictionary(_ key: PreferenceKey) -> [String: String] {
    (defaults.dictionary(forKey: key.rawValue) as? [String: String]) ?? [:]
  }

  // MARK: audit

  /// Keys this app has written into its own suite. Used by `--probe-preferences`
  /// so the allowlist can be checked against a real running binary.
  public func writtenKeys() -> [String] {
    let persistent = defaults.persistentDomain(forName: WorkbenchPreferences.suiteName) ?? [:]
    return persistent.keys.sorted()
  }
}
