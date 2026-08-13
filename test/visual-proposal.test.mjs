import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const proposalRoot = join(process.cwd(), "docs/proposals/codex-like-workbench");
const tokens = JSON.parse(readFileSync(join(proposalRoot, "tokens.json"), "utf8"));
const matrix = JSON.parse(readFileSync(join(proposalRoot, "state-matrix.json"), "utf8"));
const html = readFileSync(join(proposalRoot, "index.html"), "utf8");
const css = readFileSync(join(proposalRoot, "proposal.css"), "utf8");
const script = readFileSync(join(proposalRoot, "proposal.js"), "utf8");

function rgb(hex) {
  return hex.slice(1).match(/.{2}/gu).map((value) => Number.parseInt(value, 16) / 255);
}

function luminance(hex) {
  return rgb(hex)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("Codex-like proposal defines one complete dependency-free token system", () => {
  assert.deepEqual(
    Object.keys(tokens).filter((key) => !["schema_version", "proposal"].includes(key)),
    ["typography", "spacing", "radii", "border", "elevation", "surface", "semantic", "attention", "interaction"],
  );
  assert.deepEqual(Object.keys(tokens.semantic), ["done", "ready", "blocked", "refine", "deviated", "archived"]);
  assert.deepEqual(Object.keys(tokens.attention), ["upcoming", "pending", "recorded", "complete"]);
  assert.match(tokens.typography.family_ui, /^ui-monospace/u);
  assert.equal(tokens.typography.family_ui, tokens.typography.family_mono);
  assert.match(css, /--ui:\s*ui-monospace/u);
  assert.equal(tokens.interaction.target_narrow, 44);
  assert.equal(tokens.interaction.reduced_motion.includes("disabled"), true);
  assert.equal(html.includes("http://") || html.includes("https://"), false);
  assert.equal(html.includes("proposal.css") && html.includes("proposal.js"), true);
});

test("operational state and human attention remain complete independent axes", () => {
  assert.deepEqual(matrix.operational_axis.map((item) => item.state), ["DONE", "READY", "BLOCKED", "REFINE", "DEVIATED"]);
  assert.deepEqual(matrix.attention_axis.map((item) => item.state), ["UPCOMING", "PENDING", "RECORDED", "COMPLETE"]);
  assert.equal(matrix.coexistence_examples.length, 4);
  assert.equal(matrix.attention_axis.every((item) => item.label && item.treatment), true);
  assert.equal(matrix.attention_axis.every((item) => /icon/u.test(item.label)), true);
  assert.match(matrix.non_color_contract, /label and distinct icon/u);
});

test("proposal retains real Workbench capabilities and review states", () => {
  for (const value of [
    "Ticket causal graph proposal",
    "Compact overview",
    "Ticket Inspector",
    "Execution",
    "Contract",
    "Log",
    "Exact Git source",
    "Copy focus",
    "Ticket state legend",
    "Human attention legend",
    "ticket-propose-codex-like",
    "ticket-prepare-rooms",
    "ticket-decide-codex-like",
    "ARCHIVED",
    "DEVIATED",
    "REFINE",
  ]) assert.match(html, new RegExp(value, "u"));
  assert.equal(html.includes("Proven left, executable right"), false);
  assert.equal(html.includes("Execution flow"), false);
  assert.equal(html.includes("Owner decision follows this proposal"), false);
  assert.equal(html.includes("No Active Run proven"), false);
  assert.equal(/[☝○◌◆▶▣✓]/u.test(html), false);
  assert.match(css, /@media \(max-width: 1220px\)/u);
  assert.match(css, /@media \(max-width: 700px\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(script, /data-direction/u);
});

test("proposal text and semantic accents meet annotated contrast floors", () => {
  const ink = tokens.surface.ink;
  for (const item of Object.values(tokens.semantic)) {
    assert.ok(contrast(ink, item.surface) >= 12, `${item.label} whole-card text contrast`);
    assert.ok(contrast(item.accent, item.surface) >= 4.5, `${item.label} accent contrast`);
    assert.ok(item.label && item.icon, `${item.label} has redundant text and icon`);
  }
  for (const item of Object.values(tokens.attention)) {
    if (item.surface !== "transparent") {
      assert.ok(contrast(item.accent, item.surface) >= 4.5, `${item.label} attention contrast`);
    }
    assert.ok(item.label && item.icon, `${item.label} has redundant text and icon`);
  }
});
