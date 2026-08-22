import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

async function launchShell(context, { codex = null, env = {} } = {}) {
  const args = ["scripts/vh-codex-first-shell.mjs", "--repo", ".", "--port", "0", "--json", ...(codex ? ["--codex", codex] : [])];
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

async function assertHostBoundary({ envelope, url }) {
  assert.equal(envelope.localOnly, true);
  assert.equal(envelope.repositoryWrites, false);
  assert.equal(envelope.codexRuntime, true);
  assert.equal(envelope.shell, "codex-first-shell");
  assert.equal(envelope.harness, "codex");
  assert.equal(url.hostname, "127.0.0.1");
  const health = await fetch(new URL("health", url));
  assert.deepEqual(await health.json(), { ok: true, shell: "codex-first-shell", harness: "codex", localOnly: true, repositoryWrites: false, codexRuntime: true });
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
  for (const label of ["New chat", "Chat", "Tasks", "Rooms", "Projects", "Appearance", "Search", "Task inbox", "Recents"]) assert.match(html, new RegExp(label, "i"));
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
