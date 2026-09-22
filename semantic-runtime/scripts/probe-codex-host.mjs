// Opt-in integration measurement, not a production Collector or transcript reader.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const self = fileURLToPath(import.meta.url);
const EVENTS = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
const ITEMS = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
const fail = code => Object.assign(new Error(`Codex probe: ${code}`), { code });

// Only metadata and a boolean about an exact synthetic receipt leave this parser.
// Never use this to claim CLI JSONL contains user messages or every model message.
export function createProbeObserver(expectedAck) {
  const labels = new Map(), rows = []; let threadId, ack = false, completed = false, failed = false;
  const label = id => {
    if (typeof id !== 'string' || !id.length || id.length > 200) return null;
    if (!labels.has(id)) labels.set(id, `item-${labels.size + 1}`);
    return labels.get(id);
  };
  return {
    accept(event, elapsedMs) {
      if (!event || !EVENTS.has(event.type) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      if (rows.length >= 1000) throw fail('event_limit');
      if (event.type === 'thread.started' && typeof event.thread_id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(event.thread_id)) threadId = event.thread_id;
      const item = event.item;
      rows.push({ sequence: rows.length + 1, elapsed_ms: Math.round(elapsedMs), event: event.type,
        ...(item && ITEMS.has(item.type) ? { item_type: item.type, item: label(item.id) } : {}) });
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') ack ||= item.text.trim() === expectedAck;
      completed ||= event.type === 'turn.completed'; failed ||= ['error', 'turn.failed'].includes(event.type);
    },
    // The runner uses only this newly created synthetic ID, never --last/list.
    threadId: () => threadId,
    report: () => ({ events: structuredClone(rows), assistant_ack: ack, turn_completed: completed, failure_observed: failed }),
  };
}

// Minimal read-only MCP fixture. No filesystem, shell, network, auth or user data.
export function createProbeToolHandler() {
  const nonce = randomUUID(); let queried = false;
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  return request => {
    if (request.id === undefined) return null;
    if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vibehub-synthetic-probe', version: '1' } });
    if (request.method === 'ping') return reply(request.id, {});
    if (request.method === 'tools/list') return reply(request.id, { tools: [
      { name: 'get_context', description: 'Read the synthetic probe context and its acknowledgement nonce.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      { name: 'ack_context', description: 'Acknowledge the nonce returned by get_context; this changes only this synthetic fixture memory.', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    ] });
    if (request.method === 'tools/call') {
      const p = request.params;
      if (p?.name === 'get_context' && p.arguments && !Object.keys(p.arguments).length) { queried = true; return reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ context: 'Synthetic project uses blue triangles.', nonce }) }], isError: false }); }
      if (p?.name === 'ack_context' && queried && p.arguments?.nonce === nonce && Object.keys(p.arguments).length === 1) return reply(request.id, { content: [{ type: 'text', text: 'VH_CONTEXT_ACK' }], isError: false });
      return reply(request.id, { content: [{ type: 'text', text: 'synthetic_invalid_request' }], isError: true });
    }
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported_probe_method' } };
  };
}

function childEnvironment() {
  // Let the CLI own its normal saved login. Never inspect/copy auth or API keys.
  return Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'CODEX_HOME'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}
function configArgs() {
  const entries = {
    'features.shell_tool': 'false', 'features.unified_exec': 'false', 'features.plugins': 'false',
    'features.apps': 'false', 'features.multi_agent': 'false', 'features.skill_mcp_dependency_install': 'false',
    'tools.view_image': 'false', web_search: '"disabled"', project_doc_max_bytes: '0',
    'skills.max_context_tokens': '1', model_reasoning_effort: '"low"',
    'shell_environment_policy.inherit': '"none"',
    'mcp_servers.vh_probe.command': JSON.stringify(process.execPath),
    'mcp_servers.vh_probe.args': JSON.stringify([self, '--mcp']),
    'mcp_servers.vh_probe.required': 'true',
    developer_instructions: JSON.stringify('This is a synthetic capability probe. Do not inspect files, environment, credentials, skills, other projects or sessions. Use only the vh_probe MCP tools if asked, then give the exact requested short reply. Do not delegate.'),
  };
  return Object.entries(entries).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}
async function runTurn(cwd, prompt, expectedAck, threadId) {
  const observer = createProbeObserver(expectedAck), started = performance.now();
  const args = ['exec', ...configArgs(), '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--json',
    ...(threadId ? ['resume', threadId, '-'] : ['-'])];
  const child = spawn('codex', args, { cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', bytes = 0, bad = false, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90_000);
  child.stderr.resume(); // Never forward host diagnostics or provider errors.
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { bad = true; child.kill('SIGKILL'); return; }
    stdout += chunk.toString('utf8');
    let at;
    while ((at = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, at); stdout = stdout.slice(at + 1);
      try { observer.accept(JSON.parse(line), performance.now() - started); }
      catch { bad = true; child.kill('SIGKILL'); }
    }
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise(resolve => { child.on('error', () => resolve(null)); child.on('close', resolve); });
  clearTimeout(timer);
  return { threadId: observer.threadId(), report: { ...observer.report(), exit_code: exitCode,
    timed_out: timedOut, malformed_stream: bad || Boolean(stdout.trim()), elapsed_ms: Math.round(performance.now() - started) } };
}

export async function probeCodexHost() {
  const versionResult = spawnSync('codex', ['--version'], { encoding: 'utf8', env: childEnvironment() });
  const match = versionResult.stdout?.trim().match(/^codex-cli (\d+\.\d+\.\d+)$/);
  if (versionResult.status !== 0 || !match) throw fail('codex_unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'vh-codex-synthetic-'));
  try {
    if (spawnSync('git', ['init', '--quiet', dir], { env: childEnvironment() }).status !== 0) throw fail('temporary_git_failed');
    const first = await runTurn(dir, 'Call vh_probe get_context exactly once, then call ack_context with its returned nonce. If the tool acknowledges successfully, reply exactly VH_CONTEXT_ACK. Do nothing else.', 'VH_CONTEXT_ACK');
    let second = null;
    if (first.threadId && first.report.turn_completed && first.report.assistant_ack && first.report.exit_code === 0) second = await runTurn(dir,
      'This is the next synthetic user turn. Reply exactly VH_NEXT_TURN_ACK. Do not call any tool.', 'VH_NEXT_TURN_ACK', first.threadId);
    return { schema_version: 1, host: 'codex-cli', version: match[1], surface: 'exec-jsonl-with-stdio-mcp',
      synthetic_only: true, first: first.report, resumed: second?.report ?? null,
      same_thread_after_process_restart: Boolean(second && first.threadId === second.threadId),
      limits: ['Only this newly created synthetic session is selected.', 'CLI does not prove Desktop/plugin coverage.', 'Compaction and crash replay were not exercised.', 'Receipt is transport/model observation, not durable service acceptance.'] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function probeSucceeded(report) {
  const completed = turn => turn?.assistant_ack === true && turn.turn_completed === true
    && turn.exit_code === 0 && turn.timed_out === false && turn.malformed_stream === false && turn.failure_observed === false;
  return completed(report?.first) && completed(report?.resumed) && report.same_thread_after_process_restart === true
    && report.first.events.filter(row => row.event === 'item.completed' && row.item_type === 'mcp_tool_call').length >= 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--mcp') {
    const handle = createProbeToolHandler();
    const lines = createInterface({ input: process.stdin });
    lines.on('line', line => { if (line.length > 16_384) return; try { const response = handle(JSON.parse(line)); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); } catch {} });
  } else if (process.argv.length === 3 && process.argv[2] === '--live-synthetic') {
    try { const report = await probeCodexHost(); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (!probeSucceeded(report)) process.exitCode = 1; }
    catch (error) { process.stderr.write(`${error?.code === 'codex_unavailable' ? 'codex_unavailable' : 'probe_failed'}\n`); process.exitCode = 1; }
  } else { process.stdout.write('Opt-in: node scripts/probe-codex-host.mjs --live-synthetic (at most two subscription turns; synthetic project only)\n'); }
}
