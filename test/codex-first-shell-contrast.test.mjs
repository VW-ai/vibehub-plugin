import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// WCAG 2.x contrast over the production shell's Light and Dark tokens. The
// pairs below mirror the rules in apps/codex-first-shell/app.css: each entry
// names the rule it models, and the test also asserts that rule text so the
// model cannot drift away from the stylesheet silently. Thresholds are the
// AA floors: 4.5:1 for normal text (every text size in this shell is below
// the large-text cut-off), 3:1 for focus indicators, state indicators and
// text-entry boundaries (SC 1.4.11). Disabled controls are exempt (SC 1.4.3)
// and are reported, not asserted.

const css = await readFile(new URL("../apps/codex-first-shell/app.css", import.meta.url), "utf8");

function parseTokens(block) {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

const blocks = {
  rootLight: css.match(/^:root \{([^}]+)\}/m)?.[1],
  mediaDark: css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]+)\}/)?.[1],
  explicitLight: css.match(/\[data-theme="light"\] \{([^}]+)\}/)?.[1],
  explicitDark: css.match(/\[data-theme="dark"\] \{([^}]+)\}/)?.[1],
};
for (const [name, block] of Object.entries(blocks)) assert.ok(block, `token block ${name} is present`);
const tokens = Object.fromEntries(Object.entries(blocks).map(([name, block]) => [name, parseTokens(block)]));

function hex(value) {
  const raw = value.trim().replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((char) => char + char).join("") : raw;
  assert.match(full, /^[0-9a-f]{6}$/i, `hex colour: ${value}`);
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16) / 255);
}
const named = { white: [1, 1, 1], black: [0, 0, 0] };
const colour = (value) => named[value] ?? hex(value);
const linear = (channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
// color-mix(in srgb, X p%, transparent) composited over a surface, and
// color-mix(in srgb, X p%, Y) for an opaque blend, are both this blend.
const blend = (top, share, under) => top.map((channel, index) => channel * share + under[index] * (1 - share));
const ratio = (value) => `${value.toFixed(2)}:1`;

const COLOUR_TOKENS = ["accent", "bg", "sidebar", "panel", "raised", "hover", "text", "muted", "faint", "line", "line-strong", "field-line", "code", "on-accent", "ok", "warn", "danger"];

test("Light and Dark token sets are complete, and the explicit override equals the system preference block", () => {
  for (const token of COLOUR_TOKENS) {
    for (const block of ["rootLight", "mediaDark", "explicitLight", "explicitDark"]) assert.ok(tokens[block][token], `--${token} defined in ${block}`);
    assert.equal(tokens.explicitLight[token].toLowerCase(), tokens.rootLight[token].toLowerCase(), `--${token}: [data-theme="light"] equals the system Light block`);
    assert.equal(tokens.explicitDark[token].toLowerCase(), tokens.mediaDark[token].toLowerCase(), `--${token}: [data-theme="dark"] equals the prefers-color-scheme: dark block`);
  }
  // The owner-provided baseline primitives are untouched.
  assert.equal(tokens.rootLight.accent.toLowerCase(), "#0169cc");
  assert.equal(tokens.rootLight.bg.toLowerCase(), "#fff");
  assert.equal(tokens.rootLight.text.toLowerCase(), "#0d0d0d");
  assert.equal(tokens.mediaDark.accent.toLowerCase(), "#339cff");
  assert.equal(tokens.mediaDark.bg.toLowerCase(), "#181818");
  assert.equal(tokens.mediaDark.text.toLowerCase(), "#fff");
});

// Rule text the pair table models. If a rule changes, the matching pair has
// to change with it.
const MODELLED_RULES = [
  [".stop-banner", /\.stop-banner \{[^}]*color: var\(--text\); background: color-mix\(in srgb, var\(--danger\) 8%, transparent\);/],
  [".stop-banner p", /\.stop-banner p \{ margin: 0; color: var\(--muted\); \}/],
  [".approval-card", /\.approval-card \{[^}]*background: color-mix\(in srgb, #d89b00 7%, var\(--panel\)\);/],
  [".approval-card > header", /\.approval-card > header \{[^}]*color: var\(--warn\);/],
  [".project-import", /\.project-import \{[^}]*color: var\(--accent\); background: color-mix\(in srgb, var\(--accent\) 7%, transparent\);/],
  ["unbound scope pill", /\[data-scope="unbound"\] \.scope-pill \{[^}]*color: var\(--accent\); background: color-mix\(in srgb, var\(--accent\) 9%, transparent\);/],
  ["bound scope pill", /\[data-scope="bound"\] \.scope-pill \{[^}]*color: var\(--ok\); background: color-mix\(in srgb, var\(--ok\) 10%, transparent\);/],
  ["danger scope pill", /\.scope-pill \{[^}]*color: var\(--danger\); background: color-mix\(in srgb, var\(--danger\) 8%, transparent\);/],
  [".primary-button", /\.primary-button \{[^}]*color: var\(--on-accent\); background: var\(--accent\);/],
  [".recommended", /\.recommended \{[^}]*color: var\(--on-accent\); background: var\(--accent\);/],
  [".approval-card button.accept", /\.approval-card button\.accept \{[^}]*color: var\(--on-accent\); background: var\(--accent\);/],
  [".approval-card button.danger", /\.approval-card button\.danger \{ color: var\(--danger\); \}/],
  [".packet-inspector pre", /\.packet-inspector pre \{[^}]*color: var\(--muted\); background: var\(--code\);/],
  [".terminal-output", /\.terminal-output, \.tool-arguments \{[^}]*color: var\(--text\); background: var\(--code\);/],
  [".retrying", /\.retrying \{ color: var\(--warn\);/],
  [".substate", /\.substate \{ color: var\(--warn\);/],
  ["RUNNING phase", /\.task-card\[data-phase="RUNNING"\] \.phase \{ color: var\(--ok\); \}/],
  [".acceptance-row i", /\.acceptance-row i \{ color: var\(--ok\);/],
  ["focus ring", /:focus-visible[^{]*\{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/],
  [".composer", /\.composer \{[^}]*border: 1px solid var\(--field-line\);/],
  [".composer:focus-within", /\.composer:focus-within \{ border-color: var\(--accent\); \}/],
  ["request inputs", /\.request-other input\[type="password"\] \{[^}]*border: 1px solid var\(--field-line\);[^}]*background: var\(--panel\);/],
  ["selected search result", /\.search-result\[aria-selected="true"\] \{ outline: 2px solid var\(--accent\); outline-offset: -2px; \}/],
  ["selected import row", /\.import-row\[aria-pressed="true"\] \{ border-color: var\(--accent\);/],
  ["placeholder", /::placeholder \{ color: var\(--muted\); opacity: 1; \}/],
  [".send-button", /\.send-button \{ color: var\(--bg\); background: var\(--text\);/],
  [".toast", /\.toast \{[^}]*color: var\(--bg\); background: var\(--text\);/],
  [".stop-button", /\.stop-button \{ color: white; background: #d33; \}/],
  [".import-row[disabled]", /\.import-row\[disabled\] \{ cursor: not-allowed; opacity: \.6; \}/],
  [".primary-button[disabled]", /\.primary-button\[disabled\] \{ opacity: \.5;/],
  [".message-actions button[disabled]", /\.message-actions button\[disabled\] \{ opacity: \.4;/],
  // The explicit Chat bridge: actions, hints, markers, sheets and provenance.
  [".bridge-hint", /\.bridge-hint \{[^}]*color: var\(--muted\);/],
  [".association-link", /\.association-link \{[^}]*border: 1px solid color-mix\(in srgb, var\(--accent\) 70%, var\(--line\)\);[^}]*color: var\(--text\); background: color-mix\(in srgb, var\(--accent\) 6%, var\(--panel\)\);/],
  [".association-link small", /\.association-link small \{ color: var\(--muted\);/],
  [".graph-chat", /\.graph-chat \{[^}]*color: var\(--text\); background: color-mix\(in srgb, var\(--accent\) 6%, var\(--panel\)\);/],
  [".graph-chat small", /\.graph-chat small \{ color: var\(--muted\);/],
  [".graph-sources-label", /\.graph-sources-label, \.graph-sources-empty \{[^}]*color: var\(--muted\);/],
  [".task-origin", /\.task-origin \{[^}]*color: var\(--muted\);/],
  [".origin-chip", /\.origin-chip \{[^}]*border: 1px solid color-mix\(in srgb, var\(--accent\) 70%, var\(--line\)\);[^}]*background: var\(--raised\);/],
  [".origin-chip p", /\.origin-chip p \{[^}]*color: var\(--text\);/],
  [".origin-excerpt", /\.origin-excerpt \{[^}]*color: var\(--muted\);/],
  [".bridge-form fields", /\.bridge-form input, \.bridge-form textarea, \.bridge-form select \{[^}]*border: 1px solid var\(--field-line\);[^}]*color: var\(--text\); background: var\(--panel\);/],
  [".bridge-status", /\.bridge-status \{[^}]*color: var\(--muted\);/],
  [".bridge-status[data-error]", /\.bridge-status\[data-error="true"\] \{ color: var\(--danger\); \}/],
  [".bridge-packet pre", /\.bridge-packet pre \{[^}]*color: var\(--muted\); background: var\(--code\);/],
  ["selected attach row", /\.attach-row\[aria-pressed="true"\] \{ border-color: var\(--accent\); background: color-mix\(in srgb, var\(--accent\) 8%, transparent\);/],
  [".attach-row .attach-provenance", /\.attach-row \.attach-provenance \{ color: var\(--accent\);/],
  [".attach-row > em", /\.attach-row > em \{ color: var\(--faint\);/],
  // Fork lineage surfaces: the source chip, the derived note, the missing
  // state and the fork listing rows in the Chat heading.
  [".lineage-chip", /\.lineage-chip \{[^}]*border: 1px solid var\(--line-strong\);[^}]*color: var\(--muted\); background: var\(--panel\);/],
  [".lineage-chip strong", /\.lineage-chip strong \{[^}]*color: var\(--text\);/],
  [".lineage-chip.is-missing", /\.lineage-chip\.is-missing \{ border-style: dashed; color: var\(--faint\); background: transparent; \}/],
  [".lineage-note", /\.lineage-note \{ color: var\(--faint\);/],
  [".lineage-placement", /\.lineage-note\.lineage-placement \{ color: var\(--warn\); \}/],
  [".fork-row small", /\.fork-row small \{[^}]*color: var\(--muted\);/],
  [".selection-sheet", /\.selection-sheet \{[^}]*background: var\(--panel\);/],
  [".quote-selection[disabled]", /\.quote-selection\[disabled\] \{ opacity: \.4;/],
  ["provenance edge", /\.graph-edges path\[data-edge-kind="provenance"\] \{ stroke: color-mix\(in srgb, var\(--accent\) 75%, transparent\); stroke-dasharray: 5 4; \}/],
  ["source focus outline", /\.turn\.assistant\[data-source-focus\] \{ outline: 2px solid var\(--accent\);/],
  [".bridge-dialog footer primary", /\.bridge-dialog > footer \.primary-button \{ border-color: var\(--accent\); color: var\(--on-accent\); background: var\(--accent\); \}/],
  // Daily-use parity surfaces: the follow-up queue, the pickers, attachment
  // and mention chips, the context meter, rename, posture and notices.
  [".queue-tray", /\.queue-tray \{[^}]*border: 1px solid var\(--line-strong\); border-radius: 12px; color: var\(--text\); background: var\(--raised\); \}/],
  [".queue-tray > header small", /\.queue-tray > header small \{[^}]*color: var\(--muted\);/],
  [".queue-paused", /\.queue-paused \{[^}]*border: 1px solid color-mix\(in srgb, var\(--warn\) 55%, transparent\); border-radius: 8px; color: var\(--text\); background: color-mix\(in srgb, var\(--warn\) 9%, var\(--panel\)\);/],
  [".queue-paused button", /\.queue-paused button \{[^}]*border: 1px solid var\(--accent\); border-radius: 7px; color: var\(--on-accent\); background: var\(--accent\);/],
  [".queue-row", /\.queue-row \{[^}]*background: var\(--panel\); \}/],
  [".queue-order", /\.queue-order \{[^}]*color: var\(--faint\);/],
  [".queue-media", /\.queue-media \{[^}]*color: var\(--muted\);/],
  [".queue-actions button", /\.queue-actions button \{[^}]*border: 1px solid var\(--line\); border-radius: 7px; color: var\(--text\); background: var\(--panel\);/],
  [".queue-actions button[disabled]", /\.queue-actions button\[disabled\] \{ opacity: \.5;/],
  [".queue-edit textarea", /\.queue-edit textarea \{[^}]*border: 1px solid var\(--field-line\); border-radius: 8px; color: var\(--text\); background: var\(--panel\);/],
  [".send-button queue", /\.send-button\[data-send-mode="queue"\] \{ width: auto;/],
  [".composer-picker", /\.composer-picker \{[^}]*color: var\(--muted\);/],
  [".composer-picker select", /\.composer-picker select \{[^}]*border: 1px solid var\(--line\); border-radius: 7px; color: var\(--text\); background: var\(--panel\);/],
  [".composer-picker select[disabled]", /\.composer-picker select\[disabled\] \{ opacity: \.6;/],
  [".settings-source", /\.settings-source \{[^}]*color: var\(--muted\);/],
  [".turn-posture", /\.turn-posture \{[^}]*color: var\(--muted\);/],
  [".attachment-chip", /\.attachment-chip \{[^}]*color: var\(--text\); background: var\(--raised\);/],
  [".attachment-chip button", /\.attachment-chip button \{[^}]*color: var\(--muted\); background: transparent; \}/],
  [".mention-chip", /\.mention-chip \{[^}]*border: 1px solid color-mix\(in srgb, var\(--accent\) 70%, var\(--line\)\); border-radius: 6px; color: var\(--text\); background: color-mix\(in srgb, var\(--accent\) 6%, var\(--panel\)\);/],
  [".composer-mention button", /\.composer-mention button \{[^}]*color: var\(--muted\); background: transparent;/],
  [".mention-picker", /\.mention-picker \{[^}]*border: 1px solid var\(--line-strong\); border-radius: 12px; background: var\(--panel\);/],
  [".mention-picker option small", /\.mention-picker \[role="option"\] small \{[^}]*color: var\(--muted\);/],
  [".mention-picker option selected", /\.mention-picker \[role="option"\]\[aria-selected="true"\] \{ outline: 2px solid var\(--accent\); outline-offset: -2px; background: color-mix\(in srgb, var\(--accent\) 8%, transparent\); \}/],
  [".mention-status", /\.mention-status \{[^}]*color: var\(--muted\);/],
  [".thread-context", /\.thread-context \{[^}]*color: var\(--muted\);/],
  [".thread-context unknown", /\.thread-context\[data-state="unknown"\] \{ color: var\(--faint\); \}/],
  [".context-meter", /\.context-meter \{[^}]*border: 1px solid var\(--line-strong\); border-radius: 999px; background: var\(--raised\); \}/],
  [".context-meter i", /\.context-meter i \{ display: block; height: 100%; background: var\(--accent\); \}/],
  [".turn-boundary.compacted span", /\.turn-boundary\.compacted span \{ color: var\(--accent\); \}/],
  [".thread-rename", /\.thread-rename \{[^}]*border: 1px solid var\(--line\); border-radius: 7px; color: var\(--muted\); background: var\(--panel\);/],
  [".rename-form input", /\.rename-form input \{[^}]*border: 1px solid var\(--field-line\); border-radius: 8px; color: var\(--text\); background: var\(--panel\);/],
  [".rename-form button", /\.rename-form button \{[^}]*border: 1px solid var\(--line\); border-radius: 7px; color: var\(--text\); background: var\(--panel\);/],
  [".rename-form submit", /\.rename-form button\[type="submit"\] \{ border-color: var\(--accent\); color: var\(--on-accent\); background: var\(--accent\); \}/],
  [".thread-posture", /\.thread-posture \{[^}]*color: var\(--muted\);/],
  [".thread-posture strong", /\.thread-posture strong \{ color: var\(--text\);/],
  [".thread-posture danger", /\.thread-posture\[data-posture="fullAccess"\] strong:nth-of-type\(-n\+2\), \.thread-posture\[data-pending="fullAccess"\] strong:last-of-type \{ color: var\(--danger\); \}/],
  [".danger-button", /\.bridge-dialog > footer \.danger-button \{ border-color: var\(--danger\); color: var\(--on-accent\); background: var\(--danger\); \}/],
  [".completion-badge", /\.thread-button em\.completion-badge \{[^}]*color: var\(--ok\); background: var\(--panel\); \}/],
  [".notification-setting", /\.notification-setting \{[^}]*color: var\(--text\);/],
  [".notification-setting select", /\.notification-setting select \{[^}]*border: 1px solid var\(--line\); border-radius: 7px; color: var\(--text\); background: var\(--panel\);/],
  // Honest voice input: the recording tray with its live clock and Cancel,
  // the persistent permission-denied state, and the disabled microphone.
  [".recording-tray", /\.recording-tray \{[^}]*color: var\(--text\); background: var\(--raised\);/],
  [".recording-tray small", /\.recording-tray small \{ color: var\(--muted\); font-size: 10px; \}/],
  [".recording-dot", /\.recording-dot \{[^}]*background: var\(--danger\); animation: pulse/],
  [".recording-clock", /\.recording-clock \{ color: var\(--text\); font: 11px\/1\.4 var\(--mono\); font-variant-numeric: tabular-nums; \}/],
  [".recording-cancel", /\.recording-cancel \{[^}]*border: 1px solid var\(--line\); border-radius: 7px; color: var\(--text\); background: var\(--panel\);/],
  [".recording-tray denied heading", /\.recording-tray\[data-recording-state="denied"\] strong \{ color: var\(--danger\); \}/],
  [".composer-icon[disabled]", /\.composer-icon\[disabled\] \{ opacity: \.45; cursor: not-allowed; \}/],
];

test("the contrast pair table models rules that still exist in app.css", () => {
  for (const [name, pattern] of MODELLED_RULES) assert.match(css, pattern, `${name} rule`);
  // No one-mode literal text colour remains outside the token blocks.
  const rules = css.replace(/^:root \{[^}]+\}/m, "").replace(/@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]+\}\s*\}/, "").replace(/\[data-theme="(?:light|dark)"\] \{[^}]+\}/g, "");
  assert.doesNotMatch(rules, /(?<![-\w])color: #(?:b06a00|22a06b|b42318|c84848)/, "hard-coded one-mode text colours have become tokens");
});

function pairsFor(t) {
  const c = (token) => colour(t[token]);
  const approvalSurface = blend(hex("#d89b00"), 0.07, c("panel"));
  const stopSurface = blend(c("danger"), 0.08, c("bg"));
  const text = (name, fg, bg, note = "") => ({ name, fg, bg, floor: 4.5, kind: "text", note });
  const ui = (name, fg, bg, note = "") => ({ name, fg, bg, floor: 3, kind: "ui", note });
  const info = (name, fg, bg, note = "") => ({ name, fg, bg, floor: null, kind: "info", note });
  return [
    text("body text on canvas", c("text"), c("bg")),
    text("body text on panel", c("text"), c("panel")),
    text("body text on sidebar", c("text"), c("sidebar")),
    text("body text on raised", c("text"), c("raised")),
    text("body text on hover", c("text"), c("hover")),
    text("muted text on canvas", c("muted"), c("bg")),
    text("muted text on panel", c("muted"), c("panel")),
    text("muted text on sidebar", c("muted"), c("sidebar")),
    text("muted text on raised", c("muted"), c("raised")),
    text("muted text on hover", c("muted"), c("hover")),
    text("placeholder (muted) on panel", c("muted"), c("panel")),
    text("faint text on canvas", c("faint"), c("bg")),
    text("faint text on panel", c("faint"), c("panel")),
    text("faint text on sidebar", c("faint"), c("sidebar")),
    text("faint text on raised", c("faint"), c("raised")),
    text("faint text on hover", c("faint"), c("hover")),
    text("faint text on code", c("faint"), c("code")),
    text("accent link on canvas", c("accent"), c("bg")),
    text("accent link on panel", c("accent"), c("panel")),
    text("accent text on sidebar", c("accent"), c("sidebar")),
    text("accent text on hover", c("accent"), c("hover")),
    text("accent label on import button fill", c("accent"), blend(c("accent"), 0.07, c("panel"))),
    text("accent label on unbound scope pill", c("accent"), blend(c("accent"), 0.09, c("panel"))),
    text("primary action label on accent", c("on-accent"), c("accent")),
    text("ok text on panel", c("ok"), c("panel")),
    text("ok label on bound scope pill", c("ok"), blend(c("ok"), 0.10, c("panel"))),
    text("ok text on hover", c("ok"), c("hover")),
    text("warn text on panel", c("warn"), c("panel")),
    text("warn header on approval card", c("warn"), approvalSurface),
    text("warn substate on canvas", c("warn"), c("bg")),
    text("danger text on canvas", c("danger"), c("bg")),
    text("danger text on panel", c("danger"), c("panel")),
    text("danger text on raised", c("danger"), c("raised")),
    text("danger label on danger scope pill", c("danger"), blend(c("danger"), 0.08, c("panel"))),
    text("code text on code surface", c("text"), c("code")),
    text("muted packet text on code surface", c("muted"), c("code")),
    text("text on stop banner", c("text"), stopSurface),
    text("muted text on stop banner", c("muted"), stopSurface),
    text("inverse label (send, toast, avatar)", c("bg"), c("text")),
    text("stop button label on #d33", named.white, hex("#d33")),
    ui("focus ring on canvas", c("accent"), c("bg")),
    ui("focus ring on sidebar", c("accent"), c("sidebar")),
    ui("focus ring on panel", c("accent"), c("panel")),
    ui("focus ring on raised", c("accent"), c("raised")),
    ui("focus ring on hover", c("accent"), c("hover")),
    ui("focus ring on code", c("accent"), c("code")),
    ui("composer focus border on canvas", c("accent"), c("bg")),
    ui("composer boundary on canvas", c("field-line"), c("bg")),
    ui("request input boundary on approval card", c("field-line"), approvalSurface),
    ui("request input boundary on panel", c("field-line"), c("panel")),
    ui("selected search result outline on panel", c("accent"), c("panel")),
    ui("selected search result outline on hover", c("accent"), c("hover")),
    ui("selected import row border on panel", c("accent"), c("panel")),
    ui("live thread dot on sidebar", c("accent"), c("sidebar")),
    ui("connected dot (#22a06b) on sidebar", hex("#22a06b"), c("sidebar")),
    ui("needs-you dot (#d74747) on sidebar", hex("#d74747"), c("sidebar")),
    info("decorative border line on canvas (exempt: not a component boundary)", c("line"), c("bg")),
    info("decorative border line-strong on canvas (exempt)", c("line-strong"), c("bg")),
    info("hover background on canvas (exempt: pointer hover only)", c("hover"), c("bg")),
    info("restarting dot (#d98a1a) on canvas (label carries the state)", hex("#d98a1a"), c("bg")),
    info("disabled primary label (opacity .5)", blend(c("on-accent"), 0.5, c("bg")), blend(c("accent"), 0.5, c("bg"))),
    info("disabled import row muted text (opacity .6)", blend(c("muted"), 0.6, c("panel")), c("panel")),
    info("disabled import row body text (opacity .6)", blend(c("text"), 0.6, c("panel")), c("panel")),
    info("disabled message action (opacity .4)", blend(c("muted"), 0.4, c("panel")), c("panel")),
    // The explicit Chat bridge: marker and provenance fills, the origin chip,
    // sheet fields, and the selection sheet.
    text("body text on association link fill", c("text"), blend(c("accent"), 0.06, c("panel"))),
    text("muted text on association link fill", c("muted"), blend(c("accent"), 0.06, c("panel"))),
    text("body text on Chat provenance node fill", c("text"), blend(c("accent"), 0.06, c("panel"))),
    text("muted text on Chat provenance node fill", c("muted"), blend(c("accent"), 0.06, c("panel"))),
    text("muted provenance label on sources strip (panel over canvas)", c("muted"), blend(c("panel"), 0.92, c("bg"))),
    text("body text on origin chip (raised)", c("text"), c("raised")),
    text("muted excerpt on origin chip (raised)", c("muted"), c("raised")),
    text("muted bridge hint on panel", c("muted"), c("panel")),
    text("bridge field text on panel", c("text"), c("panel")),
    text("danger bridge status on panel", c("danger"), c("panel")),
    text("muted packet preview on code surface", c("muted"), c("code")),
    text("accent provenance note on attach row", c("accent"), c("panel")),
    text("accent provenance note on selected attach row", c("accent"), blend(c("accent"), 0.08, c("panel"))),
    text("faint attach row posture on panel", c("faint"), c("panel")),
    text("body text on selected attach row", c("text"), blend(c("accent"), 0.08, c("panel"))),
    text("selection sheet action label on panel", c("text"), c("panel")),
    text("bridge confirm label on accent", c("on-accent"), c("accent")),
    // Fork lineage: the chip sits on the heading canvas with a panel fill;
    // the derived note and the missing state are faint text on the canvas;
    // the placement note is warn on the canvas; listing rows sit on canvas.
    text("fork lineage chip label (muted) on panel", c("muted"), c("panel")),
    text("fork lineage chip source title on panel", c("text"), c("panel")),
    text("fork lineage missing state (faint) on canvas", c("faint"), c("bg")),
    text("fork lineage derived note (faint) on canvas", c("faint"), c("bg")),
    text("fork placement note (warn) on canvas", c("warn"), c("bg")),
    text("fork listing row title on canvas", c("text"), c("bg")),
    text("fork listing row detail (muted) on canvas", c("muted"), c("bg")),
    info("fork lineage chip boundary (line-strong) on panel (exempt: the chip carries its own text label)", c("line-strong"), c("panel")),
    ui("bridge field boundary on panel", c("field-line"), c("panel")),
    ui("selected attach row border on panel", c("accent"), c("panel")),
    ui("association link, provenance node and origin chip border (accent 70% over line) on panel", blend(c("accent"), 0.7, c("line")), c("panel")),
    ui("origin chip border (accent 70% over line) on raised", blend(c("accent"), 0.7, c("line")), c("raised")),
    ui("source focus outline on canvas", c("accent"), c("bg")),
    info("provenance edge stroke (accent 75%) on canvas (the sources strip names the Chat)", blend(c("accent"), 0.75, c("bg")), c("bg")),
    info("disabled selection sheet action (opacity .4)", blend(c("text"), 0.4, c("panel")), c("panel")),
    // Daily-use parity surfaces. The follow-up queue sits on raised with
    // panel rows; the paused note is warn 9% over panel; chips and pickers
    // follow the panel and raised surfaces; the context meter fill is a
    // state indicator on raised; the posture line sits on the canvas.
    text("queue tray text on raised", c("text"), c("raised")),
    text("queue tray summary (muted) on raised", c("muted"), c("raised")),
    text("queue row text on panel", c("text"), c("panel")),
    text("queue order (faint) on panel", c("faint"), c("panel")),
    text("queue media note (muted) on panel", c("muted"), c("panel")),
    text("queue paused text on warn 9% over panel", c("text"), blend(c("warn"), 0.09, c("panel"))),
    text("Resume label on accent", c("on-accent"), c("accent")),
    text("queue action label on panel", c("text"), c("panel")),
    text("queue edit text on panel", c("text"), c("panel")),
    text("Queue send label (inverse)", c("bg"), c("text")),
    text("picker label (muted) on panel", c("muted"), c("panel")),
    text("picker value on panel", c("text"), c("panel")),
    text("settings source (muted) on panel", c("muted"), c("panel")),
    text("Turn posture line (muted) on raised", c("muted"), c("raised")),
    text("attachment chip name on raised", c("text"), c("raised")),
    text("attachment chip remove (muted) on raised", c("muted"), c("raised")),
    text("mention chip on accent 6% over panel", c("text"), blend(c("accent"), 0.06, c("panel"))),
    text("mention chip in a user message (accent 6% over panel, bubble on raised)", c("text"), blend(c("accent"), 0.06, c("panel"))),
    text("mention chip remove (muted) on accent 6% over panel", c("muted"), blend(c("accent"), 0.06, c("panel"))),
    text("mention option name on panel", c("text"), c("panel")),
    text("mention option path (muted) on panel", c("muted"), c("panel")),
    text("mention option name on selected fill (accent 8% over panel)", c("text"), blend(c("accent"), 0.08, c("panel"))),
    text("mention status (muted) on panel", c("muted"), c("panel")),
    text("context label (muted) on canvas", c("muted"), c("bg")),
    text("context label unknown (faint) on canvas", c("faint"), c("bg")),
    text("compaction boundary label (accent) on raised", c("accent"), c("raised")),
    text("Rename control (muted) on panel", c("muted"), c("panel")),
    text("rename input text on panel", c("text"), c("panel")),
    text("rename Save label on accent", c("on-accent"), c("accent")),
    text("posture line (muted) on canvas", c("muted"), c("bg")),
    text("posture value on canvas", c("text"), c("bg")),
    text("full-access posture value (danger) on canvas", c("danger"), c("bg")),
    text("Allow full access label on danger", c("on-accent"), c("danger")),
    text("completion badge (ok) on its panel fill", c("ok"), c("panel")),
    text("notification setting label on sidebar", c("text"), c("sidebar")),
    text("notification setting value on panel", c("text"), c("panel")),
    // Honest voice input: the recording tray sits on raised, its Cancel on
    // panel; the pulsing dot is a state indicator; the denied state names its
    // cause in danger; the disabled microphone is exempt (SC 1.4.3), reported.
    text("recording label and clock on recording tray (raised)", c("text"), c("raised")),
    text("recording hint (muted) on recording tray (raised)", c("muted"), c("raised")),
    text("recording Cancel label on panel", c("text"), c("panel")),
    text("recording denied heading (danger) on raised", c("danger"), c("raised")),
    text("recording denied cause on raised", c("text"), c("raised")),
    ui("recording state dot (danger) on raised", c("danger"), c("raised")),
    info("disabled microphone glyph (opacity .45)", blend(c("text"), 0.45, c("panel")), c("panel")),
    ui("queue edit boundary (field-line) on panel", c("field-line"), c("panel")),
    ui("rename input boundary (field-line) on panel", c("field-line"), c("panel")),
    ui("mention chip border (accent 70% over line) on accent 6% fill", blend(c("accent"), 0.7, c("line")), blend(c("accent"), 0.06, c("panel"))),
    ui("selected mention option outline on panel", c("accent"), c("panel")),
    ui("context meter fill (accent) on raised", c("accent"), c("raised")),
    ui("drop target ring (accent) on canvas", c("accent"), c("bg")),
    info("disabled queue action (opacity .5)", blend(c("text"), 0.5, c("panel")), c("panel")),
    info("disabled picker (opacity .6)", blend(c("text"), 0.6, c("panel")), c("panel")),
    info("context meter track border (line-strong) on canvas (exempt: decorative)", c("line-strong"), c("bg")),
  ];
}

for (const [theme, block] of [["Light", "rootLight"], ["Dark", "mediaDark"]]) {
  test(`${theme} tokens meet WCAG AA: 4.5:1 for text, 3:1 for focus, state and text-entry boundaries`, (t) => {
    const failures = [];
    for (const pair of pairsFor(tokens[block])) {
      const value = contrast(pair.fg, pair.bg);
      const verdict = pair.floor === null ? "info" : value >= pair.floor ? "pass" : "FAIL";
      t.diagnostic(`${theme} · ${pair.name.padEnd(64)} ${ratio(value).padStart(8)} ${pair.floor ? `(≥${pair.floor})` : ""} ${verdict}`);
      if (verdict === "FAIL") failures.push(`${pair.name} ${ratio(value)} < ${pair.floor}:1`);
    }
    assert.deepEqual(failures, [], `${theme} contrast floors`);
  });
}
