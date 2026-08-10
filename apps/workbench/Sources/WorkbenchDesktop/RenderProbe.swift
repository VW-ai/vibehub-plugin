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
  private enum Phase {
    case initial
    case deepLinkFocus
  }

  private let session: RepositorySession
  private let host: HostSession
  private let webView: WKWebView
  private let policy: NavigationPolicy
  private let window: NSWindow
  private let deepLink: DeepLink?
  private var phase: Phase = .initial
  private var finished = false
  private var deniedFileNavigation = false
  private var pendingPayload: [String: Any] = [:]
  private var pendingDeepLinkPayload: [String: Any] = [:]

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

  /// What the shell reads back after a deep link: the Ticket and inspector
  /// layer the shared frontend actually selected.
  private static let selectionReadout = """
    JSON.stringify({
      selection: (() => {
        const tab = document.querySelector('.ticket-tab[aria-selected="true"]');
        if (!tab || typeof tab.id !== 'string' || !tab.id.startsWith('ticket-tab-')) return '';
        const rest = tab.id.slice('ticket-tab-'.length);
        const cut = rest.lastIndexOf('-');
        if (cut <= 0) return '';
        return rest.slice(0, cut) + ' ' + rest.slice(cut + 1);
      })(),
      nodes: document.querySelectorAll('#nodeLayer [data-ticket-id]').length,
      path: (document.querySelector('#sourcePath') || {}).textContent || ''
    })
    """

  init(session: RepositorySession, host: HostSession, deepLink: DeepLink? = nil) {
    self.session = session
    self.host = host
    self.deepLink = deepLink
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

  func run(timeout: TimeInterval = 90) -> Int32 {
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
      guard let self else { return }
      switch self.phase {
      case .initial: self.probeFileBoundary()
      case .deepLinkFocus: self.readSelection()
      }
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
      var payload: [String: Any] = [
        "ok": true,
        "repo": self.session.repoRoot,
        "rendered": rendered,
        "fileNavigationDenied": self.deniedFileNavigation,
        "escapeAttempts": escapeResult,
        "loadedOrigin": self.webView.url?.host ?? "",
        "loadedPort": self.webView.url?.port ?? -1,
      ]
      guard let link = self.deepLink else {
        self.report(payload)
        return
      }
      self.applyDeepLink(link, into: &payload)
    }
  }

  /// Applies a `vibehub://` link to the page this session is already showing,
  /// exactly as the window does: resolve, then either re-address the one
  /// authorized URL at the Ticket, or state that this worktree has no such
  /// Ticket and leave the open repository alone.
  private func applyDeepLink(_ link: DeepLink, into payload: inout [String: Any]) {
    let resolution = DeepLinkPlanner.resolve(
      link: link,
      currentRepository: session.repoRoot,
      knownRepositories: [session.repoRoot]
    )
    let present = link.ticketId
      .map { DeepLinkPlanner.ticketIsPresent($0, inWorktree: session.repoRoot) }
    var deepLinkPayload: [String: Any] = [
      "uri": link.uri,
      "resolution": resolution.name,
      "requiresConfirmation": resolution.requiresConfirmation,
      "ticket": link.ticketId ?? NSNull(),
      "view": link.view?.rawValue ?? NSNull(),
      "ticketPresent": present ?? NSNull(),
    ]
    guard let ticketId = link.ticketId, present == true else {
      if let ticketId = link.ticketId {
        deepLinkPayload["navigated"] = false
        deepLinkPayload["missingTicketStatement"] = [
          MissingTicketStatement.title(ticketId),
          MissingTicketStatement.detail(ticketId: ticketId, worktree: session.repoRoot),
        ].joined(separator: " ")
      } else {
        deepLinkPayload["navigated"] = false
      }
      payload["deepLink"] = deepLinkPayload
      report(payload)
      return
    }
    deepLinkPayload["navigated"] = true
    pendingPayload = payload
    pendingDeepLinkPayload = deepLinkPayload
    phase = .deepLinkFocus
    webView.load(URLRequest(
      url: host.ready.focusedURL(ticket: ticketId, view: link.view ?? .execution)
    ))
  }

  private func readSelection() {
    webView.evaluateJavaScript(RenderProbe.selectionReadout) { [weak self] value, error in
      guard let self else { return }
      var payload = self.pendingPayload
      var deepLinkPayload = self.pendingDeepLinkPayload
      if let raw = value as? String,
        let data = raw.data(using: .utf8),
        let selection = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        let parts = (selection["selection"] as? String ?? "").split(separator: " ")
        deepLinkPayload["selectedTicket"] = parts.count == 2 ? String(parts[0]) : NSNull()
        deepLinkPayload["selectedTab"] = parts.count == 2 ? String(parts[1]) : NSNull()
        deepLinkPayload["nodesAfterFocus"] = selection["nodes"] ?? NSNull()
        deepLinkPayload["pathAfterFocus"] = selection["path"] ?? NSNull()
      } else {
        deepLinkPayload["error"] = error?.localizedDescription
          ?? "the focused Ticket could not be read"
      }
      deepLinkPayload["focusedQuery"] = self.webView.url?.query ?? NSNull()
      deepLinkPayload["focusedOrigin"] = self.webView.url?.host ?? NSNull()
      payload["deepLink"] = deepLinkPayload
      self.report(payload)
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
