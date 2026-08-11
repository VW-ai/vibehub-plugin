import Foundation

/// §9 deep link: `vibehub://open?repo=<absolute-path>&ticket=<id>&view=<execution|contract|log>`.
///
/// The type is deliberately total: a `DeepLink` value can express a repository,
/// a Ticket, and an inspector layer, and **nothing else**. There is no field a
/// write could travel in, so "navigation only" is a property of the type rather
/// than a rule the handler has to remember.
///
/// `view` mirrors the launcher rule in `skills/scripts/vh-ui.mjs`: it is one of
/// exactly three layers and it requires a Ticket.
public struct DeepLink: Equatable, Sendable {
  /// Absolute, standardized worktree path. Still unvalidated as a repository:
  /// `GitMetadata.readSession` is the only thing that decides that, exactly as
  /// it does for a path chosen in `NSOpenPanel`.
  public let repoRoot: String
  public let ticketId: String?
  public let view: InspectorTab?

  public init(repoRoot: String, ticketId: String? = nil, view: InspectorTab? = nil) {
    self.repoRoot = repoRoot
    self.ticketId = ticketId
    self.view = view
  }

  public static let scheme = "vibehub"
  public static let action = "open"
  public static let parameters = ["repo", "ticket", "view"]
}

/// Every way a URI can fail to be a deep link. Each case is a refusal, never a
/// repair: a malformed link opens nothing, reads no repository, and changes no
/// preference.
public enum DeepLinkError: Error, LocalizedError, Equatable {
  case malformedURI(String)
  case unsupportedScheme(String)
  case unsupportedAction(String)
  case unsupportedComponent(String)
  case unknownParameter(String)
  case repeatedParameter(String)
  case missingRepository
  case repositoryNotAbsolute(String)
  case repositoryTraversal(String)
  case malformedTicket(String)
  case unsupportedView(String)
  case viewWithoutTicket

  public var errorDescription: String? {
    switch self {
    case .malformedURI(let text):
      return "\(text) is not a valid URI."
    case .unsupportedScheme(let scheme):
      return "\(scheme):// is not a VibeHub deep link. Expected \(DeepLink.scheme)://."
    case .unsupportedAction(let action):
      return "\(DeepLink.scheme)://\(action) is not a supported action. Expected \(DeepLink.scheme)://\(DeepLink.action)."
    case .unsupportedComponent(let component):
      return "A VibeHub deep link carries no \(component)."
    case .unknownParameter(let name):
      return "\(name) is not a deep link parameter. Only repo, ticket, and view are read."
    case .repeatedParameter(let name):
      return "\(name) was given more than once."
    case .missingRepository:
      return "repo is required: a deep link always names the exact worktree it opens."
    case .repositoryNotAbsolute(let path):
      return "repo must be an absolute path. \(path) is not."
    case .repositoryTraversal(let path):
      return "repo must not traverse directories. \(path) does."
    case .malformedTicket(let value):
      return "ticket must be a canonical Ticket ID. \(value) is not."
    case .unsupportedView(let value):
      return "view must be execution, contract, or log. \(value) is not."
    case .viewWithoutTicket:
      return "view requires ticket."
    }
  }
}

extension DeepLink {
  /// Parses a URI into a deep link, or throws.
  ///
  /// Pure: it touches no filesystem, starts no host, and writes nothing, so an
  /// unknown scheme, an unknown parameter, a traversing path, or any other
  /// malformed URI costs exactly one rejected string.
  public static func parse(_ text: String) throws -> DeepLink {
    guard let components = URLComponents(string: text), components.scheme != nil else {
      throw DeepLinkError.malformedURI(text)
    }
    let scheme = (components.scheme ?? "").lowercased()
    guard scheme == DeepLink.scheme else { throw DeepLinkError.unsupportedScheme(scheme) }
    let action = (components.host ?? "").lowercased()
    guard action == DeepLink.action else { throw DeepLinkError.unsupportedAction(action) }
    guard components.path.isEmpty || components.path == "/" else {
      throw DeepLinkError.unsupportedAction(action + components.path)
    }
    // A deep link is a plain query. Credentials, a port, or a fragment would all
    // be carrying something the contract does not define, so they are refused
    // rather than ignored — a fragment in particular is where a token would hide.
    if components.user != nil { throw DeepLinkError.unsupportedComponent("user") }
    if components.password != nil { throw DeepLinkError.unsupportedComponent("password") }
    if components.port != nil { throw DeepLinkError.unsupportedComponent("port") }
    if components.fragment != nil { throw DeepLinkError.unsupportedComponent("fragment") }

    var values: [String: String] = [:]
    for item in components.queryItems ?? [] {
      guard DeepLink.parameters.contains(item.name) else {
        throw DeepLinkError.unknownParameter(item.name)
      }
      guard values[item.name] == nil else { throw DeepLinkError.repeatedParameter(item.name) }
      values[item.name] = item.value ?? ""
    }

    guard let rawRepository = values["repo"], !rawRepository.isEmpty else {
      throw DeepLinkError.missingRepository
    }
    guard rawRepository.hasPrefix("/") else {
      throw DeepLinkError.repositoryNotAbsolute(rawRepository)
    }
    guard !rawRepository.split(separator: "/").contains("..") else {
      throw DeepLinkError.repositoryTraversal(rawRepository)
    }
    let repoRoot = URL(fileURLWithPath: rawRepository).standardizedFileURL.path

    var ticketId: String?
    if let rawTicket = values["ticket"] {
      guard isCanonicalTicketId(rawTicket) else { throw DeepLinkError.malformedTicket(rawTicket) }
      ticketId = rawTicket
    }

    var view: InspectorTab?
    if let rawView = values["view"] {
      guard let parsed = InspectorTab(rawValue: rawView) else {
        throw DeepLinkError.unsupportedView(rawView)
      }
      guard ticketId != nil else { throw DeepLinkError.viewWithoutTicket }
      view = parsed
    }

    return DeepLink(repoRoot: repoRoot, ticketId: ticketId, view: view)
  }

  /// The URI an inspector or an Agent would write for this link.
  public var uri: String {
    var components = URLComponents()
    components.scheme = DeepLink.scheme
    components.host = DeepLink.action
    var items = [URLQueryItem(name: "repo", value: repoRoot)]
    if let ticketId {
      items.append(URLQueryItem(name: "ticket", value: ticketId))
      items.append(URLQueryItem(name: "view", value: (view ?? .execution).rawValue))
    }
    components.queryItems = items
    return components.string ?? ""
  }
}

/// What a deep link is allowed to do next, given what this app session is
/// already showing.
///
/// Both confirmation cases exist because a deep link can arrive from anywhere —
/// a chat message, a script, an Agent. Opening a repository the user has never
/// opened, or swapping the project under a window they are reading, are user
/// decisions, so the planner returns a question instead of an action.
public enum DeepLinkResolution: Equatable, Sendable {
  /// The link names the repository this session already has open.
  case focusCurrentSession
  /// No session yet, and the user has opened this worktree before.
  case openKnownRepository
  /// No session yet, and this worktree is new to the Workbench.
  case confirmFirstUse
  /// A session is open on a different worktree.
  case confirmSwitch(from: String)

  public var requiresConfirmation: Bool {
    switch self {
    case .confirmFirstUse, .confirmSwitch: return true
    case .focusCurrentSession, .openKnownRepository: return false
    }
  }

  public var name: String {
    switch self {
    case .focusCurrentSession: return "focus-current-session"
    case .openKnownRepository: return "open-known-repository"
    case .confirmFirstUse: return "confirm-first-use"
    case .confirmSwitch: return "confirm-switch"
    }
  }
}

/// A question the user has to answer before a deep link may open anything.
public struct ConfirmationPrompt: Equatable, Sendable {
  public let title: String
  public let detail: String
  public let affirmative: String
  public let cancel: String
}

/// Who asked for a repository.
///
/// Both entry points — a `vibehub://` link and the in-app `Open Repository…` or
/// recent-repositories menu — ask the same question, with the same title, the
/// same two buttons, the same two paths, and the same consequence. Only the one
/// line naming the requester differs, because telling someone who just picked a
/// worktree from a menu that "a vibehub:// link asked for" it would be false.
public enum RepositoryRequester: Equatable, Sendable {
  case deepLink
  case userSelection

  /// The line that introduces the requested worktree.
  public var requestPhrase: String {
    switch self {
    case .deepLink: return "A vibehub:// link asked for:"
    case .userSelection: return "You asked to open:"
    }
  }
}

/// The exact questions §9.2 and §9.3 require, kept beside the rule so the sheet
/// the user reads and the headless probe are the same words.
public enum ConfirmationPrompts {
  public static func firstUse(repoRoot: String) -> ConfirmationPrompt {
    ConfirmationPrompt(
      title: "Open this repository in the Workbench?",
      detail: """
        A vibehub:// link asked to open a repository this Workbench has not opened before:

        \(repoRoot)

        The Workbench only reads the checked-in Ticket graph. Nothing is opened until you confirm.
        """,
      affirmative: "Open Repository",
      cancel: "Cancel"
    )
  }

  /// The one switch question, asked identically however the switch was
  /// requested. `requestedBy` changes nothing but the line that names who asked.
  public static func switchRepository(
    from current: String,
    to requested: String,
    requestedBy requester: RepositoryRequester = .deepLink
  ) -> ConfirmationPrompt {
    ConfirmationPrompt(
      title: "Switch the Workbench to a different repository?",
      detail: """
        This Workbench is open on:

        \(current)

        \(requester.requestPhrase)

        \(requested)

        Switching ends the current read-only session and starts one for the other worktree.
        """,
      affirmative: "Switch Repository",
      cancel: "Stay Here"
    )
  }
}

/// The exact words the shell uses for §9.4, kept beside the rule so the window
/// sheet and the headless probe state the same thing rather than two versions
/// of it.
public enum MissingTicketStatement {
  public static func title(_ ticketId: String) -> String {
    "\(ticketId) is not in this worktree."
  }

  public static func detail(ticketId: String, worktree: String) -> String {
    """
    The repository is open and its checked-in Ticket graph is shown, but \
    \(worktree) checks in no Ticket with the ID \(ticketId). Nothing was \
    created: the Workbench only reads.
    """
  }
}

public enum DeepLinkPlanner {
  /// Decides the §9 behaviour without performing it.
  public static func resolve(
    link: DeepLink,
    currentRepository: String?,
    knownRepositories: [String]
  ) -> DeepLinkResolution {
    let requested = canonical(link.repoRoot)
    if let currentRepository {
      let current = canonical(currentRepository)
      return current == requested ? .focusCurrentSession : .confirmSwitch(from: currentRepository)
    }
    return knownRepositories.contains(where: { canonical($0) == requested })
      ? .openKnownRepository
      : .confirmFirstUse
  }

  /// Whether this exact worktree checks in that Ticket.
  ///
  /// The shell asks this one narrow question so a deep link naming a Ticket that
  /// does not exist here opens the repository anyway (§9.4) instead of being
  /// refused at startup by the host's own `--ticket` validation. It is a single
  /// `.vibehub/tickets/<id>.yaml` existence test inside the already-validated
  /// worktree: no projection, no parse, no Ticket semantics, and the launcher's
  /// validation stays authoritative for everything the shell does pass on.
  public static func ticketIsPresent(_ ticketId: String, inWorktree repoRoot: String) -> Bool {
    guard isCanonicalTicketId(ticketId) else { return false }
    let path = URL(fileURLWithPath: repoRoot)
      .appendingPathComponent(".vibehub/tickets")
      .appendingPathComponent("\(ticketId).yaml")
    var isDirectory: ObjCBool = false
    let exists = FileManager.default.fileExists(atPath: path.path, isDirectory: &isDirectory)
    return exists && !isDirectory.boolValue
  }

  private static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
  }
}
