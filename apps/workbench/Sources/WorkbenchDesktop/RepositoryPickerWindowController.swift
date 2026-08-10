import AppKit
import WorkbenchRepositorySession

/// The launch surface: recent repositories plus native directory selection.
///
/// This window is the only place a repository enters the app. There is no
/// background scan, no discovery, and no auto-open: a worktree becomes visible
/// because the user chose it here (§8.3, §15).
final class RepositoryPickerWindowController: NSObject {
  let window: NSWindow
  private let preferences: WorkbenchPreferences
  private let onOpen: (String) -> Void
  private let statusLabel = NSTextField(labelWithString: "")
  private let recentsStack = NSStackView()

  init(preferences: WorkbenchPreferences, onOpen: @escaping (String) -> Void) {
    self.preferences = preferences
    self.onOpen = onOpen
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 560, height: 380),
      styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    super.init()

    window.title = "VibeHub Workbench"
    // Opening a repository closes this window and a later refused deep link
    // brings it back. AppKit's default would have freed it on that first close.
    window.isReleasedWhenClosed = false
    window.center()
    window.contentView = buildContent()
    reloadRecents()
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
    if preferences.recentRepositories.isEmpty {
      DispatchQueue.main.async { [weak self] in self?.chooseRepository(nil) }
    }
  }

  func report(_ message: String) {
    statusLabel.stringValue = message
    statusLabel.isHidden = message.isEmpty
  }

  private func buildContent() -> NSView {
    let heading = NSTextField(labelWithString: "Open an exact Git worktree")
    heading.font = .systemFont(ofSize: 20, weight: .semibold)

    let explanation = NSTextField(wrappingLabelWithString: """
      The Workbench reads the checked-in Ticket graph from Git on every launch. \
      It belongs to you, not to an Agent task: no Agent conversation starts it, \
      and closing one never closes this window.
      """)
    explanation.font = .systemFont(ofSize: 12)
    explanation.textColor = .secondaryLabelColor

    let recentsHeading = NSTextField(labelWithString: "Recent repositories")
    recentsHeading.font = .systemFont(ofSize: 11, weight: .semibold)
    recentsHeading.textColor = .secondaryLabelColor

    recentsStack.orientation = .vertical
    recentsStack.alignment = .leading
    recentsStack.spacing = 4

    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.documentView = recentsStack
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true

    let choose = NSButton(title: "Choose Repository…", target: self, action: #selector(chooseRepository(_:)))
    choose.keyEquivalent = "\r"
    choose.bezelStyle = .rounded

    statusLabel.font = .systemFont(ofSize: 11)
    statusLabel.textColor = .systemRed
    statusLabel.isHidden = true
    statusLabel.lineBreakMode = .byWordWrapping
    statusLabel.maximumNumberOfLines = 3

    let stack = NSStackView(views: [
      heading, explanation, recentsHeading, scroll, statusLabel, choose,
    ])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 24, left: 24, bottom: 24, right: 24)
    stack.translatesAutoresizingMaskIntoConstraints = false

    let container = NSView()
    container.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      stack.topAnchor.constraint(equalTo: container.topAnchor),
      stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -48),
    ])
    return container
  }

  func reloadRecents() {
    for view in recentsStack.arrangedSubviews { view.removeFromSuperview() }
    let recents = preferences.recentRepositories
    guard !recents.isEmpty else {
      let empty = NSTextField(labelWithString: "No repositories opened yet.")
      empty.font = .systemFont(ofSize: 12)
      empty.textColor = .tertiaryLabelColor
      recentsStack.addArrangedSubview(empty)
      return
    }
    for path in recents {
      let button = NSButton(
        title: (path as NSString).lastPathComponent,
        target: self,
        action: #selector(openRecent(_:))
      )
      button.bezelStyle = .inline
      button.toolTip = path
      button.identifier = NSUserInterfaceItemIdentifier(path)
      let detail = NSTextField(labelWithString: path)
      detail.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
      detail.textColor = .tertiaryLabelColor
      detail.lineBreakMode = .byTruncatingHead
      let row = NSStackView(views: [button, detail])
      row.orientation = .vertical
      row.alignment = .leading
      row.spacing = 0
      recentsStack.addArrangedSubview(row)
    }
  }

  @objc private func openRecent(_ sender: NSButton) {
    guard let path = sender.identifier?.rawValue else { return }
    onOpen(path)
  }

  @objc private func chooseRepository(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.title = "Choose an exact Git worktree"
    panel.prompt = "Open"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.resolvesAliases = true
    panel.beginSheetModal(for: window) { [weak self] response in
      guard response == .OK, let url = panel.url else { return }
      self?.onOpen(url.resolvingSymlinksInPath().path)
    }
  }
}
