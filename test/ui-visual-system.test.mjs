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
    "check", "play", "running", "lock", "sliders", "alert", "archive",
    "upcoming", "pending", "recorded", "complete",
  ]) assert.match(html, new RegExp(`id="icon-${id}"`, "u"));
  assert.equal(/[☝○●✓✦⚠🔒▶◉◌▣≡⎇□⌗↗]/u.test(html), false);
});

test("production graph keeps four phases, one substate slot, archive, and live independent", () => {
  for (const phase of ["draft", "ready", "running", "done"]) {
    assert.match(css, new RegExp(`\\.ticket-node\\.phase-${phase} \\.ticket-boundary \\{ fill:`, "u"));
  }
  assert.match(css, /\.ticket-node\.archived \.ticket-boundary \{ fill:/u);
  assert.match(css, /\.ticket-node\.archived \.ticket-boundary[\s\S]*stroke-dasharray/u);
  for (const substate of ["blocked", "needs-you", "deviated", "verifying", "waiting"]) {
    assert.match(css, new RegExp(`\\.ticket-node\\.substate-${substate} \\.ticket-substate-badge`, "u"));
  }
  assert.match(script, /STATE_ICON_IDS/u);
  assert.match(script, /SUBSTATE_ICON_IDS/u);
  assert.match(script, /ticket-state-icon/u);
  assert.match(script, /ticket-substate-badge/u);
  assert.doesNotMatch(script, /class: "ticket-accent"/u);
  assert.match(script, /ticket-live-indicator/u);
  assert.match(css, /@keyframes ticket-live-pulse/u);
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

test("production canvas exposes exactly four primary phases and one compact substate channel", () => {
  assert.match(html, /Ticket phase and attention summary/u);
  assert.match(html, /aria-label="Ticket phase legend"/u);
  assert.doesNotMatch(html, /Human attention legend/u);
  assert.match(script, /renderGraphSummary/u);
  assert.match(
    script,
    /add\(counts\.RUNNING, "RUNNING", "running", "phase-running"\);[\s\S]*add\(counts\.READY, "READY"[\s\S]*add\(counts\.DRAFT, "DRAFT"[\s\S]*add\(counts\.DONE, "DONE"/u,
  );
  assert.doesNotMatch(html, /id="closeoutQueue"/u);
  for (const id of ["summaryDraft", "summaryReady", "summaryRunning", "summaryDone"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"));
  }
  assert.match(script, /"NEEDS YOU"/u);
  for (const banned of [
    "Execution flow",
    "Proven left, executable right",
    "Proven upstream, executable downstream",
    "Owner decision follows this proposal",
    "No Active Run proven",
  ]) assert.equal(html.includes(banned), false);
});

test("focused Ticket makes the exact copy handoff the dominant recommended action", () => {
  assert.match(script, /className = classes\("recommended-action"/u);
  assert.match(script, /eyebrow\.textContent = "Recommended action"/u);
  assert.match(script, /embeddedParentOrigin[\s\S]*"Verify in Chat" : "Start in Chat"[\s\S]*: "Copy prompt"/u);
  assert.match(script, /if \(contextPackage\.agentPayload\) return canonical;/u);
  assert.match(css, /\.recommended-action-title \{[\s\S]*font-size: 15px/u);
  assert.match(css, /\.recommended-action \.agent-handoff \{[\s\S]*background: var\(--ink\)/u);
});

test("card phase pair is label-relative and action detail stays on demand", () => {
  assert.match(script, /const labelWidth = stateLabel\.getComputedTextLength\(\)/u);
  assert.match(script, /NODE\.width - 14 - labelWidth - 18/u);
  assert.match(script, /y: NODE\.height - 22/u);
  assert.match(script, /label\.className = "recommended-action-title"/u);
  assert.match(script, /label\.tabIndex = 0/u);
  assert.match(script, /label\.dataset\.fullText = nextAction\?\.detail/u);
  assert.match(script, /label\.setAttribute\("aria-describedby", "textTooltip"\)/u);
  assert.doesNotMatch(script, /detail\.textContent = nextAction\?\.detail/u);
  assert.match(css, /\.recommended-action-title:focus-visible/u);
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
