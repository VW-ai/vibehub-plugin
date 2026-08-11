import AppKit
import Foundation
import WorkbenchRepositorySession
import WorkbenchWebViewBridge

/// A `UserDefaults` that never reaches disk.
///
/// A named suite would create a real preference domain in the user's home
/// directory and leave the file there even after its values are removed. This
/// one lives and dies with the probe process, so running a probe writes no
/// preference anywhere — including none of its own.
final class InMemoryDefaults: UserDefaults {
  private var storage: [String: Any] = [:]

  override func object(forKey defaultName: String) -> Any? { storage[defaultName] }

  override func set(_ value: Any?, forKey defaultName: String) {
    if let value {
      storage[defaultName] = value
    } else {
      storage.removeValue(forKey: defaultName)
    }
  }

  override func removeObject(forKey defaultName: String) {
    storage.removeValue(forKey: defaultName)
  }

  override func array(forKey defaultName: String) -> [Any]? { storage[defaultName] as? [Any] }

  override func string(forKey defaultName: String) -> String? { storage[defaultName] as? String }

  override func dictionary(forKey defaultName: String) -> [String: Any]? {
    storage[defaultName] as? [String: Any]
  }

  override func persistentDomain(forName domainName: String) -> [String: Any]? { storage }

  override func removePersistentDomain(forName domainName: String) { storage.removeAll() }
}

/// The preference state of one probe run.
///
/// The probes need to seed a remembered list and a window frame and then prove
/// exactly what the shell wrote, without touching the preferences of the
/// Workbench the user actually runs and without leaving anything behind.
final class EphemeralPreferences {
  let preferences: WorkbenchPreferences
  private let defaults = InMemoryDefaults()

  init(recents: [String] = [], windowFrame: String? = nil) {
    preferences = WorkbenchPreferences(defaults: defaults)
    if !recents.isEmpty {
      defaults.set(recents, forKey: PreferenceKey.recentRepositories.rawValue)
    }
    if let windowFrame {
      defaults.set(windowFrame, forKey: PreferenceKey.windowFrame.rawValue)
    }
  }

  /// Where this run's preference state lives, printed so a test can see that it
  /// is not the domain the shipped app reads.
  var domain: String { "in-memory" }

  var writtenKeys: [String] {
    (defaults.persistentDomain(forName: domain) ?? [:]).keys.sorted()
  }

  /// Whether anything here looks like the host's 64-hex bearer.
  ///
  /// The bearer lives only in the app session's memory; this is the mechanical
  /// check that it reached no preference key, allowed or not.
  var holdsBearer: Bool {
    let stored = defaults.persistentDomain(forName: domain) ?? [:]
    let text = String(describing: stored)
    return text.range(of: "[0-9a-f]{64}", options: [.regularExpression, .caseInsensitive]) != nil
  }

  func discard() {
    defaults.removePersistentDomain(forName: domain)
  }
}

/// Small blocking HTTP reads, used only to prove what a port answers.
enum ProbeHTTP {
  /// The status code, or -1 when nothing answered at all.
  static func status(_ url: URL, bearer: String? = nil, timeout: TimeInterval = 5) -> Int {
    fetch(url, bearer: bearer, timeout: timeout).0
  }

  static func fetch(
    _ url: URL,
    bearer: String? = nil,
    timeout: TimeInterval = 5
  ) -> (Int, Data?) {
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = timeout
    let session = URLSession(configuration: configuration)
    let semaphore = DispatchSemaphore(value: 0)
    var code = -1
    var payload: Data?
    let task = session.dataTask(with: request) { data, response, _ in
      code = (response as? HTTPURLResponse)?.statusCode ?? -1
      payload = data
      semaphore.signal()
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + timeout + 2)
    session.invalidateAndCancel()
    return (code, payload)
  }
}

/// Drives a real in-app repository change over the real application object.
///
/// Everything a menu selection touches is exercised: the menu this app installs,
/// the `NSMenuItem` action sent through the responder chain, the confirmation
/// AppKit actually puts on the window as a sheet, the host lifecycle, and the
/// window replacement.
///
/// The one thing the probe supplies that a person would is the *answer*. GUI
/// automation is not available here, so the sheet the app presented is ended
/// with the exact return code its affirmative or its cancel button produces.
/// Nothing about the decision, the wording, or the teardown is simulated.
final class SwitchProbe {
  private let from: String
  private let to: String
  private let accept: Bool
  private let seededRecents: [String]
  private let seededFrame: String

  init(from: String, to: String, accept: Bool, recents: [String], frame: String?) {
    self.from = from
    self.to = to
    self.accept = accept
    self.seededRecents = recents
    self.seededFrame = frame ?? "{{120, 120}, {1000, 700}}"
  }

  func run() -> Int32 {
    // `.accessory` keeps the probe out of the Dock; it still needs a window
    // server, exactly as `--probe-render` does.
    NSApplication.shared.setActivationPolicy(.accessory)
    let store = EphemeralPreferences(recents: seededRecents, windowFrame: seededFrame)
    defer { store.discard() }

    var payload: [String: Any] = [
      "ok": true,
      "preferenceDomain": store.domain,
      "answer": accept ? "accept" : "decline",
      "recentsSeeded": seededRecents,
      "windowFrameSeeded": seededFrame,
      "bearerPrinted": false,
    ]

    let delegate = AppDelegate(initialRepository: from, preferences: store.preferences)
    NSApplication.shared.delegate = delegate
    let menu = WorkbenchMenu(recents: { [preferences = store.preferences] in
      preferences.recentRepositories
    })
    delegate.menu = menu
    NSApplication.shared.mainMenu = menu.menu

    delegate.applicationDidFinishLaunching(
      Notification(name: NSApplication.didFinishLaunchingNotification)
    )
    guard pump(until: { delegate.host != nil }, timeout: 90) else {
      delegate.endSession()
      return report(["ok": false, "error": "the first repository never opened"])
    }
    guard let firstHost = delegate.host, let firstWindow = delegate.workbench?.window else {
      delegate.endSession()
      return report(["ok": false, "error": "the first session has no window"])
    }
    // Held in memory for the after-the-switch checks and never printed.
    let firstBearer = firstHost.ready.authorizedURL.fragment ?? ""
    let firstAuthorized = firstHost.ready.authorizedURL
    let firstPid = Int(firstHost.ready.processIdentifier)
    let firstOrigin = firstHost.ready.origin
    let firstWindowIdentity = ObjectIdentifier(firstWindow)
    // Let the frontend finish its first projection round-trip.
    _ = pump(until: { false }, timeout: 3)
    payload["first"] = [
      "repo": delegate.currentRepository ?? NSNull(),
      "hostPid": firstPid,
      "origin": firstOrigin.absoluteString,
      "port": firstHost.ready.port,
      "windowFrame": NSStringFromRect(firstWindow.frame),
      "projection": projection(origin: firstOrigin, bearer: firstBearer),
    ]
    payload["recentsBefore"] = store.preferences.recentRepositories

    // The menu the application installed, read back as data.
    payload["menu"] = menu.descriptor
    let openItem = menu.menu.items
      .compactMap(\.submenu)
      .flatMap(\.items)
      .first { $0.title == WorkbenchMenu.openRepositoryTitle }
    payload["openRepositoryItem"] = openItem.map { item -> [String: Any] in
      let responder = NSApplication.shared.target(
        forAction: item.action ?? #selector(AppDelegate.openRepository(_:)),
        to: item.target,
        from: item
      )
      return [
        "title": item.title,
        "key": item.keyEquivalent,
        "modifiers": item.keyEquivalentModifierMask.contains(.command) ? ["command"] : [],
        "action": item.action.map { NSStringFromSelector($0) } ?? "",
        // Cmd-O opens `NSOpenPanel`, which cannot be answered headlessly, so the
        // probe proves the item is wired to a responder that handles it rather
        // than claiming a directory was chosen.
        "responder": responder.map { String(describing: type(of: $0)) } ?? "",
      ]
    } ?? NSNull()

    guard let recentItem = menu.recentItem(forPath: to), let action = recentItem.action else {
      delegate.endSession()
      return report(["ok": false, "error": "no recent-repositories item names \(to)"])
    }
    payload["chosenItem"] = [
      "title": recentItem.title,
      "path": recentItem.representedObject as? String ?? "",
      "toolTip": recentItem.toolTip ?? "",
      "action": NSStringFromSelector(action),
    ]

    // Exactly what AppKit does for a click: the item's action is sent to its
    // target — nil, so it travels the responder chain to the application
    // delegate, the same way the menu bar delivers it.
    payload["actionSent"] = NSApplication.shared.sendAction(action, to: recentItem.target, from: recentItem)

    // Whatever the app decided to put on the window, read back as text.
    let sheetPresented = pump(until: { firstWindow.attachedSheet != nil }, timeout: 20)
    var sheetText: [String] = []
    var isConfirmation = false
    if let sheet = firstWindow.attachedSheet {
      sheetText = SwitchProbe.text(in: sheet.contentView)
      let expected = ConfirmationPrompts.switchRepository(
        from: delegate.currentRepository ?? from,
        to: URL(fileURLWithPath: to).standardizedFileURL.path,
        requestedBy: .userSelection
      )
      isConfirmation = sheetText.contains(expected.title)
      payload["prompt"] = [
        "title": expected.title,
        "detail": expected.detail,
        "affirmative": expected.affirmative,
        "cancel": expected.cancel,
      ]
      payload["promptMatchesSheet"] = isConfirmation
        && sheetText.contains(expected.detail)
        && sheetText.contains(expected.affirmative)
        && sheetText.contains(expected.cancel)
      firstWindow.endSheet(
        sheet,
        returnCode: isConfirmation && !accept ? .alertSecondButtonReturn : .alertFirstButtonReturn
      )
    }
    payload["sheetPresented"] = sheetPresented
    payload["sheetIsConfirmation"] = isConfirmation
    payload["sheetText"] = sheetText

    let expectSwitch = isConfirmation && accept
    _ = pump(
      until: { expectSwitch ? delegate.host !== firstHost : false },
      timeout: expectSwitch ? 90 : 4
    )
    _ = pump(until: { false }, timeout: 2)

    let switched = delegate.host !== firstHost
    payload["switched"] = switched
    payload["currentRepository"] = delegate.currentRepository ?? NSNull()
    if switched, let second = delegate.host, let secondWindow = delegate.workbench?.window {
      payload["second"] = [
        "repo": delegate.currentRepository ?? NSNull(),
        "hostPid": Int(second.ready.processIdentifier),
        "origin": second.ready.origin.absoluteString,
        "port": second.ready.port,
        "windowFrame": NSStringFromRect(secondWindow.frame),
        "projection": projection(
          origin: second.ready.origin,
          bearer: second.ready.authorizedURL.fragment ?? ""
        ),
      ]
      payload["windowRecreated"] = ObjectIdentifier(secondWindow) != firstWindowIdentity
      payload["windowFrameReused"] = NSStringFromRect(secondWindow.frame) == seededFrame
    } else {
      payload["second"] = NSNull()
      payload["windowRecreated"] = false
      payload["windowFrameReused"] = false
    }

    // What is left of the session the user was in a moment ago.
    payload["previousHostAlive"] = SwitchProbe.alive(pid_t(firstPid))
    payload["previousOriginStatus"] = ProbeHTTP.status(firstOrigin.appendingPathComponent("health"))
    payload["previousAuthorizedUrlStatus"] = ProbeHTTP.status(firstAuthorized)
    payload["previousAuthorizedApiStatus"] = ProbeHTTP.status(
      firstOrigin.appendingPathComponent("api/state"),
      bearer: firstBearer
    )

    payload["recentsAfter"] = store.preferences.recentRepositories
    payload["preferenceKeys"] = store.writtenKeys
    payload["preferenceAllowlist"] = PreferenceKey.allowlist
    payload["bearerInPreferences"] = store.holdsBearer

    // Nothing this probe started may outlive it.
    let secondPid = (payload["second"] as? [String: Any])?["hostPid"] as? Int
    delegate.endSession()
    _ = pump(until: { !SwitchProbe.alive(pid_t(firstPid)) }, timeout: 10)
    payload["firstHostAliveAtExit"] = SwitchProbe.alive(pid_t(firstPid))
    payload["secondHostAliveAtExit"] = secondPid.map { SwitchProbe.alive(pid_t($0)) } ?? false
    return report(payload)
  }

  private func projection(origin: URL, bearer: String) -> [String: Any] {
    let (status, data) = ProbeHTTP.fetch(origin.appendingPathComponent("api/state"), bearer: bearer)
    guard status == 200, let data,
      let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let body = envelope["data"] as? [String: Any]
    else { return ["status": status] }
    let project = body["project"] as? [String: Any] ?? [:]
    let graph = body["graph"] as? [String: Any] ?? [:]
    let tickets = graph["tickets"] as? [[String: Any]] ?? []
    return [
      "status": status,
      "worktreeRoot": project["worktreeRoot"] ?? NSNull(),
      "branch": project["branch"] ?? NSNull(),
      "tickets": tickets.count,
      "ticketIds": tickets.compactMap { $0["ticketId"] as? String }.sorted(),
    ]
  }

  /// Every piece of text AppKit actually drew in that sheet.
  private static func text(in view: NSView?) -> [String] {
    guard let view else { return [] }
    var found: [String] = []
    if let field = view as? NSTextField, !field.stringValue.isEmpty {
      found.append(field.stringValue)
    }
    if let button = view as? NSButton, !button.title.isEmpty {
      found.append(button.title)
    }
    for child in view.subviews { found.append(contentsOf: text(in: child)) }
    return found
  }

  private static func alive(_ pid: pid_t) -> Bool {
    kill(pid, 0) == 0
  }

  /// Runs the real main run loop until the condition holds or the budget runs
  /// out. AppKit does the work; the probe only decides when to stop waiting.
  private func pump(until condition: () -> Bool, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline {
      RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return condition()
  }

  private func report(_ payload: [String: Any]) -> Int32 {
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
      ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    return (payload["ok"] as? Bool) == true ? 0 : 1
  }
}
