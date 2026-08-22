import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { threadLocation } from "../apps/codex-first-shell/thread-location.mjs";
import { buildTaskContextPacket } from "../packages/codex-adapter/task-context.mjs";
import { capabilitySnapshot } from "../packages/harness-core/capabilities.mjs";
import { probeDomainIsolation } from "../packages/harness-core/probe-package-isolation.mjs";
import { buildTicketHandoff, buildUiSnapshot } from "../skills/scripts/vh-ui.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const fixtureAppServer = fileURLToPath(new URL("fixtures/codex-app-server-fixture.mjs", import.meta.url));

function olderThan(version, baseline) {
  const parse = (value) => String(value ?? "").split(".").map(Number);
  const [left, right] = [parse(version), parse(baseline)];
  if (left.length !== 3 || right.length !== 3 || [...left, ...right].some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

async function launchShell(context, { codex = null, env = {}, repo = "." } = {}) {
  const args = ["scripts/vh-codex-first-shell.mjs", "--repo", repo, "--port", "0", "--json", ...(codex ? ["--codex", codex] : [])];
  const child = spawn(process.execPath, args, { cwd: new URL(".", root), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  context.after(() => child.kill("SIGTERM"));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const startup = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => ({ type: "ready", text: String(chunk).trim() })),
    once(child.stderr, "data").then(([chunk]) => ({ type: "error", text: String(chunk).trim() })),
    once(child, "exit").then(([code]) => ({ type: "exit", text: `exit ${code}` })),
  ]);
  clearTimeout(timer);
  if (startup.type !== "ready" && /EPERM|Operation not permitted/.test(startup.text)) {
    context.skip("local app-server or loopback sockets are unavailable in this sandbox");
    return null;
  }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  const url = new URL(envelope.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const api = async (path, options = {}) => {
    const response = await fetch(new URL(path, url), { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) } });
    return { status: response.status, body: await response.json() };
  };
  const action = (payload) => api("api/action", { method: "POST", body: JSON.stringify(payload) });
  return { child, envelope, url, token, api, action };
}

// Lifecycle proofs drive the fixture app-server through its persistence,
// pidfile and fault knobs; the restart backoff is shortened so a test can
// observe the restarting window without waiting on production delays.
async function lifecycleTemp(context) {
  const temp = await mkdtemp(join(tmpdir(), "vibehub-codex-lifecycle-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  return {
    temp,
    statePath: join(temp, "codex-state.json"),
    pidPath: join(temp, "codex-pids"),
    logPath: join(temp, "app-server-calls.jsonl"),
    env: (extra = {}) => ({
      CODEX_FIXTURE_VERSION: "0.147.0",
      CODEX_FIXTURE_STATE: join(temp, "codex-state.json"),
      CODEX_FIXTURE_PIDFILE: join(temp, "codex-pids"),
      CODEX_FIXTURE_LOG: join(temp, "app-server-calls.jsonl"),
      VIBEHUB_CODEX_RESTART_BACKOFF_MS: "300,600,900",
      ...extra,
    }),
  };
}

async function fixturePids(pidPath) {
  return (await readFile(pidPath, "utf8")).split("\n").filter(Boolean).map(Number);
}

async function appServerCalls(logPath) {
  return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Poll the host event window until `predicate` accepts it (or time runs out);
// returns the last window read.
async function pollEventsUntil(api, predicate, { timeoutMs = 15_000, after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let window = null;
  while (Date.now() < deadline) {
    window = (await api(`api/events?after=${after}`)).body.data;
    if (predicate(window)) return window;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`event window never satisfied the predicate; last kinds: ${window?.events.map((event) => event.kind).join(",")}`);
}

const hostEvents = (window) => window.events.filter((event) => !["notification", "runtimeStderr", "serverRequest"].includes(event.kind));

// The host writes nothing by default; the explicit import is the single
// exception and it names every path it may touch, all left uncommitted.
const REPOSITORY_WRITES = {
  default: false,
  explicitImportOnly: [".vibehub/version.yaml", ".vibehub/rooms/", ".vibehub/tickets/", ".vibehub/evidence/", ".vibehub/outcomes/", ".vibehub/codex-project.yaml"],
  commits: false,
};

async function assertHostBoundary({ envelope, url }) {
  assert.equal(envelope.localOnly, true);
  assert.deepEqual(envelope.repositoryWrites, REPOSITORY_WRITES);
  assert.equal(envelope.codexRuntime, true);
  assert.equal(envelope.shell, "codex-first-shell");
  assert.equal(envelope.harness, "codex");
  assert.equal(url.hostname, "127.0.0.1");
  const health = await fetch(new URL("health", url));
  assert.deepEqual(await health.json(), { ok: true, shell: "codex-first-shell", harness: "codex", localOnly: true, repositoryWrites: REPOSITORY_WRITES, codexRuntime: true });
  const unauthorized = await fetch(new URL("api/bootstrap", url));
  assert.equal(unauthorized.status, 401);
  const rejected = await fetch(url, { method: "POST" });
  assert.equal(rejected.status, 405);
}

test("Codex-first shell uses real app-server ownership and additive VibeHub Tasks", async () => {
  const [html, script, server, adapter, review] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("packages/codex-adapter/harness.mjs"),
    source("docs/CODEX_FIRST_SHELL_PROTOTYPE_REVIEW.md"),
  ]);
  for (const label of ["New chat", "Chat", "Tasks", "Rooms", "Chat groups", "Project", "Appearance", "Search", "Task inbox", "Recents"]) assert.match(html, new RegExp(label, "i"));
  for (const seam of ["createSharedHarnessShell", "createCodexHarnessAdapter", "harness.boot()", "harness.newChat(", "harness.sendChat(", "harness.sendChatAttachments(", "harness.sendChatAudio(", "harness.interruptChat(", "harness.resolveInteraction(", "harness.close()"]) assert.ok(server.includes(seam), seam);
  for (const request of ["thread/start", "turn/start", "turn/interrupt"]) assert.match(adapter, new RegExp(request.replace("/", "\\/")));
  for (const request of ["thread/list", "thread/read", "thread/resume", "turn/steer", "thread/name/set"]) assert.match(server, new RegExp(request.replace("/", "\\/")));
  assert.doesNotMatch(server, /client\.request\("(?:thread\/start|turn\/start|turn\/interrupt)"/);
  assert.doesNotMatch(server, /client\.respond\(request/);
  for (const event of ["turn/started", "turn/completed", "serverRequest"]) assert.match(server + script, new RegExp(event.replace("/", "\\/")));
  assert.match(server, /buildTicketHandoff/);
  assert.match(server, /startTaskContextThread/);
  assert.match(server, /buildTaskContextPacket/);
  assert.match(script, /vibehub_ticket_handoff/);
  assert.match(script, /relation\.prerequisiteTicketId/);
  assert.match(script, /relation\.dependentTicketId/);
  assert.match(script, /searchCorpus/);
  assert.match(script, /openInbox/);
  assert.match(server, /knowledgeProjection/);
  assert.match(server, /attentionProjection/);
  assert.match(review, /Codex owns Threads, Turns, tools, approvals and execution/);
  assert.doesNotMatch(html + script, /DeepSeek|native DSH|DSH Session/);
  assert.doesNotMatch(html + script + server, /localStorage|sessionStorage|sqlite/i);
});

test("Projects, unprojected Recents, drag, keyboard move, and Fork use the native Codex adapter", async () => {
  const [html, script, css, server, adapter, research, contractText, fixtureText] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("packages/codex-adapter/projects.mjs"),
    source("docs/CODEX_PROJECTS_RECENTS_PARITY_RESEARCH.md"),
    source("docs/proposals/codex-projects/project-object-contract.json"),
    source("apps/codex-first-shell/project-fixtures.json"),
  ]);
  const contract = JSON.parse(contractText);
  const fixture = JSON.parse(fixtureText);
  assert.equal(contract.objects.codexProject.protocolObject, "ThreadSection");
  assert.equal(contract.uiSemantics.Recents, "non-archived Threads returned by thread/list with sectionId explicitly null");
  assert.equal(contract.objects.vibehubTask.owner, "VibeHub Git-native Ticket graph");
  assert.match(adapter, /sectionId: null/);
  for (const method of ["threadSection/list", "threadSection/create", "threadSection/update", "threadSection/delete", "thread/section/move", "thread/fork", "thread/archive", "thread/unarchive"]) assert.match(adapter, new RegExp(method.replace("/", "\\/")));
  for (const action of ["createProject", "renameProject", "deleteProject", "moveThread", "forkThread", "archiveThread", "searchThreads"]) assert.match(server, new RegExp(action));
  assert.match(html, /id="projectList"/);
  assert.match(html, /data-project-drop="recent"/);
  assert.match(script, /document\.addEventListener\("pointerdown"/);
  assert.match(script, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/);
  assert.doesNotMatch(script, /dataTransfer/);
  assert.match(script, /data-toggle-project/);
  assert.match(script, /id="activeThreadProject"/);
  assert.match(script, /data-fork-thread/);
  assert.match(script, /data-archive-thread/);
  assert.match(css, /\.project-group\.drag-over/);
  assert.match(css, /\.thread-actions/);
  assert.equal(fixture.projects[0].threads[1].forkedFromId, "fixture-project-chat");
  assert.equal(fixture.pinned[0].project.id, "01984de2-8f74-7c91-a3b2-5c5e937cf318");
  assert.equal(fixture.recents[0].project, null);
  assert.equal(fixture.archived[0].visibleInRecents, false);
  for (const sourceUrl of ["codex-rs/app-server/README.md", "thread_data.rs", "thread_sections.rs", "thread_metadata_update.rs"]) assert.match(research, new RegExp(sourceUrl.replaceAll(".", "\\.")));
  assert.doesNotMatch(html + script + server + adapter, /localStorage|sessionStorage|indexedDB/i);
});

test("Search, Task attention, and object semantics are explicit and source-backed", async () => {
  const [html, script, server, research, contractText] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("docs/CODEX_NATIVE_SEARCH_ATTENTION_RESEARCH.md"),
    source("docs/proposals/codex-native-attention/interaction-contract.json"),
  ]);
  const contract = JSON.parse(contractText);
  assert.equal(contract.defaultSurface, "chat");
  assert.deepEqual(contract.search.groups, ["Chats", "Tasks", "Context"]);
  assert.equal(contract.attention.needsYou.eligibleWhen, "canonical next_action is NEEDS_HUMAN");
  assert.match(contract.attention.completion.eligibleWhen, /successful Outcome/);
  assert.match(contract.attention.running.presentation, /outside the notification count/);
  for (const object of ["chat", "task", "context", "notification", "livePresence"]) assert.ok(contract.objects[object]);
  for (const sourceUrl of ["developers.openai.com", "linear.app/docs/inbox", "docs.github.com/en/subscriptions-and-notifications", "docs.cursor.com/background-agent", "manual.raycast.com"]) assert.match(research, new RegExp(sourceUrl.replaceAll(".", "\\.")));
  assert.match(html, /id="searchDialog"/);
  assert.match(html, /id="inboxPanel"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="reviewPanel"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /id="sidebarAttention"/);
  assert.match(script, /Meta\+K|metaKey/);
  assert.match(script, /Chat|Task|Context/);
  assert.match(script, /initialCompletionKeys/);
  assert.match(script, /unreadCompletionKeys/);
  assert.match(server, /current_attention_not_unread_event/);
  assert.match(server, /repository_history_not_unread_event/);
  assert.match(server, /presence_only_never_notification/);
  assert.doesNotMatch(html + script + server, /localStorage|sessionStorage|indexedDB/i);
});

test("Codex-native Chat contract covers replay, live deltas, rich items, and licensed reuse", async () => {
  const [script, model, renderer, css, research, review, contractText, fixtureText, lockText] = await Promise.all([
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/chat-model.mjs"),
    source("apps/codex-first-shell/chat-renderer.mjs"),
    source("apps/codex-first-shell/app.css"),
    source("docs/CODEX_NATIVE_CHAT_PARITY_RESEARCH.md"),
    source("docs/proposals/codex-native-chat/README.md"),
    source("docs/proposals/codex-native-chat/chat-ui-contract.json"),
    source("apps/codex-first-shell/chat-fixtures.json"),
    source("packages/codex-adapter/upstream-lock.json"),
  ]);
  const contract = JSON.parse(contractText);
  const fixture = JSON.parse(fixtureText);
  const lock = JSON.parse(lockText);
  assert.equal(contract.baseline.version, lock.codex.version);
  assert.equal(contract.baseline.commit, lock.codex.commit);
  assert.equal(contract.baseline.protocolSchemaSha256, lock.codex.protocolSchemaSha256);
  for (const type of ["userMessage", "agentMessage", "memoryCitation", "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "imageGeneration", "contextCompaction", "unknown"]) assert.ok(contract.components[type]);
  for (const method of ["item/started", "item/agentMessage/delta", "item/reasoning/summaryTextDelta", "item/plan/delta", "item/commandExecution/outputDelta", "item/fileChange/patchUpdated", "item/completed", "error", "turn/completed"]) assert.ok(contract.streaming.events.includes(method));
  assert.equal(contract.vibehubBoundary.ordinaryChatRequiresTask, false);
  assert.equal(contract.vibehubBoundary.threadIsTask, false);
  assert.equal(contract.performance.initialReplayTail, 240);
  for (const repository of ["assistant-ui/assistant-ui", "yunhaoli24/codex-gateway", "lezi-fun/codex-webui", "vercel/chatbot", "0xcaff/codex-web"]) assert.match(research, new RegExp(repository.replace("/", "\\/")));
  assert.match(research, /Do not copy code/);
  assert.match(review, /Required v1 parity/);
  assert.match(review, /Explicitly deferred/);
  assert.match(script, /applyChatNotification/);
  assert.match(script, /state\.activeThread = \{ \.\.\.data\.thread, turns: \[\] \}/);
  assert.match(script, /groupableActivityTypes/);
  assert.match(script, /renderTimelineItems/);
  assert.match(script, /requestAnimationFrame/);
  assert.match(script, /canonicalTimeline/);
  assert.match(model, /slice\(-limit\)/);
  assert.match(renderer, /renderMarkdown/);
  assert.match(renderer, /renderMemoryCitations/);
  assert.match(renderer, /citation\?\.threadIds/);
  assert.match(model, /itemKey\(threadId, turnId, itemId\)/);
  assert.match(script, /patchTimeline/);
  assert.match(script, /turnBoundary/);
  assert.match(model, /\["interrupted", "failed"\]\.includes\(turn\.status\)/);
  assert.match(renderer, /noreferrer noopener/);
  assert.match(script, /Unsupported item/);
  assert.match(css, /\.activity-card/);
  assert.match(css, /\.activity-group/);
  assert.match(css, /\.code-block/);
  assert.match(css, /\.turn-error/);
  assert.match(css, /\.source-citations/);
  assert.match(css, /\.turn-boundary/);
  const fixtureTypes = fixture.thread.turns.flatMap((turn) => turn.items.map((item) => item.type));
  for (const type of ["userMessage", "agentMessage", "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall", "subAgentActivity", "contextCompaction"]) assert.ok(fixtureTypes.includes(type));
  assert.ok(["started", "interacted", "interrupted"].includes(fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "subAgentActivity")?.kind));
  const citedMessage = fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "agentMessage" && item.memoryCitation);
  assert.ok(citedMessage?.memoryCitation.entries.length);
  assert.ok(citedMessage?.memoryCitation.threadIds.length);
  assert.ok(fixture.thread.turns.some((turn) => turn.status === "interrupted"));
  for (const term of ["Model and mode posture", "Microphone posture", "Shortcuts", "Focus and accessibility", "Memory citations"]) assert.match(research, new RegExp(term));
  assert.equal(fixture.pendingRequests[0].fixture, true);
  const inputRequest = fixture.pendingRequests.find((request) => request.method === "item/tool/requestUserInput");
  assert.equal(inputRequest.params.questions.length, 2);
  assert.equal(inputRequest.params.questions.some((question) => question.isSecret), true);
  assert.equal(inputRequest.params.questions.some((question) => question.isOther), true);
  assert.equal(fixture.secondaryThread.status.type, "idle");
  assert.equal(fixture.activeThread.turns.at(-1).status, "inProgress");
});

test("Codex-first shell exposes ordinary audio honestly and routes real approvals", async () => {
  const [html, script, server, eventWindow, registry, lock] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("apps/codex-first-shell/event-window.mjs"),
    source("apps/codex-first-shell/server-request-registry.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
  ]);
  assert.match(html, /Record voice input/);
  assert.match(script, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(script, /MediaRecorder/);
  assert.match(script, /ordinary Codex audio input/);
  assert.match(server, /audioInput: harness\.capabilities\.capabilities\.audio\.available/);
  assert.equal(capabilitySnapshot("codex").capabilities.audio.available, true);
  assert.match(server, /realtimeConversation: false/);
  assert.match(lock, /"stableTurnInputs": \["audio", "localAudio"\]/);
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) assert.match(registry, new RegExp(`"${decision}"`));
  assert.match(server, /item\/tool\/requestUserInput/);
  assert.match(server, /unsupportedServerRequestResult/);
  assert.match(eventWindow, /oldestCursor/);
  assert.match(server, /runtimeGeneration/);
  assert.match(script, /data-request-decision/);
});

test("Task Workspace reuses native Chat and keeps Context packet assembly host-owned", async () => {
  const [html, script, css, server, module, research, contractText, fixtureText] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("packages/codex-adapter/task-context.mjs"),
    source("docs/CODEX_TASK_WORKSPACE_RESEARCH.md"),
    source("docs/proposals/codex-task-workspace/task-workspace-contract.json"),
    source("apps/codex-first-shell/task-fixtures.json"),
  ]);
  const contract = JSON.parse(contractText);
  const fixture = JSON.parse(fixtureText);
  assert.equal(contract.contextPacket.owner, "local host");
  assert.equal(contract.rooms.taskCreationRequiresRoom, false);
  assert.equal(contract.rooms.crossProjectWriteback, false);
  for (const object of ["task", "thread", "turn", "project", "room", "context", "reference", "evidence", "outcome"]) assert.ok(contract.productObjects[object]);
  for (const state of ["draft", "ready", "running", "waitingHuman", "verifying", "deviated", "done"]) assert.ok(contract.lifecycleDisclosure[state]);
  for (const variant of ["draft", "ready", "running", "needs-you", "verifying", "deviated", "done", "standalone"]) assert.ok(fixture.variants[variant]);
  assert.match(script, /taskContextSelectionMarkup/);
  assert.match(script, /renderTaskConversation/);
  assert.match(script, /data-focus-task-composer/);
  assert.match(script, /startTaskTurn/);
  assert.match(script, /steerTaskTurn/);
  assert.match(script, /selectedContextIds/);
  assert.match(css, /\.task-conversation-timeline/);
  assert.match(css, /\.task-context-row/);
  assert.match(server, /buildTaskContextPacket/);
  assert.match(server, /startTaskContextThread/);
  assert.match(server, /turn\/steer/);
  assert.match(module, /browserMayReconstructPrompt: false/);
  assert.match(module, /readingNeverGrantsWriteback: true/);
  assert.match(module, /thread\/name\/set/);
  assert.match(research, /completed Codex Turn only\s+means the Turn completed/);
  assert.doesNotMatch(html + script + server + module, /localStorage|sessionStorage|indexedDB/i);
});

test("Codex light and dark primitives share one responsive accessible shell", async () => {
  const [html, css, script, guard, host] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.css"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  for (const exact of ["#0169cc", "#fff", "#0d0d0d", "#339cff", "#181818"]) assert.match(css.toLowerCase(), new RegExp(exact));
  assert.match(css, /Inter, -apple-system/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.app-shell[^}]+color: var\(--text\)/);
  assert.match(css, /\.graph-edges[^}]+pointer-events: none/);
  assert.match(css, /\.graph-edges \{ display: none; \}/);
  assert.match(css, /\.search-dialog/);
  assert.match(css, /\.inbox-panel/);
  assert.match(css, /\.attention-item/);
  assert.match(script, /reviewFrame === "narrow"/);
  assert.match(script, /sidebar\.inert = narrow && !open/);
  assert.match(script, /mainColumn\.inert = mobileNavigationOpen/);
  assert.match(script, /closeMobileSidebar/);
  assert.match(script, /event\.key === "Tab" && modal/);
  assert.match(script, /aria-expanded/);
  assert.match(html, /role="combobox"[^>]+aria-controls="searchResults"/);
  assert.match(script, /document\.documentElement\.dataset\.theme/);
  assert.match(script, /focusRouteHeading/);
  for (const behavior of ["narrow drawer closes", "wide sidebar collapses without trapping focus", "search traps forward Tab", "request draft and focus survive reconciliation", "request draft survives an intentional route change", "streaming never replaces a selected transcript entry", "releasing the selection reconciles the held entry", "switching Thread does not leak Composer state", "Quote serializes exact source identity into the Turn input", "replayed quote renders its durable source identity", "Composer growth stops at the CSS ceiling", "active submission dispatches one exact steer", "terminal reconciliation re-enables Fork", "Fork opens returned lineage", "Fork navigation updates the Thread deep link", "mounted timeline discloses its bound", "deferred model, mode and realtime controls make no contrary claim", "dark theme reaches overlay siblings", "page has no horizontal overflow", "Turn posture is internally coherent", "terminal mixed fixture makes no false live claim"]) assert.match(guard, new RegExp(behavior));
  assert.match(guard, /history\.replaceState\(history\.state, "", originalHref\)/, "the guard restores the review URL it changed");
  assert.match(script, /runBrowserInteractionGuard/);
  assert.match(host, /browser-interaction-guard\.mjs/);
  assert.match(css, /body\[data-review-frame="narrow"\] \{[^}]*width: 390px; height: 844px/);
  assert.match(css, /body\[data-review-frame="narrow"\] \.search-dialog/);
  assert.match(css, /body\[data-review-frame="narrow"\] \.inbox-panel/);
  assert.doesNotMatch(css, /\.task-card::before/);
  assert.match(script, /requestAnimationFrame\(renderGraphEdges\)/);
  assert.match(html, /aria-label="Application navigation"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /meta name="color-scheme"/);
});

test("Project names only the repository-bound VibeHub Project while chat grouping stays native under its own label", async () => {
  const [html, script, css, host, fixtureText, guard] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("apps/codex-first-shell/project-fixtures.json"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
  ]);
  const fixture = JSON.parse(fixtureText);
  assert.doesNotMatch(html + script, /Create Project|Move Chat to Project|No Projects yet|New Project name|Loading Codex Projects|Project renamed|Project deleted|Project created|source Project/);
  assert.match(html, /id="projectLabel">Chat groups</);
  assert.match(html, /aria-label="Create chat group"/);
  assert.match(script, /aria-label="Move Chat to group"/);
  assert.match(script, /prompt\("New chat group name"\)/);
  assert.match(script, /prompt\("Rename chat group"/);
  assert.match(script, /chat group\? Its Chats will return to Recents/);
  assert.match(script, /Chat group deleted\. Chats returned to Recents/);
  assert.match(script, /\$\{project\.name\}\)? group`|selected"\} group`/);
  assert.match(html, /id="projectHeader"/);
  assert.match(html, /id="projectHeaderLabel">Project</);
  assert.match(html, /id="importProject"[^>]*>Set up from Codex…/);
  assert.match(html, /id="importDialog"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /nothing is committed, and no Room tree is invented/);
  assert.match(html, /id="recentsFootnote"/);
  assert.match(script, /in other folders hidden/);
  assert.match(script, /Rooms: cold start pending — run distill/);
  assert.match(script, /this shell never invents one/);
  assert.match(script, /Working folder \(cwd\)/, "cwd is inspectable metadata, not a heading");
  for (const scope of ["bound", "unbound", "no-repository", "migration-required"]) {
    assert.equal(fixture.scopes[scope]?.scope, scope, `${scope} fixture variant`);
    assert.match(script, new RegExp(`"${scope}"`), `${scope} rendered by the shell`);
    assert.match(host, new RegExp(`"${scope}"`), `${scope} projected by the host`);
    assert.match(guard, new RegExp(`"scope state ${scope} renders"`), `${scope} proven in the real DOM`);
  }
  assert.equal(fixture.scopes.bound.rooms.coldStart, true, "the review fixture shows the deferred Room state, not a fabricated tree");
  assert.equal(fixture.importCandidates.projects.filter((project) => project.importable).length, 1);
  assert.equal(fixture.importCandidates.projects.find((project) => project.name === "vibehub-plugin").importable, false, "a namesake with a foreign folder is never importable");
  for (const behavior of ["import dialog is a contained modal that lands focus on the first eligible Codex Project", "ineligible Codex Projects stay visible but disabled with their reason", "selecting an eligible Codex Project names the uncommitted scaffold it will write", "import dialog traps forward Tab", "import dialog Escape restores focus to its trigger without importing", "unbound Tasks route explains the missing scope instead of a graph", "bound cold start hands off to distill without inventing a Room tree", "grouping copy never says Project for a Codex ThreadSection", "cwd appears only as inspectable metadata"]) assert.match(guard, new RegExp(behavior.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(script, /function scopeBound\(\)/);
  assert.match(script, /function renderProjectHeader\(\)/);
  assert.match(script, /action: "listImportableProjects"/);
  assert.match(script, /action: "importProject"/);
  assert.match(script, /const tasks = \(bound \? state\.bootstrap\?\.graph\.tickets \?\? \[\] : \[\]\)/, "search drops Task results outside a bound Project");
  assert.match(script, /const contexts = \(bound \? state\.bootstrap\?\.contexts \?\? \[\] : \[\]\)/, "search drops Context results outside a bound Project");
  assert.match(script, /\$\("#inboxButton"\)\.hidden = !bound/);
  assert.match(script, /\[\$\("#searchDialog"\), \$\("#importDialog"\), \$\("#inboxPanel"\), \$\("#reviewPanel"\)/, "the import dialog joins the shared focus trap");
  assert.match(script, /runtime-baseline-mismatch|Stopped: Codex runtime does not match the pinned baseline/);
  assert.match(host, /requireBoundScope\(\)/);
  assert.match(host, /"scope_unavailable"/);
  assert.match(host, /"import_ineligible"/);
  assert.match(host, /"already_bound"/);
  assert.match(host, /realpathSync\.native\(flags\.repo\)/);
  assert.match(host, /projects\.snapshot\(\{ cwd: repoRoot \}\)/);
  assert.match(host, /searchTerm: payload\.searchTerm\.trim\(\), cwd: repoRoot/);
  assert.doesNotMatch(host, /git\b[^\n]*\bcommit\b/, "the host never commits");
  for (const rule of [".project-header", ".scope-pill", ".import-dialog", ".import-row", ".scope-panel", ".stop-banner", ".scope-footnote"]) assert.match(css, new RegExp(rule.replace(".", "\\.")));
  assert.match(css, /body\[data-review-frame="narrow"\] \.import-dialog/);
  assert.doesNotMatch(html + script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("promoted shell keeps upstream runtime packages out of the browser app", async () => {
  const result = await probeDomainIsolation({
    id: "codex-first-shell",
    roots: ["apps/codex-first-shell"],
    forbiddenPackagePrefixes: ["@openai/codex", "@deepseek-ai/dsh"],
  });
  assert.ok(result.files >= 7, `expected the promoted app modules to be scanned, saw ${result.files}`);
  assert.deepEqual(result.violations, []);
  assert.equal(result.proven, true);
});

test("launcher rejects unknown, repeated, and malformed flags before touching the runtime", async () => {
  for (const [args, message] of [
    [["--bogus"], /unknown flag: --bogus/u],
    [["--port", "70000"], /--port must be an integer from 0 to 65535/u],
    [["--repo"], /--repo requires a value/u],
    [["--json", "--json"], /repeated flag: --json/u],
    [["--repo", "/nonexistent/vibehub-repo"], /Repository does not exist/u],
  ]) {
    const child = spawn(process.execPath, ["scripts/vh-codex-first-shell.mjs", ...args], { cwd: new URL(".", root), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 1, args.join(" "));
    assert.match(stderr, message);
  }
});

test("production shell routes ordinary Chat, approvals, interruption, and Tasks through the harness shell into one app-server", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "vibehub-codex-shell-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "app-server-calls.jsonl");
  const shell = await launchShell(context, { codex: fixtureAppServer, env: { CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_VERSION: "0.147.0" } });
  if (!shell) return;
  const { child, envelope, url, api, action } = shell;
  await assertHostBoundary(shell);
  assert.equal(envelope.runtime.version, "0.147.0");
  assert.equal(envelope.runtime.baselineVersion, capabilitySnapshot("codex").upstream.version);
  assert.equal(envelope.runtime.baselineMatch, true);
  assert.equal(envelope.runtime.command, fixtureAppServer);

  const bootstrap = await api("api/bootstrap");
  assert.equal(bootstrap.body.ok, true);
  assert.equal(bootstrap.body.data.account.authenticated, true);
  assert.equal(bootstrap.body.data.harness.carrierId, "codex");
  assert.deepEqual(bootstrap.body.data.harness.capabilities, capabilitySnapshot("codex"));
  assert.equal(bootstrap.body.data.runtime.audioInput, true);
  assert.equal(bootstrap.body.data.runtime.realtimeConversation, false);
  assert.equal(bootstrap.body.data.runtime.alive, true);
  assert.deepEqual(bootstrap.body.data.projects, []);
  assert.equal(bootstrap.body.data.project.scope, "bound", "this repository carries a CURRENT .vibehub scaffold");
  assert.equal(bootstrap.body.data.project.taskActions.available, true);
  assert.equal(bootstrap.body.data.project.binding, null, "a CLI-scaffolded repository is bound without a Codex binding record");
  assert.equal(bootstrap.body.data.project.visibility.cwd, fileURLToPath(root).replace(/\/$/u, ""));
  assert.equal(bootstrap.body.data.stop, null);
  const ticketId = bootstrap.body.data.graph.tickets.find((ticket) => ticket.ticketId.startsWith("ticket-"))?.ticketId;
  assert.ok(ticketId, "the repository graph must expose at least one current Ticket");

  const created = await action({ action: "newThread" });
  assert.equal(created.body.ok, true);
  const threadId = created.body.data.thread.id;
  assert.equal(created.body.data.thread.taskLink, null);
  const started = await action({ action: "startTurn", threadId, input: [{ type: "text", text: "hello" }, { type: "image", url: "data:image/png;base64,AA==" }] });
  assert.equal(started.body.ok, true);
  const turnId = started.body.data.turn.id;
  assert.match(turnId, /^fixture-turn-/u);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const events = await api("api/events?after=0");
  assert.equal(events.body.data.runtimeAlive, true);
  assert.deepEqual(events.body.data.events.map((event) => event.kind), ["notification", "serverRequest"]);
  const [pending] = events.body.data.pendingRequests;
  assert.equal(pending.method, "item/commandExecution/requestApproval");
  const invalidDecision = await action({ action: "resolveRequest", requestId: pending.id, decision: "nope" });
  assert.equal(invalidDecision.status, 400);
  const resolved = await action({ action: "resolveRequest", requestId: pending.id, decision: "accept" });
  assert.deepEqual(resolved.body.data, { resolved: true });
  const stale = await action({ action: "resolveRequest", requestId: pending.id, decision: "accept" });
  assert.equal(stale.status, 409);
  const interrupted = await action({ action: "interruptTurn", threadId, turnId });
  assert.equal(interrupted.body.ok, true);
  const unsupported = await action({ action: "teleport" });
  assert.equal(unsupported.status, 400);

  const task = await action({ action: "startTask", ticketId, selectedContextIds: [] });
  assert.equal(task.body.ok, true);
  assert.equal(task.body.data.ticketId, ticketId);
  assert.equal(JSON.parse(task.body.data.payloadText).kind, "vibehub_task_context_packet");
  const continued = await action({ action: "startTaskTurn", ticketId, threadId: task.body.data.threadId, message: "continue" });
  assert.equal(continued.body.ok, true);
  const unlinked = await action({ action: "startTaskTurn", ticketId, threadId, message: "continue" });
  assert.equal(unlinked.status, 409);

  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.kind === "request" ? call.method : `respond:${JSON.stringify(call.result)}`), [
    "initialize",
    "account/read",
    "account/read",
    "threadSection/list",
    "thread/list",
    "thread/list",
    "thread/start",
    "turn/start",
    "respond:{\"decision\":\"accept\"}",
    "turn/interrupt",
    "thread/start",
    "thread/name/set",
    "turn/start",
    "thread/list",
    "thread/resume",
    "turn/start",
    "thread/list",
  ]);
  const threadStarts = calls.filter((call) => call.method === "thread/start");
  for (const call of threadStarts) assert.deepEqual(call.params, { approvalPolicy: "on-request", sandbox: "workspace-write", cwd: fileURLToPath(root).replace(/\/$/u, ""), ephemeral: false });
  const [scopedRecents, unscopedCount] = calls.filter((call) => call.method === "thread/list");
  assert.deepEqual([scopedRecents.params.sectionId, scopedRecents.params.cwd], [null, fileURLToPath(root).replace(/\/$/u, "")], "Recents is the native unsectioned query scoped to this folder");
  assert.equal(unscopedCount.params.cwd, undefined, "the one unscoped query only counts hidden history");
  assert.equal(calls.find((call) => call.method === "thread/name/set").params.name, `VibeHub Task · ${ticketId}`);
  assert.deepEqual(Object.keys(calls.find((call) => call.method === "thread/resume").params).sort(), ["approvalPolicy", "cwd", "sandbox", "threadId"]);
  assert.equal(calls.find((call) => call.method === "turn/interrupt").params.turnId, turnId);
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

test("Codex-first shell host is loopback-only, bounded, and connected to the real runtime", async (context) => {
  const shell = await launchShell(context);
  if (!shell) return;
  const { child, envelope, url, api } = shell;
  await assertHostBoundary(shell);
  const fixtures = await fetch(new URL("chat-fixtures.json", url));
  assert.equal(fixtures.status, 200);
  assert.match(fixtures.headers.get("content-type"), /application\/json/);
  assert.equal((await fixtures.json()).thread.id, "fixture-chat-parity");
  const taskFixtures = await fetch(new URL("task-fixtures.json", url));
  assert.equal(taskFixtures.status, 200);
  assert.equal((await taskFixtures.json()).ticketId, "ticket-review-task-workspace");
  const projectFixtures = await fetch(new URL("project-fixtures.json", url));
  assert.equal(projectFixtures.status, 200);
  assert.equal((await projectFixtures.json()).projects[0].name, "Launch VibeHub");
  const eventRecovery = await api("api/events?after=-1");
  assert.equal(eventRecovery.body.data.gap, true);
  assert.ok(Number.isInteger(eventRecovery.body.data.oldestCursor));
  assert.equal(eventRecovery.body.data.runtimeAlive, true);
  for (const moduleName of ["chat-renderer.mjs", "event-window.mjs", "server-request-registry.mjs", "browser-interaction-guard.mjs"]) {
    const module = await fetch(new URL(moduleName, url));
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type"), /text\/javascript/);
  }
  assert.equal(envelope.runtime.baselineVersion, capabilitySnapshot("codex").upstream.version);
  if (olderThan(envelope.runtime.version, envelope.runtime.baselineVersion)) {
    context.skip(`local Codex app-server ${envelope.runtime.version} predates the pinned ${envelope.runtime.baselineVersion} baseline`);
    return;
  }
  const bootstrap = await api("api/bootstrap");
  const payload = bootstrap.body;
  assert.equal(payload.ok, true, JSON.stringify(payload.error ?? null));
  assert.equal(payload.data.account.authenticated, true);
  assert.equal(payload.data.harness.carrierId, "codex");
  assert.equal(payload.data.runtime.provider, "Codex app-server");
  assert.equal(payload.data.runtime.alive, true);
  assert.ok(payload.data.runtime.generation >= 1);
  assert.equal(payload.data.runtime.audioInput, true);
  assert.equal(payload.data.runtime.realtimeConversation, false);
  assert.ok(payload.data.contexts.some((context) => context.contextId === "decision-chat-default-search-and-task-attention"));
  assert.equal(payload.data.attention.semantics.running, "presence_only_never_notification");
  assert.ok(Array.isArray(payload.data.attention.needsYou));
  assert.ok(Array.isArray(payload.data.attention.recentCompletions));
  assert.ok(payload.data.graph.tickets.length > 0);
  assert.ok(payload.data.graph.tickets.every((ticket) => typeof ticket.ticketId === "string"));
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function temporaryRepository(context, { initGit = true } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "vibehub-scope-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "README.md"), "# scope fixture\n");
  if (initGit) {
    git(folder, ["init", "-q", "-b", "main"]);
    git(folder, ["config", "user.email", "fixture@example.com"]);
    git(folder, ["config", "user.name", "Fixture"]);
    git(folder, ["add", "README.md"]);
    git(folder, ["commit", "-q", "-m", "fixture"]);
  }
  // The seed deliberately uses the unresolved temp path so the proof covers
  // macOS /var -> /private/var real-path matching on both sides.
  return { folder, realFolder: realpathSync.native(folder) };
}

function scopeSeed(folder) {
  const elsewhere = join(tmpdir(), "vibehub-scope-elsewhere-not-a-repo");
  return {
    sections: [
      { id: "section-match", name: "Matching single folder" },
      { id: "section-foreign", name: "Foreign single folder" },
      { id: "section-multi", name: "Spans two folders" },
      { id: "section-empty", name: "Empty group" },
    ],
    threads: [
      { id: "seed-recent-here", name: "Recent in this folder", preview: "here", cwd: folder },
      { id: "seed-recent-elsewhere", name: "Recent elsewhere", preview: "elsewhere", cwd: elsewhere },
      { id: "seed-match-a", name: "Matching a", preview: "match", cwd: folder, sectionId: "section-match" },
      { id: "seed-match-archived", name: "Matching archived", preview: "match", cwd: folder, sectionId: "section-match", archived: true },
      { id: "seed-foreign-a", name: "Foreign a", preview: "foreign", cwd: elsewhere, sectionId: "section-foreign" },
      { id: "seed-multi-here", name: "Multi here", preview: "multi", cwd: folder, sectionId: "section-multi" },
      { id: "seed-multi-there", name: "Multi there", preview: "multi", cwd: elsewhere, sectionId: "section-multi" },
    ],
  };
}

test("an unbound Git repository hides foreign Codex history, refuses Task actions, and binds only through an eligible single-folder import", async (context) => {
  const { folder, realFolder } = await temporaryRepository(context);
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: { CODEX_FIXTURE_VERSION: "0.147.0", CODEX_FIXTURE_SEED: JSON.stringify(scopeSeed(folder)) } });
  if (!shell) return;
  const { child, api, action } = shell;
  await assertHostBoundary(shell);

  const before = (await api("api/bootstrap")).body.data;
  assert.equal(before.project.scope, "unbound");
  assert.equal(before.project.repositoryRoot, realFolder);
  assert.equal(before.project.worktreeRoot, realFolder);
  assert.equal(before.project.branch, "main");
  assert.equal(before.project.compatibility.detectedFormat, "uninitialized");
  assert.equal(before.project.binding, null);
  assert.deepEqual(before.project.taskActions, { available: false, reason: before.project.reason });
  assert.match(before.project.reason, /not set up as a VibeHub Project/);
  assert.deepEqual(before.recents.map((thread) => thread.id), ["seed-recent-here"], "Recents is native unsectioned Threads in this folder only");
  assert.deepEqual(before.projects.map((group) => [group.id, group.threads.map((thread) => thread.id), group.hiddenElsewhere]), [
    ["section-match", ["seed-match-a"], 0],
    ["section-multi", ["seed-multi-here"], 1],
    ["section-empty", [], 0],
  ], "a group is listed when it has a member here or no members at all; foreign-only groups are never listed");
  assert.ok(!before.threads.some((thread) => realpathSync.native(thread.cwd) !== realFolder), "no Thread from another folder reaches the browser");
  assert.deepEqual(before.project.visibility, { cwd: realFolder, scopedCount: 3, totalCount: 6, hiddenChats: 3, hiddenGroups: 1 });
  assert.deepEqual(before.graph.tickets, []);
  assert.deepEqual(before.contexts, []);

  for (const payload of [{ action: "startTask", ticketId: "ticket-anything" }, { action: "readTask", ticketId: "ticket-anything" }, { action: "startTaskTurn", ticketId: "ticket-anything", threadId: "seed-recent-here", message: "go" }]) {
    const refused = await action(payload);
    assert.equal(refused.status, 409, payload.action);
    assert.equal(refused.body.error.code, "scope_unavailable");
    assert.match(refused.body.error.message, /not set up as a VibeHub Project/);
  }
  const chat = await action({ action: "newThread" });
  assert.equal(chat.status, 200, "Chat stays fully usable without a bound Project");
  assert.equal(chat.body.data.thread.cwd, realFolder, "new Chats carry this folder as their native cwd");
  const turn = await action({ action: "startTurn", threadId: chat.body.data.thread.id, input: [{ type: "text", text: "hello" }] });
  assert.equal(turn.status, 200);
  const search = await action({ action: "searchThreads", searchTerm: "Recent" });
  assert.deepEqual(search.body.data.threads.map((thread) => thread.id), ["seed-recent-here"], "host search never lists foreign history either");

  const candidates = (await action({ action: "listImportableProjects" })).body.data;
  assert.equal(candidates.scope, "unbound");
  assert.equal(candidates.canImport, true);
  assert.equal(candidates.repositoryRoot, realFolder);
  assert.deepEqual(candidates.writes, REPOSITORY_WRITES.explicitImportOnly);
  assert.deepEqual(Object.fromEntries(candidates.projects.map((item) => [item.id, [item.eligibility, item.matchesRepository, item.memberCount, item.archivedCount]])), {
    "section-match": ["single-folder", true, 2, 1],
    "section-foreign": ["single-folder", false, 1, 0],
    "section-multi": ["multi-folder", false, 2, 0],
    "section-empty": ["empty", false, 0, 0],
  });
  assert.deepEqual(candidates.projects.find((item) => item.id === "section-match").folders, [realFolder]);

  for (const [sectionId, reason] of [["section-foreign", /different repository/], ["section-multi", /spans 2 folders/], ["section-empty", /no chats/], ["section-missing", /no longer exists/]]) {
    const refused = await action({ action: "importProject", sectionId });
    assert.equal(refused.status, 409, sectionId);
    assert.equal(refused.body.error.code, "import_ineligible");
    assert.match(refused.body.error.message, reason);
    assert.equal(existsSync(join(folder, ".vibehub")), false, `${sectionId} wrote nothing`);
  }

  const imported = await action({ action: "importProject", sectionId: "section-match" });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.data.committed, false);
  assert.equal(imported.body.data.scaffold.created, true);
  assert.deepEqual(imported.body.data.writtenPaths, [".vibehub/version.yaml", ".vibehub/rooms/", ".vibehub/tickets/", ".vibehub/evidence/", ".vibehub/outcomes/", ".vibehub/codex-project.yaml"]);
  for (const path of [".vibehub/version.yaml", ".vibehub/rooms", ".vibehub/tickets", ".vibehub/evidence", ".vibehub/outcomes", ".vibehub/codex-project.yaml"]) assert.ok(existsSync(join(folder, path)), path);
  assert.deepEqual(JSON.parse(await readFile(join(folder, ".vibehub/version.yaml"), "utf8")), { format_version: 2, kind: "vibehub_project", schema_version: 1 });
  const binding = JSON.parse(await readFile(join(folder, ".vibehub/codex-project.yaml"), "utf8"));
  assert.deepEqual(Object.keys(binding).sort(), ["codex_version", "folder", "harness", "imported_at", "kind", "schema_version", "section_id", "section_name_at_import"]);
  assert.deepEqual([binding.kind, binding.harness, binding.section_id, binding.section_name_at_import, binding.folder, binding.codex_version], ["codex_project_binding", "codex", "section-match", "Matching single folder", realFolder, "0.147.0"]);
  assert.equal(existsSync(join(folder, ".vibehub/rooms/room.yaml")), false, "import never fabricates a Room tree");
  assert.equal(git(folder, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).every((line) => line.startsWith("?? .vibehub/")), true, "the scaffold stays untracked");
  assert.equal(git(folder, ["rev-list", "--count", "HEAD"]), "1", "import never commits");

  const after = (await api("api/bootstrap")).body.data;
  assert.equal(after.project.scope, "bound");
  assert.equal(after.project.taskActions.available, true);
  assert.equal(after.project.compatibility.state, "CURRENT");
  assert.deepEqual(after.project.rooms, { coldStart: true, count: 0 });
  assert.deepEqual(after.project.binding, { sectionId: "section-match", sectionName: "Matching single folder", folder: realFolder, importedAt: binding.imported_at, codexVersion: "0.147.0", sectionPresent: true, recordPath: ".vibehub/codex-project.yaml" });
  assert.ok(after.project.uncommitted.paths.includes(".vibehub/codex-project.yaml"));
  assert.ok(after.project.uncommitted.paths.includes(".vibehub/version.yaml"));
  assert.equal(after.project.uncommitted.committed, false);
  assert.equal(after.project.sync.automaticCommit, false);
  const again = await action({ action: "importProject", sectionId: "section-match" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "already_bound");
  const afterChat = await action({ action: "newThread" });
  assert.equal(afterChat.body.data.thread.cwd, realFolder, "after binding, new Chats still sync to the checked-in folder natively");
  assert.equal((await action({ action: "readTask", ticketId: "ticket-missing" })).status, 500, "Task actions are gated by scope, not by the absence of Tickets");

  await action({ action: "deleteProject", projectId: "section-match" });
  const afterDelete = (await api("api/bootstrap")).body.data;
  assert.equal(afterDelete.project.binding.sectionPresent, false, "the binding record is provenance; the native section list is re-read on every boot");
  assert.ok(afterDelete.recents.some((thread) => thread.id === "seed-match-a"), "deleting a group returns its members to Recents");
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

test("a folder outside any Git repository keeps Chat usable while import and Task actions explain the missing scope", async (context) => {
  const { folder, realFolder } = await temporaryRepository(context, { initGit: false });
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: { CODEX_FIXTURE_VERSION: "0.147.0", CODEX_FIXTURE_SEED: JSON.stringify(scopeSeed(folder)) } });
  if (!shell) return;
  const { child, api, action } = shell;
  const bootstrap = (await api("api/bootstrap")).body.data;
  assert.equal(bootstrap.project.scope, "no-repository");
  assert.equal(bootstrap.project.repositoryRoot, null);
  assert.equal(bootstrap.project.worktreeRoot, realFolder);
  assert.equal(bootstrap.project.branch, null);
  assert.match(bootstrap.project.reason, /not inside a Git repository/);
  assert.equal(bootstrap.project.taskActions.available, false);
  assert.deepEqual(bootstrap.recents.map((thread) => thread.id), ["seed-recent-here"]);
  const candidates = (await action({ action: "listImportableProjects" })).body.data;
  assert.equal(candidates.canImport, false);
  assert.match(candidates.blockedReason, /not inside a Git repository/);
  const refused = await action({ action: "importProject", sectionId: "section-match" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "scope_unavailable");
  assert.equal(existsSync(join(folder, ".vibehub")), false);
  const task = await action({ action: "startTask", ticketId: "ticket-anything" });
  assert.equal(task.status, 409);
  assert.equal(task.body.error.code, "scope_unavailable");
  const chat = await action({ action: "newThread" });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.data.thread.cwd, realFolder);
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

test("a repository whose VibeHub data needs migration is neither bound nor importable and says why", async (context) => {
  const { folder } = await temporaryRepository(context);
  execFileSync("mkdir", ["-p", join(folder, ".vibehub", "tickets")]);
  await writeFile(join(folder, ".vibehub", "version.yaml"), JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 1 }, null, 2));
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: { CODEX_FIXTURE_VERSION: "0.147.0", CODEX_FIXTURE_SEED: JSON.stringify(scopeSeed(folder)) } });
  if (!shell) return;
  const { child, api, action } = shell;
  const bootstrap = (await api("api/bootstrap")).body.data;
  assert.equal(bootstrap.project.scope, "migration-required");
  assert.equal(bootstrap.project.compatibility.state, "MIGRATION_REQUIRED");
  assert.match(bootstrap.project.reason, /explicit VibeHub data migration/);
  const refused = await action({ action: "importProject", sectionId: "section-match" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "scope_unavailable");
  assert.equal(existsSync(join(folder, ".vibehub", "codex-project.yaml")), false);
  assert.equal((await action({ action: "newThread" })).status, 200);
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

test("a runtime that misses the pinned baseline surfaces a stop instead of a 500 and refuses reuse", async (context) => {
  const { folder } = await temporaryRepository(context);
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: { CODEX_FIXTURE_VERSION: "0.144.1" } });
  if (!shell) return;
  const { child, envelope, api, action } = shell;
  assert.equal(envelope.runtime.baselineMatch, false);
  // The stop is the pinned condition itself: a different binary is a
  // different generated protocol, so reuse halts before any Thread is read.
  assert.equal(envelope.runtime.state, "halted");
  assert.equal(envelope.runtime.halt.conditionId, "generated-protocol-hash-changed");
  const bootstrap = await api("api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.body.data.stop, {
    code: "runtime-baseline-mismatch",
    conditionId: "generated-protocol-hash-changed",
    message: `Codex app-server 0.144.1 is running but VibeHub pins ${envelope.runtime.baselineVersion}. The shell stops here instead of reusing an unverified runtime.`,
    detail: `Codex app-server 0.144.1 is running but the lock pins ${envelope.runtime.baselineVersion} (protocol schema f3dec1e031d9…).`,
    observedVersion: "0.144.1",
    baselineVersion: envelope.runtime.baselineVersion,
  });
  assert.deepEqual([bootstrap.body.data.projects, bootstrap.body.data.recents, bootstrap.body.data.threads], [[], [], []]);
  assert.equal(bootstrap.body.data.project.scope, "unbound");
  assert.equal(bootstrap.body.data.runtime.state, "halted");
  assert.equal(bootstrap.body.data.runtime.conditions.find((entry) => entry.id === "generated-protocol-hash-changed").status, "violated");
  const refused = await action({ action: "newThread" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "runtime_halted");
  assert.equal(refused.body.error.conditionId, "generated-protocol-hash-changed");
  const events = await api("api/events?after=0");
  assert.equal(events.body.data.runtimeState, "halted");
  assert.equal(events.body.data.runtimeHalt.conditionId, "generated-protocol-hash-changed");
  assert.deepEqual(events.body.data.events.map((event) => event.kind), ["runtimeHalted"]);
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

// A bound repository with two Tickets, one accepted prerequisite, Evidence for
// one of two criteria, one active and one superseded Context: enough for the
// canonical projection, the Context packet and the proof state to be
// predicted exactly.
async function proofRepository(context) {
  const { folder, realFolder } = await temporaryRepository(context);
  const write = async (path, document) => {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), `${JSON.stringify(document, null, 2)}\n`);
  };
  await write(".vibehub/version.yaml", { format_version: 2, kind: "vibehub_project", schema_version: 1 });
  await write(".vibehub/rooms/product/room.yaml", { schema_version: 1, kind: "room", room_id: "product", description: "Product direction", boundary: "What the shell promises", anchors: ["README.md"], stale: false });
  await write(".vibehub/rooms/product/decision-proof-direction.yaml", {
    schema_version: 1, kind: "context", context_id: "decision-proof-direction", type: "decision", state: "active",
    summary: "The Workspace shows the exact host packet", detail: "Every Task Workspace shows its host-built packet verbatim.", tags: ["proof", "packet"],
    source: { ref: "conversation:proof-direction", captured_at: "2026-08-20T10:00:00Z" },
    evidence: [{ ref: "conversation:proof-direction", note: "Owner decision." }], relations: [],
  });
  await write(".vibehub/rooms/product/note-superseded-proof.yaml", {
    schema_version: 1, kind: "context", context_id: "note-superseded-proof", type: "note", state: "superseded",
    summary: "An older note that search and packets must not surface", detail: "Superseded.", tags: [],
    source: { ref: "conversation:proof-direction", captured_at: "2026-08-19T10:00:00Z" },
    evidence: [{ ref: "conversation:proof-direction", note: "Superseded note." }], relations: [],
  });
  await write(".vibehub/tickets/ticket-proof-prerequisite.yaml", {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-proof-prerequisite", maturity: "firm", outcome: "The prerequisite is accepted.", deliveries: [],
    context: "Closes first.", acceptance: [{ acceptance_id: "prereq-holds", criterion: "The prerequisite holds." }], constraints: [], context_refs: [], relations: [], provenance_refs: [],
  });
  await write(".vibehub/tickets/ticket-proof-workspace.yaml", {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-proof-workspace", maturity: "firm", outcome: "The Task Workspace proves its packet and proof state.", deliveries: [],
    context: "Shows contract, Evidence, Outcome and the host packet.",
    acceptance: [{ acceptance_id: "workspace-renders", criterion: "The Workspace renders the contract." }, { acceptance_id: "packet-is-exact", criterion: "The packet is byte-exact." }],
    constraints: ["No second store."],
    context_refs: [{ ref: ".vibehub/rooms/product/decision-proof-direction.yaml", purpose: "Binding direction." }],
    relations: [{ type: "depends_on", target_ticket_id: "ticket-proof-prerequisite", rationale: "Prerequisite must be accepted first." }],
    provenance_refs: ["conversation:proof-direction"],
  });
  await write(".vibehub/evidence/ticket-proof-prerequisite/prereq-proof.yaml", { schema_version: 1, kind: "ticket_evidence", evidence_id: "prereq-proof", ticket_id: "ticket-proof-prerequisite", acceptance_ids: ["prereq-holds"], summary: "Prerequisite proven.", refs: ["README.md"], origin: "agent", recorded_at: "2026-08-20T11:00:00Z" });
  await write(".vibehub/evidence/ticket-proof-workspace/workspace-proof.yaml", { schema_version: 1, kind: "ticket_evidence", evidence_id: "workspace-proof", ticket_id: "ticket-proof-workspace", acceptance_ids: ["workspace-renders"], summary: "The Workspace rendered the contract.", refs: ["apps/codex-first-shell/app.js"], origin: "agent", recorded_at: "2026-08-21T09:00:00Z" });
  await write(".vibehub/outcomes/ticket-proof-prerequisite.yaml", { schema_version: 1, kind: "ticket_outcome", ticket_id: "ticket-proof-prerequisite", status: "successful", accepted_acceptance_ids: ["prereq-holds"], unresolved_acceptance_ids: [], evidence_ids: ["prereq-proof"], summary: "Independently accepted.", closed_at: "2026-08-20T12:00:00Z" });
  git(folder, ["add", ".vibehub"]);
  git(folder, ["commit", "-q", "-m", "vibehub proof graph"]);
  return { folder, realFolder };
}

// The contexts input the host hands task-context.mjs, rebuilt from the
// canonical Room projection alone (an independent oracle for bootstrap.contexts).
function canonicalContexts(snapshot) {
  return snapshot.state.rooms.rooms
    .flatMap((room) => room.contexts.filter((item) => item.state === "active").map((item) => {
      const document = snapshot.repository.contexts.documents.get(item.contextId).document;
      return { contextId: item.contextId, type: item.type, summary: item.summary, detail: document.detail, tags: document.tags, room: room.room, sourceRef: document.source.ref, contextRef: item.path, source: "canonical_room_projection" };
    }))
    .sort((left, right) => left.summary.localeCompare(right.summary));
}

test("Graph and Task Workspace routes serve the canonical projection, and the Workspace packet is exactly the adapter's", async (context) => {
  const { folder, realFolder } = await proofRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-codex-proof-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "app-server-calls.jsonl");
  const elsewhere = join(tmpdir(), "vibehub-scope-elsewhere-not-a-repo");
  const seed = {
    sections: [{ id: "section-proof", name: "Proof group" }],
    threads: [
      { id: "seed-proof-recent", name: "Proof thread in Recents", preview: "proof", cwd: folder },
      { id: "seed-proof-grouped", name: "Proof thread in a group", preview: "proof", cwd: folder, sectionId: "section-proof" },
      { id: "seed-proof-archived", name: "Proof thread archived", preview: "proof", cwd: folder, archived: true },
      { id: "seed-proof-elsewhere", name: "Proof thread elsewhere", preview: "proof", cwd: elsewhere },
      { id: "seed-other", name: "Unrelated chat", preview: "other", cwd: folder },
    ],
  };
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: { CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_VERSION: "0.147.0", CODEX_FIXTURE_SEED: JSON.stringify(seed) } });
  if (!shell) return;
  const { child, api, action } = shell;

  // Graph route: the host projection is the canonical read-only snapshot, field for field.
  const snapshot = buildUiSnapshot(realFolder);
  const bootstrap = (await api("api/bootstrap")).body.data;
  assert.equal(bootstrap.project.scope, "bound");
  assert.deepEqual(bootstrap.graph, {
    snapshotId: snapshot.state.graph.snapshotId,
    project: snapshot.state.project,
    tickets: snapshot.state.graph.tickets,
    relations: snapshot.state.graph.relations,
    source: snapshot.state.graph.source,
  }, "the Graph is the canonical buildUiSnapshot graph, not a host re-derivation");
  assert.deepEqual(bootstrap.graph.tickets.map((ticket) => [ticket.ticketId, ticket.capabilities.operational.summary.label, ticket.capabilities.nextAction.summary.action]), [
    ["ticket-proof-prerequisite", "DONE", "DONE"],
    ["ticket-proof-workspace", "READY", "EXECUTE"],
  ]);
  assert.deepEqual(bootstrap.contexts, canonicalContexts(snapshot), "durable Context comes through the canonical Room projection and excludes superseded entries");
  assert.deepEqual(bootstrap.contexts.map((item) => item.contextId), ["decision-proof-direction"]);

  // Task Workspace route: contract, Evidence, Outcome and the packet exactly as task-context.mjs assembles it.
  const workspace = await action({ action: "readTask", ticketId: "ticket-proof-workspace" });
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  const handoff = buildTicketHandoff(realFolder, "ticket-proof-workspace");
  assert.deepEqual(workspace.body.data.handoff, handoff, "the Workspace contract is the canonical handoff");
  const priorAccepted = [{
    ticketId: "ticket-proof-prerequisite",
    rationale: "Prerequisite must be accepted first.",
    outcomeRef: join(realFolder, ".vibehub", "outcomes", "ticket-proof-prerequisite.yaml"),
    outcome: { status: "successful", summary: "Independently accepted.", closedAt: "2026-08-20T12:00:00Z", acceptedAcceptanceIds: ["prereq-holds"] },
    evidence: [{ evidenceId: "prereq-proof", evidenceRef: join(realFolder, ".vibehub", "evidence", "ticket-proof-prerequisite", "prereq-proof.yaml"), summary: "Prerequisite proven.", acceptanceIds: ["prereq-holds"], origin: "agent", refs: ["README.md"] }],
  }];
  const packetInputs = { handoff, project: snapshot.state.project, contexts: canonicalContexts(snapshot), rooms: snapshot.state.rooms.rooms, selectedContextIds: [], priorAccepted };
  const expectedPacket = buildTaskContextPacket({ ...packetInputs, thread: null, operation: "start", humanMessage: null });
  assert.deepEqual(workspace.body.data.packet, expectedPacket, "the read-time packet is exactly the adapter's assembly");
  assert.equal(workspace.body.data.packetText, JSON.stringify(expectedPacket, null, 2), "packetText is the host serialization the browser shows verbatim");
  assert.deepEqual(workspace.body.data.evidence, handoff.evidence);
  assert.deepEqual(workspace.body.data.evidence.map((item) => [item.evidenceId, item.acceptanceIds, item.origin, item.refs]), [["workspace-proof", ["workspace-renders"], "agent", ["apps/codex-first-shell/app.js"]]]);
  assert.equal(workspace.body.data.outcome, null, "no Outcome is recorded for the open Ticket");
  assert.deepEqual(workspace.body.data.nextAction, { action: "EXECUTE", reason: "acceptance_evidence_incomplete", detail: "Executable criteria still need reproducible acceptance-linked Evidence.", acceptanceIds: ["packet-is-exact"], blockingTicketIds: [] });
  assert.equal(workspace.body.data.packet.context.items[0].contextId, "decision-proof-direction");
  assert.deepEqual(workspace.body.data.source, { handoff: "vh-ui.buildTicketHandoff", packet: "codex-adapter/task-context.buildTaskContextPacket", contexts: "canonical_room_projection", snapshotId: snapshot.state.graph.snapshotId });
  const closed = (await action({ action: "readTask", ticketId: "ticket-proof-prerequisite" })).body.data;
  assert.deepEqual([closed.outcome.status, closed.outcome.accepted_acceptance_ids, closed.outcome.evidence_ids, closed.outcome.closed_at], ["successful", ["prereq-holds"], ["prereq-proof"], "2026-08-20T12:00:00Z"], "a closed Ticket's Workspace carries its canonical Outcome record");
  assert.equal(closed.nextAction.reason, "successful_outcome");

  // The packet a Start sends is the same bytes, persisted by the app-server as the Turn's user input.
  const started = (await action({ action: "startTask", ticketId: "ticket-proof-workspace", selectedContextIds: [] })).body.data;
  assert.equal(started.payloadText, workspace.body.data.packetText);
  const replayed = (await action({ action: "readThread", threadId: started.threadId })).body.data.thread;
  assert.equal(replayed.turns[0].items[0].type, "userMessage");
  assert.equal(replayed.turns[0].items[0].content[0].text, started.payloadText, "thread/read replays the exact packet bytes; no second store is consulted");

  // Continue and steer rebuild the packet for their operation; each response names the exact bytes it sent.
  const continued = (await action({ action: "startTaskTurn", ticketId: "ticket-proof-workspace", threadId: started.threadId, message: "continue the proof" })).body.data;
  assert.deepEqual([continued.ticketId, continued.threadId, continued.operation], ["ticket-proof-workspace", started.threadId, "continue"]);
  assert.deepEqual(JSON.parse(continued.payloadText), buildTaskContextPacket({ ...packetInputs, thread: { id: started.threadId, activeTurnId: null }, operation: "continue", humanMessage: "continue the proof" }));
  const steered = (await action({ action: "steerTaskTurn", ticketId: "ticket-proof-workspace", threadId: started.threadId, expectedTurnId: continued.turn.id, message: "steer the proof" })).body.data;
  assert.deepEqual([steered.operation, steered.turnId], ["steer", continued.turn.id]);
  assert.deepEqual(JSON.parse(steered.payloadText), buildTaskContextPacket({ ...packetInputs, thread: { id: started.threadId, activeTurnId: continued.turn.id }, operation: "steer", humanMessage: "steer the proof" }));
  const afterTurns = (await action({ action: "readThread", threadId: started.threadId })).body.data.thread.turns;
  assert.equal(afterTurns.at(-1).items.filter((item) => item.type === "userMessage").map((item) => item.content[0].text).join("\n"), `${continued.payloadText}\n${steered.payloadText}`, "continue and steer inputs are persisted verbatim in the Thread");

  // Typed Search: native thread/list searchTerm scoped to this folder, bounded, never the archived or foreign history.
  const search = (await action({ action: "searchThreads", searchTerm: "Proof", limit: 99 })).body.data;
  assert.deepEqual(search.threads.map((thread) => thread.id).sort(), ["seed-proof-grouped", "seed-proof-recent"], "search spans Recents and groups in this folder only");
  assert.deepEqual([search.total, search.limit, search.searchTerm, search.scope.cwd, search.scope.method, search.scope.filter], [2, 20, "Proof", realFolder, "thread/list", "searchTerm"]);
  const bounded = (await action({ action: "searchThreads", searchTerm: "Proof", limit: 1 })).body.data;
  assert.deepEqual([bounded.threads.length, bounded.total, bounded.limit], [1, 2, 1]);
  assert.deepEqual((await action({ action: "searchThreads", searchTerm: "   " })).body.data.threads, []);
  const calls = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const searches = calls.filter((call) => call.method === "thread/list" && call.params?.searchTerm);
  assert.equal(searches.length, 2, "each non-empty search is one native thread/list query");
  for (const call of searches) assert.deepEqual([call.params.searchTerm, call.params.cwd, call.params.archived, call.params.sectionId], ["Proof", realFolder, false, undefined]);
  assert.equal(calls.filter((call) => call.method === "thread/list" && call.params?.searchTerm === "   ").length, 0, "a blank query never reaches the app-server");
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});

test("Chat is the default landing, the Graph is never a fallback, and the Workspace shows proof and the verbatim packet", async () => {
  const [html, script, css, host, guard, contractText] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
    source("docs/proposals/codex-native-attention/interaction-contract.json"),
  ]);
  const contract = JSON.parse(contractText);
  // Landing: start() ends on Chat; no code path routes to the Graph except a real click.
  const startSource = script.slice(script.indexOf("async function start()"), script.indexOf("await start();"));
  const routeCalls = [...startSource.matchAll(/setRoute\("([a-z]+)"\)/g)].map((match) => match[1]);
  assert.equal(routeCalls.at(-1), "chat", "the tail of start() lands on Chat");
  assert.ok(!routeCalls.includes("tasks"), "start() never routes to the Graph");
  assert.doesNotMatch(script, /setRoute\("tasks"\)/, "the Graph is reached only through a data-route click, never as a programmatic landing or fallback");
  assert.match(html, /id="backButton"[^>]+data-route="tasks"/, "the Workspace back button is the one data-route path");
  const openTaskSource = script.slice(script.indexOf("async function openTask"), script.indexOf("function addAttachment"));
  assert.match(openTaskSource, /catch \(error\) \{[^]*state\.activeTicketId = null;[^]*setRoute\("chat"\);/, "an unreadable Task lands on Chat");
  assert.match(script, /async function landFromLocation\(params\) \{\s*const requestedTicketId = params\.get\("task"\);\s*if \(requestedTicketId\) \{[^]*await openTask\(requestedTicketId\);/, "?task= reopens the Workspace on landing");
  assert.match(script, /if \(await landFromLocation\(params\)\) \{\s*pollEvents\(\);\s*return;\s*\}/);
  assert.match(script, /threadLocation\(location\.href, state\.activeThreadId, state\.route === "task" \? state\.activeTicketId : null\)/);
  assert.match(script, /function setRoute\(route\) \{[^]*syncThreadLocation\(\);\s*syncComposerMode\(\);\s*\}/, "leaving the Workspace drops ?task= from the URL");
  assert.equal(threadLocation("http://127.0.0.1:1/?chatFixture=mixed&thread=t1#tok", "t1", "ticket-a"), "http://127.0.0.1:1/?chatFixture=mixed&thread=t1&task=ticket-a#tok");
  assert.equal(threadLocation("http://127.0.0.1:1/?chatFixture=mixed&thread=t1&task=ticket-a#tok", "t1"), "http://127.0.0.1:1/?chatFixture=mixed&thread=t1#tok");
  // Workspace: contract, Evidence, Outcome, next action reason, and the packet verbatim from the host.
  assert.match(host, /packetText: JSON\.stringify\(packet, null, 2\),\s*evidence: handoff\.evidence,\s*outcome: handoff\.outcomeRecord,\s*nextAction: handoff\.nextAction,/);
  assert.match(host, /const payloadText = workspace\.packetText;/, "Task Turns send the same bytes the Workspace shows");
  assert.match(host, /function knowledgeProjection\(snapshot = buildUiSnapshot\(repoRoot\)\)/);
  assert.match(host, /source: KNOWLEDGE_SOURCE,/);
  assert.match(host, /const KNOWLEDGE_SOURCE = "canonical_room_projection";/);
  assert.doesNotMatch(host, /loadRepository/, "the host reads the repository only through the canonical snapshot");
  assert.match(host, /const SEARCH_LIMIT = 20;/);
  const proofSource = script.slice(script.indexOf("function proofMarkup"), script.indexOf("function renderTaskWorkspace"));
  assert.match(proofSource, /workspace\?\.evidence \?\? handoff\.evidence/);
  assert.match(proofSource, /workspace\?\.outcome \?\? handoff\.outcomeRecord/);
  assert.match(proofSource, /nextAction\.reason/);
  for (const field of ["evidenceId", "summary", "acceptanceIds", "origin", "refs", "outcome.status", "outcome.summary", "outcome.closed_at", "accepted_acceptance_ids", "unresolved_acceptance_ids"]) assert.ok(proofSource.includes(field), field);
  assert.match(script, /<pre data-packet-text[^>]*>\$\{escapeHtml\(packetText\)\}<\/pre>/, "the packet is rendered as the host's own bytes");
  assert.match(script, /const packetText = workspace\?\.packetText \?\? /);
  assert.match(script, /function packetRawDisclosure/);
  assert.match(script, /pre\.textContent = userInputText\(item\.content\);/, "the transcript raw packet is the replayed Turn input");
  assert.match(script, /capabilities\.operational\?\.summary\?\.label/, "phase prefers the canonical operational summary");
  for (const rule of [".proof-section", ".evidence-list", ".outcome-record", ".packet-raw", ".search-status"]) assert.match(css, new RegExp(rule.replace(".", "\\.")));
  // Search: one entry, three labelled owners, native Thread search merged with local Tasks and Context.
  assert.deepEqual(contract.search.labels, ["Chats (Codex)", "Tasks (VibeHub)", "Context (Rooms)"]);
  for (const label of contract.search.labels) assert.ok(script.includes(`"${label}"`), label);
  assert.match(script, /action: "searchThreads", searchTerm: query, limit: SEARCH_NATIVE_LIMIT/);
  assert.match(script, /const SEARCH_NATIVE_LIMIT = 20;/);
  assert.match(script, /if \(sequence !== searchSequence \|\| \$\("#searchDialog"\)\.hidden\) return;/, "a stale native reply never overwrites the typed query");
  assert.match(script, /data-search-source="\$\{item\.source\}"/);
  for (const behavior of ["search groups are labelled by owner and include a native Thread result", "Task Workspace shows canonical PROOF, Evidence, Outcome and the fixture packet verbatim", "Task packet transcript card discloses the persisted Turn input byte-exact", "task deep link reopens the Workspace through the landing path", "leaving the Workspace drops the task deep link", "live Task Workspace renders the host PROOF and packet verbatim"]) assert.match(guard, new RegExp(behavior.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html + script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("killing the app-server mid-Turn restarts it and recovers the same Thread identities, Task linkage and running-Turn truth", async (context) => {
  const { folder } = await proofRepository(context);
  const lifecycle = await lifecycleTemp(context);
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: lifecycle.env() });
  if (!shell) return;
  const { child, envelope, api, action } = shell;
  assert.equal(envelope.runtime.state, "alive");
  assert.equal(envelope.runtime.generation, 1);
  assert.equal(envelope.runtime.halt, null);
  const conditionStatus = (runtime, id) => runtime.conditions.find((entry) => entry.id === id)?.status;
  assert.equal(conditionStatus(envelope.runtime, "thread-restart-recovery-unavailable"), "unverified", "recovery is unproven until a restart is observed");
  assert.equal(conditionStatus(envelope.runtime, "generated-protocol-hash-changed"), "unverified", "the fixture cannot emit the generated schema; the hash stays unverified, never assumed");
  assert.equal(conditionStatus(envelope.runtime, "managed-auth-status-unavailable"), "pass");

  // One ordinary Chat with a live Turn and one Task-linked Thread, both
  // known to this folder before the process dies.
  const chat = (await action({ action: "newThread" })).body.data.thread;
  const task = (await action({ action: "startTask", ticketId: "ticket-proof-workspace", selectedContextIds: [] })).body.data;
  const turn = (await action({ action: "startTurn", threadId: chat.id, input: [{ type: "text", text: "keep running" }] })).body.data.turn;
  await pollEventsUntil(api, (window) => window.pendingRequests.some((request) => request.params?.turnId === turn.id));
  const before = (await api("api/bootstrap")).body.data;
  const identity = (threads) => threads.map((thread) => [thread.id, thread.taskLink?.ticketId ?? null]).sort();
  assert.deepEqual(identity(before.threads), [[chat.id, null], [task.threadId, "ticket-proof-workspace"]]);
  const liveBefore = (await action({ action: "readThread", threadId: chat.id })).body.data.thread;
  assert.deepEqual([liveBefore.status.type, liveBefore.turns.at(-1).status], ["active", "inProgress"], "before the kill the Turn is truthfully live");
  const pendingBefore = before.pendingRequests.map((request) => request.id);
  assert.ok(pendingBefore.length >= 1);

  const [firstPid] = await fixturePids(lifecycle.pidPath);
  process.kill(firstPid, "SIGKILL");
  const exited = await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "runtimeExit"));
  if (!exited.events.some((event) => event.kind === "runtimeRestarted")) {
    // Inside the restart window every adapter verb is refused as temporary,
    // and the bootstrap says so instead of failing.
    const refused = await action({ action: "newThread" });
    if (refused.status === 503) {
      assert.equal(refused.body.error.code, "runtime_restarting");
      assert.equal(refused.body.error.runtimeState, "restarting");
      const restarting = (await api("api/bootstrap")).body.data;
      assert.equal(restarting.runtime.alive, false);
      assert.deepEqual([restarting.threads, restarting.pendingRequests], [[], []], "nothing is invented from memory while the process is gone");
    } else assert.equal(refused.status, 200, "the restart had already completed");
  }
  const restarted = await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "runtimeRestarted"));
  const sequence = hostEvents(restarted).map((event) => event.kind);
  const exitIndex = sequence.indexOf("runtimeExit");
  assert.ok(exitIndex >= 0);
  assert.deepEqual(sequence.slice(exitIndex), ["runtimeExit", ...pendingBefore.map(() => "requestResolved"), "runtimeRestarted"], "exit, every pending request voided, then one restart");
  const exit = restarted.events.find((event) => event.kind === "runtimeExit").value;
  assert.deepEqual([exit.generation, exit.signal, exit.requested, exit.runtimeGeneration], [1, "SIGKILL", false, 1]);
  const voided = restarted.events.filter((event) => event.kind === "requestResolved").map((event) => event.value);
  assert.deepEqual(voided.map((value) => [value.id, value.resolution, value.runtimeGeneration]).sort(), pendingBefore.map((id) => [id, "runtime_exited", 1]).sort());
  const recovery = restarted.events.find((event) => event.kind === "runtimeRestarted").value;
  assert.deepEqual([recovery.generation, recovery.version, recovery.attempt], [2, "0.147.0", 1]);
  assert.deepEqual([...recovery.recoveredThreadIds].sort(), [chat.id, task.threadId].sort());
  assert.deepEqual(recovery.recoveredTaskLinks, [{ ticketId: "ticket-proof-workspace", threadId: task.threadId }]);
  assert.deepEqual([restarted.runtimeGeneration, restarted.runtimeAlive, restarted.runtimeState, restarted.runtimeHalt, restarted.pendingRequests], [2, true, "alive", null, []]);
  assert.ok(!restarted.events.some((event) => event.kind === "notification" && event.value.method === "turn/started" && event.sequence > exit.sequence), "no live Turn is minted by the restart");

  // Same identities and links after the restart, read from Codex again, and
  // the orphaned Turn is replayed as persisted (still inProgress) on a
  // Thread that is no longer active: not live.
  const after = (await api("api/bootstrap")).body.data;
  assert.deepEqual(identity(after.threads), identity(before.threads));
  assert.deepEqual([after.runtime.state, after.runtime.generation, after.stop, after.runtime.restart.attempts], ["alive", 2, null, 1]);
  assert.equal(conditionStatus(after.runtime, "thread-restart-recovery-unavailable"), "pass");
  assert.match(after.runtime.conditions.find((entry) => entry.id === "thread-restart-recovery-unavailable").detail, /2 known Thread identities and 1 Task link resolved from Codex again/);
  const replayed = (await action({ action: "readThread", threadId: chat.id })).body.data.thread;
  assert.deepEqual([replayed.id, replayed.status.type, replayed.turns.at(-1).id, replayed.turns.at(-1).status], [chat.id, "notLoaded", turn.id, "inProgress"]);
  const stale = await action({ action: "resolveRequest", requestId: pendingBefore[0], decision: "accept" });
  assert.equal(stale.status, 409, "a request the dead process asked for is never answered to the new one");
  assert.equal(stale.body.error.code, "request_not_pending");

  // Work continues in the new generation: a history Thread is resumed into
  // the process before its next Turn; the Task link is usable as before.
  const resumedTurn = await action({ action: "startTurn", threadId: chat.id, input: [{ type: "text", text: "after restart" }] });
  assert.equal(resumedTurn.status, 200, JSON.stringify(resumedTurn.body));
  const continued = await action({ action: "startTaskTurn", ticketId: "ticket-proof-workspace", threadId: task.threadId, message: "continue after restart" });
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  assert.equal(continued.body.data.operation, "continue");
  const calls = await appServerCalls(lifecycle.logPath);
  assert.equal(calls.filter((call) => call.method === "initialize").length, 2, "the second process initialized on its own");
  const secondInitialize = calls.findIndex((call, index) => call.method === "initialize" && index > calls.findIndex((entry) => entry.method === "initialize"));
  const afterRestart = calls.slice(secondInitialize).map((call) => call.method);
  assert.deepEqual(afterRestart.slice(0, 3), ["initialize", "account/read", "thread/list"], "restart re-reads auth and the folder's Threads before reuse");
  assert.deepEqual(afterRestart.filter((method) => ["thread/resume", "turn/start"].includes(method)).slice(0, 2), ["thread/resume", "turn/start"], "a Thread unknown to the new process is resumed before its Turn starts");
  const pids = await fixturePids(lifecycle.pidPath);
  assert.equal(pids.length, 2);
  assert.notEqual(pids[0], pids[1]);
  const shutdown = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await shutdown, [0, null]);
});

test("a launcher restart over the same persisted Codex state recovers identities and Task links without a second store", async (context) => {
  const { folder } = await proofRepository(context);
  const lifecycle = await lifecycleTemp(context);
  const first = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: lifecycle.env() });
  if (!first) return;
  const chat = (await first.action({ action: "newThread" })).body.data.thread;
  const task = (await first.action({ action: "startTask", ticketId: "ticket-proof-workspace", selectedContextIds: [] })).body.data;
  const turn = (await first.action({ action: "startTurn", threadId: chat.id, input: [{ type: "text", text: "left running" }] })).body.data.turn;
  const before = (await first.api("api/bootstrap")).body.data;
  const identity = (threads) => threads.map((thread) => [thread.id, thread.taskLink?.ticketId ?? null]).sort();
  const firstExit = once(first.child, "exit");
  first.child.kill("SIGTERM");
  assert.deepEqual(await firstExit, [0, null]);

  const second = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: lifecycle.env() });
  if (!second) return;
  const after = (await second.api("api/bootstrap")).body.data;
  assert.deepEqual(identity(after.threads), identity(before.threads));
  assert.deepEqual(identity(after.threads), [[chat.id, null], [task.threadId, "ticket-proof-workspace"]]);
  assert.equal(after.threads.find((thread) => thread.id === task.threadId).taskLink.kind, "codex_thread_name", "the link is re-derived from the Codex Thread name, not read from a VibeHub store");
  const replayed = (await second.action({ action: "readThread", threadId: chat.id })).body.data.thread;
  assert.deepEqual([replayed.status.type, replayed.turns.at(-1).id, replayed.turns.at(-1).status], ["notLoaded", turn.id, "inProgress"], "the orphaned Turn replays as persisted on an unloaded Thread");
  assert.equal(after.pendingRequests.length, 0);
  assert.equal(after.runtime.generation, 1, "a new launcher is a new process generation 1; nothing carries over");
  assert.equal(after.runtime.conditions.find((entry) => entry.id === "thread-restart-recovery-unavailable").status, "unverified");
  const packet = (await second.action({ action: "readThread", threadId: task.threadId })).body.data.thread.turns[0].items[0].content[0].text;
  assert.equal(packet, task.payloadText, "the Task packet is replayed byte-exact from Codex after the launcher restart");
  assert.equal(existsSync(join(folder, ".vibehub", "codex-project.yaml")), false);
  assert.equal(git(folder, ["status", "--porcelain", "--untracked-files=all"]), "", "neither launcher wrote anything into the repository");
  const shutdown = once(second.child, "exit");
  second.child.kill("SIGTERM");
  assert.deepEqual(await shutdown, [0, null]);
});

test("a restart that cannot recover the known Thread identities halts reuse visibly", async (context) => {
  const { folder } = await proofRepository(context);
  const lifecycle = await lifecycleTemp(context);
  // No CODEX_FIXTURE_STATE: the respawned app-server knows nothing, like a
  // runtime whose rollouts were lost.
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: { ...lifecycle.env(), CODEX_FIXTURE_STATE: "" } });
  if (!shell) return;
  const { child, api, action } = shell;
  const chat = (await action({ action: "newThread" })).body.data.thread;
  const task = (await action({ action: "startTask", ticketId: "ticket-proof-workspace", selectedContextIds: [] })).body.data;
  const [firstPid] = await fixturePids(lifecycle.pidPath);
  process.kill(firstPid, "SIGKILL");
  const halted = await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "runtimeHalted"));
  const kinds = hostEvents(halted).map((event) => event.kind);
  assert.deepEqual(kinds.slice(kinds.indexOf("runtimeExit")), ["runtimeExit", "requestResolved", "runtimeHalted"], "the Task Turn's pending approval is voided between the exit and the halt; no restart is announced");
  const halt = halted.events.find((event) => event.kind === "runtimeHalted").value;
  assert.deepEqual([halt.code, halt.conditionId, halt.generation], ["stop-condition-violated", "thread-restart-recovery-unavailable", 2]);
  assert.match(halt.detail, new RegExp(`After restart \\(generation 2\\), Threads ${[chat.id, task.threadId].join(", ")} did not come back; Task link ticket-proof-workspace→${task.threadId} lost`));
  assert.deepEqual([halted.runtimeState, halted.runtimeHalt.conditionId, halted.runtimeAlive], ["halted", "thread-restart-recovery-unavailable", true]);
  const bootstrap = (await api("api/bootstrap")).body.data;
  assert.deepEqual([bootstrap.runtime.state, bootstrap.stop.code, bootstrap.stop.conditionId, bootstrap.threads], ["halted", "stop-condition-violated", "thread-restart-recovery-unavailable", []]);
  assert.equal(bootstrap.runtime.conditions.find((entry) => entry.id === "thread-restart-recovery-unavailable").status, "violated");
  for (const payload of [{ action: "newThread" }, { action: "readThread", threadId: chat.id }, { action: "startTaskTurn", ticketId: "ticket-proof-workspace", threadId: task.threadId, message: "go" }]) {
    const refused = await action(payload);
    assert.equal(refused.status, 409, payload.action);
    assert.equal(refused.body.error.code, "runtime_halted");
    assert.equal(refused.body.error.conditionId, "thread-restart-recovery-unavailable");
  }
  const workspace = await action({ action: "readTask", ticketId: "ticket-proof-workspace" });
  assert.equal(workspace.status, 200, "the checked-in Task contract is still readable; only the runtime is halted");
  assert.equal((await fixturePids(lifecycle.pidPath)).length, 2, "exactly one respawn happened before the halt");
  const shutdown = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await shutdown, [0, null]);
});

test("restart exhaustion halts instead of looping", async (context) => {
  const { folder } = await temporaryRepository(context);
  const lifecycle = await lifecycleTemp(context);
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: lifecycle.env({ CODEX_FIXTURE_MAX_STARTS: "1", VIBEHUB_CODEX_RESTART_BACKOFF_MS: "40,40,40" }) });
  if (!shell) return;
  const { child, api, action } = shell;
  const [firstPid] = await fixturePids(lifecycle.pidPath);
  process.kill(firstPid, "SIGKILL");
  const halted = await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "runtimeHalted"));
  const kinds = hostEvents(halted).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "runtimeRestartFailed").length, 3, "every backoff step was tried");
  assert.equal(kinds.at(-1), "runtimeHalted");
  const halt = halted.events.find((event) => event.kind === "runtimeHalted").value;
  assert.equal(halt.conditionId, "thread-restart-recovery-unavailable");
  assert.match(halt.detail, /could not be restarted after 3 attempts/);
  assert.deepEqual([halted.runtimeState, halted.runtimeAlive], ["halted", false]);
  const refused = await action({ action: "newThread" });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "runtime_halted"]);
  assert.equal((await fixturePids(lifecycle.pidPath)).length, 1, "the fixture refused every further start");
  const shutdown = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await shutdown, [0, null]);
});

test("an unreadable managed auth status halts reuse at boot", async (context) => {
  const { folder } = await temporaryRepository(context);
  const lifecycle = await lifecycleTemp(context);
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: lifecycle.env({ CODEX_FIXTURE_AUTH: "unavailable" }) });
  if (!shell) return;
  const { child, envelope, api, action } = shell;
  assert.deepEqual([envelope.runtime.state, envelope.runtime.halt.conditionId, envelope.runtime.halt.code], ["halted", "managed-auth-status-unavailable", "stop-condition-violated"]);
  assert.match(envelope.runtime.halt.detail, /account\/read did not answer: account status unavailable \(fixture\)/);
  const bootstrap = (await api("api/bootstrap")).body.data;
  assert.deepEqual([bootstrap.stop.conditionId, bootstrap.account.authenticated, bootstrap.threads], ["managed-auth-status-unavailable", false, []]);
  const refused = await action({ action: "newThread" });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.conditionId], [409, "runtime_halted", "managed-auth-status-unavailable"]);
  const shutdown = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await shutdown, [0, null]);
});

test("a pinned request the runtime does not know halts reuse at the first -32601", async (context) => {
  const { folder } = await temporaryRepository(context);
  const lifecycle = await lifecycleTemp(context);
  const shell = await launchShell(context, { codex: fixtureAppServer, repo: folder, env: lifecycle.env({ CODEX_FIXTURE_DROP_METHODS: "turn/steer" }) });
  if (!shell) return;
  const { child, envelope, api, action } = shell;
  assert.equal(envelope.runtime.state, "alive", "the drop is invisible until the pinned request is used");
  const chat = (await action({ action: "newThread" })).body.data.thread;
  const turn = (await action({ action: "startTurn", threadId: chat.id, input: [{ type: "text", text: "hello" }] })).body.data.turn;
  const steered = await action({ action: "steerTurn", threadId: chat.id, expectedTurnId: turn.id, input: [{ type: "text", text: "steer" }] });
  assert.deepEqual([steered.status, steered.body.error.code, steered.body.error.conditionId], [409, "runtime_halted", "required-request-or-event-missing"], "the failing call itself reports the halt, not a bare 500");
  assert.match(steered.body.error.detail, /rejected pinned request turn\/steer as unknown \(-32601\)/);
  const events = (await api("api/events?after=0")).body.data;
  assert.deepEqual([events.runtimeState, events.runtimeHalt.conditionId, events.runtimeAlive], ["halted", "required-request-or-event-missing", true]);
  assert.ok(events.events.some((event) => event.kind === "runtimeHalted"));
  const refused = await action({ action: "newThread" });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "runtime_halted"]);
  const bootstrap = (await api("api/bootstrap")).body.data;
  assert.deepEqual([bootstrap.stop.code, bootstrap.stop.conditionId, bootstrap.threads], ["stop-condition-violated", "required-request-or-event-missing", []]);
  const shutdown = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await shutdown, [0, null]);
});

test("lifecycle recovery keeps Codex as the only transcript store and the explicit import as the only repository write", async () => {
  const [host, script, model, guard, windowSource, client, stopConditions, fixtureSource, lockText] = await Promise.all([
    source("scripts/vh-codex-first-shell.mjs"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/chat-model.mjs"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
    source("apps/codex-first-shell/event-window.mjs"),
    source("packages/codex-adapter/client.mjs"),
    source("packages/codex-adapter/stop-conditions.mjs"),
    source("test/fixtures/codex-app-server-fixture.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
  ]);
  const lock = JSON.parse(lockText);
  // No browser store, no host database, no second transcript anywhere on the
  // recovery path; the fixture's persistence stands in for Codex rollouts
  // and lives in the test double only.
  assert.doesNotMatch(host + script + model + guard + windowSource + client + stopConditions, /localStorage|sessionStorage|indexedDB|sqlite|better-sqlite|openDatabase|caches\.open|leveldb|levelup/i);
  assert.doesNotMatch(host, /writeFile|appendFile|createWriteStream|mkdir\(|renameSync|rmSync|unlink/);
  assert.deepEqual([...host.matchAll(/writeDocument\((.*)\);/g)].map((match) => match[1]), ["join(repoRoot, BINDING_FILE), document"], "the binding record is the only document the host writes");
  assert.equal([...host.matchAll(/initProject\(/g)].length, 1, "the scaffold is written once, by the explicit import");
  const explicit = host.match(/explicitImportOnly: Object\.freeze\(\[([^\]]+)\]\)/)[1].match(/"[^"]+"/g).map((entry) => JSON.parse(entry));
  assert.deepEqual(explicit, REPOSITORY_WRITES.explicitImportOnly, "the declared write list is exactly package D's explicit import");
  assert.match(fixtureSource, /CODEX_FIXTURE_STATE/, "persistence across a kill is the fixture standing in for Codex, never the host");
  assert.doesNotMatch(host, /CODEX_FIXTURE/);
  // The restart path is host plus adapter client: the shared harness shell
  // stays booted (router close is permanent) and only the process respawns.
  const restartSource = host.slice(host.indexOf("async function restartRuntime"), host.indexOf("async function readAccount"));
  assert.match(restartSource, /client\.start\(\)/);
  assert.match(restartSource, /recoverKnownThreads\(\)/);
  assert.match(restartSource, /gateRuntime\(\)/);
  assert.match(restartSource, /appendEvent\("runtimeRestarted"/);
  assert.doesNotMatch(restartSource, /harness\.close|harness\.boot/);
  assert.match(host, /const RESTART_BACKOFF_MS = Object\.freeze\(parseBackoff\(process\.env\.VIBEHUB_CODEX_RESTART_BACKOFF_MS, \[500, 2000, 5000\]\)\)/);
  assert.match(host, /resolution: "runtime_exited"/);
  assert.match(host, /request\.runtimeGeneration !== runtime\.generation/, "a request from an exited generation can never be answered");
  assert.match(client, /this\.generation = generation;/);
  assert.match(client, /emit\("methodMissing"/);
  // Every pinned stop condition is evaluated by the adapter module and the
  // host halts on the first violation with one visible 409.
  for (const id of lock.stopConditions) assert.ok(stopConditions.includes(`"${id}"`), `${id} is evaluated`);
  assert.match(stopConditions, /export function firstViolation/);
  for (const seam of ["firstViolation(", "haltRuntime(", "gateRuntime()", "\"runtime_halted\"", "\"runtime_restarting\"", "appendEvent(\"runtimeHalted\"", "probeCodexSchema({ codex: flags.codex })", "state: runtime.state,"]) assert.ok(host.includes(seam), seam);
  assert.match(host, /if \(!ADAPTER_FREE_ACTIONS\.has\(payload\.action\)\) requireRuntime\(\);/);
  assert.match(host, /const ADAPTER_FREE_ACTIONS = new Set\(\["readTask"\]\);/);
  assert.match(windowSource, /runtimeState: runtime\.state/);
  assert.match(windowSource, /runtimeHalt: runtime\.halt/);
  // Browser: liveness comes from thread/read alone; a runtime exit drops the
  // running posture, a restart re-reads, a halt raises the persistent stop,
  // and nothing claims to reconnect on its own.
  assert.doesNotMatch(script, /Runtime reconnecting/);
  for (const seam of ["function markRuntimeExited", "function applyRuntimeHalt", "entry.kind === \"runtimeRestarted\"", "entry.kind === \"runtimeHalted\"", "data.runtimeHalt", "state: \"unreachable\"", "banner.dataset.conditionId", "status !== \"runtimeExited\"", "state.running && item._turnId === state.currentTurnId"]) assert.ok(script.includes(seam), seam);
  assert.match(script, /const runtimeActive = state\.runtimeAlive && !state\.bootstrap\?\.stop &&/, "the sidebar presence dot needs a live runtime");
  assert.match(model, /method === "runtime\/exited"/);
  assert.match(model, /status: "runtimeExited"/);
  assert.match(script, /Runtime exited during this Turn/);
  for (const name of ["runtime exit clears the running posture and marks the dead Turn", "runtime halt raises a persistent stop that names the condition and disables adapter actions", "restoring the runtime posture withdraws the stop"]) assert.match(guard, new RegExp(`check\\(results, "${name}"`), name);
  // Reload recovery: the URL names the Thread and Task; both land through the
  // host projections that re-derive identity and linkage from Codex.
  assert.match(script, /const requestedThreadId = params\.get\("thread"\)/);
  assert.match(script, /const requestedTicketId = params\.get\("task"\)/);
  assert.match(host, /function taskLinkFromThread\(thread\)/);
  assert.match(host, /VibeHub Task · \(ticket-\[a-z0-9-\]\+\)/);
  assert.doesNotMatch(host, /createFileAssociationStore|createMemoryAssociationStore/, "linkage is re-derived from the Codex Thread name; no association store shadows it");
});
