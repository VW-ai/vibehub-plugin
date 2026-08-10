// swift-tools-version:5.9
import PackageDescription

// The thin macOS Workbench shell (docs/VIBEHUB_WORKBENCH_WEBVIEW.zh-CN.md §12).
// The desktop framework stays outside the Ticket semantic layer: projection,
// layout, and the frontend all remain in the shared read-only host and assets.
let package = Package(
  name: "VibeHubWorkbench",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "VibeHubWorkbench", targets: ["WorkbenchDesktop"]),
  ],
  targets: [
    // exact worktree, Git metadata, preference allowlist
    .target(name: "WorkbenchRepositorySession"),
    // starts/stops the read-only host, holds the token in memory, narrow policy
    .target(name: "WorkbenchWebViewBridge", dependencies: ["WorkbenchRepositorySession"]),
    // window, directory selection, session lifecycle
    .executableTarget(
      name: "WorkbenchDesktop",
      dependencies: ["WorkbenchRepositorySession", "WorkbenchWebViewBridge"]
    ),
  ]
)
