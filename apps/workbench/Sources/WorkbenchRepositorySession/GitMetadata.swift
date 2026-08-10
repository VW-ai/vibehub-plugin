import Foundation

public enum WorktreeError: Error, LocalizedError {
  case notADirectory(String)
  case notAnExactWorktree(String, String)
  case notAVibeHubRepository(String)
  case gitFailed(String)

  public var errorDescription: String? {
    switch self {
    case .notADirectory(let path):
      return "\(path) is not a directory."
    case .notAnExactWorktree(let path, let toplevel):
      return "\(path) is not an exact Git worktree root. Its worktree root is \(toplevel)."
    case .notAVibeHubRepository(let path):
      return "\(path) has no .vibehub directory, so it holds no checked-in Ticket graph."
    case .gitFailed(let message):
      return message.isEmpty ? "git could not read this directory." : message
    }
  }
}

/// Git metadata for the exact worktree the user selected.
///
/// The shell never scans, discovers, or walks other repositories: every read is
/// scoped to one absolute path the user chose through `NSOpenPanel` (§8.3).
public enum GitMetadata {
  public static let gitExecutable = URL(fileURLWithPath: "/usr/bin/git")

  /// Reads a fresh, non-semantic session for `path`, or throws when the path is
  /// not the exact root of a Git worktree holding a `.vibehub` directory.
  public static func readSession(repoRoot path: String) throws -> RepositorySession {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
      isDirectory.boolValue
    else { throw WorktreeError.notADirectory(path) }

    let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    let toplevel = try git(["rev-parse", "--show-toplevel"], in: resolved)
    let resolvedToplevel = URL(fileURLWithPath: toplevel).resolvingSymlinksInPath().path
    guard resolvedToplevel == resolved else {
      throw WorktreeError.notAnExactWorktree(resolved, resolvedToplevel)
    }
    guard FileManager.default.fileExists(atPath: resolved + "/.vibehub") else {
      throw WorktreeError.notAVibeHubRepository(resolved)
    }

    let head = try git(["rev-parse", "--abbrev-ref", "HEAD"], in: resolved)
    let commit = try git(["rev-parse", "HEAD"], in: resolved)
    let status = try git(["status", "--porcelain"], in: resolved)
    return RepositorySession(
      repoRoot: resolved,
      branch: head == "HEAD" ? nil : head,
      commit: commit,
      dirty: !status.isEmpty
    )
  }

  @discardableResult
  static func git(_ arguments: [String], in repoRoot: String) throws -> String {
    let process = Process()
    process.executableURL = gitExecutable
    process.arguments = ["-C", repoRoot] + arguments
    // A fixed, minimal environment: nothing from the selected repository is
    // ever executed, and no repository-provided pager or editor is invoked.
    process.environment = ["PATH": "/usr/bin:/bin", "GIT_TERMINAL_PROMPT": "0"]
    let output = Pipe()
    let errors = Pipe()
    process.standardOutput = output
    process.standardError = errors
    do {
      try process.run()
    } catch {
      throw WorktreeError.gitFailed("git could not be started: \(error.localizedDescription)")
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let errorData = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let message = String(decoding: errorData, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      throw WorktreeError.gitFailed(message)
    }
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
