import Foundation

public enum NavigationDecision: String, Sendable {
  /// The one authorized loopback session origin.
  case allowInWebView = "allow-in-webview"
  /// A remote link the user activated: handed to the default browser instead.
  case openExternally = "open-externally"
  /// Everything else, including every `file:` URL.
  case deny
}

/// The complete navigation surface of the WebView (§10).
///
/// The WebView is allowed exactly one origin: the loopback host this app
/// session started. `file:` is denied unconditionally, so the WebView has no
/// path to any local file — selected worktree or otherwise. Directory choice
/// and Git metadata reach the page only through the narrow native bridge
/// (`NSOpenPanel` -> `HostSession` -> the read-only HTTP contract).
public struct NavigationPolicy: Sendable {
  public let sessionOrigin: URL

  public init(sessionOrigin: URL) {
    self.sessionOrigin = sessionOrigin
  }

  public func decide(for url: URL?, isLinkActivation: Bool) -> NavigationDecision {
    guard let url, let scheme = url.scheme?.lowercased() else { return .deny }
    if scheme == "http",
      url.host == sessionOrigin.host,
      url.port == sessionOrigin.port
    {
      return .allowInWebView
    }
    if isLinkActivation, scheme == "https" || scheme == "http" { return .openExternally }
    return .deny
  }
}
