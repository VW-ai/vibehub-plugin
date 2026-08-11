import AppKit
import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.contains("--help") || arguments.contains("-h") {
  FileHandle.standardOutput.write(Data("\(ProbeCommand.usage)\n".utf8))
  exit(0)
}

if let probe = ProbeCommand(arguments: arguments) {
  exit(probe.run())
}

// `--repo <worktree>` is the command-line form of the same explicit user choice
// the picker makes; it opens that exact worktree instead of the picker. It is
// never inferred, discovered, or remembered from anywhere else.
var initialRepository: String?
if arguments.first == "--repo", arguments.count == 2 {
  initialRepository = arguments[1]
} else if let unexpected = arguments.first {
  FileHandle.standardError.write(Data("unknown flag: \(unexpected)\n\(ProbeCommand.usage)\n".utf8))
  exit(1)
}

let application = NSApplication.shared
let delegate = AppDelegate(initialRepository: initialRepository)
application.delegate = delegate
application.setActivationPolicy(.regular)
// The menu reads the remembered list from the same preferences the session
// writes, and the session keeps a reference so the recent-repositories submenu
// is rebuilt whenever that list changes.
let mainMenu = WorkbenchMenu(recents: { [preferences = delegate.preferences] in
  preferences.recentRepositories
})
delegate.menu = mainMenu
application.mainMenu = mainMenu.menu
application.run()
