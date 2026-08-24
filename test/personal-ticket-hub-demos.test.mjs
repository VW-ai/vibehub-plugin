import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const demos = {
  branch: readFileSync(join(root, "docs/demos/personal-ticket-branch-workbench.html"), "utf8"),
  goals: readFileSync(join(root, "docs/demos/personal-ticket-goal-directions.html"), "utf8"),
  workbench: readFileSync(join(root, "docs/demos/vibehub-workbench-webview.html"), "utf8"),
};

function inlineScripts(source) {
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
}

function staticIds(source) {
  return [...source.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]);
}

test("Personal Ticket Hub demos remain self-contained and syntactically valid", () => {
  for (const [name, source] of Object.entries(demos)) {
    assert.doesNotMatch(source, /<script\s+[^>]*src=/i, `${name} must not load remote scripts`);
    assert.doesNotMatch(source, /\/(?:Users|home)\//, `${name} must not contain machine-local paths`);

    const ids = staticIds(source);
    assert.equal(new Set(ids).size, ids.length, `${name} must not contain duplicate static ids`);

    const scripts = inlineScripts(source);
    assert.ok(scripts.length > 0, `${name} must include its interaction script`);
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), `${name} inline script must parse`);
    }
  }
});

test("Goal comparison exposes five Jira/Linear-inspired directions and preserves selection", () => {
  for (const key of ["a", "b", "c", "d", "e"]) {
    assert.match(demos.goals, new RegExp(`data-variant=["']${key}["']`));
    assert.match(demos.goals, new RegExp(`data-panel=["']${key}["']`));
  }

  assert.match(demos.goals, /function showVariant\(key\)/);
  assert.match(demos.goals, /document\.addEventListener\(["']keydown["']/);
  assert.match(demos.goals, /window\.addEventListener\(["']hashchange["']/);
  assert.match(demos.goals, /localStorage\.setItem\(["']personal-ticket-goal-direction["']/);
  assert.match(demos.goals, /setAttribute\(["']aria-pressed["']/);
});

test("Personal Ticket branch workbench keeps Goal, Ticket, Inbox and VibeHub controls", () => {
  for (const filter of ["open", "implementing", "needs-you", "done"]) {
    assert.match(demos.branch, new RegExp(`data-queue-filter=["']${filter}["']`));
  }
  for (const mode of ["auto", "on", "off"]) {
    assert.match(demos.branch, new RegExp(`data-integration-mode=["']${mode}["']`));
  }

  assert.match(demos.branch, /data-workspace-view=["']tickets["']/);
  assert.match(demos.branch, /data-workspace-view=["']graph["']/);
  assert.match(demos.branch, /id=["']inbox-drawer["']/);
  assert.match(demos.branch, /id=["']goal-composer["']/);
  assert.match(demos.branch, /id=["']ticket-composer["']/);
  assert.match(demos.branch, /function setWorkspaceMode\(mode\)/);
  assert.match(demos.branch, /document\.addEventListener\(["']keydown["']/);
  assert.match(demos.branch, /aria-label=["']Open attention inbox["']/);
  assert.match(demos.branch, /aria-label=["']Open Ticket details["']/);
  assert.doesNotMatch(demos.branch, /<button[^>]*role=["']listitem["']/);
  assert.match(demos.branch, /event\.key === ["']ArrowRight["']/);
  assert.match(demos.branch, /:focus-visible\s*\{/);
  assert.doesNotMatch(demos.branch, /outline:\s*none/);
});

test("VibeHub workbench keeps implementation switching and human Inbox actions", () => {
  assert.match(demos.workbench, /aria-label=["']切换正在实现的 Ticket["']/);
  assert.match(demos.workbench, /data-workspace-view=["']tickets["']/);
  assert.match(demos.workbench, /data-workspace-view=["']inbox["']/);
  for (const filter of ["needs", "review", "decision", "blocked", "all"]) {
    assert.match(demos.workbench, new RegExp(`data-inbox-filter=["']${filter}["']`));
  }

  assert.match(demos.workbench, /function simulateGitUpdate\(\)/);
  assert.match(demos.workbench, /navigator\.clipboard\.writeText/);
  assert.match(demos.workbench, /copyInboxPromptButton/);
  assert.match(demos.workbench, /openInboxTicketButton/);
  assert.match(demos.workbench, /markInboxSeenButton/);
  assert.match(demos.workbench, /refreshButton/);
  assert.match(demos.workbench, /Math\.min\(1\.25, Math\.max\(0\.72, nextZoom\)\)/);
  assert.match(demos.workbench, /id=["']simulateButton["'][^>]*aria-label=["']模拟 Git 更新["']/);
  assert.match(demos.workbench, /aria-controls=["']panel-execution["']/);
  assert.match(demos.workbench, /function wireRovingTablist\(tablist\)/);
});
