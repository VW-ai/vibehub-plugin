import AppKit
import Foundation
import WorkbenchRepositorySession
import WorkbenchWebViewBridge

/// Headless probes over the exact code the window uses.
///
/// They exist so the lifecycle and security boundaries can be proved
/// mechanically from `test/workbench-shell.test.mjs` without a GUI session.
/// They open no window and register no user interface.
enum ProbeCommand {
  case preferences
  case toolchain
  case navigation(origin: String, url: String, isLinkActivation: Bool)
  case session(repoRoot: String)
  case render(repoRoot: String, deepLink: String?)
  case deepLink(uri: String, currentRepository: String?, knownRepositories: [String])

  static let usage = """
    VibeHubWorkbench — the thin macOS Workbench shell.

    With no arguments it opens the recent-repository picker.
      --repo <worktree>                        open that exact worktree directly

    Headless probes:
      --probe-preferences                      print the §8.2 persistence allowlist
      --probe-toolchain                        print the resolved node and host launcher
      --probe-navigation --origin <origin> --url <url> [--link]
                                               print the WebView navigation decision
      --probe-session --repo <worktree>        start the read-only host, print its
                                               origin and pid, and hold it until
                                               SIGTERM/SIGINT
      --probe-render --repo <worktree> [--deep-link <uri>]
                                               load the authorized URL in the real
                                               WKWebView off-screen and print what
                                               the shared frontend rendered, then
                                               apply the deep link to it
      --probe-deep-link --url <uri> [--current <worktree>] [--known <worktree>]...
                                               print the §9 decision for that URI
                                               without opening a window or a host
    """

  init?(arguments: [String]) {
    guard let first = arguments.first, first.hasPrefix("--probe-") else { return nil }
    func value(_ flag: String) -> String? {
      guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else {
        return nil
      }
      return arguments[index + 1]
    }
    func values(_ flag: String) -> [String] {
      arguments.indices.compactMap { index in
        arguments[index] == flag && index + 1 < arguments.count ? arguments[index + 1] : nil
      }
    }
    switch first {
    case "--probe-preferences":
      self = .preferences
    case "--probe-toolchain":
      self = .toolchain
    case "--probe-navigation":
      guard let origin = value("--origin"), let url = value("--url") else { return nil }
      self = .navigation(origin: origin, url: url, isLinkActivation: arguments.contains("--link"))
    case "--probe-session":
      guard let repo = value("--repo") else { return nil }
      self = .session(repoRoot: repo)
    case "--probe-render":
      guard let repo = value("--repo") else { return nil }
      self = .render(repoRoot: repo, deepLink: value("--deep-link"))
    case "--probe-deep-link":
      guard let uri = value("--url") else { return nil }
      self = .deepLink(
        uri: uri,
        currentRepository: value("--current"),
        knownRepositories: values("--known")
      )
    default:
      return nil
    }
  }

  func run() -> Int32 {
    switch self {
    case .preferences:
      return emit([
        "ok": true,
        "suite": WorkbenchPreferences.suiteName,
        "allowlist": PreferenceKey.allowlist,
        "written": WorkbenchPreferences().writtenKeys(),
        "viewportRestored": false,
      ])
    case .toolchain:
      do {
        let node = try ToolchainLocator.nodeExecutable()
        let launcher = try ToolchainLocator.launcherScript(searchingFrom: ownLocation())
        return emit([
          "ok": true,
          "node": node.path,
          "launcher": launcher.path,
          "resolvedFrom": "app-installation",
        ])
      } catch {
        return fail(error)
      }
    case .navigation(let origin, let url, let isLinkActivation):
      guard let originURL = URL(string: origin) else {
        return fail(NSError(
          domain: "VibeHubWorkbench",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "origin is not a URL"]
        ))
      }
      let decision = NavigationPolicy(sessionOrigin: originURL)
        .decide(for: URL(string: url), isLinkActivation: isLinkActivation)
      return emit(["ok": true, "url": url, "decision": decision.rawValue])
    case .session(let repoRoot):
      return runSession(repoRoot: repoRoot)
    case .render(let repoRoot, let deepLink):
      return runRender(repoRoot: repoRoot, deepLink: deepLink)
    case .deepLink(let uri, let currentRepository, let knownRepositories):
      return runDeepLink(uri: uri, current: currentRepository, known: knownRepositories)
    }
  }

  /// The whole §9 decision for one URI, over the same code the app runs, with
  /// no window, no host, and no write of any kind.
  private func runDeepLink(uri: String, current: String?, known: [String]) -> Int32 {
    // Captured before and after so a refusal can be shown to change nothing.
    let preferenceKeys = WorkbenchPreferences().writtenKeys()
    let link: DeepLink
    do {
      link = try DeepLink.parse(uri)
    } catch {
      return emit([
        "ok": true,
        "accepted": false,
        "stage": "uri",
        "error": (error as? LocalizedError)?.errorDescription ?? error.localizedDescription,
        "hostStarted": false,
        "preferenceKeys": preferenceKeys,
        "preferenceKeysAfter": WorkbenchPreferences().writtenKeys(),
      ])
    }

    // Exactly the picker's validation: an exact Git worktree root holding
    // `.vibehub`. A deep link reaches no path this would refuse.
    do {
      _ = try GitMetadata.readSession(repoRoot: link.repoRoot)
    } catch {
      return emit([
        "ok": true,
        "accepted": false,
        "stage": "repository",
        "error": (error as? LocalizedError)?.errorDescription ?? error.localizedDescription,
        "repo": link.repoRoot,
        "hostStarted": false,
        "preferenceKeys": preferenceKeys,
        "preferenceKeysAfter": WorkbenchPreferences().writtenKeys(),
      ])
    }

    let resolution = DeepLinkPlanner.resolve(
      link: link,
      currentRepository: current,
      knownRepositories: known
    )
    let ticketPresent = link.ticketId
      .map { DeepLinkPlanner.ticketIsPresent($0, inWorktree: link.repoRoot) }
    // A synthetic base stands in for the live session URL so the focus contract
    // and the carried fragment can be shown without a running host or a token.
    let base = URL(string: "http://127.0.0.1:65535/#SESSIONFRAGMENT")!
    let focused = FocusedSessionURL.make(
      base: base,
      ticket: ticketPresent == true ? link.ticketId : nil,
      view: link.view
    )
    // The exact question the user would be asked, printed instead of shown.
    var prompt: [String: Any] = [:]
    switch resolution {
    case .confirmFirstUse:
      prompt = describe(ConfirmationPrompts.firstUse(repoRoot: link.repoRoot))
    case .confirmSwitch(let from):
      prompt = describe(ConfirmationPrompts.switchRepository(from: from, to: link.repoRoot))
    case .focusCurrentSession, .openKnownRepository:
      break
    }
    return emit([
      "ok": true,
      "accepted": true,
      "stage": "resolved",
      "repo": link.repoRoot,
      "ticket": link.ticketId ?? NSNull(),
      "view": link.view?.rawValue ?? NSNull(),
      "uri": link.uri,
      "resolution": resolution.name,
      "requiresConfirmation": resolution.requiresConfirmation,
      "prompt": prompt.isEmpty ? NSNull() : prompt,
      "ticketPresent": ticketPresent ?? NSNull(),
      "focusPath": (focused.path) + (focused.query.map { "?\($0)" } ?? ""),
      "focusFragmentPreserved": focused.fragment == "SESSIONFRAGMENT",
      "hostStarted": false,
      "preferenceKeys": preferenceKeys,
      "preferenceKeysAfter": WorkbenchPreferences().writtenKeys(),
    ])
  }

  private func runRender(repoRoot: String, deepLink: String?) -> Int32 {
    do {
      let session = try GitMetadata.readSession(repoRoot: repoRoot)
      let link = try deepLink.map { try DeepLink.parse($0) }
      let host = try HostSession.start(
        repoRoot: session.repoRoot,
        node: try ToolchainLocator.nodeExecutable(),
        launcher: try ToolchainLocator.launcherScript(searchingFrom: ownLocation())
      )
      defer { host.terminate() }
      // `.accessory` keeps the probe out of the Dock and away from focus.
      NSApplication.shared.setActivationPolicy(.accessory)
      return RenderProbe(session: session, host: host, deepLink: link).run()
    } catch {
      return fail(error)
    }
  }

  private func runSession(repoRoot: String) -> Int32 {
    do {
      let session = try GitMetadata.readSession(repoRoot: repoRoot)
      let host = try HostSession.start(
        repoRoot: session.repoRoot,
        node: try ToolchainLocator.nodeExecutable(),
        launcher: try ToolchainLocator.launcherScript(searchingFrom: ownLocation())
      )
      _ = emit([
        "ok": true,
        "repo": session.repoRoot,
        "branch": session.branch ?? NSNull(),
        "commit": session.commit,
        "dirty": session.dirty,
        "origin": host.ready.origin.absoluteString,
        "port": host.ready.port,
        "hostPid": Int(host.ready.processIdentifier),
        "shellPid": Int(ProcessInfo.processInfo.processIdentifier),
        // The authorized URL and its token stay in memory; only the origin is
        // ever printed.
        "tokenPrinted": false,
      ])

      let queue = DispatchQueue(label: "dev.vibehub.workbench.probe-signals")
      var sources: [DispatchSourceSignal] = []
      for number in [SIGTERM, SIGINT] {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
        source.setEventHandler {
          host.terminate()
          exit(0)
        }
        source.resume()
        sources.append(source)
      }
      withExtendedLifetime(sources) { RunLoop.main.run() }
      host.terminate()
      return 0
    } catch {
      return fail(error)
    }
  }

  private func describe(_ prompt: ConfirmationPrompt) -> [String: Any] {
    [
      "title": prompt.title,
      "detail": prompt.detail,
      "affirmative": prompt.affirmative,
      "cancel": prompt.cancel,
    ]
  }

  private func ownLocation() -> URL {
    URL(fileURLWithPath: CommandLine.arguments.first ?? ".").resolvingSymlinksInPath()
  }

  private func emit(_ payload: [String: Any]) -> Int32 {
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
      ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    return 0
  }

  private func fail(_ error: Error) -> Int32 {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    _ = emit(["ok": false, "error": message])
    return 1
  }
}
