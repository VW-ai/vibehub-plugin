import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbeObserver, createProbeToolHandler, probeSucceeded } from '../probe-codex-host.mjs';

test('probe exposes bounded event metadata, stable per-run item labels and exact synthetic ack only', () => {
  const observer = createProbeObserver('ACK');
  observer.accept({ type: 'thread.started', thread_id: 'synthetic-thread' }, 0);
  observer.accept({ type: 'item.started', item: { id: 'private-item', type: 'mcp_tool_call', arguments: { apiKey: 'CANARY' } } }, 2);
  observer.accept({ type: 'item.completed', item: { id: 'private-item', type: 'mcp_tool_call', result: 'CANARY' } }, 3);
  observer.accept({ type: 'item.completed', item: { id: 'assistant', type: 'agent_message', text: 'ACK' } }, 4);
  observer.accept({ type: 'turn.completed', usage: { opaque: 'CANARY' } }, 5);
  const report = observer.report();
  assert.equal(observer.threadId(), 'synthetic-thread');
  assert.equal(report.events[1].item, report.events[2].item);
  assert.equal(report.assistant_ack, true); assert.equal(report.turn_completed, true);
  assert.equal(JSON.stringify(report).includes('CANARY'), false);
  assert.equal(JSON.stringify(report).includes('private-item'), false);
  assert.equal(JSON.stringify(report).includes('synthetic-thread'), false);
});

test('unknown events, diagnostic contents, malformed identities and oversized streams never become capture claims', () => {
  const observer = createProbeObserver('ACK');
  observer.accept({ type: 'user.message', text: 'secret' }, 0);
  observer.accept({ type: 'thread.started', thread_id: 'private/path' }, 1);
  observer.accept({ type: 'error', message: 'CANARY' }, 2);
  observer.accept({ type: 'item.completed', item: { type: 'new_unknown', text: 'ACK' } }, 3);
  assert.equal(observer.threadId(), undefined);
  assert.equal(observer.report().assistant_ack, false);
  assert.equal(observer.report().failure_observed, true);
  assert.equal(JSON.stringify(observer.report()).includes('CANARY'), false);
  for (let i = 3; i < 1000; i++) observer.accept({ type: 'turn.started' }, i);
  assert.throws(() => observer.accept({ type: 'turn.started' }, 1001), /event_limit/);
});

test('synthetic query and explicit nonce acknowledgement require a real matching tool response', () => {
  const handle = createProbeToolHandler();
  assert.equal(handle({ method: 'notifications/initialized' }), null);
  const tools = handle({ id: 1, method: 'tools/list' }).result.tools;
  assert.deepEqual(tools.map(t => t.name), ['get_context', 'ack_context']);
  assert.equal(handle({ id: 2, method: 'tools/call', params: { name: 'ack_context', arguments: { nonce: 'forged' } } }).result.isError, true);
  const context = JSON.parse(handle({ id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } }).result.content[0].text);
  const ack = handle({ id: 4, method: 'tools/call', params: { name: 'ack_context', arguments: { nonce: context.nonce } } });
  assert.equal(ack.result.content[0].text, 'VH_CONTEXT_ACK');
  assert.equal(ack.result.isError, false);
  assert.equal(handle({ id: 5, method: 'tools/call', params: { name: 'read_any_file', arguments: {} } }).result.isError, true);
});

test('a printed acknowledgement alone never makes a failed or incomplete live probe pass', () => {
  const turn = { assistant_ack: true, turn_completed: true, exit_code: 0, timed_out: false,
    malformed_stream: false, failure_observed: false, events: Array.from({ length: 2 }, () => ({ event: 'item.completed', item_type: 'mcp_tool_call' })) };
  const report = { first: turn, resumed: turn, same_thread_after_process_restart: true };
  assert.equal(probeSucceeded(report), true);
  for (const mutation of [{ exit_code: 1 }, { timed_out: true }, { failure_observed: true }, { malformed_stream: true }, { turn_completed: false }, { events: [] }]) {
    assert.equal(probeSucceeded({ ...report, first: { ...turn, ...mutation } }), false);
  }
  assert.equal(probeSucceeded({ ...report, resumed: null }), false);
  assert.equal(probeSucceeded({ ...report, same_thread_after_process_restart: false }), false);
});
