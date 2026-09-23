// Explicit synthetic measurement. Never read a user's transcript/auth/config file.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createProbeToolHandler } from '../codex/probe-codex-host.mjs';

const self = fileURLToPath(import.meta.url);
const HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'PreCompact', 'PostCompact']);
const TYPES = new Set(['system', 'user', 'assistant', 'result', 'stream_event', 'tool_progress', 'tool_use_summary']);
const SUBTYPES = new Set(['init', 'success', 'error_max_turns', 'error_during_execution', 'hook_started', 'hook_progress', 'hook_response', 'compact_boundary', 'status']);
const STREAM_TYPES = new Set(['message_start', 'message_delta', 'message_stop', 'content_block_start', 'content_block_delta', 'content_block_stop']);
const TOOLS = ['mcp__vh_probe__get_context', 'mcp__vh_probe__ack_context'];
const PHASES = new Set(['first', 'compact', 'resumed']);
const fail = code => Object.assign(new Error(`Claude probe: ${code}`), { code });

// registration is trusted launcher metadata, never a field claimed by a model.
// Inputs must already be canonical paths. Production activation/auth is elsewhere.
export function admitClaudeCollection(registration, event) {
  return registration?.enabled === true && registration.origin === 'interactive'
    && typeof registration.projectRoot === 'string' && registration.projectRoot.startsWith('/')
    && registration.projectRoot === event?.cwd && typeof registration.sessionId === 'string'
    && registration.sessionId.length > 0 && registration.sessionId === event.session_id;
}
export function projectClaudeHook(registration, payload, at = Date.now()) {
  if (!HOOKS.has(payload?.hook_event_name) || !Number.isFinite(at)) return null;
  return { hook: payload.hook_event_name, at_ms: at,
    ...(PHASES.has(registration.phase) ? { phase: registration.phase } : {}),
    ...(['manual', 'auto'].includes(payload.trigger) ? { trigger: payload.trigger } : {}),
    ...(['startup', 'resume', 'clear', 'compact'].includes(payload.source) ? { source: payload.source } : {}),
    selected_project_session: payload.cwd === registration.projectRoot && payload.session_id === registration.sessionId,
    collection_admitted: admitClaudeCollection(registration, payload),
    has_prompt: typeof payload.prompt === 'string', has_last_assistant_message: typeof payload.last_assistant_message === 'string',
    has_tool_use_id: typeof payload.tool_use_id === 'string', has_compact_summary: typeof payload.compact_summary === 'string' };
}
export function createClaudeObserver(expectedAck, expectedSession) {
  const rows = [], labels = new Map(); let assistantAck = false, resultAck = false, successful = false, errors = false, sameSession = false, toolAck = false, compactBoundary = false, commandDiagnostic = null;
  const label = value => { if (typeof value !== 'string' || value.length > 200) return null; if (!labels.has(value)) labels.set(value, `id-${labels.size + 1}`); return labels.get(value); };
  return {
    accept(event, elapsed) {
      if (!TYPES.has(event?.type) || !Number.isFinite(elapsed) || elapsed < 0) return;
      if (rows.length >= 1000) throw fail('event_limit');
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      const blockTypes = blocks.map(b => b?.type).filter(t => ['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(t));
      rows.push({ sequence: rows.length + 1, elapsed_ms: Math.round(elapsed), type: event.type,
        ...(SUBTYPES.has(event.subtype) ? { subtype: event.subtype } : {}),
        ...(STREAM_TYPES.has(event.event?.type) ? { stream_type: event.event.type } : {}),
        ...(blockTypes.length ? { block_types: blockTypes } : {}),
        ...(event.uuid ? { event_id: label(event.uuid) } : {}),
        ...(event.message?.id ? { message_id: label(event.message.id) } : {}),
        ...(blocks.some(b => b?.type === 'tool_use') ? { tools: blocks.filter(b => b?.type === 'tool_use').map(b => TOOLS.includes(b.name) ? b.name : 'other') } : {}) });
      if (event.type === 'system' && event.subtype === 'init') sameSession = event.session_id === expectedSession;
      if (event.type === 'system' && event.subtype === 'compact_boundary' && event.session_id === expectedSession) compactBoundary = true;
      if (event.type === 'assistant') assistantAck ||= blocks.some(b => b?.type === 'text' && b.text?.trim() === expectedAck);
      for (const b of blocks.filter(b => b?.type === 'tool_result' && !b.is_error)) {
        const content = Array.isArray(b.content) ? b.content : [{ text: b.content }];
        toolAck ||= content.some(c => c?.text === 'VH_CONTEXT_ACK');
      }
      if (event.type === 'result') {
        successful = event.subtype === 'success' && event.is_error !== true; resultAck = event.result?.trim() === expectedAck; errors ||= !successful;
        if (expectedAck === null && typeof event.result === 'string') {
          // Classify bounded host command diagnostics without exposing raw text.
          commandDiagnostic = /too (short|few)|not enough|no (messages|conversation|context)/i.test(event.result) ? 'insufficient_context'
            : /unknown (command|skill)|not (supported|available)|unsupported|disabled|cannot.*(print|non.?interactive)|can't.*(print|non.?interactive)/i.test(event.result) ? 'unavailable_command'
            : /compact.*(failed|error)|failed.*compact/i.test(event.result) ? 'compaction_error'
            : event.result.length ? 'unclassified_response' : 'empty_response';
        }
      }
    },
    report: () => ({ events: structuredClone(rows), assistant_ack: assistantAck, result_ack: resultAck,
      result_success: successful, error_observed: errors, selected_session: sameSession, tool_ack: toolAck, compact_boundary: compactBoundary, command_diagnostic: commandDiagnostic }),
  };
}
function environment() {
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
export function claudeProbeInvocation(phase, marker) {
  if (!PHASES.has(phase) || !/^VH_HOOK_[a-f0-9]{32}$/.test(marker)) throw fail('invalid_invocation');
  return { expected: phase === 'compact' ? null : `${phase === 'first' ? 'VH_CONTEXT_ACK' : 'VH_NEXT_TURN_ACK'} ${marker}`,
    prompt: phase === 'compact' ? '/compact Preserve the synthetic protocol probe history briefly.' : phase === 'resumed'
      ? 'Next synthetic turn: reply exactly VH_NEXT_TURN_ACK followed by the marker supplied by this turn\'s UserPromptSubmit hook, separated by one space. Do not call tools.'
      : 'Call vh_probe get_context exactly once, then ack_context with its returned nonce. Reply only with the successful acknowledgement text followed by the marker supplied by the UserPromptSubmit hook, separated by one space. Do not inspect any files or call other tools.' };
}
async function runClaude(dir, log, sessionId, phase, marker) {
  const command = [process.execPath, self, '--hook', dir, log, sessionId, phase, marker].map(quote).join(' ');
  const settings = { claudeMdExcludes: ['**'], autoMemoryEnabled: false,
    hooks: Object.fromEntries([...HOOKS].map(name => [name, [{ hooks: [{ type: 'command', command, timeout: 3 }] }]])) };
  const mcp = { mcpServers: { vh_probe: { command: process.execPath, args: [self, '--mcp'] } } };
  const { expected, prompt } = claudeProbeInvocation(phase, marker);
  const args = ['-p', '--restricted', '--setting-sources', '', '--settings', JSON.stringify(settings), '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--tools', '', '--allowedTools', TOOLS.join(','), ...(phase === 'compact' ? [] : ['--disable-slash-commands']), '--no-chrome', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--model', 'haiku', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--include-hook-events', '--replay-user-messages',
    '--system-prompt', 'You are running an isolated synthetic protocol probe. Use only the two supplied MCP tools and synthetic hook context when requested. Never inspect files, credentials, other projects or sessions, or delegate. Return the exact short acknowledgement requested.',
    ...(phase === 'first' ? ['--session-id', sessionId] : ['--resume', sessionId])];
  const started = performance.now(), observer = createClaudeObserver(expected, sessionId);
  const child = spawn('claude', args, { cwd: dir, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '', bytes = 0, malformed = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90_000);
  child.stderr.resume(); child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    bytes += chunk.length; if (bytes > 2_097_152) { malformed = true; child.kill('SIGKILL'); return; }
    pending += chunk.toString('utf8'); let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      try { observer.accept(JSON.parse(line), performance.now() - started); } catch { malformed = true; child.kill('SIGKILL'); }
    }
  });
  child.stdin.end(`${JSON.stringify({ type: 'user', uuid: randomUUID(), session_id: sessionId, message: { role: 'user', content: prompt } })}\n`);
  const code = await new Promise(resolve => { child.on('error', () => resolve(null)); child.on('close', resolve); }); clearTimeout(timer);
  return { ...observer.report(), exit_code: code, malformed_stream: malformed || Boolean(pending.trim()), timed_out: timedOut, elapsed_ms: Math.round(performance.now() - started) };
}
export function claudeProbeSucceeded(report) {
  const pass = r => r?.assistant_ack === true && r.result_ack === true && r.result_success === true && r.error_observed === false
    && r.selected_session === true && r.exit_code === 0 && r.malformed_stream === false && r.timed_out === false;
  return pass(report?.first) && pass(report?.resumed) && report.first.tool_ack === true
    && report.fresh_hook_markers === true && report.compaction?.status === 'completed'
    && report.compaction.pre_hook === true && report.compaction.post_hook === true;
}
export function classifyClaudeCompaction(turn, hooks) {
  const matching = hooks.filter(h => h.phase === 'compact' && h.selected_project_session === true && h.trigger === 'manual');
  const pre = matching.some(h => h.hook === 'PreCompact'), post = matching.some(h => h.hook === 'PostCompact');
  const clean = turn?.exit_code === 0 && turn.malformed_stream === false && turn.timed_out === false && turn.error_observed === false
    && turn.result_success === true && turn.selected_session === true;
  return { attempted: turn !== null, mechanism: 'native-/compact-command',
    status: clean && turn.compact_boundary === true && pre && post ? 'completed' : turn === null ? 'not_attempted' : 'no_completed_compaction',
    pre_hook: pre, post_hook: post, turn };
}
export async function probeClaudeHost() {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', env: environment() });
  const match = version.stdout?.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
  if (version.status !== 0 || !match) throw fail('host_unavailable');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'vh-claude-synthetic-'))), log = join(dir, 'probe-hooks.ndjson'), sessionId = randomUUID();
  try {
    if (spawnSync('git', ['init', '--quiet', dir], { env: environment() }).status !== 0) throw fail('temporary_git_failed');
    const markers = Array.from({ length: 3 }, () => `VH_HOOK_${randomUUID().replaceAll('-', '')}`);
    const first = await runClaude(dir, log, sessionId, 'first', markers[0]);
    const canResume = first.result_success && first.assistant_ack && first.exit_code === 0;
    const compact = canResume ? await runClaude(dir, log, sessionId, 'compact', markers[1]) : null;
    const resumed = canResume ? await runClaude(dir, log, sessionId, 'resumed', markers[2]) : null;
    const hooks = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { schema_version: 2, host: 'claude-code', version: match[1], surface: 'print-stream-json-with-mcp-and-invocation-hooks',
      source_origin: 'probe', fresh_hook_markers: new Set(markers).size === 3,
      first, compaction: classifyClaudeCompaction(compact, hooks), resumed, hooks,
      limits: ['Not an interactive TTY/plugin installation test.', 'Automatic compaction and crash replay untested.', 'All probe/Worker-origin events excluded from user collection.'] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
if (process.argv[1] === self) {
  if (process.argv[2] === '--mcp') {
    const handle = createProbeToolHandler(), lines = createInterface({ input: process.stdin });
    lines.on('line', line => { if (line.length > 16384) return; try { const result = handle(JSON.parse(line)); if (result) process.stdout.write(`${JSON.stringify(result)}\n`); } catch {} });
  } else if (process.argv[2] === '--hook' && process.argv.length === 8) {
    const [, , , projectRoot, log, sessionId, phase, marker] = process.argv; let text = '';
    try { claudeProbeInvocation(phase, marker); } catch { process.exit(0); }
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 262144) process.exit(0); }
    try {
      const payload = JSON.parse(text), row = projectClaudeHook({ projectRoot, sessionId, phase, enabled: true, origin: 'probe' }, payload);
      if (row?.selected_project_session) {
        appendFileSync(log, `${JSON.stringify(row)}\n`, { mode: 0o600 });
        if (row.hook === 'UserPromptSubmit') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Synthetic probe marker: ${marker}.` } }));
      }
    } catch {} // Hook failure must not emit incoming prompt/diagnostics.
  } else if (process.argv.length === 3 && process.argv[2] === '--live-synthetic') {
    try { const report = await probeClaudeHost(); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (!claudeProbeSucceeded(report)) process.exitCode = 1; }
    catch { process.stderr.write('claude_probe_failed\n'); process.exitCode = 1; }
  } else process.stdout.write('Opt-in: npm run probe:claude:live (at most three saved-login invocations, including /compact; synthetic project only)\n');
}
