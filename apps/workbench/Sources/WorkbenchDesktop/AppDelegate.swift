import AppKit
import WorkbenchRepositorySession
import WorkbenchWebViewBridge

/// Owns the whole session: window, read-only host, watcher, and token.
///
/// There is no daemon, no login item, no auto-start, and no background
/// repository scanning. The host lives exactly as long as this application
/// process, and quitting ends it.
final class AppDelegate: NSObject, NSApplicationDelegate {
  let preferences: WorkbenchPreferences
  private var picker: RepositoryPickerWindowController?
  private(set) var workbench: WorkbenchWindowController?
  private(set) var host: HostSession?
  /// The main menu this session installed, so the recent-repositories submenu
  /// can be rebuilt whenever the remembered list changes.
  var menu: WorkbenchMenu?
  private var signalSources: [DispatchSourceSignal] = []
  private let initialRepository: String?
  /// The worktree this session currently has open, or nil before one is opened.
  private(set) var currentRepository: String?
  /// A `vibehub://` URI that arrived before the app finished launching.
  private var pendingDeepLink: String?
  private var didFinishLaunching = false

  init(initialRepository: String? = nil, preferences: WorkbenchPreferences = WorkbenchPreferences()) {
    self.initialRepository = initialRepository
    self.preferences = preferences
    super.init()
  }

  /// Registers the `vibehub://` handler before AppKit installs its own, so a
  /// deep link that launched the app is delivered to this session.
  func applicationWillFinishLaunching(_ notification: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
      forEventClass: AEEventClass(kInternetEventClass),
      andEventID: AEEventID(kAEGetURL)
    )
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    installSignalHandlers()
    // Everything the launch surface offers goes through the same in-app entry
    // the menu uses, so a repository chosen there and a repository chosen from
    // `Recent Repositories` mid-session are resolved identically.
    let picker = RepositoryPickerWindowController(preferences: preferences) { [weak self] path in
      self?.requestRepository(path)
    }
    self.picker = picker
    didFinishLaunching = true
    if let initialRepository {
      picker.window.orderFront(nil)
      open(repoRoot: initialRepository)
    } else if let pending = pendingDeepLink {
      // Launched by a deep link: the link decides what opens, and a repository
      // this Workbench has not seen before still needs an explicit yes.
      //
      // The launch surface is put on screen first and the link is handled one
      // run loop turn later. A question asked before the event loop is running,
      // with no window behind it, ends with AppKit quitting the app the moment
      // the question closes — the user would never get to answer it.
      pendingDeepLink = nil
      picker.window.makeKeyAndOrderFront(nil)
      DispatchQueue.main.async { [weak self] in self?.handle(deepLink: pending) }
    } else {
      picker.show()
    }
    NSApp.activate(ignoringOtherApps: true)
  }

  /// AppKit does not run `applicationWillTerminate` for a plain `kill`, so the
  /// host would outlive a signalled shell. These handlers close that gap: every
  /// ordinary way of ending the app also ends the host.
  private func installSignalHandlers() {
    for number in [SIGTERM, SIGINT, SIGHUP] {
      signal(number, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
      source.setEventHandler { [weak self] in
        self?.endSession()
        exit(0)
      }
      source.resume()
      signalSources.append(source)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    endSession()
  }

  /// Ends the read-only host, its `.vibehub/**` + Git watcher, and the
  /// in-memory bearer token together.
  func endSession() {
    workbench?.close()
    workbench = nil
    host?.terminate()
    host = nil
    currentRepository = nil
  }

  // MARK: - vibehub:// deep links (§9)

  @objc private func handleGetURLEvent(
    _ event: NSAppleEventDescriptor,
    withReplyEvent reply: NSAppleEventDescriptor
  ) {
    guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue else { return }
    guard didFinishLaunching else {
      pendingDeepLink = text
      return
    }
    handle(deepLink: text)
  }

  /// The single entry every `vibehub://` URI takes.
  ///
  /// A deep link carries navigation and nothing else: it can name a repository,
  /// a Ticket, and an inspector layer. There is no parameter, and no branch of
  /// this method, that writes a Ticket, an Evidence, an Outcome, or any other
  /// checked-in document.
  func handle(deepLink text: String) {
    let link: DeepLink
    do {
      link = try DeepLink.parse(text)
    } catch {
      // A malformed URI is refused whole: nothing is opened, no repository is
      // read, no preference changes, and no window is taken from the user.
      reportRefusedLink(message(for: error))
      return
    }

    do {
      // Validated before anything is focused, opened, or asked: exactly the
      // check the picker applies to a chosen directory. The user is never asked
      // about a path the Workbench could not open anyway, and a deep link can
      // never make the app read something that is not a VibeHub worktree.
      _ = try GitMetadata.readSession(repoRoot: link.repoRoot)
    } catch {
      reportRefusedLink(message(for: error))
      return
    }

    switch DeepLinkPlanner.resolve(
      link: link,
      currentRepository: currentRepository,
      knownRepositories: preferences.recentRepositories
    ) {
    case .focusCurrentSession:
      focusCurrentSession(with: link)
    case .openKnownRepository:
      open(repoRoot: link.repoRoot, deepLink: link)
    case .confirmFirstUse:
      confirmFirstUse(link)
    case .confirmSwitch(let from):
      confirmSwitch(from: from, to: link)
    }
  }

  /// §9.1 — the repository is already validated above; focus the window, then
  /// select the Ticket and layer.
  private func focusCurrentSession(with link: DeepLink) {
    guard let workbench, host != nil else {
      open(repoRoot: link.repoRoot, deepLink: link)
      return
    }
    NSApp.activate(ignoringOtherApps: true)
    workbench.focusWindow()

    guard let ticketId = link.ticketId else {
      workbench.focus(ticket: nil, view: nil)
      return
    }
    if DeepLinkPlanner.ticketIsPresent(ticketId, inWorktree: link.repoRoot) {
      workbench.focus(ticket: ticketId, view: link.view ?? .execution)
    } else {
      // §9.4 — the repository stays open and the absence is stated. The current
      // view is left alone rather than silently reset to something else.
      workbench.reportMissingTicket(ticketId, worktree: link.repoRoot)
    }
  }

  /// §9.2 — a repository this Workbench has never opened needs an explicit yes.
  private func confirmFirstUse(_ link: DeepLink) {
    ask(ConfirmationPrompts.firstUse(repoRoot: link.repoRoot), declined: { [weak self] in
      self?.offerPicker("The deep link was not opened.")
    }, accepted: { [weak self] in
      self?.open(repoRoot: link.repoRoot, deepLink: link)
    })
  }

  /// §9.3 — never swap the project under a window the user is reading.
  ///
  /// The same question guards an in-app switch: `requestedBy` changes only the
  /// line naming who asked, and the answer is what opens anything either way.
  private func confirmSwitch(
    from current: String,
    to link: DeepLink,
    requestedBy requester: RepositoryRequester = .deepLink
  ) {
    let prompt = ConfirmationPrompts.switchRepository(
      from: current,
      to: link.repoRoot,
      requestedBy: requester
    )
    ask(prompt, declined: { [weak self] in
      self?.workbench?.focusWindow()
    }, accepted: { [weak self] in
      self?.open(repoRoot: link.repoRoot, deepLink: link)
    })
  }

  /// Puts a question on the window the user is actually looking at.
  ///
  /// A sheet, not an application-modal loop: the answer is the only thing that
  /// can open or switch a repository, and while it is waiting the app stays
  /// responsive and keeps the window the question belongs to. An
  /// application-modal alert run at launch, before the event loop and with no
  /// window behind it, both answers itself and ends the app.
  private func ask(
    _ prompt: ConfirmationPrompt,
    declined: @escaping () -> Void,
    accepted: @escaping () -> Void
  ) {
    guard let window = workbench?.window ?? picker?.window else {
      declined()
      return
    }
    let alert = NSAlert()
    alert.messageText = prompt.title
    alert.informativeText = prompt.detail
    alert.alertStyle = .informational
    alert.addButton(withTitle: prompt.affirmative)
    alert.addButton(withTitle: prompt.cancel)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    alert.beginSheetModal(for: window) { response in
      guard response == .alertFirstButtonReturn else {
        declined()
        return
      }
      accepted()
    }
  }

  private func reportRefusedLink(_ detail: String) {
    if let workbench {
      workbench.report("That vibehub:// link was not opened.", detail: detail)
    } else {
      offerPicker(detail)
    }
  }

  private func offerPicker(_ message: String) {
    picker?.report(message)
    picker?.reloadRecents()
    picker?.window.makeKeyAndOrderFront(nil)
  }

  private func message(for error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  }

  // MARK: - changing repository from inside the app

  /// Cmd-O — the same directory chooser the launch surface offers, presented on
  /// whichever window the user is actually looking at.
  ///
  /// It is one `NSOpenPanel`, owned by the picker, rather than a second one that
  /// could drift from it.
  @objc func openRepository(_ sender: Any?) {
    picker?.chooseRepository(presentedOn: workbench?.window)
  }

  /// A worktree chosen from the `Recent Repositories` submenu. The item carries
  /// the exact absolute path, never the readable name shown in the menu.
  @objc func openRecentRepository(_ sender: Any?) {
    guard let path = (sender as? NSMenuItem)?.representedObject as? String else { return }
    requestRepository(path)
  }

  /// The single in-app entry for changing repository.
  ///
  /// It shares one resolution and one confirmation with `vibehub://open`: the
  /// path is validated first, then `DeepLinkPlanner` decides, so the menu and a
  /// link cannot disagree about what choosing a worktree means. A menu selection
  /// is expressed as a `DeepLink` carrying only a repository, which is exactly
  /// what it is — navigation, naming no Ticket and no layer.
  func requestRepository(_ repoRoot: String) {
    // Validated before anything is focused, opened, or asked, exactly as a deep
    // link is: the user is never asked about a path the Workbench could not open
    // anyway. A remembered worktree that has permanently stopped being one is
    // dropped here; a transient git failure is reported and the entry kept.
    switch RepositoryOpen.attempt(repoRoot: repoRoot, preferences: preferences) {
    case .failure(let error):
      reloadRecents()
      reportRepositoryFailure(message(for: error))
      return
    case .success:
      break
    }

    let link = DeepLink(repoRoot: URL(fileURLWithPath: repoRoot).standardizedFileURL.path)
    switch DeepLinkPlanner.resolve(
      link: link,
      currentRepository: currentRepository,
      knownRepositories: preferences.recentRepositories
    ) {
    case .focusCurrentSession:
      // Already open on this worktree. Tearing the host down and starting an
      // identical one would cost the user their session for nothing, and unlike
      // a deep link this selection names no Ticket and no layer, so there is
      // nothing to re-address either: the window is brought forward as it is.
      guard let workbench else {
        open(repoRoot: link.repoRoot)
        return
      }
      NSApp.activate(ignoringOtherApps: true)
      workbench.focusWindow()
    case .openKnownRepository, .confirmFirstUse:
      // No session is on screen to protect, and the worktree was named in the
      // app itself — through the directory chooser or the remembered list. That
      // selection *is* the explicit yes a link arriving from elsewhere has to
      // ask for, so asking again would only be noise.
      open(repoRoot: link.repoRoot)
    case .confirmSwitch(let from):
      // A window is open on another project: the same §9.3 question, sheeted on
      // that window, and nothing changes until it is answered.
      confirmSwitch(from: from, to: link, requestedBy: .userSelection)
    }
  }

  /// States a repository failure where the user actually is: on the open window
  /// when there is one, and on the launch surface otherwise.
  private func reportRepositoryFailure(_ detail: String) {
    if let workbench {
      workbench.report("That repository could not be opened.", detail: detail)
    } else {
      offerPicker(detail)
    }
  }

  /// Keeps every surface that lists remembered repositories in step with the
  /// list itself — the launch surface and the menu are two views of one fact.
  private func reloadRecents() {
    picker?.reloadRecents()
    menu?.reloadRecents()
  }

  // MARK: - opening a repository

  private func open(repoRoot: String, deepLink: DeepLink? = nil) {
    let session: RepositorySession
    switch RepositoryOpen.attempt(repoRoot: repoRoot, preferences: preferences) {
    case .success(let value):
      session = value
    case .failure(let error):
      reloadRecents()
      reportRepositoryFailure(message(for: error))
      return
    }

    do {
      let node = try ToolchainLocator.nodeExecutable()
      let launcher = try ToolchainLocator.launcherScript(
        searchingFrom: URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
      )

      // Which Ticket this session opens on. A deep link outranks the restored
      // preference, and neither is trusted to still exist: the host refuses to
      // start on an unknown `--ticket`, which would keep the repository itself
      // from opening, so the shell only passes a Ticket this worktree checks in.
      var focusTicket = deepLink?.ticketId ?? preferences.lastTicketId(forRepository: session.repoRoot)
      var focusTab = deepLink?.ticketId == nil
        ? preferences.lastInspectorTab(forRepository: session.repoRoot)
        : (deepLink?.view ?? .execution)
      var missingTicket: String?
      if let requested = focusTicket,
        !DeepLinkPlanner.ticketIsPresent(requested, inWorktree: session.repoRoot)
      {
        focusTicket = nil
        focusTab = nil
        // §9.4 — only a Ticket the link named is worth stating; a stale
        // preference is not something the user asked for.
        if deepLink?.ticketId == requested { missingTicket = requested }
      }

      // The new host is started before the old one is ended, so a switch that
      // cannot start leaves the session the user is reading exactly as it was.
      let started = try HostSession.start(
        repoRoot: session.repoRoot,
        node: node,
        launcher: launcher,
        // Restored from preference or named by a deep link; every Ticket state
        // behind it is recomputed from Git YAML by the host.
        focusTicket: focusTicket,
        focusTab: focusTab
      )

      // From here the change is committed. The previous repository's host, its
      // `.vibehub/**` + Git watcher, and the bearer it authorized end together,
      // before the new window is on screen: no orphan process, no port left
      // listening, and the URL authorized a moment ago resolves to nothing.
      host?.terminate()
      host = started
      currentRepository = session.repoRoot
      preferences.rememberRepository(session.repoRoot)

      // The window is replaced, never re-pointed: swapping a live WKWebView's
      // URL across a repository switch crashes the shell. Closing the old one
      // writes the frame the user arranged and the new controller restores it,
      // so a switch keeps the window exactly where it was.
      workbench?.close()
      let window = WorkbenchWindowController(
        session: session,
        ready: started.ready,
        preferences: preferences
      )
      workbench = window
      window.show()
      picker?.window.close()
      reloadRecents()
      if let missingTicket {
        window.reportMissingTicket(missingTicket, worktree: session.repoRoot)
      }
    } catch {
      reportRepositoryFailure(message(for: error))
    }
  }
}
