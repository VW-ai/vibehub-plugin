import Foundation
import WebKit

/// The single hardened WKWebView configuration the shell ever builds (§10).
///
/// What is deliberately never done here:
/// - no `WKUserContentController.add(_:name:)` script message handler, so the
///   page has no native function to call and cannot ask for a file,
/// - no `WKUserScript` injected into the shared frontend,
/// - no `loadFileURL(_:allowingReadAccessTo:)` anywhere in the shell, and no
///   `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs`,
/// - no persistent data store, so no projected snapshot, token, or cache is
///   left on disk when the app session ends.
///
/// Everything the page knows about the repository arrives over the read-only
/// loopback contract that `HostSession` started for the one worktree the user
/// picked in `NSOpenPanel`.
public enum WorkbenchWebView {
  public static func makeConfiguration() -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    return configuration
  }
}
