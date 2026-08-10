import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

const app = join(root, "apps", "workbench");
const sources = join(app, "Sources");
const binary = join(app, ".build", "debug", "VibeHubWorkbench");

const repos = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // SIGTERM, not SIGKILL: the shell can only take its host down with it if it
    // is allowed to run its handler, and a leaked test must not leak a host.
    child.kill("SIGTERM");
    await settle(() => child.exitCode !== null || child.signalCode !== null, 6_000);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function swiftFiles(directory = sources) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(absolute);
    return entry.name.endsWith(".swift") ? [absolute] : [];
  });
}

/**
 * Every Swift line that is actually compiled. Full-line comments are dropped so
 * a doc comment naming a forbidden API (to explain why it is never used) cannot
 * satisfy or defeat a boundary assertion.
 */
function allSwiftSource() {
  return swiftFiles()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function read(relative) {
  return readFileSync(join(app, relative), "utf8");
}

/**
 * The Swift toolchain is optional: this suite must stay green on a machine
 * without Xcode, so every test that compiles or runs the shell is skipped
 * rather than failed when the toolchain is missing.
 */
function toolchain() {
  if (process.platform !== "darwin") return null;
  const swift = spawnSync("swift", ["--version"], { encoding: "utf8" });
  if (swift.status !== 0) return null;
  const developer = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
  if (developer.status !== 0) return null;
  return { swift: swift.stdout.trim().split("\n")[0] };
}

let built = false;
function buildOnce(t) {
  if (!toolchain()) {
    t.skip("Swift toolchain or macOS SDK is unavailable");
    return false;
  }
  if (!built) {
    const build = spawnSync("swift", ["build", "--package-path", app], { encoding: "utf8" });
    assert.equal(build.status, 0, `swift build failed:\n${build.stdout}\n${build.stderr}`);
    built = true;
  }
  return true;
}

function probe(...args) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

function fixture() {
  // The shell resolves symlinks so the exact worktree is unambiguous; the
  // fixture must compare against the same resolved path.
  const repo = realpathSync(tempRepo("workbench-shell"));
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("foundation")] }).status, 0);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "workbench-fixture");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "fixture");
  return repo;
}

function canonicalBytes(repo) {
  const base = join(repo, ".vibehub");
  function collect(directory, prefix = "") {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relative = join(prefix, entry.name);
      const absolute = join(directory, entry.name);
      return entry.isDirectory()
        ? collect(absolute, relative)
        : [[relative, readFileSync(absolute, "utf8")]];
    });
  }
  return collect(base).sort(([left], [right]) => left.localeCompare(right));
}

function firstLine(child) {
  return new Promise((resolveLine, rejectLine) => {
    let buffered = "";
    const timer = setTimeout(
      () => rejectLine(new Error(`shell produced no handshake: ${buffered}`)),
      60_000,
    );
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        resolveLine(buffered.slice(0, newline));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      rejectLine(new Error(`shell exited early: ${buffered}`));
    });
  });
}

function exited(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(condition, budgetMs = 8_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !condition()) {
    await new Promise((wait) => setTimeout(wait, 100));
  }
  return condition();
}

// ---------------------------------------------------------------- layout

test("the shell is a thin Swift package split into desktop, session, and bridge", () => {
  const manifest = read("Package.swift");
  assert.match(manifest, /\.executable\(name: "VibeHubWorkbench", targets: \["WorkbenchDesktop"\]\)/u);
  for (const target of [
    "WorkbenchRepositorySession",
    "WorkbenchWebViewBridge",
    "WorkbenchDesktop",
  ]) {
    assert.match(manifest, new RegExp(`name: "${target}"`, "u"));
    assert.ok(statSync(join(sources, target)).isDirectory(), `missing target ${target}`);
  }
  assert.match(manifest, /platforms: \[\.macOS\(\.v13\)\]/u);
});

test("the shell owns repository selection and recent repositories natively", () => {
  const picker = read("Sources/WorkbenchDesktop/RepositoryPickerWindowController.swift");
  assert.match(picker, /NSOpenPanel\(\)/u);
  assert.match(picker, /panel\.canChooseDirectories = true/u);
  assert.match(picker, /panel\.canChooseFiles = false/u);
  assert.match(picker, /recentRepositories/u);
  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  assert.match(delegate, /rememberRepository/u);
});

// ------------------------------------------------------- session lifecycle

test("the shell starts the existing read-only host instead of reimplementing it", () => {
  const host = read("Sources/WorkbenchWebViewBridge/HostSession.swift");
  assert.match(host, /launcher\.path, "--repo", repoRoot, "--no-open", "--json"/u);
  const locator = read("Sources/WorkbenchWebViewBridge/ToolchainLocator.swift");
  assert.match(locator, /skills\/scripts\/vh-workbench\.mjs/u);
  // The launcher is resolved from the app's own installation. Nothing about the
  // selected repository may influence which executable is spawned.
  assert.doesNotMatch(locator, /repoRoot/u);

  const source = allSwiftSource();
  // No projection, layout, or Ticket semantics leak into the desktop shell.
  for (const forbidden of [/\/api\/state/u, /buildUiSnapshot/u, /frontier\s*=/u]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("quitting the shell terminates the host, and nothing daemonizes", () => {
  const source = allSwiftSource();
  assert.match(source, /func terminate\(gracePeriod/u);
  assert.match(source, /applicationWillTerminate/u);
  assert.match(source, /applicationShouldTerminateAfterLastWindowClosed/u);
  // AppKit skips applicationWillTerminate for a plain kill, so the shell also
  // handles the signals itself.
  assert.match(source, /DispatchSource\.makeSignalSource\(signal: number/u);
  for (const forbidden of [
    /SMLoginItemSetEnabled/u,
    /NSBackgroundActivityScheduler/u,
    /LSSharedFileList/u,
    /launchctl/u,
    /LSUIElement.*true/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  const plist = readFileSync(join(app, "Scripts", "make-app-bundle.sh"), "utf8");
  assert.doesNotMatch(plist, /LSBackgroundOnly|NSUIElement|LoginItem/u);
});

// ------------------------------------------------------------ persistence

test("only the §8.2 preference allowlist is written, and never authority", () => {
  const preferences = read("Sources/WorkbenchRepositorySession/WorkbenchPreferences.swift");
  const cases = [...preferences.matchAll(/^\s{2}case (\w+)$/gmu)].map(([, name]) => name);
  assert.deepEqual(cases, [
    "recentRepositories",
    "windowFrame",
    "lastTicketId",
    "lastInspectorTab",
  ]);

  const source = allSwiftSource();
  const written = [...source.matchAll(/defaults\.set\([\s\S]{0,200}?forKey: ([^,)\n]+)/gu)]
    .map(([, key]) => key.trim());
  assert.ok(written.length >= 4, "no preference writes were found to audit");
  for (const key of written) {
    assert.ok(
      key.startsWith("PreferenceKey.") || key === "WorkbenchPreferences.suiteName",
      `preference written under a key outside the allowlist: ${key}`,
    );
  }
  // The bearer token, Ticket states, the frontier, and projected snapshots are
  // never persisted under any name.
  for (const forbidden of [
    /set\([^)]*token/iu,
    /UserDefaults[^\n]*token/iu,
    /forKey: "(?!\w*(?:recentRepositories|windowFrame|lastTicketId|lastInspectorTab))/u,
    /snapshot/iu,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("the running binary reports the persistence allowlist honestly", (t) => {
  if (!buildOnce(t)) return;
  const preferences = probe("--probe-preferences");
  assert.equal(preferences.ok, true);
  assert.deepEqual(preferences.allowlist, [
    "recentRepositories",
    "windowFrame",
    "lastTicketId",
    "lastInspectorTab",
  ]);
  // §8.2 permits viewport, but the shared frontend exposes no viewport contract
  // through its URL, so the shell honestly restores nothing rather than faking
  // a pan/zoom it cannot reproduce.
  assert.equal(preferences.viewportRestored, false);
  for (const key of preferences.written) {
    assert.ok(preferences.allowlist.includes(key), `unexpected persisted key ${key}`);
  }
});

// -------------------------------------------------------- narrow boundary

test("the WebView gets no file access and no callable native bridge", () => {
  const source = allSwiftSource();
  for (const forbidden of [
    /loadFileURL/u,
    /allowingReadAccessTo/u,
    /allowFileAccessFromFileURLs/u,
    /allowUniversalAccessFromFileURLs/u,
    /WKScriptMessageHandler/u,
    /WKUserScript/u,
    /userContentController\.add/u,
    /NSOpenPanel[\s\S]{0,400}evaluateJavaScript/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  const configuration = read("Sources/WorkbenchWebViewBridge/WorkbenchWebView.swift");
  assert.match(configuration, /websiteDataStore = \.nonPersistent\(\)/u);

  const policy = read("Sources/WorkbenchWebViewBridge/NavigationPolicy.swift");
  assert.match(policy, /url\.host == sessionOrigin\.host/u);
  assert.match(policy, /url\.port == sessionOrigin\.port/u);
});

test("the navigation policy allows exactly one loopback session origin", (t) => {
  if (!buildOnce(t)) return;
  const origin = "http://127.0.0.1:51234";
  const decide = (url, link = false) =>
    probe("--probe-navigation", "--origin", origin, "--url", url, ...(link ? ["--link"] : []))
      .decision;

  assert.equal(decide(`${origin}/`), "allow-in-webview");
  assert.equal(decide(`${origin}/api/state`), "allow-in-webview");
  assert.equal(decide("http://127.0.0.1:51235/api/state"), "deny");
  assert.equal(decide("http://localhost:51234/api/state"), "deny");
  assert.equal(decide("file:///etc/passwd"), "deny");
  assert.equal(decide("file:///etc/passwd", true), "deny");
  assert.equal(decide("data:text/html,<b>x"), "deny");
  assert.equal(decide("https://example.com/evil"), "deny");
  // Remote links a user clicks leave the WebView for the default browser.
  assert.equal(decide("https://github.com/VW-ai/vibehub-plugin", true), "open-externally");
});

// --------------------------------------------------- shared frontend only

test("the shell ships no frontend of its own", () => {
  const forked = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".build") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.(?:html|css|js|mjs|jsx|ts|tsx)$/u.test(entry.name)) forked.push(absolute);
    }
  };
  walk(app);
  assert.deepEqual(forked, [], `the shell forked frontend assets: ${forked.join(", ")}`);
  // The Phase 0 browser entry keeps working from the same code.
  assert.ok(existsSync(join(root, "skills", "scripts", "vh-workbench.mjs")));
  assert.ok(existsSync(join(root, "skills", "vibehub-ticket-review", "assets", "app.js")));
});

// -------------------------------------------------- end-to-end lifecycle

test("the shell session owns the host and leaves no process or port behind", async (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture();
  const before = canonicalBytes(repo);
  const child = spawn(binary, ["--probe-session", "--repo", repo], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const envelope = JSON.parse(await firstLine(child));

  assert.equal(envelope.ok, true);
  // Foundation canonicalises /private/var to /var; both name the same worktree.
  const canonical = (path) => path.replace(/^\/private(?=\/)/u, "");
  assert.equal(canonical(envelope.repo), canonical(repo));
  assert.equal(envelope.branch, "workbench-fixture");
  assert.equal(envelope.tokenPrinted, false);
  assert.match(envelope.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  // The bearer token never reaches stdout, a log, or a preference.
  assert.doesNotMatch(JSON.stringify(envelope), /[0-9a-f]{64}/u);

  const health = await (await fetch(`${envelope.origin}/health`)).json();
  assert.deepEqual(health, { ok: true, schemaVersion: 1, readOnly: true });
  assert.equal(alive(envelope.hostPid), true);

  child.kill("SIGTERM");
  assert.deepEqual(await exited(child), { code: 0, signal: null });
  assert.equal(await settle(() => !alive(envelope.hostPid)), true, "the host outlived the shell");
  await assert.rejects(fetch(`${envelope.origin}/health`));
  assert.deepEqual(canonicalBytes(repo), before);
});

test("the WebView renders the shared frontend and cannot escape the origin", async (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture();
  const result = spawnSync(binary, ["--probe-render", "--repo", repo], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.signal || !result.stdout.trim()) {
    t.skip(`the WKWebView probe needs a window server session: ${result.stderr}`);
    return;
  }
  const rendered = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(rendered.ok, true, result.stderr);

  // Exactly the shared assets the browser mode serves, over the same host.
  assert.deepEqual(rendered.rendered.assets, ["/app.css", "/app.js"]);
  assert.equal(rendered.rendered.nodes, 1);
  assert.equal(rendered.rendered.path, repo);
  assert.equal(rendered.rendered.branch, "workbench-fixture");
  assert.equal(rendered.loadedOrigin, "127.0.0.1");

  // The live page cannot reach the local filesystem and has no native bridge.
  assert.equal(rendered.fileNavigationDenied, true);
  assert.equal(rendered.escapeAttempts, "fetch-file:blocked,bridge:absent");
});
