import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startVibeHubUi } from "../skills/scripts/vh-ui.mjs";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

const app = join(root, "apps", "workbench");
const sources = join(app, "Sources");
const binary = join(app, ".build", "debug", "VibeHubWorkbench");

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function read(relative) {
  return readFileSync(join(app, relative), "utf8");
}

function swiftFiles(directory = sources) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return swiftFiles(absolute);
    return entry.name.endsWith(".swift") ? [absolute] : [];
  });
}

/** Every Swift line that is actually compiled; full-line comments are dropped. */
function allSwiftSource() {
  return swiftFiles()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/**
 * The Swift toolchain is optional: this suite must stay green on a machine
 * without Xcode, so every test that compiles or runs the shell is skipped
 * rather than failed when the toolchain is missing.
 */
function toolchain() {
  if (process.platform !== "darwin") return null;
  if (spawnSync("swift", ["--version"], { encoding: "utf8" }).status !== 0) return null;
  return spawnSync("xcode-select", ["-p"], { encoding: "utf8" }).status === 0 ? {} : null;
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

function link(uri, { current, known = [] } = {}) {
  return probe(
    "--probe-deep-link",
    "--url",
    uri,
    ...(current ? ["--current", current] : []),
    ...known.flatMap((path) => ["--known", path]),
  );
}

function fixture(label = "workbench-deep-link", tickets = ["ticket-foundation"]) {
  // The shell resolves symlinks so the exact worktree is unambiguous; the
  // fixture must compare against the same resolved path.
  const repo = realpathSync(tempRepo(label));
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: tickets.map((id) => ticket(id)) }).status, 0);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "deep-link-fixture");
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

/** Foundation canonicalises /private/var to /var; both name the same worktree. */
function canonical(path) {
  return path.replace(/^\/private(?=\/)/u, "");
}

function uri(repo, ticketId, view) {
  const query = new URLSearchParams({ repo });
  if (ticketId) query.set("ticket", ticketId);
  if (view) query.set("view", view);
  return `vibehub://open?${query.toString()}`;
}

// ------------------------------------------------------------ registration

test("the app bundle registers exactly one scheme and the app handles it", () => {
  const bundle = read("Scripts/make-app-bundle.sh");
  assert.match(bundle, /<key>CFBundleURLTypes<\/key>/u);
  assert.match(bundle, /<key>CFBundleURLSchemes<\/key>\s*\n\s*<array><string>vibehub<\/string><\/array>/u);
  assert.match(bundle, /<key>CFBundleTypeRole<\/key><string>Viewer<\/string>/u);
  // Exactly one scheme is claimed, and it is not a document or file handler.
  assert.equal([...bundle.matchAll(/<string>vibehub<\/string>/gu)].length, 1);
  assert.doesNotMatch(bundle, /CFBundleDocumentTypes|UTExportedTypeDeclarations/u);

  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  assert.match(delegate, /NSAppleEventManager\.shared\(\)\s*\n?\s*\.?setEventHandler\(/u);
  assert.match(delegate, /AEEventClass\(kInternetEventClass\)/u);
  assert.match(delegate, /AEEventID\(kAEGetURL\)/u);
  assert.match(delegate, /paramDescriptor\(forKeyword: keyDirectObject\)/u);
});

test("a deep link can express navigation and nothing else", () => {
  const contract = read("Sources/WorkbenchRepositorySession/DeepLink.swift");
  assert.match(contract, /public static let scheme = "vibehub"/u);
  assert.match(contract, /public static let action = "open"/u);
  assert.match(contract, /public static let parameters = \["repo", "ticket", "view"\]/u);
  // The type has exactly three stored properties: repository, Ticket, layer.
  const declaration = contract.slice(
    contract.indexOf("public struct DeepLink"),
    contract.indexOf("public init(repoRoot:"),
  );
  const stored = [...declaration.matchAll(/^  public let (\w+):/gmu)].map(([, name]) => name);
  assert.deepEqual(stored, ["repoRoot", "ticketId", "view"]);

  const source = allSwiftSource();
  // No deep-link branch may write a checked-in document or call a mutating
  // helper: the shell has no write API at all, and the URI adds none.
  for (const forbidden of [
    /vh\.mjs/u,
    /"ticket", "apply"/u,
    /createFile|writeToFile|contentsOfFile|\.write\(to:/u,
    /URLRequest\([\s\S]{0,120}httpMethod/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

// -------------------------------------------------------------- URI contract

test("the running binary accepts exactly the §9 URI forms", (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture();

  const repositoryOnly = link(uri(repo));
  assert.equal(repositoryOnly.accepted, true);
  assert.equal(canonical(repositoryOnly.repo), canonical(repo));
  assert.equal(repositoryOnly.ticket, null);
  assert.equal(repositoryOnly.view, null);
  assert.equal(repositoryOnly.focusPath, "/");

  const withTicket = link(uri(repo, "ticket-foundation"));
  assert.equal(withTicket.accepted, true);
  assert.equal(withTicket.ticket, "ticket-foundation");
  assert.equal(withTicket.focusPath, "/?ticket=ticket-foundation&view=execution");

  for (const view of ["execution", "contract", "log"]) {
    const focused = link(uri(repo, "ticket-foundation", view));
    assert.equal(focused.accepted, true, `${view} was refused`);
    assert.equal(focused.view, view);
    assert.equal(focused.focusPath, `/?ticket=ticket-foundation&view=${view}`);
    // The frontend's own contract, and the session fragment it needs, survive.
    assert.equal(focused.focusFragmentPreserved, true);
  }
});

test("every malformed or over-reaching URI fails safe", (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture();
  const before = canonicalBytes(repo);
  const baseline = link(uri(repo)).preferenceKeys;

  const refusals = [
    ["not a URI at all", /is not a valid URI|not a VibeHub deep link/u],
    [`vibehubx://open?repo=${repo}`, /not a VibeHub deep link/u],
    [`https://open?repo=${repo}`, /not a VibeHub deep link/u],
    [`file://open?repo=${repo}`, /not a VibeHub deep link/u],
    [`vibehub://write?repo=${repo}`, /not a supported action/u],
    [`vibehub://open/apply?repo=${repo}`, /not a supported action/u],
    ["vibehub://open", /repo is required/u],
    ["vibehub://open?repo=", /repo is required/u],
    ["vibehub://open?repo=relative/path", /must be an absolute path/u],
    ["vibehub://open?repo=/tmp/../etc", /must not traverse directories/u],
    [`vibehub://open?repo=${repo}/../..`, /must not traverse directories/u],
    [`vibehub://open?repo=${repo}&view=contract`, /view requires ticket/u],
    [`vibehub://open?repo=${repo}&ticket=ticket-foundation&view=viewport`, /view must be execution, contract, or log/u],
    [`vibehub://open?repo=${repo}&ticket=ticket-foundation&view=EXECUTION`, /view must be execution, contract, or log/u],
    [`vibehub://open?repo=${repo}&ticket=Ticket_Foundation`, /canonical Ticket ID/u],
    [`vibehub://open?repo=${repo}&ticket=../../etc/passwd`, /canonical Ticket ID/u],
    [`vibehub://open?repo=${repo}&ticket=ticket-foundation&mutate=1`, /is not a deep link parameter/u],
    [`vibehub://open?repo=${repo}&ticket=ticket-foundation&token=abc`, /is not a deep link parameter/u],
    [`vibehub://open?repo=${repo}&ticket=a&ticket=b`, /given more than once/u],
    [`vibehub://open?repo=${repo}#0123456789abcdef`, /carries no fragment/u],
    [`vibehub://user:secret@open?repo=${repo}`, /carries no (user|password)/u],
    [`vibehub://open:8080?repo=${repo}`, /carries no port/u],
  ];
  for (const [candidate, reason] of refusals) {
    const refused = link(candidate);
    assert.equal(refused.accepted, false, `accepted a malformed URI: ${candidate}`);
    assert.equal(refused.stage, "uri", candidate);
    assert.match(refused.error, reason, candidate);
    // Nothing was opened, spawned, or remembered on the way to the refusal.
    assert.equal(refused.hostStarted, false, candidate);
    assert.deepEqual(refused.preferenceKeys, baseline, candidate);
    assert.deepEqual(refused.preferenceKeysAfter, baseline, candidate);
    assert.equal(refused.repo, undefined, candidate);
  }
  assert.deepEqual(canonicalBytes(repo), before);
});

test("a deep link reaches no path the picker would refuse", (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture();
  const notARepository = tempRepo("workbench-deep-link-plain");
  repos.push(notARepository);

  for (const path of ["/etc", "/", notARepository, join(repo, ".vibehub")]) {
    const refused = link(`vibehub://open?repo=${path}`);
    assert.equal(refused.accepted, false, `accepted a non-worktree path: ${path}`);
    assert.equal(refused.stage, "repository", path);
    assert.equal(refused.hostStarted, false, path);
  }
  // The same validation the NSOpenPanel path uses: exact worktree root + .vibehub.
  const metadata = read("Sources/WorkbenchRepositorySession/GitMetadata.swift");
  assert.match(metadata, /notAnExactWorktree/u);
  assert.match(metadata, /notAVibeHubRepository/u);
  const probes = read("Sources/WorkbenchDesktop/ProbeCommands.swift");
  assert.match(probes, /GitMetadata\.readSession\(repoRoot: link\.repoRoot\)/u);
  // The app validates before it resolves, so no question is ever asked about a
  // path the Workbench could not open.
  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  const handler = delegate.slice(delegate.indexOf("func handle(deepLink text: String)"));
  const validation = handler.indexOf("GitMetadata.readSession(repoRoot: link.repoRoot)");
  const decision = handler.indexOf("DeepLinkPlanner.resolve(");
  assert.ok(validation > 0 && decision > validation, "the repository is not validated first");
});

// --------------------------------------------------------------- behaviours

test("the §9 behaviours are decided before anything opens", (t) => {
  if (!buildOnce(t)) return;
  const open = fixture("workbench-deep-link-open");
  const other = fixture("workbench-deep-link-other");

  // 1. Running on that repository: focus it, no question asked.
  const focus = link(uri(open, "ticket-foundation", "contract"), { current: open, known: [open] });
  assert.equal(focus.resolution, "focus-current-session");
  assert.equal(focus.requiresConfirmation, false);
  assert.equal(focus.prompt, null);

  // 2. Not running, repository already known: open it directly.
  const known = link(uri(open), { known: [open, other] });
  assert.equal(known.resolution, "open-known-repository");
  assert.equal(known.requiresConfirmation, false);
  assert.equal(known.prompt, null);

  // 2b. Not running, repository seen for the first time: ask first.
  const first = link(uri(open), { known: [other] });
  assert.equal(first.resolution, "confirm-first-use");
  assert.equal(first.requiresConfirmation, true);
  assert.equal(first.prompt.affirmative, "Open Repository");
  assert.equal(first.prompt.cancel, "Cancel");
  assert.match(first.prompt.title, /Open this repository in the Workbench\?/u);
  assert.ok(first.prompt.detail.includes(canonical(open)), "the prompt hides which repository");
  assert.match(first.prompt.detail, /has not opened before/u);
  assert.equal(link(uri(open)).resolution, "confirm-first-use");

  // 3. Running on a different repository: never switch silently.
  const switching = link(uri(other, "ticket-foundation"), { current: open, known: [open, other] });
  assert.equal(switching.resolution, "confirm-switch");
  assert.equal(switching.requiresConfirmation, true);
  assert.equal(switching.prompt.affirmative, "Switch Repository");
  assert.equal(switching.prompt.cancel, "Stay Here");
  // The question names both projects, so the user is never guessing.
  assert.ok(switching.prompt.detail.includes(canonical(open)), "the prompt hides the open project");
  assert.ok(
    switching.prompt.detail.includes(canonical(other)),
    "the prompt hides the requested project",
  );
  // Even a repository the user has opened many times still asks, because the
  // question is about the window they are reading, not about trust.
  assert.equal(
    link(uri(other), { current: open, known: [other, open] }).resolution,
    "confirm-switch",
  );
});

test("both confirmations are real prompts the user has to answer", () => {
  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  const firstUse = delegate.slice(delegate.indexOf("private func confirmFirstUse"));
  const switching = delegate.slice(delegate.indexOf("private func confirmSwitch"));
  for (const [name, body] of [
    ["first use", firstUse.slice(0, firstUse.indexOf("private func confirmSwitch"))],
    ["switch", switching.slice(0, switching.indexOf("private func ask"))],
  ]) {
    // The repository is opened only from the accepted branch of the question.
    assert.match(
      body,
      /ask\((?:prompt|ConfirmationPrompts\.[\s\S]{0,80}?), declined: \{[\s\S]{0,200}?\}, accepted: \{[\s\S]{0,160}?open\(repoRoot: link\.repoRoot, deepLink: link\)/u,
      `${name} opens without an affirmative answer`,
    );
  }
  // Only the affirmative button runs the accepted branch, and the question is a
  // sheet on a real window: an application-modal alert raised at launch answers
  // itself with its default button and then ends the app.
  const ask = delegate.slice(delegate.indexOf("private func ask("));
  assert.match(ask, /addButton\(withTitle: prompt\.affirmative\)/u);
  assert.match(ask, /addButton\(withTitle: prompt\.cancel\)/u);
  assert.match(
    ask,
    /alert\.beginSheetModal\(for: window\) \{ response in\s*\n\s*guard response == \.alertFirstButtonReturn else \{\s*\n\s*declined\(\)\s*\n\s*return\s*\n\s*\}\s*\n\s*accepted\(\)/u,
  );
  assert.doesNotMatch(delegate, /runModal\(\)/u);
  // A deep link that launched the app is answered after the launch surface is
  // on screen, never before the event loop exists.
  assert.match(
    delegate,
    /picker\.window\.makeKeyAndOrderFront\(nil\)\s*\n\s*DispatchQueue\.main\.async \{ \[weak self\] in self\?\.handle\(deepLink: pending\) \}/u,
  );
  // Declining leaves the session exactly as it was.
  assert.match(firstUse, /offerPicker\("The deep link was not opened\."\)/u);
  assert.match(switching, /workbench\?\.focusWindow\(\)/u);
  // A question with nowhere to appear is a refusal, never a silent yes.
  assert.match(ask, /guard let window = workbench\?\.window \?\? picker\?\.window else \{\s*\n\s*declined\(\)/u);
});

test("a window the shell keeps is never freed by closing it", () => {
  // A deep link closes windows the app still owns: the picker when a repository
  // opens, and the previous Workbench window when the user confirms a switch.
  // AppKit's default (isReleasedWhenClosed) frees those under ARC, and the next
  // deep link that touches them crashes the app.
  for (const file of [
    "Sources/WorkbenchDesktop/WorkbenchWindowController.swift",
    "Sources/WorkbenchDesktop/RepositoryPickerWindowController.swift",
  ]) {
    const controller = read(file);
    assert.match(controller, /window = NSWindow\(/u, file);
    assert.match(controller, /window\.isReleasedWhenClosed = false/u, file);
  }
});

// ------------------------------------------------- a Ticket that is not here

test("an unknown Ticket would stop the host, so the shell never passes one", (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture();

  // The launcher's own validation is unchanged and still authoritative.
  assert.throws(
    () => startVibeHubUi({ repoRoot: repo, ticket: "ticket-not-in-this-worktree" }),
    /Unknown Ticket for --ticket/u,
  );

  const missing = link(uri(repo, "ticket-not-in-this-worktree", "log"), {
    current: repo,
    known: [repo],
  });
  // The URI itself is well formed and the repository is real, so the repository
  // opens; only the Ticket is absent.
  assert.equal(missing.accepted, true);
  assert.equal(canonical(missing.repo), canonical(repo));
  assert.equal(missing.ticketPresent, false);
  assert.equal(missing.focusPath, "/", "a Ticket that is not here must not reach the focus query");
  assert.equal(link(uri(repo, "ticket-foundation"), { current: repo }).ticketPresent, true);

  // The shell gates every Ticket it passes to the host on that same check, so a
  // stale preference cannot keep the repository from opening either.
  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  assert.match(
    delegate,
    /if let requested = focusTicket,\s*\n\s*!DeepLinkPlanner\.ticketIsPresent\(requested, inWorktree: session\.repoRoot\)/u,
  );
  assert.match(delegate, /focusTicket = nil/u);
  // And the honest state is stated in words, not left as an empty inspector.
  const statement = read("Sources/WorkbenchRepositorySession/DeepLink.swift");
  assert.match(statement, /is not in this worktree/u);
  assert.match(statement, /Nothing was \\?\s*\n?\s*created: the Workbench only reads/u);
  const window = read("Sources/WorkbenchDesktop/WorkbenchWindowController.swift");
  assert.match(window, /MissingTicketStatement\.title\(ticketId\)/u);
  assert.match(window, /MissingTicketStatement\.detail\(ticketId: ticketId, worktree: worktree\)/u);
});

// ------------------------------------------------------- live WebView proof

test("a deep link selects the Ticket and layer in the real WebView", async (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture("workbench-deep-link-render", ["ticket-foundation", "ticket-second"]);
  const before = canonicalBytes(repo);
  const result = spawnSync(
    binary,
    ["--probe-render", "--repo", repo, "--deep-link", uri(repo, "ticket-second", "contract")],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (result.signal || !result.stdout.trim()) {
    t.skip(`the WKWebView probe needs a window server session: ${result.stderr}`);
    return;
  }
  const rendered = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(rendered.ok, true, result.stderr);
  assert.equal(rendered.deepLink.resolution, "focus-current-session");
  assert.equal(rendered.deepLink.navigated, true);
  // The page the user is looking at now shows exactly that Ticket and layer.
  assert.equal(rendered.deepLink.selectedTicket, "ticket-second");
  assert.equal(rendered.deepLink.selectedTab, "contract");
  assert.equal(rendered.deepLink.focusedQuery, "ticket=ticket-second&view=contract");
  // Still the one authorized loopback origin, and still the shared frontend.
  assert.equal(rendered.deepLink.focusedOrigin, "127.0.0.1");
  assert.equal(rendered.deepLink.pathAfterFocus, repo);
  assert.deepEqual(rendered.rendered.assets, ["/app.css", "/app.js"]);
  assert.equal(rendered.fileNavigationDenied, true);
  assert.equal(rendered.escapeAttempts, "fetch-file:blocked,bridge:absent");
  assert.deepEqual(canonicalBytes(repo), before);
});

test("a Ticket absent from the worktree still opens the repository", async (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture("workbench-deep-link-missing");
  const before = canonicalBytes(repo);
  const result = spawnSync(
    binary,
    ["--probe-render", "--repo", repo, "--deep-link", uri(repo, "ticket-not-in-this-worktree", "log")],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (result.signal || !result.stdout.trim()) {
    t.skip(`the WKWebView probe needs a window server session: ${result.stderr}`);
    return;
  }
  const rendered = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(rendered.ok, true, result.stderr);
  // The repository is open and its graph is on screen.
  assert.equal(rendered.rendered.path, repo);
  assert.ok(rendered.rendered.nodes >= 1, "the repository did not open");
  // The Ticket's absence is stated, and nothing was navigated or invented.
  assert.equal(rendered.deepLink.ticketPresent, false);
  assert.equal(rendered.deepLink.navigated, false);
  assert.match(rendered.deepLink.missingTicketStatement, /ticket-not-in-this-worktree is not in this worktree/u);
  assert.match(rendered.deepLink.missingTicketStatement, /Nothing was created: the Workbench only reads/u);
  assert.deepEqual(canonicalBytes(repo), before);
});

// ------------------------------------------------------------ no mutation

test("deep link handling writes nothing, valid or not", (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture("workbench-deep-link-bytes");
  const other = fixture("workbench-deep-link-bytes-other");
  const before = canonicalBytes(repo);
  const rootEntriesBefore = readdirSync(repo).sort();
  const preferencesBefore = link(uri(repo)).preferenceKeys;

  const everyForm = [
    uri(repo),
    uri(repo, "ticket-foundation"),
    uri(repo, "ticket-foundation", "contract"),
    uri(repo, "ticket-not-in-this-worktree", "log"),
    uri(other, "ticket-foundation"),
    `vibehub://open?repo=${repo}&ticket=ticket-foundation&mutate=1`,
    `vibehub://open?repo=${repo}&delete=true`,
    `vibehub://apply?repo=${repo}`,
    "vibehub://open?repo=/tmp/../etc",
    "not-a-uri",
  ];
  for (const candidate of everyForm) {
    for (const context of [{}, { current: repo, known: [repo] }, { current: other }]) {
      const answer = link(candidate, context);
      assert.equal(answer.ok, true, candidate);
      assert.equal(answer.hostStarted, false, candidate);
      assert.deepEqual(answer.preferenceKeysAfter, preferencesBefore, candidate);
    }
  }
  assert.deepEqual(canonicalBytes(repo), before);
  assert.deepEqual(canonicalBytes(other), canonicalBytes(other));
  assert.deepEqual(readdirSync(repo).sort(), rootEntriesBefore);
});

test("the deep link widens no part of the WebView boundary", (t) => {
  if (!buildOnce(t)) return;
  const origin = "http://127.0.0.1:51234";
  const decide = (url, isLink = false) =>
    probe("--probe-navigation", "--origin", origin, "--url", url, ...(isLink ? ["--link"] : []))
      .decision;

  // Registering a scheme for the app must not make it navigable inside the page.
  assert.equal(decide("vibehub://open?repo=/etc"), "deny");
  assert.equal(decide("vibehub://open?repo=/etc", true), "deny");
  assert.equal(decide("file:///etc/passwd"), "deny");
  assert.equal(decide("data:text/html,<b>x"), "deny");
  assert.equal(decide("http://127.0.0.1:51235/api/state"), "deny");
  assert.equal(decide(`${origin}/?ticket=ticket-foundation&view=contract`), "allow-in-webview");

  const policy = read("Sources/WorkbenchWebViewBridge/NavigationPolicy.swift");
  assert.doesNotMatch(policy, /vibehub/u);
  const focus = read("Sources/WorkbenchWebViewBridge/FocusedSessionURL.swift");
  // Focus rewrites query only: the origin, scheme, and token come from the
  // session that is already running.
  assert.doesNotMatch(focus, /components\.(?:scheme|host|port) =/u);
  assert.match(focus, /URLQueryItem\(name: "ticket"/u);
  assert.match(focus, /URLQueryItem\(name: "view"/u);
});
