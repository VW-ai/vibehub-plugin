// The explicit Chat bridge of the Codex-first shell: Create Task, Attach to
// Task, Remember and Quote into Task on the host side. Every proof runs the
// production launcher over the fixture app-server against a temporary bound
// repository; the only persistence under test is checked-in YAML plus the
// Codex Thread identity the fixture replays.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildTaskContextPacket } from "../packages/codex-adapter/task-context.mjs";
import { buildCandidateTicketHandoff, buildTicketHandoff, buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { VibeHubError, applyTickets, validateTicket } from "../skills/vibehub-core/scripts/vh.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const fixtureAppServer = fileURLToPath(new URL("fixtures/codex-app-server-fixture.mjs", import.meta.url));
const SHA = (text) => crypto.createHash("sha256").update(text).digest("hex");
const CAPTURED_AT = "2026-08-22T18:00:00.000Z";

// The two explicit write classes the host advertises, verbatim.
const REPOSITORY_WRITES = {
  default: false,
  explicitImportOnly: [".vibehub/version.yaml", ".vibehub/rooms/", ".vibehub/tickets/", ".vibehub/evidence/", ".vibehub/outcomes/", ".vibehub/codex-project.yaml"],
  explicitChatBridge: [".vibehub/tickets/<ticket_id>.yaml", ".vibehub/rooms/<room_id>/<context_id>.yaml"],
  commits: false,
};
const BRIDGE_ACTIONS = ["listTaskTargets", "listRooms", "previewCreateTask", "createTask", "attachTask", "remember"];

async function launchShell(context, { repo, env = {} }) {
  const args = ["scripts/vh-codex-first-shell.mjs", "--repo", repo, "--port", "0", "--json", "--codex", fixtureAppServer];
  const child = spawn(process.execPath, args, { cwd: new URL(".", root), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEX_FIXTURE_VERSION: "0.149.0", ...env } });
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
  const bootstrap = async () => (await api("api/bootstrap")).body.data;
  const shutdown = async () => {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    assert.deepEqual(await exit, [0, null]);
  };
  return { child, envelope, url, api, action, bootstrap, shutdown };
}

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Read untrimmed: a tracked change's two-column status starts with a space.
const porcelain = (folder, extra = []) => execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all", ...extra], { cwd: folder, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
const commitCount = (folder) => git(folder, ["rev-list", "--count", "HEAD"]);
const readYaml = (folder, path) => JSON.parse(readFileSync(join(folder, path), "utf8"));

async function temporaryRepository(context, { initGit = true } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "vibehub-bridge-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "README.md"), "# bridge fixture\n");
  if (initGit) {
    git(folder, ["init", "-q", "-b", "main"]);
    git(folder, ["config", "user.email", "fixture@example.com"]);
    git(folder, ["config", "user.name", "Fixture"]);
    git(folder, ["add", "README.md"]);
    git(folder, ["commit", "-q", "-m", "fixture"]);
  }
  return { folder, realFolder: realpathSync.native(folder) };
}

// A bound repository committed as a whole: one Room with a nested Room and an
// active Context, one open firm Ticket, one Ticket closed by a successful
// Outcome. Everything the bridge writes afterwards is visibly uncommitted.
async function bridgeRepository(context) {
  const { folder, realFolder } = await temporaryRepository(context);
  const write = async (path, document) => {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), `${JSON.stringify(document, null, 2)}\n`);
  };
  await write(".vibehub/version.yaml", { format_version: 2, kind: "vibehub_project", schema_version: 1 });
  await write(".vibehub/rooms/product/room.yaml", { schema_version: 1, kind: "room", room_id: "product", description: "Product direction", boundary: "What the shell promises", anchors: ["README.md"], stale: false });
  await write(".vibehub/rooms/product/ux/room.yaml", { schema_version: 1, kind: "room", room_id: "ux", description: "Interaction detail", boundary: "How the shell behaves", anchors: ["README.md"], stale: false });
  await write(".vibehub/rooms/product/decision-bridge-direction.yaml", {
    schema_version: 1, kind: "context", context_id: "decision-bridge-direction", type: "decision", state: "active",
    summary: "Chat stays continuous and births Tasks explicitly", detail: "A Task is born only through an explicit Create Task confirmation.", tags: ["bridge"],
    source: { ref: "conversation:bridge-direction", captured_at: "2026-08-21T10:00:00Z" },
    evidence: [{ ref: "conversation:bridge-direction", note: "Owner decision." }], relations: [],
  });
  await write(".vibehub/tickets/ticket-bridge-open.yaml", {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-bridge-open", maturity: "firm", outcome: "The open Task accepts associations.", deliveries: [],
    context: "Stays open.", acceptance: [{ acceptance_id: "open-holds", criterion: "The open Task holds." }], constraints: ["No second store."],
    context_refs: [{ ref: ".vibehub/rooms/product/decision-bridge-direction.yaml", purpose: "Binding direction." }], relations: [], provenance_refs: ["conversation:bridge-direction"],
  });
  await write(".vibehub/tickets/ticket-bridge-closed.yaml", {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-bridge-closed", maturity: "firm", outcome: "The closed Task is accepted.", deliveries: [],
    context: "Closed.", acceptance: [{ acceptance_id: "closed-holds", criterion: "The closed Task holds." }], constraints: [], context_refs: [], relations: [], provenance_refs: [],
  });
  await write(".vibehub/evidence/ticket-bridge-closed/closed-proof.yaml", { schema_version: 1, kind: "ticket_evidence", evidence_id: "closed-proof", ticket_id: "ticket-bridge-closed", acceptance_ids: ["closed-holds"], summary: "Closed proven.", refs: ["README.md"], origin: "agent", recorded_at: "2026-08-20T11:00:00Z" });
  await write(".vibehub/outcomes/ticket-bridge-closed.yaml", { schema_version: 1, kind: "ticket_outcome", ticket_id: "ticket-bridge-closed", status: "successful", accepted_acceptance_ids: ["closed-holds"], unresolved_acceptance_ids: [], evidence_ids: ["closed-proof"], summary: "Independently accepted.", closed_at: "2026-08-20T12:00:00Z" });
  git(folder, ["add", ".vibehub"]);
  git(folder, ["commit", "-q", "-m", "vibehub bridge graph"]);
  return { folder, realFolder };
}

// One ordinary Chat with one finalized Turn in the fixture, so the origin the
// browser would capture names a Thread and Turn that really exist in Codex.
async function sourceTurn(action) {
  const chat = (await action({ action: "newThread" })).body.data.thread;
  const turn = (await action({ action: "startTurn", threadId: chat.id, input: [{ type: "text", text: "Explain the login flow and propose a fix." }] })).body.data.turn;
  const item = (await action({ action: "readThread", threadId: chat.id })).body.data.thread.turns[0].items[0];
  return { chat, turn, item };
}

function originFor({ chat, turn, item }, overrides = {}) {
  const text = "propose a fix";
  return {
    harness: "codex",
    thread_id: chat.id,
    forked_from_id: chat.forkedFromId ?? null,
    turn_id: turn.id,
    item_id: item.id,
    selection: { start: 26, end: 26 + text.length, text_sha256: SHA(text) },
    captured_at: CAPTURED_AT,
    ...overrides,
  };
}

const createInput = (origin, overrides = {}) => ({
  action: "createTask",
  title: "Fix the login flow",
  outcome: "Login succeeds on the first attempt for every account type.",
  context: "> Explain the login flow and propose a fix.\n\nQuoted from the finalized assistant message.",
  origin,
  ...overrides,
});

// The contexts input the host hands task-context.mjs, rebuilt from the
// canonical Room projection alone.
function canonicalContexts(snapshot) {
  return snapshot.state.rooms.rooms
    .flatMap((room) => room.contexts.filter((item) => item.state === "active").map((item) => {
      const document = snapshot.repository.contexts.documents.get(item.contextId).document;
      return { contextId: item.contextId, type: item.type, summary: item.summary, detail: document.detail, tags: document.tags, room: room.room, sourceRef: document.source.ref, contextRef: item.path, source: "canonical_room_projection" };
    }))
    .sort((left, right) => left.summary.localeCompare(right.summary));
}

async function appServerCalls(logPath) {
  return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function assertWriteClasses({ envelope, url, bootstrap }) {
  assert.deepEqual(envelope.repositoryWrites, REPOSITORY_WRITES, "the launcher envelope advertises both explicit write classes");
  const health = await (await fetch(new URL("health", url))).json();
  assert.deepEqual(health.repositoryWrites, REPOSITORY_WRITES, "/health advertises both explicit write classes");
  assert.deepEqual((await bootstrap()).repositoryWrites, REPOSITORY_WRITES, "bootstrap advertises both explicit write classes");
}

test("graph rows carry Chat associations parsed from origin and codex-thread provenance alone, and the dirty-path projection keeps every tracked change", async (context) => {
  const { folder } = await bridgeRepository(context);
  const origin = { harness: "codex", thread_id: "thr_birth", forked_from_id: null, turn_id: "turn_3", item_id: "item_9", selection: null, captured_at: CAPTURED_AT };
  applyTickets({
    repo: folder,
    tickets: [{
      schema_version: 2, kind: "ticket", ticket_id: "ticket-born", maturity: "draft", outcome: "Born from a Turn.", deliveries: [], context: "Born.",
      acceptance: [{ acceptance_id: "refine-after-creation", criterion: "Refine later." }], constraints: [], context_refs: [], relations: [],
      provenance_refs: ["codex-thread:thr_birth/turn:turn_3", "codex-thread:thr_other/turn:turn_1/item:item_2", "codex-thread:thr_other/turn:turn_1", "conversation:owner", "codex-thread:malformed", "VibeHub Task · ticket-born"],
      origin,
    }],
  });
  const snapshot = buildUiSnapshot(folder);
  const born = snapshot.state.graph.tickets.find((row) => row.ticketId === "ticket-born");
  assert.deepEqual(born.origin, origin);
  assert.deepEqual(born.associations, [
    { kind: "origin", ref: "codex-thread:thr_birth/turn:turn_3", harness: "codex", threadId: "thr_birth", turnId: "turn_3", itemId: "item_9" },
    { kind: "attached", ref: "codex-thread:thr_other/turn:turn_1/item:item_2", harness: "codex", threadId: "thr_other", turnId: "turn_1", itemId: "item_2" },
  ], "origin first, one entry per Thread and Turn, nothing parsed from a Thread name or a free-form reference");
  assert.deepEqual(born.provenanceRefs.length, 6, "provenance_refs stay verbatim beside the parsed associations");
  const open = snapshot.state.graph.tickets.find((row) => row.ticketId === "ticket-bridge-open");
  assert.deepEqual([open.origin, open.associations], [null, []]);
  assert.ok(!snapshot.state.graph.relations.some((relation) => relation.dependentTicketId === "ticket-born"), "an association is never a relation");
  const handoff = buildTicketHandoff(folder, "ticket-born");
  assert.deepEqual(handoff.associations, born.associations, "the handoff carries the same associations for the Workspace");
  // A tracked modification listed first by git keeps its leading dot: the
  // two-column status begins with a space that a trimmed read would eat.
  await writeFile(join(folder, ".vibehub/tickets/ticket-bridge-open.yaml"), `${JSON.stringify({ ...readYaml(folder, ".vibehub/tickets/ticket-bridge-open.yaml"), context: "Stays open, edited." }, null, 2)}\n`);
  assert.deepEqual(porcelain(folder), [" M .vibehub/tickets/ticket-bridge-open.yaml", "?? .vibehub/tickets/ticket-born.yaml"]);
  assert.deepEqual(buildUiSnapshot(folder).state.graph.source.dirtyPaths, [".vibehub/tickets/ticket-bridge-open.yaml", ".vibehub/tickets/ticket-born.yaml"]);
});

test("a candidate Ticket projects exactly as it reads once written uncommitted, without writing", async (context) => {
  const { folder } = await bridgeRepository(context);
  const candidate = {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-candidate", maturity: "draft", outcome: "Candidate outcome.", deliveries: [], context: "Candidate context.",
    acceptance: [{ acceptance_id: "refine-after-creation", criterion: "Refine later." }], constraints: [], context_refs: [], relations: [],
    provenance_refs: ["codex-thread:thr_c/turn:turn_c"],
    // Browser key order on purpose: the projection reads the serialized form.
    origin: { captured_at: CAPTURED_AT, selection: null, item_id: null, turn_id: "turn_c", forked_from_id: null, thread_id: "thr_c", harness: "codex" },
  };
  const before = porcelain(folder);
  const preview = buildCandidateTicketHandoff(folder, candidate);
  assert.deepEqual(porcelain(folder), before, "projecting a candidate writes nothing");
  assert.deepEqual(preview.source.dirtyPaths, [".vibehub/tickets/ticket-candidate.yaml"], "the candidate path counts as dirty, in git's order");
  assert.equal(preview.operationalState, "REFINE");
  assert.equal(preview.nextAction.action, "REFINE");
  applyTickets({ repo: folder, tickets: [candidate] });
  const written = buildTicketHandoff(folder, "ticket-candidate");
  assert.equal(JSON.stringify(preview), JSON.stringify(written), "the candidate handoff is byte-identical to the written Ticket's handoff");
  assert.throws(() => buildCandidateTicketHandoff(folder, { ...candidate, ticket_id: "Bad Id" }), /valid ticket_id/u);
  assert.throws(() => buildCandidateTicketHandoff(folder, { ...candidate, ticket_id: "ticket-dangling", relations: [{ type: "depends_on", target_ticket_id: "ticket-missing" }] }), (error) => error instanceof VibeHubError && error.code === "validation_error");
});

test("every bridge action is unavailable with the missing scope explained while the Project is unbound or outside a repository", async (context) => {
  for (const initGit of [true, false]) {
    const { folder } = await temporaryRepository(context, { initGit });
    const shell = await launchShell(context, { repo: folder });
    if (!shell) return;
    await assertWriteClasses(shell);
    const project = (await shell.bootstrap()).project;
    assert.equal(project.scope, initGit ? "unbound" : "no-repository");
    assert.equal(project.taskActions.available, false);
    for (const name of BRIDGE_ACTIONS) {
      const refused = await shell.action({ action: name, ticketId: "ticket-anything", threadId: "t", turnId: "u", room: "product", title: "x", outcome: "y", context: "z" });
      assert.equal(refused.status, 409, name);
      assert.equal(refused.body.error.code, "scope_unavailable", name);
      assert.equal(refused.body.error.message, project.reason, `${name} explains the missing scope with the Project's own reason`);
    }
    assert.equal(existsSync(join(folder, ".vibehub")), false, "a refused bridge action writes nothing");
    assert.equal((await shell.action({ action: "newThread" })).status, 200, "ordinary Chat stays usable");
    await shell.shutdown();
  }
});

test("Create Task previews without writing, writes exactly one draft Ticket with its immutable origin, and the preview packet is byte-equal to the packet Start sends", async (context) => {
  const { folder, realFolder } = await bridgeRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-bridge-log-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "app-server-calls.jsonl");
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath } });
  if (!shell) return;
  const { action, bootstrap } = shell;
  await assertWriteClasses(shell);
  const turn = await sourceTurn(action);
  const origin = originFor(turn);
  const commits = commitCount(folder);
  assert.deepEqual(porcelain(folder), []);

  // Preview: the derived id, the full draft candidate, no validation errors,
  // the packet, and nothing on disk.
  const preview = await action({ ...createInput(origin), action: "previewCreateTask" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const previewed = preview.body.data;
  assert.equal(previewed.ticketId, "ticket-fix-the-login-flow");
  assert.equal(previewed.path, ".vibehub/tickets/ticket-fix-the-login-flow.yaml");
  assert.deepEqual(previewed.validation, []);
  assert.deepEqual(previewed.candidate, {
    schema_version: 2,
    kind: "ticket",
    ticket_id: "ticket-fix-the-login-flow",
    maturity: "draft",
    outcome: "Login succeeds on the first attempt for every account type.",
    deliveries: [],
    context: "> Explain the login flow and propose a fix.\n\nQuoted from the finalized assistant message.",
    acceptance: [{ acceptance_id: "refine-after-creation", criterion: previewed.candidate.acceptance[0].criterion }],
    constraints: [],
    context_refs: [],
    relations: [],
    provenance_refs: [`codex-thread:${turn.chat.id}/turn:${turn.turn.id}`],
    origin,
  });
  assert.match(previewed.candidate.acceptance[0].criterion, /Acceptance is written at refinement/u);
  assert.deepEqual(validateTicket(previewed.candidate), []);
  assert.equal(previewed.nextAction.action, "REFINE");
  const snapshot = buildUiSnapshot(realFolder);
  const expectedPacket = buildTaskContextPacket({
    handoff: buildCandidateTicketHandoff(realFolder, previewed.candidate),
    project: snapshot.state.project,
    contexts: canonicalContexts(snapshot),
    rooms: snapshot.state.rooms.rooms,
    selectedContextIds: [],
    priorAccepted: [],
    thread: null,
    operation: "start",
    humanMessage: null,
  });
  assert.deepEqual(previewed.packet, expectedPacket, "the preview packet is the adapter's assembly over the candidate");
  assert.equal(previewed.packetText, JSON.stringify(expectedPacket, null, 2));
  assert.deepEqual([previewed.packet.task.ticketId, previewed.packet.task.maturity, previewed.packet.operation, previewed.packet.conversation.humanMessage], ["ticket-fix-the-login-flow", "draft", "start", null]);
  assert.deepEqual(porcelain(folder), [], "a preview writes nothing");
  assert.equal((await action({ ...createInput(origin), action: "previewCreateTask" })).body.data.ticketId, "ticket-fix-the-login-flow", "previewing again derives the same free id");
  const threadStartsBefore = (await appServerCalls(logPath)).filter((call) => call.method === "thread/start").length;

  // Create: exactly one draft Ticket through applyTickets, uncommitted.
  const created = await action(createInput(origin, { ticketId: previewed.ticketId }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.data, { ticketId: "ticket-fix-the-login-flow", path: ".vibehub/tickets/ticket-fix-the-login-flow.yaml", writtenPaths: [".vibehub/tickets/ticket-fix-the-login-flow.yaml"], uncommitted: true });
  const stored = readYaml(folder, ".vibehub/tickets/ticket-fix-the-login-flow.yaml");
  assert.deepEqual(stored, JSON.parse(JSON.stringify(previewed.candidate)), "the written Ticket is the previewed candidate");
  assert.deepEqual(stored.origin, origin, "origin is recorded verbatim from the captured source identity");
  assert.deepEqual(validateTicket(stored), []);
  assert.deepEqual(porcelain(folder), ["?? .vibehub/tickets/ticket-fix-the-login-flow.yaml"], "only the one Ticket path is dirty");
  assert.equal(commitCount(folder), commits, "Create Task never commits");
  const calls = await appServerCalls(logPath);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, threadStartsBefore, "Create Task never creates a Thread");
  assert.equal(calls.filter((call) => call.method === "thread/name/set").length, 0, "Create Task never names a Thread");

  // The Task surfaces as REFINE with its origin and association, and the
  // write shows up as an uncommitted path.
  const after = await bootstrap();
  const row = after.graph.tickets.find((ticket) => ticket.ticketId === "ticket-fix-the-login-flow");
  assert.deepEqual([row.capabilities.operational.summary.label, row.capabilities.nextAction.summary.action], ["REFINE", "REFINE"]);
  assert.deepEqual(row.origin, origin);
  assert.deepEqual(row.associations, [{ kind: "origin", ref: `codex-thread:${turn.chat.id}/turn:${turn.turn.id}`, harness: "codex", threadId: turn.chat.id, turnId: turn.turn.id, itemId: turn.item.id }]);
  assert.ok(after.project.uncommitted.paths.includes(".vibehub/tickets/ticket-fix-the-login-flow.yaml"));
  assert.equal(after.project.uncommitted.committed, false);
  const targets = (await action({ action: "listTaskTargets" })).body.data.tasks;
  assert.deepEqual(targets.map((task) => [task.ticketId, task.maturity, task.status, task.nextAction.action, task.hasOrigin]), [
    ["ticket-bridge-open", "firm", "READY", "EXECUTE", false],
    ["ticket-fix-the-login-flow", "draft", "REFINE", "REFINE", true],
  ], "Attach targets are the Tasks without a successful Outcome");
  assert.deepEqual(targets[1].associations, row.associations);
  const sourceThread = after.threads.find((thread) => thread.id === turn.chat.id);
  assert.equal(sourceThread.taskLink, null, "the source Chat is not turned into a Task Thread");

  // Byte-equality: the Workspace packet and the packet Start sends are the
  // preview's bytes.
  const workspace = (await action({ action: "readTask", ticketId: "ticket-fix-the-login-flow" })).body.data;
  assert.equal(workspace.packetText, previewed.packetText, "readTask serializes the same packet bytes the preview showed");
  assert.deepEqual(workspace.handoff.origin, origin);
  assert.deepEqual(workspace.handoff.associations, row.associations);
  const started = await action({ action: "startTask", ticketId: "ticket-fix-the-login-flow", selectedContextIds: [] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.data.payloadText, previewed.packetText, "Start sends exactly the previewed packet bytes");
  const replayed = (await action({ action: "readThread", threadId: started.body.data.threadId })).body.data.thread;
  assert.equal(replayed.turns[0].items[0].content[0].text, previewed.packetText, "the app-server persists the same bytes");
  assert.equal((await bootstrap()).threads.find((thread) => thread.id === started.body.data.threadId).taskLink.ticketId, "ticket-fix-the-login-flow");

  // A second Task born from the same title: the preview moves to a free id;
  // confirming the stale id is refused instead of landing under another name.
  const again = (await action({ ...createInput(origin), action: "previewCreateTask" })).body.data;
  assert.equal(again.ticketId, "ticket-fix-the-login-flow-2");
  const stale = await action(createInput(origin, { ticketId: "ticket-fix-the-login-flow" }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "ticket_exists");
  assert.deepEqual([stale.body.error.ticketId, stale.body.error.derivedTicketId], ["ticket-fix-the-login-flow", "ticket-fix-the-login-flow-2"]);
  const mismatch = await action(createInput(origin, { ticketId: "ticket-something-else" }));
  assert.deepEqual([mismatch.status, mismatch.body.error.code], [400, "invalid_request"]);
  assert.deepEqual(porcelain(folder), ["?? .vibehub/tickets/ticket-fix-the-login-flow.yaml"], "refusals write nothing");
  const second = await action(createInput(origin, { ticketId: "ticket-fix-the-login-flow-2" }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual((await action({ action: "listTaskTargets" })).body.data.tasks.map((task) => task.ticketId), ["ticket-bridge-open", "ticket-fix-the-login-flow", "ticket-fix-the-login-flow-2"], "one Chat birthing several Tasks lists all of them");

  // Origin is fixed at birth: the same entry point the host uses refuses a
  // hand-edited re-apply of the created Ticket.
  assert.throws(
    () => applyTickets({ repo: folder, tickets: [{ ...stored, origin: { ...origin, turn_id: "turn-edited" } }] }),
    (error) => error instanceof VibeHubError && error.code === "origin_immutable" && error.details.violations[0].ticket_id === "ticket-fix-the-login-flow",
  );
  assert.throws(
    () => applyTickets({ repo: folder, tickets: [{ ...stored, origin: undefined }] }),
    (error) => error instanceof VibeHubError && error.code === "origin_immutable",
  );
  assert.deepEqual(readYaml(folder, ".vibehub/tickets/ticket-fix-the-login-flow.yaml"), stored, "the refused re-apply left the checked-in Ticket untouched");
  assert.equal(commitCount(folder), commits);
  await shell.shutdown();
});

test("a malformed or missing origin is refused with the validator's path and message before anything is written", async (context) => {
  const { folder } = await bridgeRepository(context);
  const shell = await launchShell(context, { repo: folder });
  if (!shell) return;
  const { action } = shell;
  const turn = await sourceTurn(action);
  const cases = [
    [{ selection: { start: 0, end: 4, text_sha256: "deadbeef" } }, "ticket.origin.selection.text_sha256", /64 lowercase hex/u],
    [{ selection: { start: 9, end: 3, text_sha256: SHA("x") } }, "ticket.origin.selection.end", /greater than or equal to start/u],
    [{ harness: "claude" }, "ticket.origin.harness", /must equal codex/u],
    [{ turn_id: "" }, "ticket.origin.turn_id", /non-empty string/u],
    [{ thread_name: "Chat about login" }, "ticket.origin.thread_name", /not allowed/u],
    [{ preview: "derived from the transcript" }, "ticket.origin.preview", /not allowed/u],
    [{ captured_at: "yesterday" }, "ticket.origin.captured_at", /ISO-compatible/u],
  ];
  for (const [override, path, expected] of cases) {
    for (const name of ["previewCreateTask", "createTask"]) {
      const refused = await action(createInput(originFor(turn, override), { action: name }));
      assert.equal(refused.status, 400, `${name} ${path}`);
      assert.equal(refused.body.error.code, "validation_error", `${name} ${path}`);
      assert.match(refused.body.error.message, expected, `${name} ${path}`);
      assert.deepEqual(refused.body.error.errors.map((item) => item.path), [path], `${name} reports exactly the validator's path`);
    }
  }
  for (const payload of [createInput(undefined), { ...createInput(originFor(turn)), origin: "thread/turn" }]) {
    const refused = await action(payload);
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid_request"]);
    assert.match(refused.body.error.message, /origin required/u);
  }
  const slashed = await action(createInput(originFor(turn, { thread_id: "thr/with/slash" })));
  assert.deepEqual([slashed.status, slashed.body.error.code], [400, "invalid_request"]);
  assert.match(slashed.body.error.message, /origin\.thread_id/u);
  for (const missing of ["title", "outcome", "context"]) {
    const refused = await action(createInput(originFor(turn), { [missing]: "   " }));
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid_request"], missing);
    assert.match(refused.body.error.message, new RegExp(missing, "u"));
  }
  // A title with no Latin letters derives a hashed but valid id.
  const hashed = (await action({ ...createInput(originFor(turn), { title: "修复登录流程" }), action: "previewCreateTask" })).body.data;
  assert.match(hashed.ticketId, /^ticket-[0-9a-f]{12}$/u);
  assert.deepEqual(validateTicket(hashed.candidate), []);
  // A missing nullable key is absence; captured_at is stamped by the host when
  // the browser leaves it out.
  const sparse = originFor(turn);
  delete sparse.forked_from_id;
  delete sparse.item_id;
  delete sparse.selection;
  delete sparse.captured_at;
  const filled = (await action({ ...createInput(sparse, { title: "Sparse origin" }), action: "previewCreateTask" })).body.data.candidate.origin;
  assert.deepEqual([filled.forked_from_id, filled.item_id, filled.selection], [null, null, null]);
  assert.ok(!Number.isNaN(Date.parse(filled.captured_at)));
  assert.deepEqual(porcelain(folder), [], "no refusal or preview wrote anything");
  await shell.shutdown();
});

test("Attach to Task appends one provenance reference idempotently, never touches origin, and refuses closed or missing Tasks", async (context) => {
  const { folder } = await bridgeRepository(context);
  const shell = await launchShell(context, { repo: folder });
  if (!shell) return;
  const { action, bootstrap } = shell;
  const turn = await sourceTurn(action);
  const commits = commitCount(folder);
  const openBefore = readYaml(folder, ".vibehub/tickets/ticket-bridge-open.yaml");
  const ref = `codex-thread:${turn.chat.id}/turn:${turn.turn.id}`;

  const attached = await action({ action: "attachTask", ticketId: "ticket-bridge-open", threadId: turn.chat.id, turnId: turn.turn.id });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.deepEqual(attached.body.data, { ticketId: "ticket-bridge-open", provenanceRef: ref, added: true, path: ".vibehub/tickets/ticket-bridge-open.yaml", writtenPaths: [".vibehub/tickets/ticket-bridge-open.yaml"] });
  const openAfter = readYaml(folder, ".vibehub/tickets/ticket-bridge-open.yaml");
  assert.deepEqual(openAfter, { ...openBefore, provenance_refs: [...openBefore.provenance_refs, ref] }, "only provenance_refs grew; origin, deliveries, acceptance and relations are untouched");
  assert.equal(openAfter.origin, undefined, "attaching never adds an origin to a Ticket checked in without one");
  assert.deepEqual(validateTicket(openAfter), []);
  assert.deepEqual(porcelain(folder), [" M .vibehub/tickets/ticket-bridge-open.yaml"]);
  assert.equal(commitCount(folder), commits, "Attach never commits");
  const modified = statSync(join(folder, ".vibehub/tickets/ticket-bridge-open.yaml")).mtimeMs;

  const again = await action({ action: "attachTask", ticketId: "ticket-bridge-open", threadId: turn.chat.id, turnId: turn.turn.id });
  assert.deepEqual(again.body.data, { ticketId: "ticket-bridge-open", provenanceRef: ref, added: false, path: ".vibehub/tickets/ticket-bridge-open.yaml", writtenPaths: [] }, "attaching the same Turn again is idempotent");
  assert.equal(statSync(join(folder, ".vibehub/tickets/ticket-bridge-open.yaml")).mtimeMs, modified, "an idempotent attach does not rewrite the file");
  assert.deepEqual(readYaml(folder, ".vibehub/tickets/ticket-bridge-open.yaml"), openAfter);

  const after = await bootstrap();
  const row = after.graph.tickets.find((ticket) => ticket.ticketId === "ticket-bridge-open");
  assert.deepEqual(row.associations, [{ kind: "attached", ref, harness: "codex", threadId: turn.chat.id, turnId: turn.turn.id, itemId: null }]);
  assert.equal(row.origin, null);
  assert.deepEqual(row.relationCounts, { prerequisites: 0, dependents: 0 }, "an association is never counted as a dependency");
  assert.ok(!after.graph.relations.some((relation) => relation.dependentTicketId === "ticket-bridge-open" || relation.prerequisiteTicketId === "ticket-bridge-open"));
  assert.ok(after.project.uncommitted.paths.includes(".vibehub/tickets/ticket-bridge-open.yaml"));
  assert.equal(after.threads.find((thread) => thread.id === turn.chat.id).taskLink, null, "the source Chat is not linked as a Task Thread");

  const closed = await action({ action: "attachTask", ticketId: "ticket-bridge-closed", threadId: turn.chat.id, turnId: turn.turn.id });
  assert.deepEqual([closed.status, closed.body.error.code], [409, "task_closed"]);
  assert.match(closed.body.error.message, /successful Outcome/u);
  const missing = await action({ action: "attachTask", ticketId: "ticket-never-existed", threadId: turn.chat.id, turnId: turn.turn.id });
  assert.deepEqual([missing.status, missing.body.error.code], [404, "task_not_found"]);
  for (const payload of [{ ticketId: "Not An Id", threadId: "t", turnId: "u" }, { ticketId: "ticket-bridge-open", threadId: "has space", turnId: "u" }, { ticketId: "ticket-bridge-open", threadId: "t", turnId: "a/b" }, { ticketId: "ticket-bridge-open", threadId: "t" }]) {
    const refused = await action({ action: "attachTask", ...payload });
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid_request"], JSON.stringify(payload));
  }
  assert.deepEqual((await action({ action: "listTaskTargets" })).body.data.tasks.map((task) => task.ticketId), ["ticket-bridge-open"], "a closed Task is never offered as an Attach target");

  // Attaching to a Task born with an origin re-applies that origin verbatim:
  // the immutability guard sees the same origin and does not fire.
  const origin = originFor(turn);
  const born = (await action(createInput(origin, { title: "Born then attached" }))).body.data;
  const other = await sourceTurn(action);
  const attachedToBorn = await action({ action: "attachTask", ticketId: born.ticketId, threadId: other.chat.id, turnId: other.turn.id });
  assert.equal(attachedToBorn.status, 200, JSON.stringify(attachedToBorn.body));
  const bornDocument = readYaml(folder, born.path);
  assert.deepEqual(bornDocument.origin, origin, "origin survives the attach untouched");
  assert.deepEqual(bornDocument.provenance_refs, [`codex-thread:${turn.chat.id}/turn:${turn.turn.id}`, `codex-thread:${other.chat.id}/turn:${other.turn.id}`]);
  const bornRow = (await bootstrap()).graph.tickets.find((ticket) => ticket.ticketId === born.ticketId);
  assert.deepEqual(bornRow.associations.map((item) => [item.kind, item.threadId]), [["origin", turn.chat.id], ["attached", other.chat.id]]);
  assert.deepEqual(porcelain(folder).sort(), [" M .vibehub/tickets/ticket-bridge-open.yaml", `?? ${born.path}`]);
  assert.equal(commitCount(folder), commits);
  await shell.shutdown();
});

test("Remember writes one active Context through putContext into an existing Room, never creates a Room, and leaves Git review as the gate", async (context) => {
  const { folder } = await bridgeRepository(context);
  const shell = await launchShell(context, { repo: folder });
  if (!shell) return;
  const { action, bootstrap } = shell;
  const turn = await sourceTurn(action);
  const commits = commitCount(folder);

  const rooms = (await action({ action: "listRooms" })).body.data.rooms;
  assert.deepEqual(rooms, [
    { room: "product", roomId: "product", description: "Product direction", boundary: "What the shell promises", path: ".vibehub/rooms/product", contextCount: 1 },
    { room: "product/ux", roomId: "ux", description: "Interaction detail", boundary: "How the shell behaves", path: ".vibehub/rooms/product/ux", contextCount: 0 },
  ], "only existing Rooms, from the canonical Room projection");

  const input = {
    action: "remember",
    room: "product",
    type: "decision",
    summary: "Login must succeed on the first attempt",
    detail: "The assistant confirmed that every account type must log in on the first attempt; retries hide the defect.",
    tags: ["login", "reliability"],
    source: { threadId: turn.chat.id, turnId: turn.turn.id, itemId: turn.item.id, quote: "every account type must log in on the first attempt" },
    evidenceNote: "The owner accepted this from the finalized assistant message.",
  };
  const remembered = await action(input);
  assert.equal(remembered.status, 200, JSON.stringify(remembered.body));
  const ref = `codex-thread:${turn.chat.id}/turn:${turn.turn.id}/item:${turn.item.id}`;
  assert.deepEqual(remembered.body.data, {
    contextId: "login-must-succeed-on-the-first-attempt",
    room: "product",
    path: ".vibehub/rooms/product/login-must-succeed-on-the-first-attempt.yaml",
    writtenPaths: [".vibehub/rooms/product/login-must-succeed-on-the-first-attempt.yaml"],
    sourceRef: ref,
    uncommitted: true,
  });
  const stored = readYaml(folder, remembered.body.data.path);
  assert.deepEqual({ ...stored, source: { ...stored.source, captured_at: "<now>" } }, {
    schema_version: 1,
    kind: "context",
    context_id: "login-must-succeed-on-the-first-attempt",
    type: "decision",
    state: "active",
    summary: input.summary,
    detail: input.detail,
    tags: ["login", "reliability"],
    source: { ref, quote: input.source.quote, captured_at: "<now>" },
    evidence: [{ ref, note: input.evidenceNote }],
    relations: [],
  });
  assert.ok(!Number.isNaN(Date.parse(stored.source.captured_at)));
  assert.deepEqual(porcelain(folder), ["?? .vibehub/rooms/product/login-must-succeed-on-the-first-attempt.yaml"], "exactly one Context path is dirty");
  assert.equal(commitCount(folder), commits, "Remember never commits: review is the activation gate");
  const after = await bootstrap();
  const projected = after.contexts.find((item) => item.contextId === "login-must-succeed-on-the-first-attempt");
  assert.deepEqual([projected.room, projected.type, projected.sourceRef, projected.contextRef, projected.source], ["product", "decision", ref, ".vibehub/rooms/product/login-must-succeed-on-the-first-attempt.yaml", "canonical_room_projection"]);
  assert.ok(after.project.uncommitted.paths.includes(remembered.body.data.path));

  // Nested Room, no quote, no item, default evidence note; a colliding
  // summary gets a content hash suffix rather than overwriting.
  const nested = await action({ ...input, room: "product/ux", type: "note", source: { threadId: turn.chat.id, turnId: turn.turn.id }, evidenceNote: undefined, tags: undefined });
  assert.equal(nested.status, 200, JSON.stringify(nested.body));
  assert.match(nested.body.data.contextId, /^login-must-succeed-on-the-first-attempt-[0-9a-f]{6}$/u);
  assert.equal(nested.body.data.path, `.vibehub/rooms/product/ux/${nested.body.data.contextId}.yaml`);
  const nestedStored = readYaml(folder, nested.body.data.path);
  assert.deepEqual([nestedStored.type, nestedStored.tags, nestedStored.source.ref, nestedStored.source.quote], ["note", [], `codex-thread:${turn.chat.id}/turn:${turn.turn.id}`, undefined]);
  assert.match(nestedStored.evidence[0].note, new RegExp(`Remembered by the human from Codex Thread ${turn.chat.id}, Turn ${turn.turn.id}`, "u"));
  const longSummary = "An extremely long summary that goes on and on well past the sixty character limit for a derived context id";
  const clamped = await action({ ...input, summary: longSummary });
  assert.equal(clamped.status, 200, JSON.stringify(clamped.body));
  assert.equal(clamped.body.data.contextId, "an-extremely-long-summary-that-goes-on-and-on-well-past-the");
  assert.ok(clamped.body.data.contextId.length <= 60);

  // Refusals: a Room that does not exist is never created; the Context schema
  // enum and source identity are enforced; nothing is written on refusal.
  const before = porcelain(folder);
  const missing = await action({ ...input, room: "product/missing" });
  assert.deepEqual([missing.status, missing.body.error.code], [409, "room_missing"]);
  assert.match(missing.body.error.message, /never creates a Room/u);
  assert.deepEqual(missing.body.error.rooms, ["product", "product/ux"]);
  assert.equal(existsSync(join(folder, ".vibehub/rooms/product/missing")), false);
  for (const [override, expected] of [
    [{ room: "../escape" }, /room must be/u],
    [{ room: "product", type: "insight" }, /type must be one of/u],
    [{ summary: " " }, /summary/u],
    [{ detail: "" }, /detail/u],
    [{ tags: ["ok", ""] }, /tags must be/u],
    [{ source: { turnId: "u" } }, /threadId required/u],
    [{ source: { threadId: "a b", turnId: "u" } }, /threadId must be/u],
    [{ source: null }, /source required/u],
  ]) {
    const refused = await action({ ...input, ...override });
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid_request"], JSON.stringify(override));
    assert.match(refused.body.error.message, expected, JSON.stringify(override));
  }
  assert.deepEqual(porcelain(folder), before, "no refusal wrote anything");
  assert.equal(commitCount(folder), commits);
  await shell.shutdown();
});

test("an explicit Quote into Task reaches the Agent only as the host-built packet's humanMessage, on Start as on a later Turn", async (context) => {
  const { folder, realFolder } = await bridgeRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-bridge-log-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "app-server-calls.jsonl");
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath } });
  if (!shell) return;
  const { action } = shell;
  const quoted = "> Explain the login flow and propose a fix.\n> — Quoted from Codex thread t · turn u · item i\n\nPlease take this into account.";
  const plain = (await action({ action: "readTask", ticketId: "ticket-bridge-open" })).body.data;
  const started = await action({ action: "startTask", ticketId: "ticket-bridge-open", selectedContextIds: [], humanMessage: quoted });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const sent = JSON.parse(started.body.data.payloadText);
  assert.deepEqual(sent.conversation, { ...plain.packet.conversation, humanMessage: quoted, humanMessageTruncated: false, originalHumanMessageChars: quoted.length }, "the quote is placed in conversation.humanMessage and nowhere else");
  assert.deepEqual({ ...sent, conversation: plain.packet.conversation }, plain.packet, "nothing else in the packet moves");
  const snapshot = buildUiSnapshot(realFolder);
  assert.deepEqual(sent, buildTaskContextPacket({
    handoff: buildTicketHandoff(realFolder, "ticket-bridge-open"),
    project: snapshot.state.project,
    contexts: canonicalContexts(snapshot),
    rooms: snapshot.state.rooms.rooms,
    selectedContextIds: [],
    priorAccepted: [],
    thread: null,
    operation: "start",
    humanMessage: quoted,
  }), "Start places humanMessage exactly as the adapter does");
  const turnStart = (await appServerCalls(logPath)).find((call) => call.method === "turn/start" && call.params.threadId === started.body.data.threadId);
  assert.deepEqual(turnStart.params.input, [{ type: "text", text: started.body.data.payloadText }], "the quote reaches the app-server only inside the packet bytes");
  const continued = (await action({ action: "startTaskTurn", ticketId: "ticket-bridge-open", threadId: started.body.data.threadId, message: quoted })).body.data;
  assert.equal(JSON.parse(continued.payloadText).conversation.humanMessage, quoted, "a later Task Turn carries the same placement");
  const withoutMessage = await action({ action: "startTask", ticketId: "ticket-bridge-open", selectedContextIds: [], humanMessage: null });
  assert.equal(JSON.parse(withoutMessage.body.data.payloadText).conversation.humanMessage, null);
  for (const humanMessage of ["", "   ", 7]) {
    const refused = await action({ action: "startTask", ticketId: "ticket-bridge-open", humanMessage });
    assert.deepEqual([refused.status, refused.body.error.code], [400, "invalid_request"], JSON.stringify(humanMessage));
  }
  assert.deepEqual(porcelain(folder), [], "Quote into Task writes nothing into the repository");
  await shell.shutdown();
});

// Restart proofs reuse the fixture's persistence as the stand-in for Codex
// rollouts; the host holds nothing across the restart.
async function lifecycleEnv(context) {
  const temp = await mkdtemp(join(tmpdir(), "vibehub-bridge-lifecycle-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  return {
    logPath: join(temp, "app-server-calls.jsonl"),
    env: (extra = {}) => ({
      CODEX_FIXTURE_STATE: join(temp, "codex-state.json"),
      CODEX_FIXTURE_PIDFILE: join(temp, "codex-pids"),
      CODEX_FIXTURE_LOG: join(temp, "app-server-calls.jsonl"),
      VIBEHUB_CODEX_RESTART_BACKOFF_MS: "300,600,900",
      ...extra,
    }),
  };
}

test("a created Task's origin and an attached association survive a launcher restart over the same Codex state with nothing but checked-in YAML and Thread identity", async (context) => {
  const { folder } = await bridgeRepository(context);
  const lifecycle = await lifecycleEnv(context);
  const first = await launchShell(context, { repo: folder, env: lifecycle.env() });
  if (!first) return;
  const turn = await sourceTurn(first.action);
  const origin = originFor(turn);
  const created = (await first.action(createInput(origin))).body.data;
  const other = await sourceTurn(first.action);
  const attached = (await first.action({ action: "attachTask", ticketId: "ticket-bridge-open", threadId: other.chat.id, turnId: other.turn.id })).body.data;
  assert.equal(attached.added, true);
  const before = await first.bootstrap();
  const projection = (bootstrap) => bootstrap.graph.tickets
    .filter((row) => [created.ticketId, "ticket-bridge-open"].includes(row.ticketId))
    .map((row) => [row.ticketId, row.origin, row.associations, row.capabilities.operational.summary.label]);
  assert.deepEqual(projection(before), [
    ["ticket-bridge-open", null, [{ kind: "attached", ref: attached.provenanceRef, harness: "codex", threadId: other.chat.id, turnId: other.turn.id, itemId: null }], "READY"],
    [created.ticketId, origin, [{ kind: "origin", ref: `codex-thread:${turn.chat.id}/turn:${turn.turn.id}`, harness: "codex", threadId: turn.chat.id, turnId: turn.turn.id, itemId: turn.item.id }], "REFINE"],
  ]);
  const commits = commitCount(folder);
  const dirty = porcelain(folder).sort();
  assert.deepEqual(dirty, [" M .vibehub/tickets/ticket-bridge-open.yaml", `?? ${created.path}`]);
  await first.shutdown();

  const second = await launchShell(context, { repo: folder, env: lifecycle.env() });
  if (!second) return;
  const after = await second.bootstrap();
  assert.deepEqual(projection(after), projection(before), "origin and associations read identically from YAML after the restart");
  assert.deepEqual(after.project.uncommitted.paths.sort(), [".vibehub/tickets/ticket-bridge-open.yaml", created.path].sort());
  assert.equal(after.runtime.generation, 1, "a new launcher is a new process; nothing carries over in memory");
  const threadIds = after.threads.map((thread) => thread.id);
  assert.ok(threadIds.includes(turn.chat.id) && threadIds.includes(other.chat.id), "the associated Threads resolve from Codex again");
  for (const row of after.graph.tickets) {
    for (const association of row.associations) assert.ok(threadIds.includes(association.threadId), `${association.ref} names a Thread Codex still knows`);
  }
  const workspace = (await second.action({ action: "readTask", ticketId: created.ticketId })).body.data;
  assert.deepEqual(workspace.handoff.origin, origin);
  assert.equal(workspace.nextAction.action, "REFINE");
  assert.deepEqual(porcelain(folder).sort(), dirty, "neither launcher wrote anything else");
  assert.equal(commitCount(folder), commits);
  assert.deepEqual(porcelain(folder, ["--ignored"]).sort(), dirty, "no ignored file, store or cache appeared anywhere in the repository");
  await second.shutdown();
});

test("a Start whose Thread naming or first Turn fails leaves the created Ticket valid and its Workspace still derives the next action", async (context) => {
  for (const dropped of ["thread/name/set", "turn/start"]) {
    const { folder } = await bridgeRepository(context);
    const lifecycle = await lifecycleEnv(context);
    const shell = await launchShell(context, { repo: folder, env: lifecycle.env({ CODEX_FIXTURE_DROP_METHODS: dropped }) });
    if (!shell) return;
    const { action, bootstrap } = shell;
    const chat = (await action({ action: "newThread" })).body.data.thread;
    const origin = originFor({ chat, turn: { id: "turn-seen-in-browser" }, item: { id: null } }, { item_id: null, selection: null });
    const created = await action(createInput(origin, { title: `Survives a failed start (${dropped})` }));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const stored = readYaml(folder, created.body.data.path);
    const failed = await action({ action: "startTask", ticketId: created.body.data.ticketId, selectedContextIds: [] });
    assert.equal(failed.status, 409, dropped);
    assert.equal(failed.body.error.code, "runtime_halted", dropped);
    assert.match(failed.body.error.detail, new RegExp(`rejected pinned request ${dropped.replaceAll("/", "\\/")} as unknown`, "u"));
    assert.deepEqual(readYaml(folder, created.body.data.path), stored, "the failed Start did not touch the checked-in Ticket");
    assert.deepEqual(validateTicket(stored), []);
    const workspace = await action({ action: "readTask", ticketId: created.body.data.ticketId });
    assert.equal(workspace.status, 200, dropped);
    assert.deepEqual([workspace.body.data.nextAction.action, workspace.body.data.handoff.origin], ["REFINE", origin]);
    const after = await bootstrap();
    assert.equal(after.runtime.state, "halted");
    assert.equal(after.graph.tickets.find((row) => row.ticketId === created.body.data.ticketId).capabilities.operational.summary.label, "REFINE");
    // The bridge is served from the repository alone, so it stays usable
    // while the runtime is halted; only adapter verbs are refused.
    assert.equal((await action({ action: "listTaskTargets" })).status, 200);
    const refusedChat = await action({ action: "newThread" });
    assert.deepEqual([refusedChat.status, refusedChat.body.error.code], [409, "runtime_halted"]);
    assert.deepEqual(porcelain(folder), [`?? ${created.body.data.path}`]);
    await shell.shutdown();
  }
});

test("the Chat bridge is the second explicit write class and adds no second store", async () => {
  const [host, script, uiHost] = await Promise.all([
    source("scripts/vh-codex-first-shell.mjs"),
    source("apps/codex-first-shell/app.js"),
    source("skills/vibehub-core/scripts/vh-ui.mjs"),
  ]);
  const declared = (name) => host.match(new RegExp(`${name}: Object\\.freeze\\(\\[([^\\]]+)\\]\\)`, "u"))[1].match(/"[^"]+"/g).map((entry) => JSON.parse(entry));
  assert.deepEqual(declared("explicitImportOnly"), REPOSITORY_WRITES.explicitImportOnly);
  assert.deepEqual(declared("explicitChatBridge"), REPOSITORY_WRITES.explicitChatBridge, "the bridge names exactly the Ticket and Context paths it may write");
  assert.match(host, /commits: false,\n\}\);/u);
  assert.equal([...host.matchAll(/repositoryWrites: REPOSITORY_WRITES/g)].length, 3, "advertised in /health, the launcher envelope and bootstrap");
  // Every bridge write goes through vh.mjs's validated entry points; the host
  // itself still writes only the binding record directly.
  assert.deepEqual([...host.matchAll(/writeDocument\((.*)\);/g)].map((match) => match[1]), ["join(repoRoot, BINDING_FILE), document"]);
  assert.equal([...host.matchAll(/applyTickets\(\{ repo: repoRoot, tickets: \[candidate\] \}\)/g)].length, 2, "Create Task and Attach to Task apply one candidate Ticket each");
  assert.equal([...host.matchAll(/putContext\(\{ repo: repoRoot, room, context \}\)/g)].length, 1, "Remember puts one Context");
  assert.doesNotMatch(host, /writeFile|appendFile|createWriteStream|mkdir\(|renameSync|rmSync|unlink/);
  assert.doesNotMatch(host, /loadRepository/);
  // No git from any host action: the only git invocation is the read-only
  // repository root lookup.
  assert.deepEqual([...host.matchAll(/execFileSync\("git", \[([^\]]*)\]/g)].map((match) => match[1]), ['"-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"']);
  assert.doesNotMatch(host, /"add"|"commit"|"push"/);
  assert.doesNotMatch(host + script + uiHost, /localStorage|sessionStorage|indexedDB|sqlite|better-sqlite|openDatabase|caches\.open|leveldb|levelup|AssociationStore/i);
  assert.doesNotMatch(host, /CODEX_FIXTURE/);
  // Source identity is never derived from a Thread name, preview or transcript.
  const bridge = host.slice(host.indexOf("const TEXT_LIMITS"), host.indexOf("function validInputs"));
  assert.doesNotMatch(bridge, /thread\.name|\.preview|taskLinkFromThread|taskLinkFromPreview|thread\/read|client\.request/);
  assert.match(bridge, /const origin = payload\.origin;/);
  assert.match(host, /const ADAPTER_FREE_ACTIONS = new Set\(\["readTask", "listTaskTargets", "listRooms", "previewCreateTask", "createTask", "attachTask", "remember"\]\);/);
  for (const name of BRIDGE_ACTIONS) assert.match(host, new RegExp(`if \\(payload\\.action === "${name}"\\) \\{\\s*requireBoundScope\\(\\);`, "u"), `${name} is gated on the bound scope`);
  // Associations are parsed in the canonical projection, from origin and
  // provenance_refs only, and never become relations.
  assert.match(uiHost, /const CODEX_THREAD_REF = \/\^codex-thread:/u);
  assert.match(uiHost, /associations: chatAssociations\(ticket\),/u);
  assert.doesNotMatch(uiHost.slice(uiHost.indexOf("function chatAssociations"), uiHost.indexOf("function projectRooms")), /relations\.push|depends_on/u);
});
