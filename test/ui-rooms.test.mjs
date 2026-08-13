import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildUiSnapshot } from "../skills/scripts/vh-ui.mjs";

const root = process.cwd();
const assets = join(root, "skills/vibehub-ticket-review/assets");
const html = readFileSync(join(assets, "index.html"), "utf8");
const css = readFileSync(join(assets, "app.css"), "utf8");
const script = readFileSync(join(assets, "app.js"), "utf8");

test("production host projects canonical Rooms and consuming Tickets", () => {
  const snapshot = buildUiSnapshot(root).state;
  assert.deepEqual(snapshot.rooms.rooms.map((room) => room.room), [
    "knowledge", "product", "ticket-lifecycle", "workbench",
  ]);
  const workbench = snapshot.rooms.rooms.find((room) => room.room === "workbench");
  assert.equal(workbench.boundary.includes("read-only local graph workbench"), true);
  assert.equal(workbench.anchors.includes("skills/vibehub-ticket-review/"), true);
  assert.equal(workbench.contexts.every((item) => item.path.startsWith(".vibehub/rooms/workbench/")), true);
  assert.equal(workbench.consumingTickets.includes("ticket-rooms-into-workbench"), true);
  assert.match(workbench.drift.state, /^(?:FRESH|DRIFTED|WARNING|STALE|COLD_START)$/u);
});

test("production Rooms surface is on demand, minimal, and responsive", () => {
  assert.match(html, /id="roomsButton"[^>]*aria-label="Rooms"[^>]*aria-expanded="false"/u);
  assert.match(html, /id="roomsPanel"[^>]*hidden inert/u);
  assert.match(html, /role="tree" aria-label="Canonical Room tree"/u);
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
});

test("Room filter reuses URL query and preserves the causal layout snapshot", () => {
  assert.match(script, /url\.searchParams\.append\("room", selectedRoom\)/u);
  assert.match(script, /roomFilterSnapshot = \{[\s\S]*positions: new Map\(positions\),[\s\S]*panX,[\s\S]*panY,[\s\S]*scale,[\s\S]*selected/u);
  assert.match(script, /refresh\(`Showing \$\{selectedRoom\} Tickets`, \{ preserveLayout: true \}\)/u);
  assert.match(script, /positions = new Map\(snapshot\.positions\)/u);
  assert.match(script, /if \(!snapshot\) url\.searchParams\.delete\("room"\)/u);
  assert.match(script, /roomFilterStatus\.addEventListener\("click", \(event\) => event\.stopPropagation\(\)\)/u);
  assert.match(script, /requestAnimationFrame\(preserveLayout \? applyTransform : frameGraph\)/u);
  assert.match(script, /await refresh\("Room filter cleared", \{ preserveLayout: true \}\)/u);
  assert.doesNotMatch(script, /localStorage|sessionStorage|\/api\/(?:room|write)/u);
});
