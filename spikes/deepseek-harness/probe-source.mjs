#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const sourceRoot = resolve(process.argv[2] ?? '')
if (!process.argv[2]) {
  process.stderr.write('Usage: node probe-source.mjs /absolute/path/to/deepseek-harness\n')
  process.exit(1)
}

const lock = JSON.parse(await readFile(new URL('./upstream-lock.json', import.meta.url), 'utf8'))
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
if (commit !== lock.commit) throw new Error(`expected ${lock.commit}, received ${commit}`)

const checks = [
  {
    seam: 'bundle-profile',
    file: 'docs/user/develop/basic/publish.md',
    patterns: ['dsh.bundle', 'dsh.profile', 'dsh plugin --profile demo add'],
  },
  {
    seam: 'root-layout-replacement',
    file: 'packages/client/ui-layout/src/client/index.ts',
    patterns: ["name: 'root'", "'sidebar': { kind: 'single'", "'conversation': { kind: 'single'", "'shell.overlay': { kind: 'list'"],
  },
  {
    seam: 'conversation-extension',
    file: 'packages/client/ui-conversation/src/client/contract/slots.ts',
    patterns: ["'conversation.session.header.actions'", "'conversation.view'", "'conversation.chat.assistant-actions'", "'conversation.input.dock'"],
  },
  {
    seam: 'custom-conversation-node',
    file: 'packages/client/ui-workflow-run/src/client/index.ts',
    patterns: ['conversationEvents.register', "name: 'conversation.chat.node'", "key: 'workflow-run'"],
  },
  {
    seam: 'session-fork',
    file: 'packages/core/session/src/index.ts',
    patterns: ['fork(source: SessionForkSource', 'parentSession: liveSource.id', "'OPEN_TURN'"],
  },
  {
    seam: 'human-command',
    file: 'packages/interaction/commands/src/index.ts',
    patterns: ['without sending it to the model', "'command/run'", "'command/done'", 'register(definition: CommandDefinition)'],
  },
  {
    seam: 'durable-event-feed',
    file: 'packages/core/session/src/index.ts',
    patterns: ["'session/event'", 'append-only session log', 'SessionEventMap'],
  },
  {
    seam: 'local-web',
    file: 'packages/bundle/web-app/cordis.patch.yml',
    patterns: ["host: !!js ctx.webStartup.host ?? '127.0.0.1'", 'name: \'@deepseek-ai/dsh-host-webserver\'', 'name: \'@deepseek-ai/dsh-client-ui-layout\''],
  },
  {
    seam: 'codex-provider-limit',
    file: 'packages/subagent/subagent-codex/README.md',
    patterns: ['no continuation, resume, pooling, progress stream', 'final text only', 'No human approval path'],
  },
]

const result = []
for (const check of checks) {
  const text = await readFile(join(sourceRoot, check.file), 'utf8')
  const missing = check.patterns.filter(pattern => !text.includes(pattern))
  result.push({ seam: check.seam, file: check.file, proven: missing.length === 0, missing })
}

const failed = result.filter(item => !item.proven)
process.stdout.write(`${JSON.stringify({ commit, version: lock.version, checks: result }, null, 2)}\n`)
if (failed.length) process.exitCode = 1
