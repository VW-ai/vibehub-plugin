import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Codex-first shell uses real app-server ownership and additive VibeHub Tasks", async () => {
  const [html, script, server, review] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
    source("docs/CODEX_FIRST_SHELL_PROTOTYPE_REVIEW.md"),
  ]);
  for (const label of ["New chat", "Chat", "Tasks", "Rooms", "Project", "Appearance", "Search", "Task inbox", "Recent chats"]) assert.match(html, new RegExp(label, "i"));
  for (const request of ["thread/list", "thread/read", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt"]) assert.match(server, new RegExp(request.replace("/", "\\/")));
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

test("Search, Task attention, and object semantics are explicit and source-backed", async () => {
  const [html, script, server, research, contractText] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
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
  assert.match(html, /id="inboxPanel"/);
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
  const [script, css, research, review, contractText, fixtureText, lockText] = await Promise.all([
    source("apps/codex-first-shell-prototype/app.js"),
    source("apps/codex-first-shell-prototype/app.css"),
    source("docs/CODEX_NATIVE_CHAT_PARITY_RESEARCH.md"),
    source("docs/proposals/codex-native-chat/README.md"),
    source("docs/proposals/codex-native-chat/chat-ui-contract.json"),
    source("apps/codex-first-shell-prototype/chat-fixtures.json"),
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
  assert.match(script, /slice\(-240\)/);
  assert.match(script, /renderMarkdown/);
  assert.match(script, /memoryCitationMarkup/);
  assert.match(script, /citation\?\.threadIds/);
  assert.match(script, /turnBoundary/);
  assert.match(script, /turn\.status === "interrupted"/);
  assert.match(script, /noreferrer noopener/);
  assert.match(script, /Unsupported item/);
  assert.match(css, /\.activity-card/);
  assert.match(css, /\.activity-group/);
  assert.match(css, /\.code-block/);
  assert.match(css, /\.turn-error/);
  assert.match(css, /\.source-citations/);
  assert.match(css, /\.turn-boundary/);
  const fixtureTypes = fixture.thread.turns.flatMap((turn) => turn.items.map((item) => item.type));
  for (const type of ["userMessage", "agentMessage", "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall", "subAgentActivity", "turnError", "contextCompaction"]) assert.ok(fixtureTypes.includes(type));
  const citedMessage = fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "agentMessage" && item.memoryCitation);
  assert.ok(citedMessage?.memoryCitation.entries.length);
  assert.ok(citedMessage?.memoryCitation.threadIds.length);
  assert.ok(fixture.thread.turns.some((turn) => turn.status === "interrupted"));
  for (const term of ["Model and mode posture", "Microphone posture", "Shortcuts", "Focus and accessibility", "Memory citations"]) assert.match(research, new RegExp(term));
  assert.equal(fixture.pendingRequests[0].fixture, true);
});

test("Codex-first shell exposes ordinary audio honestly and routes real approvals", async () => {
  const [html, script, server, lock] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
  ]);
  assert.match(html, /Record voice input/);
  assert.match(script, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(script, /MediaRecorder/);
  assert.match(script, /ordinary Codex audio input/);
  assert.match(server, /audioInput: true/);
  assert.match(server, /realtimeConversation: false/);
  assert.match(lock, /"stableTurnInputs": \["audio", "localAudio"\]/);
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) assert.match(server, new RegExp(`"${decision}"`));
  assert.match(server, /item\/tool\/requestUserInput/);
  assert.match(script, /data-request-decision/);
});

test("Task Workspace reuses native Chat and keeps Context packet assembly host-owned", async () => {
  const [html, script, css, server, module, research, contractText, fixtureText] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("apps/codex-first-shell-prototype/app.css"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
    source("packages/codex-adapter/task-context.mjs"),
    source("docs/CODEX_TASK_WORKSPACE_RESEARCH.md"),
    source("docs/proposals/codex-task-workspace/task-workspace-contract.json"),
    source("apps/codex-first-shell-prototype/task-fixtures.json"),
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
  const [html, css, script] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.css"),
    source("apps/codex-first-shell-prototype/app.js"),
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
  assert.match(css, /body\[data-review-frame="narrow"\] \{[^}]*width: 390px; height: 844px/);
  assert.match(css, /body\[data-review-frame="narrow"\] \.search-dialog/);
  assert.match(css, /body\[data-review-frame="narrow"\] \.inbox-panel/);
  assert.doesNotMatch(css, /\.task-card::before/);
  assert.match(script, /requestAnimationFrame\(renderGraphEdges\)/);
  assert.match(html, /aria-label="Application navigation"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /meta name="color-scheme"/);
});

test("Codex-first prototype host is loopback-only, bounded, and connected to the real runtime", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-codex-first-shell-prototype.mjs", "--repo", ".", "--port", "0", "--json"], {
    cwd: new URL(".", root),
    stdio: ["ignore", "pipe", "pipe"],
  });
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
    return;
  }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  assert.equal(envelope.localOnly, true);
  assert.equal(envelope.repositoryWrites, false);
  assert.equal(envelope.codexRuntime, true);
  const url = new URL(envelope.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const health = await fetch(new URL("health", url));
  assert.deepEqual(await health.json(), { ok: true, prototype: "codex-first-shell", localOnly: true, repositoryWrites: false, codexRuntime: true });
  const unauthorized = await fetch(new URL("api/bootstrap", url));
  assert.equal(unauthorized.status, 401);
  const bootstrap = await fetch(new URL("api/bootstrap", url), { headers: { authorization: `Bearer ${token}` } });
  const payload = await bootstrap.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.account.authenticated, true);
  assert.equal(payload.data.runtime.provider, "Codex app-server");
  assert.equal(payload.data.runtime.realtimeConversation, false);
  assert.ok(payload.data.contexts.some((context) => context.contextId === "decision-chat-default-search-and-task-attention"));
  assert.equal(payload.data.attention.semantics.running, "presence_only_never_notification");
  assert.ok(Array.isArray(payload.data.attention.needsYou));
  assert.ok(Array.isArray(payload.data.attention.recentCompletions));
  assert.ok(payload.data.graph.tickets.some((ticket) => ticket.ticketId === "ticket-prototype-codex-first-vibehub-shell"));
  const rejected = await fetch(url, { method: "POST" });
  assert.equal(rejected.status, 405);
  const fixtures = await fetch(new URL("chat-fixtures.json", url));
  assert.equal(fixtures.status, 200);
  assert.match(fixtures.headers.get("content-type"), /application\/json/);
  assert.equal((await fixtures.json()).thread.id, "fixture-chat-parity");
  const taskFixtures = await fetch(new URL("task-fixtures.json", url));
  assert.equal(taskFixtures.status, 200);
  assert.equal((await taskFixtures.json()).ticketId, "ticket-review-task-workspace");
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
