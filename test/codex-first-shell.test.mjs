import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { capabilitySnapshot } from "../packages/harness-core/capabilities.mjs";
import { probeDomainIsolation } from "../packages/harness-core/probe-package-isolation.mjs";

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
  const bootstrap = await api("api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(bootstrap.body.data.stop, {
    code: "runtime-baseline-mismatch",
    message: `Codex app-server 0.144.1 is running but VibeHub pins ${envelope.runtime.baselineVersion}. The shell stops here instead of reusing an unverified runtime.`,
    observedVersion: "0.144.1",
    baselineVersion: envelope.runtime.baselineVersion,
  });
  assert.deepEqual([bootstrap.body.data.projects, bootstrap.body.data.recents, bootstrap.body.data.threads], [[], [], []]);
  assert.equal(bootstrap.body.data.project.scope, "unbound");
  const refused = await action({ action: "newThread" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "runtime_baseline_mismatch");
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exit, [0, null]);
});
