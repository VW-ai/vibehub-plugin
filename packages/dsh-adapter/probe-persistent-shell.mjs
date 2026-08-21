#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  process.stderr.write("Usage: node packages/dsh-adapter/probe-persistent-shell.mjs /absolute/path/to/deepseek-harness\n");
  process.exit(1);
}

const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const contract = JSON.parse(await readFile(new URL("../../docs/proposals/dsh-persistent-shell/composition-contract.json", import.meta.url), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
if (commit !== lock.commit) throw new Error(`expected DSH ${lock.commit}, received ${commit}`);

const checks = [
  {
    seam: "root-keeps-three-column-shell",
    file: "packages/client/ui-layout/src/client/index.ts",
    patterns: [
      "'sidebar': { kind: 'single'; scope: 'root'",
      "'conversation': { kind: 'single'; scope: 'session-maybe'",
      "'details': { kind: 'single'; scope: 'session'",
      "'shell.overlay': { kind: 'list'; scope: 'root'",
    ],
  },
  {
    seam: "overlay-is-not-a-page-container",
    file: "packages/client/ui-layout/src/client/index.ts",
    patterns: ["Frame-wide floating layer", "outside their scroll", "click-through"],
  },
  {
    seam: "sidebar-shadow-is-single-owner-composition",
    file: "packages/client/ui-sidebar/src/client/index.ts",
    patterns: ["name: 'sidebar'", "ctx.slots.register({", "SidebarRoot"],
  },
  {
    seam: "sidebar-child-seats-are-complete",
    file: "packages/client/ui-sidebar/src/client/index.ts",
    patterns: contract.composition.recreate_child_slots.map((slot) => `'${slot}':`),
  },
  {
    seam: "native-sidebar-behavior-must-survive",
    file: "packages/client/ui-sidebar/src/client/SidebarRoot.tsx",
    patterns: ["startSession", "toggleSidebar", "renderSlot('sidebar.workspaces'", "renderSlot('sidebar.settings'", "renderSlot('sidebar.footer.action'"],
  },
  {
    seam: "native-chat-additive-actions-exist",
    file: "packages/client/ui-conversation/src/client/contract/slots.ts",
    patterns: [
      "'conversation.session.header.actions'",
      "'conversation.chat.assistant-actions'",
      "'conversation.chat.turnTail'",
      "'conversation.input.left'",
      "'conversation.input.right'",
      "'conversation.input.dock'",
    ],
  },
  {
    seam: "session-view-is-not-global-graph",
    file: "packages/client/ui-conversation/src/client/contract/slots.ts",
    patterns: ["'conversation.view'", "scope: 'session'"],
  },
  {
    seam: "theme-runtime-remains-additive",
    file: "packages/client/ui-theme/src/styles/design-platform.css",
    patterns: ["--dsw-alias-bg-base", "--dsw-alias-label-primary"],
  },
];

const results = [];
for (const check of checks) {
  const source = await readFile(resolve(sourceRoot, check.file), "utf8");
  const missing = check.patterns.filter((pattern) => !source.includes(pattern));
  results.push({ seam: check.seam, file: check.file, proven: missing.length === 0, missing });
}

const failed = results.filter((result) => !result.proven);
process.stdout.write(`${JSON.stringify({
  repository: lock.repository,
  version: lock.version,
  commit,
  recommendation: contract.recommended_variant,
  keepOwners: contract.composition.keep_owners,
  shadowOwners: contract.composition.shadow_owners,
  recreatedChildSlots: contract.composition.recreate_child_slots,
  checks: results,
}, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;
