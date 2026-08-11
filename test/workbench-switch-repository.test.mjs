import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

const app = join(root, "apps", "workbench");
const binary = join(app, ".build", "debug", "VibeHubWorkbench");

const repos = [];

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function read(relative) {
  return readFileSync(join(app, relative), "utf8");
}

/**
 * Only the lines that are actually compiled. Full-line comments are dropped so
 * a doc comment naming an API (to explain why it is *not* used here) cannot
 * defeat a boundary assertion.
 */
function compiled(relative) {
  return read(relative)
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
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 240_000 });
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

/**
 * The switch probe drives the real application object, so it needs a window
 * server exactly as `--probe-render` does. When there is none it is skipped
 * rather than reported as a failure — and never reported as a pass.
 */
function switchProbe(t, args) {
  const result = spawnSync(binary, ["--probe-switch", ...args], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.signal || !result.stdout.trim()) {
    t.skip(`the switch probe needs a window server session: ${result.stderr}`);
    return null;
  }
  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(payload.ok, true, result.stderr);
  // Whatever else it printed, the bearer never appears in it.
  assert.doesNotMatch(JSON.stringify(payload), /[0-9a-f]{64}/u, "the probe printed a bearer");
  return payload;
}

function fixture(label, tickets = ["ticket-foundation"]) {
  // The shell resolves symlinks so the exact worktree is unambiguous; the
  // fixture must compare against the same resolved path.
  const repo = realpathSync(tempRepo(label));
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(
    run(repo, "ticket", "apply", { tickets: tickets.map((id) => ticket(id)) }).status,
    0,
  );
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", `${label}-branch`);
  git(
    "-c", "user.email=t@example.com", "-c", "user.name=T",
    "commit", "-q", "--allow-empty", "-m", "fixture",
  );
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

/**
 * Foundation canonicalises /private/var to /var; both name the same worktree,
 * and /var is the form the shell remembers.
 */
function canonical(path) {
  return path.replace(/^\/private(?=\/)/u, "");
}

function menuNamed(descriptor, title) {
  return descriptor.find((entry) => entry.title === title);
}

function itemNamed(menu, title) {
  return (menu?.items ?? []).find((entry) => entry.title === title);
}

// ------------------------------------------------------------- the entries

test("the menu offers Open Repository… on Cmd-O and a recent-repositories submenu", (t) => {
  if (!buildOnce(t)) return;
  const first = "/tmp/vibehub-menu-alpha";
  const second = "/tmp/vibehub-menu-beta";
  const built = probe("--probe-menu", "--recent", first, "--recent", second);
  assert.equal(built.ok, true);

  const file = menuNamed(built.menu, "File");
  assert.ok(file, `no repository menu was built: ${JSON.stringify(built.menu.map((m) => m.title))}`);

  const open = itemNamed(file, "Open Repository…");
  assert.ok(open, "the menu has no Open Repository… item");
  assert.equal(open.key, "o");
  assert.deepEqual(open.modifiers, ["command"]);
  assert.equal(open.action, "openRepository:");

  const recents = itemNamed(file, "Recent Repositories");
  assert.ok(recents, "the menu has no Recent Repositories submenu");
  // Most recent first, readable name, exact worktree carried rather than shown.
  assert.deepEqual(recents.items.map((entry) => entry.title), [
    "vibehub-menu-alpha",
    "vibehub-menu-beta",
  ]);
  assert.deepEqual(recents.items.map((entry) => entry.path), [first, second]);
  for (const entry of recents.items) {
    assert.equal(entry.action, "openRecentRepository:");
    assert.equal(entry.key, "", "a recent repository must not claim a key equivalent");
  }
});

test("with nothing remembered the submenu says so instead of offering nothing", (t) => {
  if (!buildOnce(t)) return;
  const built = probe("--probe-menu");
  const recents = itemNamed(menuNamed(built.menu, "File"), "Recent Repositories");
  assert.deepEqual(recents.items.map((entry) => entry.title), ["No Repositories Opened Yet"]);
  assert.equal(recents.items[0].enabled, false);
  assert.equal(recents.items[0].action, "");
});

test("both in-app entries resolve through the deep link's own planner", () => {
  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  // One entry, reached from the menu item, the recents submenu, and the picker.
  assert.match(delegate, /@objc func openRepository\(_ sender: Any\?\)/u);
  assert.match(delegate, /@objc func openRecentRepository\(_ sender: Any\?\)/u);
  assert.match(delegate, /func requestRepository\(_ repoRoot: String\)/u);
  const entry = delegate.slice(
    delegate.indexOf("func requestRepository(_ repoRoot: String)"),
    delegate.indexOf("/// States a repository failure"),
  );
  // The same resolution the deep link uses, over the same remembered list.
  assert.match(entry, /DeepLinkPlanner\.resolve\(\s*\n\s*link: link,\s*\n\s*currentRepository: currentRepository,\s*\n\s*knownRepositories: preferences\.recentRepositories/u);
  // A different repository gets the §9.3 question and nothing else.
  assert.match(entry, /case \.confirmSwitch\(let from\):[\s\S]{0,400}?confirmSwitch\(from: from, to: link, requestedBy: \.userSelection\)/u);
  // The repository already open is focused, not restarted and not reloaded.
  assert.match(entry, /case \.focusCurrentSession:[\s\S]{0,600}?workbench\.focusWindow\(\)/u);
  const focus = entry.slice(entry.indexOf("case .focusCurrentSession:"), entry.indexOf("case .openKnownRepository"));
  assert.doesNotMatch(focus, /HostSession\.start|terminate\(\)|WorkbenchWindowController\(/u);
  // The picker hands its choice to the same entry rather than opening directly.
  assert.match(delegate, /RepositoryPickerWindowController\(preferences: preferences\) \{ \[weak self\] path in\s*\n\s*self\?\.requestRepository\(path\)/u);
  // One NSOpenPanel, owned by the picker, presented wherever the user is.
  assert.doesNotMatch(compiled("Sources/WorkbenchDesktop/AppDelegate.swift"), /NSOpenPanel/u);
  assert.match(delegate, /picker\?\.chooseRepository\(presentedOn: workbench\?\.window\)/u);
  const picker = read("Sources/WorkbenchDesktop/RepositoryPickerWindowController.swift");
  assert.match(picker, /func chooseRepository\(presentedOn host: NSWindow\?\)/u);
  assert.match(picker, /panel\.beginSheetModal\(for: host \?\? window\)/u);
  // A question is never application-modal, at launch or anywhere else.
  assert.doesNotMatch(delegate, /runModal\(\)/u);
  assert.doesNotMatch(picker, /runModal\(\)/u);
});

test("a switch builds a new window instead of re-pointing the live WebView", () => {
  const delegate = read("Sources/WorkbenchDesktop/AppDelegate.swift");
  const open = delegate.slice(delegate.indexOf("private func open(repoRoot: String"));
  // The new host is up before the old one is ended, so a failed switch cannot
  // take the working session down with it.
  const started = open.indexOf("let started = try HostSession.start(");
  const terminated = open.indexOf("host?.terminate()");
  const closed = open.indexOf("workbench?.close()");
  const constructed = open.indexOf("let window = WorkbenchWindowController(");
  assert.ok(started > 0 && terminated > started, "the old host is ended before the new one starts");
  // The previous session is gone before the new window exists.
  assert.ok(closed > terminated && constructed > closed, "the window is replaced too early");
  // Closing writes the frame the user arranged; the new controller restores it.
  const window = read("Sources/WorkbenchDesktop/WorkbenchWindowController.swift");
  assert.match(window, /func close\(\) \{[\s\S]{0,200}?persistFrame\(\)/u);
  assert.match(window, /restoreFrame\(\)/u);
  // The two regression guards from the deep link still hold for this path.
  assert.match(window, /window\.isReleasedWhenClosed = false/u);
  assert.match(
    read("Sources/WorkbenchDesktop/RepositoryPickerWindowController.swift"),
    /window\.isReleasedWhenClosed = false/u,
  );
  // Nothing anywhere re-addresses a WebView at a different repository's host.
  assert.doesNotMatch(open, /webView/u);
});

// ---------------------------------------------------------- recents hygiene

test("a remembered repository is dropped only when the cause is permanent", (t) => {
  if (!buildOnce(t)) return;
  const repo = fixture("workbench-switch-recents");
  const plain = tempRepo("workbench-switch-plain");
  repos.push(plain);
  const gitOnly = tempRepo("workbench-switch-git-only");
  repos.push(gitOnly);
  execFileSync("git", ["-C", gitOnly, "init", "-q"], { encoding: "utf8" });
  const other = canonical(repo);

  const cases = [
    // path, error class, permanent
    [`${canonical(repo)}-was-deleted`, "notADirectory", true],
    [join(canonical(repo), ".vibehub"), "notAnExactWorktree", true],
    [canonical(gitOnly), "notAVibeHubRepository", true],
    [canonical(plain), "gitFailed", false],
  ];
  for (const [path, errorClass, permanent] of cases) {
    const answer = probe("--probe-recents", "--open", path, "--recent", path, "--recent", other);
    assert.equal(answer.opened, false, path);
    assert.equal(answer.errorClass, errorClass, path);
    assert.equal(answer.permanent, permanent, path);
    // The failure is stated in words either way, never swallowed.
    assert.ok(answer.error.length > 0, `${path} failed silently`);
    if (permanent) {
      assert.deepEqual(answer.dropped, [path], `${path} was kept after a permanent failure`);
    } else {
      // A temporary problem must never erase a repository the user still works in.
      assert.deepEqual(answer.dropped, [], `${path} was erased by a transient failure`);
      assert.ok(answer.recentsAfter.includes(path), `${path} was erased by a transient failure`);
    }
    // The other remembered repository is never collateral damage.
    assert.ok(answer.recentsAfter.includes(other), `${path} took an unrelated entry with it`);
    // Nothing is persisted outside the app's own preference domain.
    assert.equal(answer.preferenceDomain, "in-memory");
  }

  // A successful open updates the list and puts that worktree first.
  const opened = probe("--probe-recents", "--open", canonical(repo), "--recent", canonical(plain));
  assert.equal(opened.opened, true);
  assert.deepEqual(opened.recentsAfter, [canonical(repo), canonical(plain)]);
  assert.deepEqual(opened.dropped, []);
});

// ------------------------------------------------------- a real live switch

test("choosing a recent repository switches the running app and releases the old session", (t) => {
  if (!buildOnce(t)) return;
  const alpha = fixture("workbench-switch-alpha", ["ticket-foundation"]);
  const beta = fixture("workbench-switch-beta", [
    "ticket-foundation",
    "ticket-second",
    "ticket-third",
  ]);
  const alphaBytes = canonicalBytes(alpha);
  const betaBytes = canonicalBytes(beta);
  const frame = "{{140, 140}, {1000, 700}}";

  const result = switchProbe(t, [
    "--repo", alpha,
    "--to", canonical(beta),
    "--answer", "accept",
    "--recent", canonical(beta),
    "--recent", canonical(alpha),
    "--frame", frame,
  ]);
  if (!result) return;

  // The item that was chosen is the one the menu offered, carrying the exact
  // worktree rather than the readable name.
  assert.equal(result.chosenItem.action, "openRecentRepository:");
  assert.equal(result.chosenItem.path, canonical(beta));
  assert.equal(result.chosenItem.toolTip, canonical(beta));
  assert.equal(result.actionSent, true, "the menu action reached no responder");
  // Cmd-O is wired to a responder that handles it. Answering NSOpenPanel needs
  // GUI automation, which is unavailable here, so nothing more is claimed.
  assert.equal(result.openRepositoryItem.key, "o");
  assert.deepEqual(result.openRepositoryItem.modifiers, ["command"]);
  assert.equal(result.openRepositoryItem.responder, "AppDelegate");

  // The question AppKit actually drew is the §9.3 question, word for word.
  assert.equal(result.sheetPresented, true, "the app switched without asking");
  assert.equal(result.sheetIsConfirmation, true);
  assert.equal(result.promptMatchesSheet, true);
  assert.equal(result.prompt.title, "Switch the Workbench to a different repository?");
  assert.equal(result.prompt.affirmative, "Switch Repository");
  assert.equal(result.prompt.cancel, "Stay Here");
  assert.ok(result.prompt.detail.includes(canonical(alpha)), "the question hides the open project");
  assert.ok(result.prompt.detail.includes(canonical(beta)), "the question hides the requested one");

  // The app is on the other repository, in the same session and the same frame.
  assert.equal(result.switched, true);
  assert.equal(result.currentRepository, canonical(beta));
  assert.equal(result.windowRecreated, true, "the WebView was re-pointed instead of replaced");
  assert.equal(result.windowFrameReused, true);
  assert.equal(result.second.windowFrame, frame);

  // Nothing of the previous session is left.
  assert.equal(result.previousHostAlive, false, "the previous host outlived the switch");
  assert.equal(result.previousOriginStatus, -1, "the previous port is still listening");
  assert.equal(result.previousAuthorizedUrlStatus, -1, "the previously authorized URL still resolves");
  assert.equal(result.previousAuthorizedApiStatus, -1, "the previous session still answers its bearer");
  assert.notEqual(result.second.port, result.first.port);

  // Every Ticket state on screen now is this worktree's own Git YAML, not a
  // projection carried over from the repository that was open a moment ago.
  assert.equal(result.first.projection.tickets, 1);
  assert.deepEqual(result.first.projection.ticketIds, ["ticket-foundation"]);
  assert.equal(result.first.projection.worktreeRoot, alpha);
  assert.equal(result.second.projection.tickets, 3);
  assert.deepEqual(result.second.projection.ticketIds, [
    "ticket-foundation",
    "ticket-second",
    "ticket-third",
  ]);
  assert.equal(result.second.projection.worktreeRoot, beta);
  assert.equal(result.second.projection.branch, "workbench-switch-beta-branch");

  // The remembered list reflects what was just opened, and nothing else was
  // written: no bearer, no Ticket state, no key outside the allowlist.
  assert.deepEqual(result.recentsAfter, [canonical(beta), canonical(alpha)]);
  for (const key of result.preferenceKeys) {
    assert.ok(result.preferenceAllowlist.includes(key), `unexpected persisted key ${key}`);
  }
  assert.equal(result.bearerInPreferences, false);
  assert.equal(result.bearerPrinted, false);

  // Nothing the probe started outlived it.
  assert.equal(result.firstHostAliveAtExit, false);
  assert.equal(result.secondHostAliveAtExit, false);

  // And neither worktree was written to.
  assert.deepEqual(canonicalBytes(alpha), alphaBytes);
  assert.deepEqual(canonicalBytes(beta), betaBytes);
});

test("refusing the question leaves the current session exactly as it was", (t) => {
  if (!buildOnce(t)) return;
  const alpha = fixture("workbench-refuse-alpha", ["ticket-foundation"]);
  const beta = fixture("workbench-refuse-beta", ["ticket-foundation", "ticket-second"]);
  const alphaBytes = canonicalBytes(alpha);
  const betaBytes = canonicalBytes(beta);

  const result = switchProbe(t, [
    "--repo", alpha,
    "--to", canonical(beta),
    "--answer", "decline",
    "--recent", canonical(beta),
    "--recent", canonical(alpha),
  ]);
  if (!result) return;

  assert.equal(result.sheetIsConfirmation, true);
  assert.equal(result.promptMatchesSheet, true);
  // Stay Here means stay here: same repository, same host, same port, same
  // window, and the other repository was never started.
  assert.equal(result.switched, false);
  assert.equal(result.currentRepository, canonical(alpha));
  assert.equal(result.second, null);
  assert.equal(result.previousHostAlive, true, "declining killed the session anyway");
  assert.equal(result.previousOriginStatus, 200);
  assert.equal(result.previousAuthorizedApiStatus, 200);
  assert.equal(result.windowRecreated, false);
  // The remembered list is untouched by a refusal.
  assert.deepEqual(result.recentsAfter, result.recentsBefore);
  assert.equal(result.firstHostAliveAtExit, false, "the probe leaked a host");

  assert.deepEqual(canonicalBytes(alpha), alphaBytes);
  assert.deepEqual(canonicalBytes(beta), betaBytes);
});

test("an invalid recent entry is reported on the open window and dropped", (t) => {
  if (!buildOnce(t)) return;
  const alpha = fixture("workbench-invalid-alpha");
  const alphaBytes = canonicalBytes(alpha);
  const gone = `${canonical(alpha)}-was-deleted`;

  const result = switchProbe(t, [
    "--repo", alpha,
    "--to", gone,
    "--recent", gone,
    "--recent", canonical(alpha),
  ]);
  if (!result) return;

  // No question is ever asked about a path the Workbench could not open.
  assert.equal(result.sheetIsConfirmation, false);
  assert.equal(result.switched, false);
  assert.equal(result.currentRepository, canonical(alpha));
  assert.equal(result.previousHostAlive, true, "an invalid path took the session down");
  assert.equal(result.previousOriginStatus, 200);
  // The failure is stated where the user is, and it names the path.
  assert.ok(
    result.sheetText.some((line) => line.includes("could not be opened")),
    `the failure was not stated: ${JSON.stringify(result.sheetText)}`,
  );
  assert.ok(result.sheetText.some((line) => line.includes(gone)));
  // A permanent failure drops that entry and only that entry.
  assert.ok(!result.recentsAfter.includes(gone));
  assert.ok(result.recentsAfter.includes(canonical(alpha)));
  assert.deepEqual(canonicalBytes(alpha), alphaBytes);
});

test("a transient failure reports honestly and keeps the remembered repository", (t) => {
  if (!buildOnce(t)) return;
  const alpha = fixture("workbench-transient-alpha");
  const alphaBytes = canonicalBytes(alpha);
  // A directory that exists but is not a Git worktree: git fails, and that is
  // the transient class, so the entry survives.
  const notGit = canonical(tempRepo("workbench-transient-plain"));
  repos.push(notGit);
  mkdirSync(join(notGit, ".vibehub"), { recursive: true });

  const result = switchProbe(t, [
    "--repo", alpha,
    "--to", notGit,
    "--recent", notGit,
    "--recent", canonical(alpha),
  ]);
  if (!result) return;

  assert.equal(result.sheetIsConfirmation, false);
  assert.equal(result.switched, false);
  assert.equal(result.currentRepository, canonical(alpha));
  assert.ok(
    result.sheetText.some((line) => line.includes("could not be opened")),
    `the failure was not stated: ${JSON.stringify(result.sheetText)}`,
  );
  assert.ok(
    result.recentsAfter.includes(notGit),
    "a transient failure erased a remembered repository",
  );
  assert.deepEqual(canonicalBytes(alpha), alphaBytes);
});

// ------------------------------------------------------- one wording, two doors

test("the in-app question and the deep link question differ only in who asked", (t) => {
  if (!buildOnce(t)) return;
  const alpha = fixture("workbench-wording-alpha");
  const beta = fixture("workbench-wording-beta");
  const link = probe(
    "--probe-deep-link",
    "--url", `vibehub://open?repo=${beta}`,
    "--current", alpha,
    "--known", alpha,
    "--known", beta,
  );
  assert.equal(link.resolution, "confirm-switch");
  // The deep link's wording is exactly what it was before there was a menu.
  assert.match(link.prompt.detail, /A vibehub:\/\/ link asked for:/u);

  const contract = read("Sources/WorkbenchRepositorySession/DeepLink.swift");
  // One function, one title, one pair of buttons, one consequence sentence.
  assert.equal([...contract.matchAll(/Switch the Workbench to a different repository\?/gu)].length, 1);
  assert.equal([...contract.matchAll(/Switching ends the current read-only session/gu)].length, 1);
  assert.match(contract, /public static func switchRepository\(\s*\n\s*from current: String,\s*\n\s*to requested: String,\s*\n\s*requestedBy requester: RepositoryRequester = \.deepLink\s*\n\s*\)/u);
  // Exactly two requesters, and each says truthfully who asked.
  assert.match(contract, /case \.deepLink: return "A vibehub:\/\/ link asked for:"/u);
  assert.match(contract, /case \.userSelection: return "You asked to open:"/u);
});
