import test from 'node:test';
import assert from 'node:assert/strict';
import { admitClaudeCollection, projectClaudeHook, createClaudeObserver, claudeProbeSucceeded, claudeProbeInvocation, classifyClaudeCompaction } from '../probe-claude-host.mjs';

test('trusted registration requires exact active project/session and excludes Worker/probe-origin recursion', () => {
  const registration = { projectRoot: '/synthetic/project', sessionId: 'session-1', enabled: true, origin: 'interactive' };
  const event = { cwd: '/synthetic/project', session_id: 'session-1' };
  assert.equal(admitClaudeCollection(registration, event), true);
  for (const change of [{ enabled: false }, { origin: 'worker' }, { origin: 'probe' }, { origin: 'unknown' }, { sessionId: 'other' }, { projectRoot: '/other' }]) assert.equal(admitClaudeCollection({ ...registration, ...change }, event), false);
  assert.equal(admitClaudeCollection(registration, { ...event, cwd: '/synthetic/project-sibling', origin: 'interactive' }), false);
  assert.equal(admitClaudeCollection(null, event), false);
});

test('hook projection removes prompts, transcript paths, tool contents and raw session IDs', () => {
  const registration = { projectRoot: '/synthetic/project', sessionId: 'secret-id', enabled: true, origin: 'probe' };
  const row = projectClaudeHook(registration, { hook_event_name: 'UserPromptSubmit', cwd: registration.projectRoot, session_id: registration.sessionId,
    prompt: 'CANARY', transcript_path: '/private/CANARY', tool_input: { apiKey: 'CANARY' } }, 1);
  assert.equal(row.selected_project_session, true); assert.equal(row.collection_admitted, false); assert.equal(row.has_prompt, true);
  assert.equal(JSON.stringify(row).includes('CANARY'), false); assert.equal(JSON.stringify(row).includes('secret-id'), false);
  assert.equal(projectClaudeHook(registration, { hook_event_name: 'unknown' }), null);
});

test('stream projection detects selected-session/tool/assistant receipts without exposing content', () => {
  const observer = createClaudeObserver('ACK', 'owned-session');
  observer.accept({ type: 'system', subtype: 'init', session_id: 'owned-session', cwd: 'CANARY', apiKey: 'CANARY' }, 1);
  observer.accept({ type: 'assistant', uuid: 'private-id', message: { id: 'private-message', content: [{ type: 'tool_use', name: 'mcp__vh_probe__get_context', input: { apiKey: 'CANARY' } }] } }, 2);
  observer.accept({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'VH_CONTEXT_ACK' }] }] } }, 3);
  observer.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'ACK' }] } }, 4);
  observer.accept({ type: 'result', subtype: 'success', result: 'ACK' }, 5);
  const r = observer.report(); assert.equal(r.assistant_ack, true); assert.equal(r.tool_ack, true); assert.equal(r.selected_session, true);
  assert.equal(JSON.stringify(r).includes('CANARY'), false); assert.equal(JSON.stringify(r).includes('private-id'), false);
  const turn = { ...r, exit_code: 0, malformed_stream: false, timed_out: false };
  const report = { first: turn, resumed: turn, fresh_hook_markers: true, compaction: { status: 'completed', pre_hook: true, post_hook: true } };
  assert.equal(claudeProbeSucceeded(report), true);
  for (const change of [{ result_success: false }, { exit_code: 1 }, { timed_out: true }, { error_observed: true }, { selected_session: false }]) assert.equal(claudeProbeSucceeded({ ...report, first: { ...turn, ...change } }), false);
  assert.equal(claudeProbeSucceeded({ ...report, fresh_hook_markers: false }), false);
  assert.equal(claudeProbeSucceeded({ ...report, compaction: { status: 'no_completed_compaction' } }), false);
});

test('fresh hook-only markers are absent from prompts and prior-turn recall cannot acknowledge the next marker', () => {
  const first = claudeProbeInvocation('first', `VH_HOOK_${'a'.repeat(32)}`);
  const next = claudeProbeInvocation('resumed', `VH_HOOK_${'b'.repeat(32)}`);
  assert.equal(first.prompt.includes('VH_HOOK_'), false); assert.equal(next.prompt.includes('VH_HOOK_'), false);
  assert.notEqual(first.expected, next.expected);
  const observer = createClaudeObserver(next.expected, 'selected');
  observer.accept({ type: 'assistant', message: { content: [{ type: 'text', text: `VH_NEXT_TURN_ACK VH_HOOK_${'a'.repeat(32)}` }] } }, 1);
  assert.equal(observer.report().assistant_ack, false);
  observer.accept({ type: 'assistant', message: { content: [{ type: 'text', text: next.expected }] } }, 2);
  assert.equal(observer.report().assistant_ack, true);
  assert.equal(JSON.stringify(observer.report()).includes('VH_HOOK_'), false);
  assert.match(claudeProbeInvocation('compact', `VH_HOOK_${'c'.repeat(32)}`).prompt, /^\/compact /);
  assert.throws(() => claudeProbeInvocation('resumed', 'bad marker'));
});

test('compaction completion needs selected-session native boundary plus both manual hooks; summary stays private', () => {
  const registration = { projectRoot: '/synthetic', sessionId: 'selected', origin: 'probe', enabled: true, phase: 'compact' };
  const hooks = ['PreCompact', 'PostCompact'].map(hook_event_name => projectClaudeHook(registration, {
    hook_event_name, cwd: '/synthetic', session_id: 'selected', trigger: 'manual', compact_summary: 'CANARY', custom_instructions: 'CANARY', transcript_path: 'CANARY',
  }, 1));
  assert.equal(JSON.stringify(hooks).includes('CANARY'), false);
  assert.equal(hooks[1].has_compact_summary, true);
  const observer = createClaudeObserver(null, 'selected');
  observer.accept({ type: 'system', subtype: 'init', session_id: 'selected' }, 0);
  observer.accept({ type: 'system', subtype: 'compact_boundary', session_id: 'foreign', compact_metadata: { summary: 'CANARY' } }, 1);
  assert.equal(observer.report().compact_boundary, false);
  observer.accept({ type: 'assistant', message: { content: [{ type: 'text', text: 'Compaction succeeded' }] } }, 2);
  assert.equal(observer.report().compact_boundary, false);
  observer.accept({ type: 'system', subtype: 'compact_boundary', session_id: 'selected', compact_metadata: { summary: 'CANARY' } }, 3);
  observer.accept({ type: 'result', subtype: 'success', result: '' }, 4);
  const turn = { ...observer.report(), exit_code: 0, malformed_stream: false, timed_out: false };
  assert.equal(classifyClaudeCompaction(turn, hooks).status, 'completed');
  for (const partial of [[], hooks.slice(0, 1), hooks.map(h => ({ ...h, selected_project_session: false })), hooks.map(h => ({ ...h, trigger: 'auto' }))]) {
    assert.equal(classifyClaudeCompaction(turn, partial).status, 'no_completed_compaction');
  }
  for (const change of [{ compact_boundary: false }, { timed_out: true }, { exit_code: 1 }, { error_observed: true }, { malformed_stream: true }, { result_success: false }, { selected_session: false }]) assert.equal(classifyClaudeCompaction({ ...turn, ...change }, hooks).status, 'no_completed_compaction');
  assert.equal(classifyClaudeCompaction(null, []).status, 'not_attempted');
  assert.equal(JSON.stringify(observer.report()).includes('CANARY'), false);
});

test('command diagnostics retain only an allowlisted category, never raw diagnostic text', () => {
  for (const [result, expected] of [
    ['Unknown command: /compact CANARY', 'unavailable_command'], ['Conversation is too short CANARY', 'insufficient_context'],
    ['Compaction failed CANARY', 'compaction_error'], ['CANARY', 'unclassified_response'], ['', 'empty_response'],
  ]) {
    const observer = createClaudeObserver(null, 'selected');
    observer.accept({ type: 'result', subtype: 'success', result }, 1);
    assert.equal(observer.report().command_diagnostic, expected);
    assert.equal(JSON.stringify(observer.report()).includes('CANARY'), false);
    assert.equal(observer.report().compact_boundary, false);
  }
});
