import AppKit

/// The application menu.
///
/// Beyond the minimum a `swift build` binary needs — Cmd-Q, Cmd-W, and the
/// clipboard — this is where changing repository lives: `Open Repository…`
/// (Cmd-O) and a `Recent Repositories` submenu, both reachable while a
/// repository is already open.
///
/// Neither entry decides anything. Both hand one exact worktree to the same
/// `AppDelegate` entry a `vibehub://` link reaches, so there is one switching
/// semantics and one confirmation rather than two.
final class WorkbenchMenu {
  static let openRepositoryTitle = "Open Repository…"
  static let recentRepositoriesTitle = "Recent Repositories"
  static let noRecentRepositoriesTitle = "No Repositories Opened Yet"

  let menu = NSMenu()

  /// Read on every rebuild rather than captured once: the remembered list is
  /// preference state the shell changes as repositories open and fail.
  private let recents: () -> [String]
  private let recentsMenu = NSMenu(title: WorkbenchMenu.recentRepositoriesTitle)

  init(recents: @escaping () -> [String]) {
    self.recents = recents
    build()
    reloadRecents()
  }

  /// Rebuilds the recent-repositories submenu from the remembered list.
  ///
  /// Called after every open, and after every failure that drops an entry, so
  /// the menu never offers a worktree the shell has just decided it cannot open.
  func reloadRecents() {
    recentsMenu.removeAllItems()
    let paths = recents()
    guard !paths.isEmpty else {
      let empty = NSMenuItem(title: WorkbenchMenu.noRecentRepositoriesTitle, action: nil, keyEquivalent: "")
      empty.isEnabled = false
      recentsMenu.addItem(empty)
      return
    }
    for path in paths {
      // The readable name is the worktree's own directory name; the exact
      // absolute path is what is carried and what the tooltip shows, because two
      // worktrees of the same project share a basename.
      let item = NSMenuItem(
        title: (path as NSString).lastPathComponent,
        action: #selector(AppDelegate.openRecentRepository(_:)),
        keyEquivalent: ""
      )
      item.toolTip = path
      item.representedObject = path
      recentsMenu.addItem(item)
    }
  }

  /// The item that names this exact worktree, if the menu is offering it.
  func recentItem(forPath path: String) -> NSMenuItem? {
    recentsMenu.items.first { ($0.representedObject as? String) == path }
  }

  /// The whole built menu as plain data, for `--probe-menu`. This reads the
  /// live `NSMenu` the application installs, not a description of it.
  var descriptor: [[String: Any]] {
    menu.items.map(WorkbenchMenu.describe)
  }

  private static func describe(_ item: NSMenuItem) -> [String: Any] {
    var payload: [String: Any] = [
      "title": item.title,
      "key": item.keyEquivalent,
      "modifiers": modifiers(item.keyEquivalentModifierMask),
      "action": item.action.map { NSStringFromSelector($0) } ?? "",
      "separator": item.isSeparatorItem,
      "enabled": item.isEnabled,
    ]
    if let path = item.representedObject as? String { payload["path"] = path }
    if let submenu = item.submenu { payload["items"] = submenu.items.map(describe) }
    return payload
  }

  private static func modifiers(_ mask: NSEvent.ModifierFlags) -> [String] {
    var names: [String] = []
    if mask.contains(.command) { names.append("command") }
    if mask.contains(.shift) { names.append("shift") }
    if mask.contains(.option) { names.append("option") }
    if mask.contains(.control) { names.append("control") }
    return names
  }

  private func build() {
    // Each top-level item is titled as well as its submenu. AppKit displays the
    // submenu's title, but an untitled `NSMenuItem` describes itself as
    // "NSMenuItem", and a menu that cannot say what it is cannot be audited.
    let appItem = NSMenuItem()
    appItem.title = "VibeHub Workbench"
    let appMenu = NSMenu(title: "VibeHub Workbench")
    appMenu.addItem(
      withTitle: "About VibeHub Workbench",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "Quit VibeHub Workbench",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )
    appItem.submenu = appMenu
    menu.addItem(appItem)

    // The repository menu. `Open Repository…` is the same directory chooser the
    // launch surface offers, and it stays available once a repository is open —
    // that absence is the whole reason quitting used to be the only way to move
    // between projects.
    let fileItem = NSMenuItem()
    fileItem.title = "File"
    let fileMenu = NSMenu(title: "File")
    let open = NSMenuItem(
      title: WorkbenchMenu.openRepositoryTitle,
      action: #selector(AppDelegate.openRepository(_:)),
      keyEquivalent: "o"
    )
    open.keyEquivalentModifierMask = [.command]
    fileMenu.addItem(open)
    let recentsItem = NSMenuItem(
      title: WorkbenchMenu.recentRepositoriesTitle,
      action: nil,
      keyEquivalent: ""
    )
    recentsItem.submenu = recentsMenu
    fileMenu.addItem(recentsItem)
    fileItem.submenu = fileMenu
    menu.addItem(fileItem)

    let editItem = NSMenuItem()
    editItem.title = "Edit"
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(
      withTitle: "Select All",
      action: #selector(NSResponder.selectAll(_:)),
      keyEquivalent: "a"
    )
    editItem.submenu = editMenu
    menu.addItem(editItem)

    let windowItem = NSMenuItem()
    windowItem.title = "Window"
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      withTitle: "Close Window",
      action: #selector(NSWindow.performClose(_:)),
      keyEquivalent: "w"
    )
    windowMenu.addItem(
      withTitle: "Minimize",
      action: #selector(NSWindow.performMiniaturize(_:)),
      keyEquivalent: "m"
    )
    windowItem.submenu = windowMenu
    menu.addItem(windowItem)
  }
}
