import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CODEX_PROJECT_CAPABILITIES, CodexProjectsAdapter, PINNED_THREAD_SECTION_ID, canonicalFolder, sectionEligibility } from "../packages/codex-adapter/projects.mjs";

// Stands in for the app-server's own realpath: the symlinked macOS /tmp and
// its real /private/tmp target name the same folder.
const resolveFolder = (path) => (typeof path === "string" ? path.replace(/^\/tmp\//u, "/private/tmp/") : null);

class FakeClient {
  constructor() {
    this.calls = [];
    this.sections = [{ id: "section-a", name: "Alpha" }];
    this.threads = [
      { id: "thread-recent", name: "Recent", preview: "", cwd: "/tmp/repo", section: null, forkedFromId: null },
      { id: "thread-alpha", name: "Alpha chat", preview: "", cwd: "/tmp/repo", section: this.sections[0], forkedFromId: null },
    ];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "threadSection/list") return { data: this.sections, nextCursor: null };
    if (method === "thread/list") {
      let data = this.threads.filter((thread) => Boolean(thread.archived) === Boolean(params.archived));
      if (Object.hasOwn(params, "sectionId")) data = data.filter((thread) => (thread.section?.id ?? null) === params.sectionId);
      if (params.searchTerm) data = data.filter((thread) => thread.name.includes(params.searchTerm));
      if (params.cwd !== undefined) {
        const wanted = new Set((Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map(resolveFolder));
        data = data.filter((thread) => wanted.has(resolveFolder(thread.cwd)));
      }
      return { data, nextCursor: null };
    }
    if (method === "thread/read") return { thread: this.threads.find((thread) => thread.id === params.threadId) };
    if (method === "thread/section/move") {
      const thread = this.threads.find((item) => item.id === params.threadId);
      thread.section = this.sections.find((section) => section.id === params.sectionId) ?? null;
      return {};
    }
    if (method === "thread/fork") {
      const source = this.threads.find((thread) => thread.id === params.threadId);
      const thread = { ...source, id: "thread-fork", section: null, forkedFromId: source.id };
      this.threads.push(thread);
      return { thread };
    }
    if (method === "threadSection/create") {
      const section = { id: "section-created", name: params.name };
      this.sections.push(section);
      return { section };
    }
    if (method === "threadSection/update") {
      const section = this.sections.find((item) => item.id === params.sectionId);
      section.name = params.name;
      return { section };
    }
    if (["threadSection/delete", "thread/archive", "thread/unarchive"].includes(method)) return {};
    throw new Error(`Unexpected method ${method}`);
  }
}

test("Codex Project adapter maps native ThreadSection and explicit unsectioned Recents", async () => {
  const client = new FakeClient();
  const adapter = new CodexProjectsAdapter({ client });
  const snapshot = await adapter.snapshot();
  assert.deepEqual(snapshot.projects.map(({ id, name }) => ({ id, name })), [{ id: "section-a", name: "Alpha" }]);
  assert.deepEqual(snapshot.recents.map((thread) => thread.id), ["thread-recent"]);
  assert.deepEqual(snapshot.projects[0].threads.map((thread) => thread.id), ["thread-alpha"]);
  const recentCall = client.calls.find(({ method, params }) => method === "thread/list" && params.sectionId === null);
  assert.equal(recentCall.params.sortKey, "recency_at");
  assert.equal(CODEX_PROJECT_CAPABILITIES.projectObject, "ThreadSection");
});

test("the built-in Pinned ThreadSection is never mislabeled as a user Project", async () => {
  const client = new FakeClient();
  const pinned = { id: PINNED_THREAD_SECTION_ID, name: "Pinned" };
  client.sections.unshift(pinned);
  client.threads.push({ id: "thread-pinned", name: "Pinned chat", preview: "", section: pinned, forkedFromId: null });
  const adapter = new CodexProjectsAdapter({ client });
  const snapshot = await adapter.snapshot();
  assert.deepEqual(snapshot.pinned.map((thread) => thread.id), ["thread-pinned"]);
  assert.deepEqual(snapshot.projects.map((project) => project.id), ["section-a"]);
  await assert.rejects(adapter.renameProject(PINNED_THREAD_SECTION_ID, "Not allowed"), /cannot be renamed/);
  await assert.rejects(adapter.deleteProject(PINNED_THREAD_SECTION_ID), /cannot be deleted/);
});

test("fork keeps Codex lineage and inherits only native Project membership", async () => {
  const client = new FakeClient();
  const adapter = new CodexProjectsAdapter({ client });
  const result = await adapter.forkThread("thread-alpha");
  assert.equal(result.thread.forkedFromId, "thread-alpha");
  assert.equal(result.thread.section.id, "section-a");
  assert.equal(result.placement.applied, true);
  assert.deepEqual(client.calls.slice(-3).map(({ method }) => method), ["thread/fork", "thread/section/move", "thread/read"]);
});

test("fork placement failure stays truthful and leaves the native fork visible in Recents", async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/section/move" && params.threadId === "thread-fork") throw new Error("Project disappeared");
    return request(method, params);
  };
  const adapter = new CodexProjectsAdapter({ client });
  const result = await adapter.forkThread("thread-alpha");
  assert.equal(result.thread.forkedFromId, "thread-alpha");
  assert.equal(result.thread.section, null);
  assert.deepEqual(result.placement, {
    desiredProjectId: "section-a",
    applied: false,
    fallback: "fork-remains-visible-in-unsectioned-recents",
    error: "Project disappeared",
  });
});

test("a folder scope forwards cwd to every native list and only counts the history that lives elsewhere", async () => {
  const client = new FakeClient();
  const elsewhere = { id: "section-elsewhere", name: "Other repo" };
  const mixed = { id: "section-mixed", name: "Mixed" };
  const fresh = { id: "section-fresh", name: "Fresh" };
  client.sections.push(elsewhere, mixed, fresh);
  client.threads.push(
    { id: "thread-foreign-recent", name: "Foreign recent", preview: "", cwd: "/tmp/other", section: null, forkedFromId: null },
    { id: "thread-foreign-grouped", name: "Foreign grouped", preview: "", cwd: "/tmp/other", section: elsewhere, forkedFromId: null },
    { id: "thread-mixed-here", name: "Mixed here", preview: "", cwd: "/private/tmp/repo", section: mixed, forkedFromId: null },
    { id: "thread-mixed-there", name: "Mixed there", preview: "", cwd: "/tmp/other", section: mixed, forkedFromId: null },
    { id: "thread-archived-here", name: "Archived here", preview: "", cwd: "/tmp/repo", section: null, forkedFromId: null, archived: true },
  );
  const adapter = new CodexProjectsAdapter({ client, resolveFolder });
  const snapshot = await adapter.snapshot({ cwd: "/tmp/repo" });
  const lists = client.calls.filter(({ method }) => method === "thread/list");
  const scopedLists = lists.filter(({ params }) => params.cwd !== undefined);
  assert.equal(scopedLists.length, 5, "Recents plus every section is queried through the native folder filter");
  for (const { params } of scopedLists) assert.equal(params.cwd, "/private/tmp/repo", "the filter carries the resolved real path");
  assert.equal(lists.filter(({ params }) => params.cwd === undefined).length, 1, "one unscoped query yields the hidden counts");
  assert.deepEqual(snapshot.recents.map((thread) => thread.id), ["thread-recent"]);
  assert.deepEqual(snapshot.projects.map(({ id, scopedCount, totalCount, hiddenElsewhere }) => [id, scopedCount, totalCount, hiddenElsewhere]), [
    ["section-a", 1, 1, 0],
    ["section-elsewhere", 0, 1, 1],
    ["section-mixed", 1, 2, 1],
    ["section-fresh", 0, 0, 0],
  ]);
  assert.ok(!snapshot.threads.some((thread) => resolveFolder(thread.cwd) !== "/private/tmp/repo"), "no Thread from another folder is ever listed");
  assert.deepEqual(snapshot.folderScope, { cwd: "/private/tmp/repo", scopedCount: 3, totalCount: 6, hiddenChats: 3, hiddenGroups: 1 });
  const unscoped = await new CodexProjectsAdapter({ client: new FakeClient(), resolveFolder }).snapshot();
  assert.equal(unscoped.folderScope, null);
  assert.equal(Object.hasOwn(unscoped.projects[0], "scopedCount"), false);
});

test("import eligibility is derived from member folders and matched by real path, never by name", async () => {
  const client = new FakeClient();
  const repoName = "repo";
  const namesake = { id: "section-namesake", name: repoName };
  const multi = { id: "section-multi", name: "Spans two folders" };
  const empty = { id: "section-empty", name: "Nothing yet" };
  const archivedOnly = { id: "section-archived", name: "Archived member elsewhere" };
  client.sections.push({ id: PINNED_THREAD_SECTION_ID, name: "Pinned" }, namesake, multi, empty, archivedOnly);
  client.threads.push(
    { id: "thread-namesake", name: "Named like the repo", preview: "", cwd: "/tmp/other", section: namesake, forkedFromId: null },
    { id: "thread-multi-a", name: "Multi a", preview: "", cwd: "/tmp/repo", section: multi, forkedFromId: null },
    { id: "thread-multi-b", name: "Multi b", preview: "", cwd: "/tmp/other", section: multi, forkedFromId: null, archived: true },
    { id: "thread-archived-elsewhere", name: "Archived elsewhere", preview: "", cwd: "/tmp/other", section: archivedOnly, forkedFromId: null, archived: true },
    { id: "thread-pinned", name: "Pinned chat", preview: "", cwd: "/tmp/repo", section: client.sections.at(-5), forkedFromId: null },
  );
  const adapter = new CodexProjectsAdapter({ client, resolveFolder });
  const result = await adapter.importableProjects({ repositoryRoot: "/tmp/repo" });
  assert.equal(result.repositoryRoot, "/private/tmp/repo");
  assert.equal(result.rule.byName, false);
  assert.ok(!result.projects.some((project) => project.id === PINNED_THREAD_SECTION_ID), "Pinned is never offered for import");
  const byId = Object.fromEntries(result.projects.map((project) => [project.id, project]));
  assert.deepEqual([byId["section-a"].eligibility, byId["section-a"].matchesRepository, byId["section-a"].importable], ["single-folder", true, true]);
  assert.deepEqual(byId["section-a"].folders, ["/private/tmp/repo"]);
  assert.deepEqual([byId["section-namesake"].eligibility, byId["section-namesake"].importable], ["single-folder", false], "a matching name with a foreign folder never matches");
  assert.match(byId["section-namesake"].reason, /different repository/);
  assert.deepEqual([byId["section-multi"].eligibility, byId["section-multi"].importable, byId["section-multi"].memberCount, byId["section-multi"].archivedCount], ["multi-folder", false, 2, 1], "archived members still count toward the folder set");
  assert.deepEqual([byId["section-empty"].eligibility, byId["section-empty"].importable, byId["section-empty"].folders], ["empty", false, []]);
  assert.deepEqual([byId["section-archived"].eligibility, byId["section-archived"].importable], ["single-folder", false]);
  const archivedQueries = client.calls.filter(({ method, params }) => method === "thread/list" && params.archived === true);
  assert.equal(archivedQueries.length, result.projects.length, "every candidate section is read with archived true as well as false");
  assert.equal(sectionEligibility({ memberCount: 0, folders: [] }), "empty");
  assert.equal(sectionEligibility({ memberCount: 2, folders: ["/a"] }), "single-folder");
  assert.equal(sectionEligibility({ memberCount: 2, folders: ["/a", "/b"] }), "multi-folder");
  assert.equal(canonicalFolder("/definitely/not/a/real/folder"), "/definitely/not/a/real/folder", "a vanished folder keeps its recorded identity");
  assert.equal(canonicalFolder(null), null);
  assert.equal(CODEX_PROJECT_CAPABILITIES.scope.defaultVisibility, "repository-folder-only");
  assert.equal(CODEX_PROJECT_CAPABILITIES.binding.neverMatchedBy.includes("section name"), true);
});

test("object contract keeps Codex Project, cwd, VibeHub Project, Chat, and Task separate", async () => {
  const contract = JSON.parse(await readFile(new URL("../docs/proposals/codex-projects/project-object-contract.json", import.meta.url), "utf8"));
  const review = JSON.parse(await readFile(new URL("../docs/proposals/codex-projects/review-matrix.json", import.meta.url), "utf8"));
  assert.equal(contract.objects.codexProject.protocolObject, "ThreadSection");
  assert.ok(contract.objects.codexProject.not.includes("VibeHub Project"));
  assert.equal(contract.objects.codexChat.owner, "Codex app-server");
  assert.equal(contract.objects.codexPinned.identity, PINNED_THREAD_SECTION_ID);
  assert.equal(contract.objects.vibehubTask.owner, "VibeHub Git-native Ticket graph");
  assert.match(contract.objects.taskOrigin.cardinality, /zero or many independent Tasks/);
  assert.ok(contract.invariants.includes("Codex Project movement never changes Thread.cwd."));
  assert.ok(contract.invariants.includes("A Chat fork is a Thread lineage edge, not a Subtask or Task dependency."));
  assert.equal(review.surfaces.length, 4);
  assert.equal(review.surfaces[0].checks.pinnedIsSeparateFromProjects, true);
  assert.equal(review.surfaces[1].checks.horizontalOverflow, false);
  assert.equal(review.surfaces[3].checks.keyboardProjectSelectorPresent, true);
});

test("browser Project movement contract requires real pointer, keyboard, focus, live region, and cleanup proof", async () => {
  const [scenarioText, script, html, preparer] = await Promise.all([
    readFile(new URL("../docs/proposals/codex-projects/browser-e2e-contract.json", import.meta.url), "utf8"),
    readFile(new URL("../apps/codex-first-shell/app.js", import.meta.url), "utf8"),
    readFile(new URL("../apps/codex-first-shell/index.html", import.meta.url), "utf8"),
    readFile(new URL("../packages/codex-adapter/prepare-project-browser-e2e.mjs", import.meta.url), "utf8"),
  ]);
  const scenario = JSON.parse(scenarioText);
  assert.deepEqual(scenario.requiredPaths.map(({ viewport, theme, input }) => [viewport, theme, input]), [
    ["1280x720", "light", "real pointer drag"],
    ["1280x720", "dark", "native Project select"],
    ["390x844", "light", "real pointer drag in open Sidebar"],
    ["390x844", "dark", "native Project select"],
  ]);
  assert.match(script, /id="activeThreadTitle" tabindex="-1"/);
  assert.match(script, /afterRenderFocus\("#activeThreadTitle"\)/);
  assert.match(script, /moveThreadToProject\(state\.activeThreadId, projectId, "#activeThreadProject"\)/);
  assert.match(script, /moveThreadToProject\(drag\.threadId, projectId, `\[data-thread-id=/);
  assert.match(script, /function restoreRerenderedFocus\(\)/);
  assert.match(script, /document\.activeElement !== document\.body/);
  assert.match(script, /document\.addEventListener\("focusin"/);
  assert.match(script, /document\.addEventListener\("pointerdown"/);
  assert.match(script, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/);
  assert.match(script, /moveThreadToProject\(drag\.threadId, projectId/);
  assert.doesNotMatch(script, /dataTransfer/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(preparer, /waitForNotification\("turn\/completed"/);
  assert.match(preparer, /PROJECT-BROWSER-E2E-READY/);
  assert.match(preparer, /thread\/delete/);
  assert.match(preparer, /threadSection\/delete/);
});
