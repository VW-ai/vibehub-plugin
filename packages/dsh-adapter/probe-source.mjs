#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  process.stderr.write("Usage: node packages/dsh-adapter/probe-source.mjs /absolute/path/to/deepseek-harness\n");
  process.exit(1);
}

const lock = JSON.parse(
  await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"),
);
const adapterRoot = dirname(fileURLToPath(import.meta.url));
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
    adapterFile: "../dsh-bundle/package.json",
    adapterPatterns: ['"dsh"', '"bundle"', '"./client": "./adapter/client.js"'],
  },
  {
    seam: "additive-task-view",
    file: "packages/client/ui-conversation/src/client/contract/slots.ts",
    patterns: ["'conversation.view'", "'conversation.session.header.actions'", "'conversation.chat.assistant-actions'"],
    adapterFile: "client.js",
    adapterPatterns: ['ctx.slots.inject("conversation.view"', "ctx.slots.register({", 'label: () => "Tasks"'],
  },
  {
    seam: "additive-global-task-surface",
    file: "packages/client/ui-layout/src/client/index.ts",
    patterns: ["'shell.overlay'", "kind: 'list'", "scope: 'root'"],
    adapterFile: "client.js",
    adapterPatterns: ['ctx.slots.inject("shell.overlay"', 'id: "vibehub-task-workbench"', 'label: () => "Tasks"'],
  },
  {
    seam: "slot-injection-lifecycle",
    file: "packages/client/runtime/src/client/slots.ts",
    patterns: ["inject(key: keyof SlotMap", "function register(this: SlotRegistry", "slots.register()"],
    adapterFile: "client.js",
    adapterPatterns: ["ctx.slots.inject(", "ctx.slots.register({"],
  },
  {
    seam: "native-workspace-session-routing",
    file: "packages/client/runtime/src/client/contract/workspaces.ts",
    patterns: ["create(input: { path: string })", "connectWorkspace(workspaceId", "Promise<SessionId>"],
    adapterFile: "client.js",
    adapterPatterns: ["ctx.workspaces.create({ path: repoRoot })", "ctx.workspaces.connectWorkspace(workspace.workspaceId)"],
  },
  {
    seam: "native-session-binding-and-open",
    file: "packages/client/runtime/src/client/sessions/service.ts",
    patterns: ["open(id: SessionId)", "binding(id: SessionId)", "SessionBinding | undefined"],
    adapterFile: "client.js",
    adapterPatterns: ["ctx.sessions.open(sessionId)", "ctx.sessions.binding(sessionId)?.session"],
  },
  {
    seam: "native-client-projection-hooks",
    file: "packages/client/runtime/src/client/index.ts",
    patterns: ["useProjection: UseProjection", "useSessions: SnapshotSelectorHook"],
    adapterFile: "client.js",
    adapterPatterns: ["useProjection(\"vibehubTask\")", "useSessions((state)"],
  },
  {
    seam: "trusted-session-presence",
    file: "packages/client/runtime/src/client/sessions/service.ts",
    patterns: ["running: boolean", "pendingInteraction?: PendingInteractionStatus", "completed?: boolean"],
    adapterFile: "client.js",
    adapterPatterns: ["Boolean(state.byId[sessionId]?.running)", "pendingInteraction"],
  },
  {
    seam: "native-session-prompt",
    file: "packages/client/runtime/src/client/sessions/session.ts",
    patterns: ["async prompt(", "mode: 'queue' | 'steer'", "this.api.sessions.prompt"],
    adapterFile: "client.js",
    adapterPatterns: ["connection.session.prompt([", "\"queue\""],
  },
  {
    seam: "native-session-command",
    file: "packages/client/runtime/src/client/sessions/session.ts",
    patterns: ["async command(line: string)", "this.remote.commands.execute(this.sessionId, line, [])"],
    adapterFile: "client.js",
    adapterPatterns: ["connection.session.command(`/vibehub-task ${encoded}`)"],
  },
  {
    seam: "native-session-search-and-fork",
    file: "packages/client/runtime/src/client/contract/sessions.ts",
    patterns: ["search(", "fork(opts: { sessionId: SessionId", "Promise<SessionId>"],
    adapterFile: "harness.mjs",
    adapterPatterns: ["sessions.search(input.query", "sessions.fork({ sessionId: input.conversationId"],
  },
  {
    seam: "native-session-interruption",
    file: "packages/client/runtime/src/client/contract/session.ts",
    patterns: ["cancel(): Promise<RpcResult<{", "accepted: true"],
    adapterFile: "harness.mjs",
    adapterPatterns: ["binding(input.conversationId).cancel()"],
  },
  {
    seam: "native-prompt-image-and-audio-boundary",
    file: "packages/host/apiproxy/src/api/sessions.ts",
    patterns: ["export type PromptContentPart", "type: 'text'", "type: 'image'"],
    forbiddenPatterns: ["type: 'audio'"],
  },
  {
    seam: "registered-command-lifecycle",
    file: "packages/interaction/commands/src/index.ts",
    patterns: ["'command/run'", "'command/done'", "recordInput", "without sending it to the model"],
    adapterFile: "host.js",
    adapterPatterns: ["ctx.commands.register({", 'name: "vibehub-task"', "recordInput: true"],
  },
  {
    seam: "runtime-session-projection",
    file: "packages/session/session-projection/src/index.ts",
    patterns: ["sessionProjections.register()", "register<K extends keyof SessionProjectionMap", "stateVersion"],
    adapterFile: "host.js",
    adapterPatterns: ["ctx.sessionProjections.register(taskLinkProjectionDefinition())"],
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
    adapterFile: "../dsh-bundle/cordis.patch.yml",
    adapterPatterns: ["customSkillDirs:", "skills"],
  },
  {
    seam: "native-tool-runtime",
    file: "packages/core/tools/src/index.ts",
    patterns: ["export class ToolRuntime", "register(", "'tools/pre-execute'", "'tools/execute'", "'tools/post-execute'"],
  },
  {
    seam: "native-approval-runtime",
    file: "packages/interaction/user-approval/src/index.ts",
    patterns: ["export class ApprovalService", "'approval/request'", "'approval/asked'", "'approval/decided'"],
  },
  {
    seam: "native-permission-presets",
    file: "packages/interaction/permission-presets/src/index.ts",
    patterns: ["export class PermissionPresetService", "sandbox: 'workspace-write', approval: 'ask'", "name: 'permission'"],
  },
  {
    seam: "native-delegated-work",
    file: "packages/bundle/base/package.json",
    patterns: ["@deepseek-ai/dsh-tool-subagent", "@deepseek-ai/dsh-subagent-fork-in-process", "@deepseek-ai/dsh-tool-subagent-control"],
  },
  {
    seam: "web-route-and-port-contract",
    file: "packages/host/webserver/src/index.ts",
    patterns: ["get port(): number", "register(route: WebRoute)", "registerFallback"],
    adapterFile: "host.js",
    adapterPatterns: ["ctx.webServer.port", "ctx.webServer.register({", 'path: "/vibehub/bootstrap"'],
  },
  {
    seam: "cordis-effect-cleanup",
    file: "docs/cordis-api/fiber.md",
    patterns: ["ctx.effect(execute, label?)", "disposer"],
    adapterFile: "host.js",
    adapterPatterns: ["ctx.effect(() => () => graph.close()", "ctx.effect(() => ctx.webServer.register({"],
  },
  {
    seam: "official-theme-aliases",
    file: "packages/client/ui-theme/src/styles/design-platform.css",
    patterns: ["--dsw-alias-bg-base", "--dsw-alias-label-primary"],
    adapterFile: "client.js",
    adapterPatterns: ["--dsw-alias-bg-base", "--dsw-alias-label-primary"],
  },
  {
    seam: "native-theme-runtime",
    file: "packages/client/ui-theme/src/client/index.ts",
    patterns: ["export class ThemeRuntime", "setTheme(id: string)", "overrideTokens(source: string", "getTheme(): ThemeSnapshot"],
  },
  {
    seam: "native-four-surface-composition",
    file: "packages/bundle/web-app/cordis.patch.yml",
    patterns: ["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-runtime"],
    adapterFile: "../dsh-bundle/package.json",
    adapterPatterns: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-conversation"],
  },
  {
    seam: "base-package-has-no-codex-runtime",
    file: "packages/bundle/base/package.json",
    patterns: ["@deepseek-ai/dsh-agent-loop", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-user-approval"],
    forbiddenPatterns: ["@openai/codex"],
  },
  {
    seam: "web-package-has-no-codex-runtime",
    file: "packages/bundle/web-app/package.json",
    patterns: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-theme"],
    forbiddenPatterns: ["@openai/codex"],
    adapterFile: "package.json",
    adapterPatterns: ["@deepseek-ai/dsh"],
    adapterForbiddenPatterns: ["@openai/codex"],
  },
];

const results = [];
for (const check of checks) {
  const text = await readFile(join(sourceRoot, check.file), "utf8");
  const missing = check.patterns.filter((pattern) => !text.includes(pattern));
  const forbidden = (check.forbiddenPatterns ?? []).filter((pattern) => text.includes(pattern));
  const adapterText = check.adapterFile
    ? await readFile(resolve(adapterRoot, check.adapterFile), "utf8")
    : "";
  const missingUsage = (check.adapterPatterns ?? [])
    .filter((pattern) => !adapterText.includes(pattern));
  const forbiddenUsage = (check.adapterForbiddenPatterns ?? [])
    .filter((pattern) => adapterText.includes(pattern));
  results.push({
    seam: check.seam,
    file: check.file,
    adapterFile: check.adapterFile ?? null,
    proven: missing.length === 0 && missingUsage.length === 0 && forbidden.length === 0 && forbiddenUsage.length === 0,
    missing,
    missingUsage,
    forbidden,
    forbiddenUsage,
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
