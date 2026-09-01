import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildUiSnapshot, parseUiFlags, startVibeHubUi } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { room, run, tempRepo, writeRoom } from "./helpers.mjs";

const root = process.cwd();
const assets = join(root, "skills/vibehub-review/assets");
const html = readFileSync(join(assets, "index.html"), "utf8");
const css = readFileSync(join(assets, "app.css"), "utf8");
const script = readFileSync(join(assets, "app.js"), "utf8");

test("production host projects canonical Rooms and consuming Tickets", () => {
  const snapshot = buildUiSnapshot(root).state;
  assert.deepEqual(snapshot.rooms.rooms.map((room) => room.room), [
    "knowledge", "marketing", "marketing/video", "product", "ticket-lifecycle", "workbench",
  ]);
  const workbench = snapshot.rooms.rooms.find((room) => room.room === "workbench");
  assert.equal(workbench.boundary.includes("read-only local graph workbench"), true);
  // A Room anchor is a live pointer, not a record: drift is computed from it
  // against the working tree right now, so it tracks the rename. Only a closed
  // Ticket's context_refs stay pinned to the layout they were read at.
  assert.equal(workbench.anchors.includes("skills/vibehub-review/"), true);
  assert.equal(workbench.contexts.every((item) => item.path.startsWith(".vibehub/rooms/workbench/")), true);
  assert.equal(workbench.consumingTickets.includes("ticket-rooms-into-workbench"), true);
  assert.match(workbench.drift.state, /^(?:FRESH|DRIFTED|WARNING|STALE|COLD_START)$/u);
});

test("every canonical drift state has its exact production presentation", () => {
  for (const [state, label, icon] of [
    ["FRESH", "FRESH", "check"],
    ["DRIFTED", "DRIFTED", "drift"],
    ["WARNING", "OLD CHECKOUT", "history"],
    ["STALE", "STALE", "alert-circle"],
    ["COLD_START", "ROOMS NOT INITIALIZED", "snowflake"],
  ]) {
    assert.match(script, new RegExp(`${state}: \\{ label: "${label}", icon: "${icon}" \\}`, "u"));
    assert.match(html, new RegExp(`id="icon-${icon}"`, "u"));
  }
  assert.match(script, /coldStart \? presentation\.label : "Select a Room"/u);
  assert.match(script, /rows\.push\(\[presentation\.label, drift\.reason\]\)/u);
  assert.match(script, /\[\[presentation\.label, "Room alignment needs attention"\]\]/u);
});

test("production Rooms surface is on demand, minimal, and responsive", () => {
  assert.match(html, /id="roomsButton"[^>]*aria-label="Rooms"[^>]*aria-expanded="false"/u);
  assert.match(html, /id="roomsPanel"[^>]*hidden inert/u);
  assert.match(html, /role="tree" aria-label="Canonical Room tree"/u);
  assert.match(script, /setAttribute\("aria-level", String\(room\.room\.split\("\/"\)\.length\)\)/u);
  assert.match(html, /data-room-view="context"/u);
  assert.match(html, /data-room-view="tickets"/u);
  assert.match(html, /data-room-view="drift"/u);
  assert.match(html, />Show related Tickets</u);
  for (const banned of ["Knowledge spaces", "Selected Room", "Execution flow", "Proven left"]) {
    assert.equal(html.includes(banned), false);
  }
  assert.match(css, /\.rooms-panel \{[\s\S]*position:absolute/u);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.rooms-panel \{[\s\S]*top:auto;[\s\S]*bottom:0;[\s\S]*height:66%/u);
  assert.match(css, /\.room-filter-status button \{ min-width:44px; min-height:44px;/u);
  assert.match(css, /\.causal-ticket \{\s*min-height: 44px;/u);
});

test("Room filter reuses URL query and preserves the causal layout snapshot", () => {
  assert.match(script, /url\.searchParams\.append\("room", selectedRoom\)/u);
  assert.match(script, /roomFilterSnapshot = \{[\s\S]*positions: new Map\(positions\),[\s\S]*panX,[\s\S]*panY,[\s\S]*scale,[\s\S]*selected/u);
  assert.match(script, /refresh\(`Showing \$\{selectedRoom\} Tickets`, \{ preserveLayout: true \}\)/u);
  assert.match(script, /positions = new Map\(snapshot\.positions\)/u);
  assert.match(script, /if \(!snapshot\) url\.searchParams\.delete\("room"\)/u);
  assert.match(script, /roomFilterStatus\.addEventListener\("click", \(event\) => event\.stopPropagation\(\)\)/u);
  assert.match(script, /requestAnimationFrame\(preserveLayout \? applyTransform : frameGraph\)/u);
  assert.match(script, /requestAnimationFrame\(\s*\(\) => requestAnimationFrame\(resolve\)/u);
  assert.match(script, /panX = snapshot\.panX;\s*panY = snapshot\.panY;\s*scale = snapshot\.scale;\s*applyTransform\(\);/u);
  assert.match(script, /await refresh\("Room filter cleared", \{ preserveLayout: true \}\)/u);
  assert.doesNotMatch(script, /localStorage|sessionStorage|\/api\/(?:room|write)/u);
});

const emptyRepos = [];
const emptyHosts = [];

afterEach(async () => {
  await Promise.all(emptyHosts.splice(0).map((host) => host.close()));
  for (const repo of emptyRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function emptyRoomTreeRepo() {
  const repo = tempRepo("ui-rooms-empty");
  emptyRepos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "product", room("product"));
  writeRoom(repo, "product/ux", room("ux"));
  writeRoom(repo, "engineering", room("engineering"));
  return repo;
}

test("a Room tree whose Rooms hold zero Contexts still projects completely", () => {
  const repo = emptyRoomTreeRepo();
  const rooms = buildUiSnapshot(repo).state.rooms;
  assert.deepEqual(rooms.rooms.map((item) => item.room), [
    "engineering", "product", "product/ux",
  ]);
  for (const item of rooms.rooms) {
    assert.equal(item.contexts.length, 0);
    assert.equal(item.consumingTickets.length, 0);
    assert.equal(typeof item.boundary, "string");
    assert.equal(item.boundary.length > 0, true);
    assert.match(item.drift.state, /^(?:FRESH|DRIFTED|WARNING|STALE|COLD_START)$/u);
  }
  const nested = rooms.rooms.find((item) => item.room === "product/ux");
  assert.equal(nested.parent, "product");
  assert.equal(rooms.rooms.find((item) => item.room === "product").parent, null);
});

test("the empty Room detail states the empty shell instead of rendering nothing", () => {
  assert.match(script, /const present = rows\.length \? rows : \[roomEmptyRow\(roomView\)\]/u);
  assert.match(script, /function roomEmptyRow\(view\)/u);
  assert.match(script, /\["No Tickets", "No Ticket consumes this Room subtree yet\."\]/u);
  assert.match(script, /"This Room is an empty shell: its boundary is set and no Context has been written into it yet\."/u);
});

test("the launcher opens focused on the Room tree of a zero-Context repository", async () => {
  const repo = emptyRoomTreeRepo();
  const flags = parseUiFlags(["--repo", repo, "--room", "product/ux", "--no-open", "--json"]);
  assert.deepEqual(
    { rooms: flags.rooms, room: flags.room, ticket: flags.ticket },
    { rooms: true, room: "product/ux", ticket: null },
  );
  const host = startVibeHubUi({ repoRoot: repo, rooms: flags.rooms, room: flags.room });
  emptyHosts.push(host);
  const ready = await host.ready;
  const url = new URL(ready.url);
  assert.equal(url.searchParams.get("surface"), "rooms");
  assert.equal(url.searchParams.get("room-focus"), "product/ux");
  assert.equal(url.hash.length > 1, true);
  assert.deepEqual(ready.focus, { ticket: null, view: null, rooms: true, room: "product/ux" });
  assert.throws(
    () => startVibeHubUi({ repoRoot: repo, room: "product/missing" }),
    /Unknown Room for --room/u,
  );
});

test("the Room tree front end reads its focus from the launcher URL only", () => {
  assert.match(script, /focusQuery\.get\("room-focus"\)/u);
  assert.match(script, /focusQuery\.get\("surface"\) === "rooms"/u);
  assert.match(script, /initialRoomsPending = false;\s*toggleRooms\(true\);/u);
  assert.doesNotMatch(script, /localStorage|sessionStorage/u);
});
