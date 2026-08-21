#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const sourceRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  process.stderr.write("Usage: node packages/dsh-adapter/probe-source.mjs /absolute/path/to/deepseek-harness\n");
  process.exit(1);
}

const lock = JSON.parse(
  await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"),
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
if (commit !== lock.commit) {
  throw new Error(`expected DSH ${lock.commit}, received ${commit}`);
}

const checks = [
  {
    seam: "published-baseline",
    file: "apps/cli/package.json",
    patterns: [`\"version\": \"${lock.version}\"`, `\"name\": \"@deepseek-ai/dsh\"`],
  },
  {
    seam: "runtime-baseline",
    file: "package.json",
    patterns: ["^22.19.0 || >=24.0.0", "pnpm@11.7.0"],
  },
  {
    seam: "bundle-profile",
    file: "docs/user/develop/basic/publish.md",
    patterns: ["dsh.bundle", "dsh.profile", "dsh plugin --profile demo add"],
  },
  {
    seam: "additive-task-view",
    file: "packages/client/ui-conversation/src/client/contract/slots.ts",
    patterns: ["'conversation.view'", "'conversation.session.header.actions'", "'conversation.chat.assistant-actions'"],
  },
  {
    seam: "additive-global-task-surface",
    file: "packages/client/ui-layout/src/client/index.ts",
    patterns: ["'shell.overlay'", "kind: 'list'", "scope: 'root'"],
  },
  {
    seam: "native-workspace-session-routing",
    file: "packages/client/runtime/src/client/contract/workspaces.ts",
    patterns: ["create(input: { path: string })", "connectWorkspace(workspaceId", "Promise<SessionId>"],
  },
  {
    seam: "trusted-session-presence",
    file: "packages/client/runtime/src/client/sessions/service.ts",
    patterns: ["running: boolean", "pendingInteraction?: PendingInteractionStatus", "completed?: boolean"],
  },
  {
    seam: "native-session-prompt",
    file: "packages/client/runtime/src/client/sessions/session.ts",
    patterns: ["async prompt(", "mode: 'queue' | 'steer'", "this.api.sessions.prompt"],
  },
  {
    seam: "registered-command-lifecycle",
    file: "packages/interaction/commands/src/index.ts",
    patterns: ["'command/run'", "'command/done'", "recordInput", "without sending it to the model"],
  },
  {
    seam: "runtime-session-projection",
    file: "packages/session/session-projection/src/index.ts",
    patterns: ["sessionProjections.register()", "register<K extends keyof SessionProjectionMap", "stateVersion"],
  },
  {
    seam: "unknown-events-stay-unsupported",
    file: "packages/core/session/src/known-event-types.ts",
    patterns: ["a registration surface for them is deferred", "Downstream (out-of-repo) plugin events"],
  },
  {
    seam: "project-skill-provider",
    file: "packages/skill/skill-filesystem/src/index.ts",
    patterns: ["customSkillDirs?: string[]", "PROJECT_DSH_RANK", "PROJECT_AGENTS_RANK"],
  },
  {
    seam: "web-index-composition",
    file: "packages/host/webserver/src/index.ts",
    patterns: ["tapIndex(transform", "register(route", "registerFallback"],
  },
  {
    seam: "native-four-surface-composition",
    file: "packages/bundle/web-app/cordis.patch.yml",
    patterns: ["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-runtime"],
  },
];

const results = [];
for (const check of checks) {
  const text = await readFile(join(sourceRoot, check.file), "utf8");
  const missing = check.patterns.filter((pattern) => !text.includes(pattern));
  results.push({
    seam: check.seam,
    file: check.file,
    proven: missing.length === 0,
    missing,
  });
}

const failed = results.filter((result) => !result.proven);
process.stdout.write(`${JSON.stringify({
  repository: lock.repository,
  commit,
  version: lock.version,
  checks: results,
}, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;
