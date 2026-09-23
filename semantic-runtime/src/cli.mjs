#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from './core/replay.mjs';
import { compareRuns } from './core/evaluation.mjs';
import { requireValue } from './core/contracts.mjs';
import { HeuristicJudge } from './adapters/heuristic-judge.mjs';
import { JevJudge } from './adapters/providers/jev-judge.mjs';
import { RecordedJudge } from './adapters/recorded-judge.mjs';
import { SqliteCandidateStore } from './adapters/sqlite-store.mjs';

const HELP = `Semantic Runtime — offline Phase 0 prototype

replay --events events.jsonl --tenant ID --project ID
       [--state state.json] [--policy policy.json] [--labels labels.json]
       [--judge heuristic|jev|recorded] [--recordings recordings.json]
       [--dataset-kind synthetic|real|unspecified] [--db .local/replay.sqlite]
audit  --run RUN_ID --tenant ID --project ID [--db .local/replay.sqlite]
compare --left RUN_ID --right RUN_ID --tenant ID --project ID [--db .local/replay.sqlite]

Only --judge jev makes network requests. No live host capture, injections, workers, or canonical writes.
Heuristic output tests the pipeline; it is not a semantic-model benchmark.
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) return { command: 'help' };
  const permitted = {
    replay: ['events', 'state', 'policy', 'labels', 'judge', 'recordings', 'dataset-kind'],
    audit: ['run'], compare: ['left', 'right'],
  };
  requireValue(Object.hasOwn(permitted, command), 'Unknown command');
  const allowed = new Set(['tenant', 'project', 'db', ...permitted[command]]);
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].slice(2);
    requireValue(rest[index].startsWith('--') && allowed.has(key) && !Object.hasOwn(options, key), 'Unknown or duplicate option');
    requireValue(rest[index + 1] && !rest[index + 1].startsWith('--'), `Missing value for ${key}`);
    options[key] = rest[index + 1];
  }
  requireValue(options.tenant && options.project, 'Explicit --tenant and --project are required');
  return options;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Cannot read JSON input: ${path}`); }
}

function readEvents(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch { throw new Error(`Invalid event JSON at line ${index + 1}`); }
  });
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'help') return { help: HELP };
  const scope = { tenant_id: options.tenant, project_id: options.project };
  const database = resolve(options.db ?? '.local/replay.sqlite');
  if (options.command === 'replay') {
    requireValue(options.events, '--events is required');
    const judgeKind = options.judge ?? 'heuristic';
    requireValue(['heuristic', 'jev', 'recorded'].includes(judgeKind), 'Unknown judge');
    requireValue(judgeKind === 'recorded' ? options.recordings : !options.recordings, '--recordings is required only for recorded judge');
    const judge = judgeKind === 'recorded' ? new RecordedJudge(readJson(options.recordings))
      : judgeKind === 'jev' ? new JevJudge() : new HeuristicJudge();
    const events = readEvents(options.events);
    const state = options.state ? readJson(options.state) : [];
    const policy = readJson(options.policy ?? fileURLToPath(new URL('../policies/phase0.json', import.meta.url)));
    const labels = options.labels ? readJson(options.labels) : undefined;
    const store = new SqliteCandidateStore(database);
    try {
      const report = await replay({ events, state, policy, labels, scope, judge, store, datasetKind: options['dataset-kind'] ?? 'unspecified' });
      return { ok: true, database, report };
    } finally { store.close(); }
  }
  requireValue(options.command === 'audit' ? options.run : options.left && options.right, 'Missing run identifier');
  const store = new SqliteCandidateStore(database, { readOnly: true });
  try {
    return options.command === 'audit'
      ? { ok: true, ...store.readRun(scope, options.run) }
      : { ok: true, ...compareRuns(store.readRun(scope, options.left), store.readRun(scope, options.right)) };
  } finally { store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
