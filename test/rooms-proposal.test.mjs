import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(process.cwd(), "docs/proposals/rooms-workbench");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "rooms.css"), "utf8");
const script = readFileSync(join(root, "rooms.js"), "utf8");
const contract = JSON.parse(readFileSync(join(root, "contract.json"), "utf8"));

test("Rooms proposal uses an on-demand canonical tree rather than permanent navigation", () => {
  assert.equal(contract.surface, "on-demand-floating-room-browser");
  assert.equal(contract.default_open, false);
  assert.match(contract.tree_source, /room\.yaml directory containment/u);
  assert.match(contract.ticket_filter.source, /projectTicketQuery repeated Room union/u);
  assert.match(contract.ticket_filter.layout, /preserve every surviving Ticket x\/y/u);
  assert.equal(html.includes("https://") || html.includes("http://"), false);
});

test("Rooms proposal defines every canonical drift presentation explicitly", () => {
  assert.deepEqual(Object.keys(contract.drift_states), ["FRESH", "DRIFTED", "WARNING", "STALE", "COLD_START"]);
  assert.equal(Object.values(contract.drift_states).every((item) => item.label && item.icon && item.prominence), true);
  assert.match(html, /Canonical Room tree/u);
  assert.match(html, /icon-drift/u);
  assert.match(html, /DRIFTED/u);
  assert.match(html, /icon-check/u);
  assert.match(html, /FRESH/u);
  assert.match(script, /docs\/LOCAL_GRAPH_DESIGN\.md/u);
});

test("Rooms proposal exposes Context, consuming Tickets, drift, filtering, focus, and empty states", () => {
  for (const value of [
    "Context", "Tickets", "Drift", "Show related Tickets",
    "Select a Room", "Room filter", "workbench", "product", "knowledge", "ticket-lifecycle",
  ]) assert.match(html, new RegExp(value, "u"));
  assert.match(script, /ticket\.classList\.toggle\("receded"/u);
  assert.equal(script.includes("style.setProperty") || script.includes("--x ="), false);
});

test("Rooms proposal keeps quiet desktop and accessible narrow surfaces", () => {
  assert.equal(contract.responsive.minimum_target, 44);
  assert.match(css, /@media\(max-width:700px\)/u);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/u);
  assert.match(css, /\[hidden\]\{display:none!important\}/u);
  assert.match(css, /\.rooms-panel\[hidden\]\{display:none\}/u);
  assert.match(css, /min-width:44px;height:44px/u);
  assert.match(css, /\.filter-status button\{min-width:44px;min-height:44px\}/u);
  assert.match(css, /--ui:ui-monospace/u);
  assert.match(css, /\.show-tickets\{height:44px/u);
  assert.match(html, /#icon-filter/u);
  assert.match(script, /roomsButton\.setAttribute\("aria-expanded", String\(open\)\)/u);
  assert.equal(html.includes("Knowledge spaces"), false);
  assert.equal(html.includes("Selected Room"), false);
  assert.equal(html.includes("Execution flow"), false);
  assert.equal(html.includes("Proven left, executable right"), false);
  assert.equal(html.includes("Room selection never moves Ticket cards"), false);
  assert.equal(html.includes("Uses canonical Room query · preserves x/y"), false);
  assert.equal(html.includes("Preview no-selection state"), false);
  assert.match(script, /selected === item\.dataset\.room/u);
  for (const symbol of ["✓", "▶", "▣", "≡", "⎇", "□", "⌗", "↗"]) {
    assert.equal(html.includes(symbol) || script.includes(symbol), false);
  }
  assert.match(html, /class="icon-sprite"/u);
});
