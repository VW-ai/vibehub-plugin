import AppKit

/// A minimal main menu so Cmd-Q, Cmd-W, and clipboard shortcuts exist even when
/// the binary is run straight out of `swift build` rather than from a bundle.
enum WorkbenchMenu {
  static func build() -> NSMenu {
    let main = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu()
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
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(
      withTitle: "Select All",
      action: #selector(NSResponder.selectAll(_:)),
      keyEquivalent: "a"
    )
    editItem.submenu = editMenu
    main.addItem(editItem)

    let windowItem = NSMenuItem()
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
    main.addItem(windowItem)

    return main
  }
}
