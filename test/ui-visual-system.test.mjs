import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(process.cwd(), "skills/vibehub-ticket-review/assets");
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "app.css"), "utf8");
const script = readFileSync(join(root, "app.js"), "utf8");

test("production Workbench uses the selected global visual language", () => {
  assert.match(css, /--ui:\s*ui-monospace/u);
  assert.match(css, /--mono:\s*ui-monospace/u);
  assert.match(html, /class="icon-sprite"/u);
  for (const id of [
    "check", "play", "lock", "sliders", "alert", "archive",
    "upcoming", "pending", "recorded", "complete",
  ]) assert.match(html, new RegExp(`id="icon-${id}"`, "u"));
  assert.equal(/[☝○●✓✦⚠🔒▶◉◌▣≡⎇□⌗↗]/u.test(html), false);
});

test("production graph keeps operational, archive, and attention treatments independent", () => {
  for (const state of ["done", "ready", "blocked", "refine", "deviated"]) {
    assert.match(css, new RegExp(`\\.ticket-node\\.state-${state} \\.ticket-boundary \\{ fill:`, "u"));
  }
  assert.match(css, /\.ticket-node\.archived \.ticket-boundary \{ fill:/u);
  assert.match(css, /\.ticket-node\.archived \.ticket-boundary[\s\S]*stroke-dasharray/u);
  for (const attention of ["upcoming", "pending", "recorded", "complete"]) {
    assert.match(css, new RegExp(`\\.ticket-node\\.attention-${attention} \\.ticket-attention-badge`, "u"));
  }
  assert.match(script, /STATE_ICON_IDS/u);
  assert.match(script, /ATTENTION_ICON_IDS/u);
  assert.match(script, /ticket-state-icon/u);
  assert.match(script, /ticket-attention-badge/u);
  assert.match(css, /\.ticket-node\.next-close-out \.ticket-boundary/u);
});

test("archived history stubs remain legible, anchored, and keyboard explicit", () => {
  assert.match(script, /graphLayoutModel\.historyStubGeometry/u);
  assert.match(script, /class: "history-stub-link"/u);
  assert.match(script, /class: "history-stub-label"/u);
  assert.match(script, /class: "history-stub-action"/u);
  assert.match(script, /reveal next hop: \$\{nextTicketLabel\}/u);
  assert.match(script, /querySelector\(`\[data-ticket-id="\$\{CSS\.escape\(revealedTicket\)\}"\]`\)[\s\S]*\.focus\(\)/u);
  assert.match(css, /\.history-stub-boundary \{[\s\S]*fill: var\(--surface-solid\);/u);
  assert.match(css, /\.history-stub-label \{[\s\S]*fill: var\(--ink\);[\s\S]*font: 650 10px/u);
  assert.match(css, /\.history-stub:focus-visible \.history-stub-boundary \{[\s\S]*stroke: var\(--focus\);/u);
  assert.match(css, /\.history-stub-link \{[\s\S]*stroke-dasharray/u);
});

test("production canvas counts and Overview are compact two-axis legends", () => {
  assert.match(html, /Ticket state and human attention summary/u);
  assert.match(html, /aria-label="Ticket state legend"/u);
  assert.match(html, /aria-label="Human attention legend"/u);
  assert.match(script, /renderGraphSummary/u);
  assert.match(
    script,
    /add\(counts\.DONE, "DONE", "check", "state-done"\);[\s\S]*add\(overview\.ready\.length, "READY"[\s\S]*add\(overview\.closeout\.length, "CLOSE OUT"/u,
  );
  assert.match(html, /id="closeoutQueue"/u);
  assert.match(html, /Independent closeout/u);
  assert.match(script, /"NEEDS YOU"/u);
  for (const banned of [
    "Execution flow",
    "Proven left, executable right",
    "Proven upstream, executable downstream",
    "Owner decision follows this proposal",
    "No Active Run proven",
  ]) assert.equal(html.includes(banned), false);
});

test("production narrow Inspector remains a bottom sheet over the graph", () => {
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.workspace \.inspector \{[\s\S]*top: auto;[\s\S]*bottom: 0;[\s\S]*height: min\(62%, 620px\)/u);
  assert.match(css, /\.workspace \.inspector\.open \{\s*transform: none;/u);
  assert.match(css, /\.workspace\.inspector-closed \.inspector \{[\s\S]*translateY\(100%\)/u);
  assert.match(css, /\.graph-tools button \{[\s\S]*min-width: 44px;[\s\S]*min-height: 44px/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("canvas panning cannot capture nested Workbench controls", () => {
  assert.match(
    script,
    /event\.target\.closest\([\s\S]*"button, a, input, textarea, select, summary, \[role='button'\], "[\s\S]*"\[role='treeitem'\], \.ticket-node, \.edge, \.history-stub"/u,
  );
  assert.match(
    css,
    /\.graph-tools button\[aria-pressed="true"\] \{[\s\S]*color: var\(--surface-solid\);[\s\S]*background: var\(--ink\);/u,
  );
});

test("Ticket copy wraps to the real monospace card width", () => {
  assert.match(script, /wrap\(ticket\.outcome, 28, 3\)/u);
  assert.doesNotMatch(script, /wrap\(ticket\.outcome, 34, 3\)/u);
});

test("every shortened Workbench label exposes its full text on hover and focus", () => {
  assert.match(html, /id="textTooltip" role="tooltip" hidden/u);
  assert.match(css, /\.text-tooltip \{[\s\S]*position: fixed;[\s\S]*pointer-events: none;/u);
  assert.match(script, /function textTooltipCandidate\(target\)/u);
  assert.match(script, /candidate\.scrollWidth > candidate\.clientWidth \+ 1/u);
  assert.match(script, /"data-full-text": `\$\{ticket\.ticketId\}\\n\$\{ticket\.outcome\}`/u);
  assert.match(script, /button\.dataset\.fullText = ticketId/u);
  assert.match(script, /document\.addEventListener\("pointerover"/u);
  assert.match(script, /document\.addEventListener\("focusin"/u);
});
