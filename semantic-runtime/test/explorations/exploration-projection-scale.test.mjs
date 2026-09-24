import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { fixture, bind, git, executionFor, rows, rejected } from '../support/exploration-fixture.mjs';
import { join } from 'node:path';

test('600 individual exploration origins use bounded real SQLite pages and stable append high-water cursors', { timeout: 180_000 }, t => {
  const f = fixture(t), linked = join(f.root, 'scale-linked'); git(f.folder, 'worktree', 'add', '-b', 'scale-b', linked); f.refresh();
  const executions = [f.execution, executionFor(f, linked)], ids = new Set(), started = performance.now();
  let active = null, maxBytes = 0, maxRangeRows = 0;
  const samples = [], prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql); if (!active || !/^\s*SELECT\b/i.test(sql)) return statement;
    assert.doesNotMatch(sql, /\bOFFSET\b/i); const sample = active;
    return new Proxy(statement, { get(target, property) {
      if (property === 'all') return () => assert.fail('selected exploration read cannot materialize unbounded rows');
      if (property === 'get') return (...args) => { sample.queries++; const row = target.get(...args); if (row) sample.rows++; return row; };
      if (property === 'iterate') return (...args) => {
        sample.queries++; const iterator = target.iterate(...args); let count = 0;
        return { [Symbol.iterator]() { return this; }, next() { const step = iterator.next(); if (!step.done) { sample.rows++; count++; maxRangeRows = Math.max(maxRangeRows, count); assert(count <= 32); } return step; }, return() { return iterator.return?.() ?? { done: true }; } };
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  for (let i = 0; i < 600; i++) {
    const result = bind(f, { key: `scale-enrollment-${i}`, execution: executions[i % 2] });
    assert.equal(result.status, 'applied'); assert(!ids.has(result.exploration_id)); ids.add(result.exploration_id);
    if (i === 63 || i === 599) {
      active = { origins: i + 1, queries: 0, rows: 0 };
      const selected = f.explorations.list(f.context, { cursor: null, limit: 32 }); samples.push(active); active = null;
      assert.equal(selected.items.length, 32);
    }
  }
  assert.equal(samples[0].queries, samples[1].queries, 'a fixed first page must not scan accumulated exploration history');
  assert.equal(samples[0].rows, samples[1].rows);
  // Pin the append horizon, then add another actual enrollment on a real worktree.
  let page = f.explorations.list(f.context, { cursor: null, limit: 32 }), pages = 0;
  const late = bind(f, { key: 'after-page-highwater', execution: executions[1] }), seen = new Set();
  do {
    assert(page.items.length <= 32); maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page)));
    for (const item of page.items) { assert(!seen.has(item.exploration_id)); seen.add(item.exploration_id); assert(item.origin && item.generation_id); }
    assert(++pages < 25);
    if (page.cursor === null) break;
    active = { page: pages + 1, queries: 0, rows: 0 };
    page = f.explorations.list(f.context, { cursor: page.cursor, limit: 32 }); samples.push(active); active = null;
  } while (true);
  assert.deepEqual(seen, ids); assert(!seen.has(late.exploration_id)); assert(maxBytes <= 1_048_576);
  const all = rows(f), originRows = all.sources.filter(row => row.namespace === 'exploration-projection' && JSON.parse(row.value).origin?.git_base);
  assert.equal(originRows.length, 601, 'each enrollment retains its own immutable origin row');
  assert(originRows.every(row => !JSON.parse(row.value).explorations));
  const first = f.explorations.list(f.context, { cursor: null, limit: 32 });
  const foreign = f.issue({ scope: { tenant_id: 'different-tenant', project_id: 'different-project' } }).context;
  rejected(() => f.explorations.list(foreign, { cursor: first.cursor, limit: 32 }));
  t.diagnostic(JSON.stringify({ dataset: '600-real-git-enrollments-sqlite', origins: originRows.length,
    retained_page_horizon: seen.size, pages, maximum_range_rows: maxRangeRows, maximum_page_bytes: maxBytes, selected_reads: samples,
    enrollment_ms: Math.round(performance.now() - started), note: 'Actual local measurements; no SLA. Two real enrolled worktrees, 601 individual origins, no pruning.' }));
});
