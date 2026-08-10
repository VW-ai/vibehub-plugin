import Foundation

/// The inspector layer the shared frontend accepts through `?view=`.
public enum InspectorTab: String, CaseIterable, Sendable {
  case execution
  case contract
  case log

  /// The DOM tab id the shared frontend renders (`log` is labelled `evidence`).
  public var domTabId: String { self == .log ? "evidence" : rawValue }

  public init?(domTabId: String) {
    switch domTabId {
    case "execution": self = .execution
    case "contract": self = .contract
    case "evidence": self = .log
    default: return nil
    }
  }
}

/// §8.1 RepositorySession — deliberately non-semantic.
///
/// `branch`, `commit`, and `dirty` are read fresh from Git on every launch and
/// refresh; they are never restored from a preference. `selectedTicket` and
/// `selectedTab` are interface preference only and carry no Ticket authority.
///
/// `viewport` from §8.1 is intentionally absent: the shared frontend keeps
/// pan/zoom in a closure and exposes no viewport contract through its URL, so
/// the shell cannot restore it without forking the frontend. See
/// `PreferenceKey` for the honest persistence consequence.
public struct RepositorySession: Equatable, Sendable {
  public let repoRoot: String
  public let branch: String?
  public let commit: String
  public let dirty: Bool
  public var selectedTicket: String?
  public var selectedTab: InspectorTab?

  public init(
    repoRoot: String,
    branch: String?,
    commit: String,
    dirty: Bool,
    selectedTicket: String? = nil,
    selectedTab: InspectorTab? = nil
  ) {
    self.repoRoot = repoRoot
    self.branch = branch
    self.commit = commit
    self.dirty = dirty
    self.selectedTicket = selectedTicket
    self.selectedTab = selectedTab
  }

  public var displayName: String { (repoRoot as NSString).lastPathComponent }

  public var shortCommit: String { String(commit.prefix(7)) }
}

/// Canonical Ticket id shape shared with `skills/scripts/vh-ui.mjs`.
public func isCanonicalTicketId(_ value: String) -> Bool {
  guard !value.isEmpty else { return false }
  for segment in value.split(separator: "-", omittingEmptySubsequences: false) {
    if segment.isEmpty { return false }
    for character in segment.unicodeScalars {
      let lowercase = character.value >= 97 && character.value <= 122
      let digit = character.value >= 48 && character.value <= 57
      if !lowercase && !digit { return false }
    }
  }
  return true
}
