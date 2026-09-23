import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { fixture, register, capture, initialize, assertion, mutation, NS } from './helpers/graph-store-fixture.mjs';
import { GraphStorage } from '../src/adapters/sqlite/graph-storage.mjs';

// Temporary synthetic database, one generation, no pruning or fixture reset.
test('real SQLite retains1040 transitions/600 objects with bounded indexed reads and resumable projection rebuild', t => {
  const f = fixture(t), source = register(f), event = capture(f, source), genesis = initialize(f);
  let at = genesis.receipt.next_graph, firstRevision, firstGraph, previous, maxPlanBytes = 0, activeSample = null;
  const samples = [], queryPlans = new Map(), prepare = DatabaseSync.prototype.prepare, applyPlan = GraphStorage.prototype.applyPlan;
  const raw = new DatabaseSync(f.filePath, { readOnly: true }); t.after(() => raw.close());
  t.mock.method(GraphStorage.prototype, 'applyPlan', function (plan) { maxPlanBytes = Math.max(maxPlanBytes, Buffer.byteLength(JSON.stringify(plan))); return applyPlan.call(this, plan); });
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql); if (!activeSample || !/^\s*SELECT\b/i.test(sql)) return statement;
    const sample = activeSample;
    assert.doesNotMatch(sql, /\bOFFSET\b/i);
    if (/\bFROM\s+(?:sources|records)\b/i.test(sql)) assert.match(sql, /tenant_id=\?\s+AND\s+project_id=\?\s+AND\s+namespace=\?/i);
    return new Proxy(statement, { get(target, property) {
      if (property === 'all') return () => assert.fail('ordinary Graph request must not materialize an unbounded collection');
      if (property === 'get') return (...args) => { sample.queries++; const value = target.get(...args); if (value) sample.rows++; return value; };
      if (property === 'iterate') return (...args) => {
        sample.queries++; const iterator = target.iterate(...args); let iterated = 0;
        if (!queryPlans.has(sql)) queryPlans.set(sql, { sql, args });
        return { [Symbol.iterator]() { return this; }, next() { const step = iterator.next(); if (!step.done) { iterated++; sample.rows++; sample.max_range_rows = Math.max(sample.max_range_rows, iterated); assert(iterated <= 64); } return step; }, return() { return iterator.return?.() ?? { done: true }; } };
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  const start = performance.now();
  for (let i = 0; i < 1040; i++) {
    const selected = i >= 600 ? 'entity-0' : `entity-${i}`;
    const a = assertion(f, event, `scale-${i}`, { entity_id: selected, base_revision: i >= 600 ? previous : null });
    const sampled = [0, 300, 599, 600, 800, 1039].includes(i);
    if (sampled) activeSample = { transition: i + 1, queries: 0, rows: 0, max_range_rows: 0 };
    const result = f.graph.mutate(f.context, mutation(f, at, a));
    if (sampled) { samples.push(activeSample); activeSample = null; }
    at = result.receipt.next_graph;
    if (i === 0) { firstRevision = result.revision; firstGraph = at; previous = result.revision; }
    if (i >= 600) previous = result.revision;
  }
  const mutationMs = performance.now() - start;
  assert.deepEqual(f.graph.getHead(f.context, { generation_id: 'generation-1' }).graph_revision, at);
  const old = f.graph.resolve(f.context, { at: firstGraph, address: firstRevision }); assert.equal(old.status, 'resolved');
  assert.equal(old.revision.assertion.content.data.text, 'Synthetic scale-0');
  const counts = {};
  let maxPageBytes = 0;
  for (const [name, collection, expected] of [['heads', { kind: 'heads' }, 600], ['history', { kind: 'history', entity_kind: 'entity', entity_id: 'entity-0' }, 441]]) {
    let cursor = null, items = 0, pages = 0;
    do {
      activeSample = { page: name, queries: 0, rows: 0, max_range_rows: 0 };
      const page = f.graph.page(f.context, { at, collection, cursor, limit: 64 }); activeSample = null;
      maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
      assert(page.items.length <= 64); cursor = page.next_cursor; items += page.items.length; assert(++pages <= 20);
    } while (cursor !== null);
    assert.equal(items, expected); counts[name] = { items, pages };
  }
  const explanations = [...queryPlans.values()].map(({ sql, args }) => {
    const details = prepare.call(raw, `EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail);
    assert.match(details.join(' '), /SEARCH sources USING INDEX sqlite_autoindex_sources_1/);
    assert.doesNotMatch(details.join(' '), /\bSCAN\b|TEMP B-TREE/i); return details;
  });
  const beforeRepair = prepare.call(raw, 'SELECT count(*) AS rows,max(length(CAST(value AS BLOB))) AS max_bytes FROM sources WHERE namespace=?').get(NS);
  const commits = prepare.call(raw, "SELECT count(*) AS n FROM sources WHERE namespace=? AND kind='graph-commit'").get(NS).n;
  assert.equal(commits, 1041);
  const rebuildStart = performance.now();
  let progress = f.graph.rebuildProjection(f.context, { generation_id: 'generation-1', expected_graph: at, epoch: f.epoch, cursor: null, limit: 64 }), batches = 0;
  while (progress.cursor !== null) {
    assert(++batches <= 18);
    progress = f.graph.rebuildProjection(f.context, { generation_id: 'generation-1', expected_graph: at, epoch: f.epoch, cursor: progress.cursor, limit: 64 });
  }
  assert.equal(progress.processed, 1041); assert.deepEqual(f.graph.resolve(f.context, { at: firstGraph, address: firstRevision }), old);
  const afterRepair = prepare.call(raw, 'SELECT count(*) AS rows,max(length(CAST(value AS BLOB))) AS max_bytes FROM sources WHERE namespace=?').get(NS);
  const pageCount = prepare.call(raw, 'PRAGMA page_count').get().page_count, pageSize = prepare.call(raw, 'PRAGMA page_size').get().page_size;
  const report = { schema_version: 1, dataset: 'actual-synthetic-git-ingress-sqlite-graph', measured_at: new Date().toISOString(), generation_count: 1,
    semantic_transitions: 1040, commits, distinct_semantic_objects: 600, pages: counts, fixed_support_samples: samples,
    scoped_range_plans: explanations, maximum_plan_bytes: maxPlanBytes, maximum_page_bytes: maxPageBytes,
    source_rows_before_rebuild: beforeRepair.rows, source_rows_after_rebuild: afterRepair.rows, maximum_source_value_bytes: afterRepair.max_bytes,
    mutation_ms: Math.round(mutationMs * 100) / 100, rebuild_ms: Math.round((performance.now() - rebuildStart) * 100) / 100,
    rebuild_batches: batches, database_logical_bytes: pageCount * pageSize,
    note: 'Actual adapter query/row counts include authority, source and index overhead. Core port budget remains covered by unchanged incremental contract tests. Timings are a local synthetic measurement, not an SLA; old index prefixes retained, no prune/completion claim.' };
  assert(maxPlanBytes <= 1048576 && maxPageBytes <= 1048576 && afterRepair.max_bytes <= 1048576);
  // Fixed support does not make late requests scan the accumulated semantic log.
  assert.equal(samples[3].queries, samples[5].queries); assert.equal(samples[3].rows, samples[5].rows);
  if (process.env.VH_WRITE_GRAPH_STORE_MEASUREMENT === '1') writeFileSync(new URL('../docs/measurements/graph-store-sqlite-20260922.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(JSON.stringify(report));
});
