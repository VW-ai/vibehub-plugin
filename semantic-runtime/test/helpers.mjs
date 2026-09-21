import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCandidateStore } from '../src/adapters/sqlite-store.mjs';

export const scope = { tenant_id: 'test-tenant', project_id: 'test-project' };
export const policy = JSON.parse(readFileSync(new URL('../policies/phase0.json', import.meta.url), 'utf8'));
export function event(overrides = {}) {
  return {
    schema_version: 1, ...scope, event_id: 'event-1', type: 'TOOL_RESULT',
    timestamp: '2026-09-19T10:00:00Z',
    source: { provider: 'fixture', session_id: 'session-1', worktree_id: 'worktree-1', ref: 'fixture://trajectory/1' },
    payload_ref: 'fixture://trajectory/1/payload', payload: { text: 'Session refresh regression passed.' },
    provenance: { repo: 'fixture/repo', commit: 'a'.repeat(40) },
    acl: { visibility: 'project', sensitivity: 'INTERNAL' }, ...overrides,
  };
}
export function target(overrides = {}) {
  return { ...scope, id: 'acceptance-1', type: 'acceptance', available_at: '2026-09-19T09:00:00Z',
    text: 'Session refresh regression must pass.', source_ref: 'fixture://contract/acceptance-1',
    acl: { visibility: 'project', sensitivity: 'INTERNAL' }, ...overrides };
}
export function decision(overrides = {}) {
  return { value: { relevant: false, target_ids: [] }, confidence: 0.95, latency_ms: 1,
    provider: 'test', model: 'test-v1', reason_code: 'test_result', ...overrides };
}
export function judge(evaluate = () => decision()) {
  return { descriptor: { provider: 'test', model: 'test-v1', kind: 'fixture' }, evaluate };
}
export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'semantic-runtime-test-'));
  const database = join(directory, 'candidate.sqlite');
  const store = new SqliteCandidateStore(database);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, database, store };
}
