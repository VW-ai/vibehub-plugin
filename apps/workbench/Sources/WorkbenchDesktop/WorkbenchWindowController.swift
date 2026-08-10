import AppKit
import WebKit
import WorkbenchRepositorySession
import WorkbenchWebViewBridge

/// The Workbench window: one WKWebView bound to one loopback session origin.
///
/// The shell renders nothing itself. The page is the same shared frontend the
/// browser mode serves from `skills/vibehub-ticket-review/assets`, over the same
/// read-only API contract, so there is no forked frontend to keep in sync.
final class WorkbenchWindowController: NSObject, WKNavigationDelegate {
  let window: NSWindow
  private let webView: WKWebView
  private let policy: NavigationPolicy
  private let session: RepositorySession
  private let preferences: WorkbenchPreferences
  private var selectionTimer: Timer?

  /// Reads which Ticket and inspector layer the user is looking at, straight
  /// from the rendered accessibility state. This is an observation of the page
  /// the shell already displays — the page gets no callable native surface in
  /// return, and the shared assets are unmodified.
  private static let selectionProbe = """
    (() => {
      const tab = document.querySelector('.ticket-tab[aria-selected="true"]');
      if (!tab || typeof tab.id !== 'string' || !tab.id.startsWith('ticket-tab-')) return '';
      const rest = tab.id.slice('ticket-tab-'.length);
      const cut = rest.lastIndexOf('-');
      if (cut <= 0) return '';
      return rest.slice(0, cut) + ' ' + rest.slice(cut + 1);
    })()
    """

  init(session: RepositorySession, ready: HostSessionReady, preferences: WorkbenchPreferences) {
    self.session = session
    self.preferences = preferences
    self.policy = NavigationPolicy(sessionOrigin: ready.origin)

    // One hardened configuration, shared with the headless render probe.
    webView = WKWebView(frame: .zero, configuration: WorkbenchWebView.makeConfiguration())
    webView.allowsBackForwardNavigationGestures = false

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    super.init()

    webView.navigationDelegate = self
    window.contentView = webView
    window.titlebarAppearsTransparent = false
    window.title = "VibeHub Workbench — \(session.displayName)"
    if #available(macOS 11.0, *) {
      window.subtitle = "\(session.branch ?? "detached") · \(session.shortCommit)"
      + (session.dirty ? " · dirty" : "")
    }
    window.minSize = NSSize(width: 880, height: 560)
    restoreFrame()
    window.delegate = self

    webView.load(URLRequest(url: ready.authorizedURL))
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
    startObservingSelection()
  }

  func close() {
    selectionTimer?.invalidate()
    selectionTimer = nil
    persistFrame()
    window.delegate = nil
    window.close()
  }

  // MARK: preference-only persistence

  private func restoreFrame() {
    if let stored = preferences.windowFrame {
      let frame = NSRectFromString(stored)
      if frame.width >= 880, frame.height >= 560,
        NSScreen.screens.contains(where: { $0.visibleFrame.intersects(frame) })
      {
        window.setFrame(frame, display: false)
        return
      }
    }
    window.center()
  }

  private func persistFrame() {
    preferences.windowFrame = NSStringFromRect(window.frame)
  }

  private func startObservingSelection() {
    selectionTimer?.invalidate()
    let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
      self?.captureSelection()
    }
    RunLoop.main.add(timer, forMode: .common)
    selectionTimer = timer
  }

  private func captureSelection() {
    webView.evaluateJavaScript(WorkbenchWindowController.selectionProbe) { [weak self] value, _ in
      guard let self else { return }
      let parts = (value as? String ?? "").split(separator: " ")
      guard parts.count == 2, let tab = InspectorTab(domTabId: String(parts[1])) else { return }
      self.preferences.rememberSelection(
        ticketId: String(parts[0]),
        tab: tab,
        forRepository: self.session.repoRoot
      )
    }
  }

  // MARK: navigation boundary

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    let decision = policy.decide(
      for: navigationAction.request.url,
      isLinkActivation: navigationAction.navigationType == .linkActivated
    )
    switch decision {
    case .allowInWebView:
      decisionHandler(.allow)
    case .openExternally:
      decisionHandler(.cancel)
      if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    case .deny:
      decisionHandler(.cancel)
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    presentLoadFailure(error)
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    presentLoadFailure(error)
  }

  private func presentLoadFailure(_ error: Error) {
    guard (error as NSError).code != NSURLErrorCancelled else { return }
    let alert = NSAlert()
    alert.messageText = "The Workbench could not load the read-only host."
    alert.informativeText = error.localizedDescription
    alert.alertStyle = .warning
    alert.beginSheetModal(for: window)
  }
}

extension WorkbenchWindowController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    selectionTimer?.invalidate()
    selectionTimer = nil
    persistFrame()
  }

  func windowDidResize(_ notification: Notification) {
    persistFrame()
  }

  func windowDidMove(_ notification: Notification) {
    persistFrame()
  }
}
