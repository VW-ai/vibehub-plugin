import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JevJudge } from '../src/adapters/providers/jev-judge.mjs';
import { SqliteCandidateStore } from '../src/adapters/sqlite-store.mjs';
import { replay } from '../src/core/replay.mjs';

const REQUEST_SPACING_MS = 2500;

export class PacedJudge {
  constructor(delegate, { minIntervalMs = REQUEST_SPACING_MS, now = () => Date.now(), sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms)) } = {}) {
    this.delegate = delegate;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.sleep = sleep;
    this.lastStartedAt = null;
    this.descriptor = { ...delegate.descriptor, request_spacing_ms: minIntervalMs };
  }

  async evaluate(input, options) {
    if (this.lastStartedAt !== null) {
      const remaining = this.minIntervalMs - (this.now() - this.lastStartedAt);
      if (remaining > 0) await this.sleep(remaining);
    }
    this.lastStartedAt = this.now();
    return this.delegate.evaluate(input, options);
  }
}

export function verifyBenchmarkReport(report) {
  if (report.events !== 20 || report.decisions !== 80) {
    throw new Error(`Incomplete Peel benchmark: ${report.events} events and ${report.decisions} decisions`);
  }
  if (report.judge_errors !== 0) {
    throw new Error(`Peel JEV benchmark has ${report.judge_errors} judge errors in run ${report.run_id}`);
  }
  if (report.productization_gate !== 'not_evaluated') {
    throw new Error('A replay benchmark must not advance the productization gate');
  }
  return report;
}

async function preflight() {
  const judge = new JevJudge();
  await judge.evaluate({
    event: {
      type: 'SYSTEM_CHECKPOINT',
      timestamp: '2026-09-21T00:00:00.000Z',
      payload: { text: 'Synthetic connectivity preflight for the semantic evaluation adapter.' },
    },
    stateRefs: [],
    question: {
      family: 'durable_cross_ticket_value',
      text: 'Does this synthetic event contain knowledge useful beyond this task?',
    },
  });
}

export async function runPeelBenchmark() {
  await preflight();
  const events = readFileSync('test/fixtures/peel/events.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const state = JSON.parse(readFileSync('test/fixtures/peel/state.json', 'utf8'));
  const labels = JSON.parse(readFileSync('test/fixtures/peel/labels.json', 'utf8'));
  const policy = JSON.parse(readFileSync('policies/peel-benchmark.json', 'utf8'));
  const database = resolve('.local/peel-jev-v3.sqlite');
  const store = new SqliteCandidateStore(database);
  try {
    const report = await replay({
      events, state, labels, policy,
      scope: { tenant_id: 'benchmark', project_id: 'peel' },
      judge: new PacedJudge(new JevJudge()), store, datasetKind: 'real',
    });
    verifyBenchmarkReport(report);
    return { ok: true, database, report };
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runPeelBenchmark(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
