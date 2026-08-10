import Foundation
import WorkbenchRepositorySession

public enum HostSessionError: Error, LocalizedError {
  case launchFailed(String)
  case noHandshake(String)
  case malformedHandshake(String)

  public var errorDescription: String? {
    switch self {
    case .launchFailed(let message): return "The read-only host could not start: \(message)"
    case .noHandshake(let message):
      return "The read-only host produced no authorized URL. \(message)"
    case .malformedHandshake(let message):
      return "The read-only host handshake could not be read: \(message)"
    }
  }
}

/// The handshake the host prints on its first stdout line.
///
/// `authorizedURL` carries the bearer token in its fragment. It stays in this
/// process's memory and is handed only to the WKWebView: it is never written to
/// preferences, logs, or any file. Use `redactedDescription` for anything a
/// human or a log might see.
public struct HostSessionReady: Sendable {
  public let origin: URL
  public let port: Int
  public let authorizedURL: URL
  public let processIdentifier: Int32

  public var redactedDescription: String {
    "\(origin.absoluteString)/#<token withheld> (pid \(processIdentifier))"
  }
}

/// Starts and owns the existing read-only host **inside this app session**.
///
/// The shell adds no projection, layout, or API of its own: it spawns
/// `node skills/scripts/vh-workbench.mjs --repo <path> --no-open --json`, which
/// already provides the session-owned lifetime (`tokenLifetimeMs: null`), the
/// `.vibehub/**` + Git watcher, and the shared frontend assets. Terminating this
/// object ends the host, the watcher, and the token together.
public final class HostSession {
  public let repoRoot: String
  public let ready: HostSessionReady

  private let process: Process
  private let stdout: Pipe
  private let stderr: Pipe

  private init(repoRoot: String, ready: HostSessionReady, process: Process, stdout: Pipe, stderr: Pipe) {
    self.repoRoot = repoRoot
    self.ready = ready
    self.process = process
    self.stdout = stdout
    self.stderr = stderr
  }

  public static func start(
    repoRoot: String,
    node: URL,
    launcher: URL,
    focusTicket: String? = nil,
    focusTab: InspectorTab? = nil,
    timeout: TimeInterval = 30
  ) throws -> HostSession {
    var arguments = [launcher.path, "--repo", repoRoot, "--no-open", "--json"]
    if let focusTicket, isCanonicalTicketId(focusTicket) {
      arguments.append(contentsOf: ["--ticket", focusTicket])
      arguments.append(contentsOf: ["--view", (focusTab ?? .execution).rawValue])
    }

    let process = Process()
    process.executableURL = node
    process.arguments = arguments
    // Run from the plugin bundle that owns the launcher, never from the
    // selected worktree.
    process.currentDirectoryURL = launcher.deletingLastPathComponent()
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = stdout
    process.standardError = stderr

    do {
      try process.run()
    } catch {
      throw HostSessionError.launchFailed(error.localizedDescription)
    }

    let line = try firstLine(of: stdout, process: process, stderr: stderr, timeout: timeout)
    guard let data = line.data(using: .utf8),
      let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let urlString = envelope["url"] as? String,
      let originString = envelope["origin"] as? String,
      let authorizedURL = URL(string: urlString),
      let origin = URL(string: originString),
      let port = origin.port
    else {
      process.terminate()
      throw HostSessionError.malformedHandshake(line)
    }

    // Nothing after the handshake is needed; drain both pipes so the host is
    // never blocked on backpressure.
    stdout.fileHandleForReading.readabilityHandler = { handle in
      _ = handle.availableData
    }
    stderr.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      if !chunk.isEmpty {
        FileHandle.standardError.write(chunk)
      }
    }

    let ready = HostSessionReady(
      origin: origin,
      port: port,
      authorizedURL: authorizedURL,
      processIdentifier: process.processIdentifier
    )
    return HostSession(repoRoot: repoRoot, ready: ready, process: process, stdout: stdout, stderr: stderr)
  }

  public var isRunning: Bool { process.isRunning }

  /// Ends the host, its watcher, and its in-memory token.
  ///
  /// `vh-workbench.mjs` closes the loopback server on SIGTERM and exits 0; the
  /// SIGKILL fallback only runs if it has not exited within the grace period.
  public func terminate(gracePeriod: TimeInterval = 5) {
    stdout.fileHandleForReading.readabilityHandler = nil
    stderr.fileHandleForReading.readabilityHandler = nil
    guard process.isRunning else { return }
    process.terminate()
    let deadline = Date().addingTimeInterval(gracePeriod)
    while process.isRunning && Date() < deadline {
      usleep(20_000)
    }
    if process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      process.waitUntilExit()
    }
  }

  private static func firstLine(
    of stdout: Pipe,
    process: Process,
    stderr: Pipe,
    timeout: TimeInterval
  ) throws -> String {
    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var buffered = Data()
    var line: String?

    stdout.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      lock.lock()
      defer { lock.unlock() }
      if chunk.isEmpty {
        semaphore.signal()
        return
      }
      buffered.append(chunk)
      if let newline = buffered.firstIndex(of: 0x0A) {
        line = String(decoding: buffered[buffered.startIndex..<newline], as: UTF8.self)
        semaphore.signal()
      }
    }
    defer { stdout.fileHandleForReading.readabilityHandler = nil }

    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      throw HostSessionError.noHandshake("It did not answer within \(Int(timeout))s.")
    }
    lock.lock()
    let resolved = line
    lock.unlock()
    guard let resolved else {
      let message = String(
        decoding: stderr.fileHandleForReading.availableData,
        as: UTF8.self
      ).trimmingCharacters(in: .whitespacesAndNewlines)
      process.waitUntilExit()
      throw HostSessionError.noHandshake(message.isEmpty ? "It exited early." : message)
    }
    return resolved
  }
}
