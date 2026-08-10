import Foundation

public enum ToolchainError: Error, LocalizedError {
  case nodeNotFound
  case launcherNotFound(String)

  public var errorDescription: String? {
    switch self {
    case .nodeNotFound:
      return "Node >= 20 was not found. Set VIBEHUB_NODE to the node executable."
    case .launcherNotFound(let start):
      return """
        The read-only host launcher skills/scripts/vh-workbench.mjs was not found \
        above \(start). Set VIBEHUB_WORKBENCH_LAUNCHER to it.
        """
    }
  }
}

/// Resolves the two executables the shell spawns.
///
/// Security boundary (§10): both are resolved from the app's **own**
/// installation or from an explicit environment override. The selected
/// repository is never searched for a launcher, an interpreter, a hook, or any
/// other executable — choosing a worktree must never mean running its code.
public enum ToolchainLocator {
  public static let launcherRelativePath = "skills/scripts/vh-workbench.mjs"

  private static let nodeCandidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]

  public static func nodeExecutable(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) throws -> URL {
    if let override = environment["VIBEHUB_NODE"], isExecutableFile(override) {
      return URL(fileURLWithPath: override)
    }
    for candidate in nodeCandidates where isExecutableFile(candidate) {
      return URL(fileURLWithPath: candidate)
    }
    // A bundled .app inherits a minimal PATH from launchd, so fall back to the
    // user's login shell purely to locate node.
    if let located = loginShellLookup("node"), isExecutableFile(located) {
      return URL(fileURLWithPath: located)
    }
    throw ToolchainError.nodeNotFound
  }

  /// Walks up from the running binary looking for the plugin bundle that ships
  /// the read-only host. Works for `swift build` output inside a checkout and
  /// for a `.app` placed beside the checkout it was built from.
  public static func launcherScript(
    searchingFrom start: URL,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) throws -> URL {
    if let override = environment["VIBEHUB_WORKBENCH_LAUNCHER"],
      FileManager.default.isReadableFile(atPath: override)
    {
      return URL(fileURLWithPath: override)
    }
    var directory = start.resolvingSymlinksInPath()
    if directory.hasDirectoryPath == false { directory = directory.deletingLastPathComponent() }
    while directory.path != "/" {
      let candidate = directory.appendingPathComponent(launcherRelativePath)
      if FileManager.default.isReadableFile(atPath: candidate.path) { return candidate }
      directory = directory.deletingLastPathComponent()
    }
    throw ToolchainError.launcherNotFound(start.path)
  }

  private static func isExecutableFile(_ path: String) -> Bool {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
      !isDirectory.boolValue
    else { return false }
    return FileManager.default.isExecutableFile(atPath: path)
  }

  private static func loginShellLookup(_ tool: String) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-lc", "command -v \(tool)"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    let path = String(decoding: data, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty ? nil : path
  }
}
