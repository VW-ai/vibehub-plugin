import AppKit
import WorkbenchRepositorySession
import WorkbenchWebViewBridge

/// Owns the whole session: window, read-only host, watcher, and token.
///
/// There is no daemon, no login item, no auto-start, and no background
/// repository scanning. The host lives exactly as long as this application
/// process, and quitting ends it.
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let preferences = WorkbenchPreferences()
  private var picker: RepositoryPickerWindowController?
  private var workbench: WorkbenchWindowController?
  private var host: HostSession?
  private var signalSources: [DispatchSourceSignal] = []
  private let initialRepository: String?

  init(initialRepository: String? = nil) {
    self.initialRepository = initialRepository
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    installSignalHandlers()
    let picker = RepositoryPickerWindowController(preferences: preferences) { [weak self] path in
      self?.open(repoRoot: path)
    }
    self.picker = picker
    if let initialRepository {
      picker.window.orderFront(nil)
      open(repoRoot: initialRepository)
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
  }

  private func open(repoRoot: String) {
    do {
      let session = try GitMetadata.readSession(repoRoot: repoRoot)
      let node = try ToolchainLocator.nodeExecutable()
      let launcher = try ToolchainLocator.launcherScript(
        searchingFrom: URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
      )
      host?.terminate()
      host = nil
      let started = try HostSession.start(
        repoRoot: session.repoRoot,
        node: node,
        launcher: launcher,
        // Restored from preference only; every Ticket state behind it is
        // recomputed from Git YAML by the host.
        focusTicket: preferences.lastTicketId(forRepository: session.repoRoot),
        focusTab: preferences.lastInspectorTab(forRepository: session.repoRoot)
      )
      host = started
      preferences.rememberRepository(session.repoRoot)

      workbench?.close()
      let window = WorkbenchWindowController(
        session: session,
        ready: started.ready,
        preferences: preferences
      )
      workbench = window
      window.show()
      picker?.window.close()
      picker?.reloadRecents()
    } catch {
      let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
      if case WorktreeError.notAVibeHubRepository = error {
        preferences.forgetRepository(repoRoot)
      } else if case WorktreeError.notADirectory = error {
        preferences.forgetRepository(repoRoot)
      }
      picker?.reloadRecents()
      picker?.report(message)
      picker?.window.makeKeyAndOrderFront(nil)
    }
  }
}
