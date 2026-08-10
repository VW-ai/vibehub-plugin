import AppKit
import WebKit
import WorkbenchRepositorySession
import WorkbenchWebViewBridge

/// Loads the authorized loopback URL in the shell's real, hardened WKWebView
/// and reports what the shared frontend actually rendered.
///
/// This is the headless stand-in for a screenshot: it proves the WebView shows
/// the same assets and the same read-only API contract the browser mode serves,
/// with no forked frontend, and it proves `file:` stays denied inside the live
/// WebView rather than only in the pure policy.
final class RenderProbe: NSObject, WKNavigationDelegate {
  private let session: RepositorySession
  private let host: HostSession
  private let webView: WKWebView
  private let policy: NavigationPolicy
  private let window: NSWindow
  private var finished = false
  private var deniedFileNavigation = false

  private static let readout = """
    JSON.stringify({
      nodes: document.querySelectorAll('#nodeLayer [data-ticket-id]').length,
      frontier: (document.querySelector('#frontierCount') || {}).textContent || '',
      path: (document.querySelector('#sourcePath') || {}).textContent || '',
      branch: (document.querySelector('#sourceBranch') || {}).textContent || '',
      commit: (document.querySelector('#sourceCommit') || {}).textContent || '',
      title: document.title,
      assets: [...document.querySelectorAll('link[rel=stylesheet],script[src]')]
        .map((node) => node.getAttribute('href') || node.getAttribute('src'))
    })
    """

  init(session: RepositorySession, host: HostSession) {
    self.session = session
    self.host = host
    self.policy = NavigationPolicy(sessionOrigin: host.ready.origin)
    self.webView = WKWebView(
      frame: NSRect(x: 0, y: 0, width: 1280, height: 820),
      configuration: WorkbenchWebView.makeConfiguration()
    )
    // A real window, deliberately placed off-screen: the probe must never take
    // focus from whoever is using this machine.
    self.window = NSWindow(
      contentRect: NSRect(x: -4000, y: -4000, width: 1280, height: 820),
      styleMask: [.titled],
      backing: .buffered,
      defer: false
    )
    super.init()
    window.contentView = webView
    window.orderBack(nil)
    webView.navigationDelegate = self
  }

  func run(timeout: TimeInterval = 60) -> Int32 {
    webView.load(URLRequest(url: host.ready.authorizedURL))
    let deadline = Date().addingTimeInterval(timeout)
    while !finished && Date() < deadline {
      RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    if !finished {
      report(["ok": false, "error": "the shared frontend did not finish loading"])
      return 1
    }
    return 0
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let decision = policy.decide(
      for: navigationAction.request.url,
      isLinkActivation: navigationAction.navigationType == .linkActivated
    )
    if decision != .allowInWebView, navigationAction.request.url?.scheme == "file" {
      deniedFileNavigation = true
    }
    decisionHandler(decision == .allowInWebView ? .allow : .cancel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Give the frontend one projection round-trip before reading the DOM.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      self?.probeFileBoundary()
    }
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    report(["ok": false, "error": error.localizedDescription])
  }

  /// Ask the live page to reach outside the loopback origin, the way a
  /// compromised or curious frontend would, and record that it cannot.
  private func probeFileBoundary() {
    let escape = """
      const attempts = [];
      try {
        const response = await fetch('file:///etc/passwd');
        attempts.push('fetch-file:' + response.status);
      } catch (error) { attempts.push('fetch-file:blocked'); }
      try {
        const handlers = window.webkit && window.webkit.messageHandlers;
        attempts.push('bridge:' + (handlers ? Object.keys(handlers).join('|') || 'empty' : 'absent'));
      } catch (error) { attempts.push('bridge:absent'); }
      return attempts.join(',');
      """
    webView.callAsyncJavaScript(
      escape,
      arguments: [:],
      in: nil,
      in: .page
    ) { [weak self] result in
      guard let self else { return }
      let escapeResult = (try? result.get()) as? String ?? "unavailable"
      self.webView.load(URLRequest(url: URL(fileURLWithPath: "/etc/passwd")))
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        self.readOut(escapeResult: escapeResult)
      }
    }
  }

  private func readOut(escapeResult: String) {
    webView.evaluateJavaScript(RenderProbe.readout) { [weak self] value, error in
      guard let self else { return }
      guard let raw = value as? String,
        let data = raw.data(using: .utf8),
        let rendered = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else {
        self.report([
          "ok": false,
          "error": error?.localizedDescription ?? "the rendered graph could not be read",
        ])
        return
      }
      self.report([
        "ok": true,
        "repo": self.session.repoRoot,
        "rendered": rendered,
        "fileNavigationDenied": self.deniedFileNavigation,
        "escapeAttempts": escapeResult,
        "loadedOrigin": self.webView.url?.host ?? "",
        "loadedPort": self.webView.url?.port ?? -1,
      ])
    }
  }

  private func report(_ payload: [String: Any]) {
    guard !finished else { return }
    finished = true
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
      ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
}
