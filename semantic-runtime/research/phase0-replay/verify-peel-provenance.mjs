import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_IDENTITY = /^git:([a-f0-9]{40})(?::([a-f0-9]{40}))?$/;

export function codexTurnIdentity(threadId, turnId, phase) {
  if (!['turn_started', 'turn_completed'].includes(phase)) throw new Error(`Unsupported Codex turn phase: ${phase}`);
  return `sha256:${createHash('sha256').update(`${threadId}:${turnId}:${phase}`, 'utf8').digest('hex')}`;
}

export function parseLocator(locator) {
  let match = /^peel-codex-turn:\/\/(sha256:[a-f0-9]{64})$/.exec(locator);
  if (match) return { kind: 'codex_turn', identity: match[1] };
  match = /^peel-git:\/\/([a-f0-9]{40})\/(.+)$/.exec(locator);
  if (match) return { kind: 'git', commit: match[1], path: match[2] };
  match = /^peel-record:\/\/(ticket|outcome)\/([a-z0-9][a-z0-9-]*)@(sha256:[a-f0-9]{64})$/.exec(locator);
  if (match) return { kind: 'record', recordKind: match[1], id: match[2], identity: match[3] };
  match = /^peel-pr:\/\/(\d+)@([a-f0-9]{40})$/.exec(locator);
  if (match) return { kind: 'pr', number: Number(match[1]), commit: match[2] };
  throw new Error(`Unsupported Peel source locator: ${locator}`);
}

function hashFile(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function resolveProvenanceEntry(entry, { sourceRepo, codexTurns = [] } = {}) {
  const parsed = parseLocator(entry.source_locator);
  if (parsed.kind === 'codex_turn') {
    const matches = codexTurns.filter(item => codexTurnIdentity(item.thread_id, item.turn_id, item.phase) === parsed.identity);
    if (matches.length !== 1 || entry.source_identity !== parsed.identity) {
      throw new Error(`Codex turn locator did not resolve exactly once for ${entry.source_ref}`);
    }
    const availableAt = new Date(matches[0].source_available_at).toISOString();
    if (entry.source_available_at && entry.source_available_at !== availableAt) {
      throw new Error(`Codex turn time mismatch for ${entry.source_ref}`);
    }
    return { kind: parsed.kind, identity: parsed.identity, source_available_at: availableAt };
  }
  if (!sourceRepo) throw new Error(`A Peel source repository is required for ${entry.source_locator}`);
  if (parsed.kind === 'git') {
    const identity = GIT_IDENTITY.exec(entry.source_identity);
    if (!identity || identity[1] !== parsed.commit || !identity[2]) {
      throw new Error(`Git identity does not bind commit and blob for ${entry.source_ref}`);
    }
    const blob = git(sourceRepo, ['rev-parse', `${parsed.commit}:${parsed.path}`]);
    if (blob !== identity[2]) throw new Error(`Git blob mismatch for ${entry.source_ref}`);
    let availableAt;
    if (parsed.path.startsWith('.vibehub/outcomes/')) {
      const outcome = JSON.parse(git(sourceRepo, ['show', `${parsed.commit}:${parsed.path}`]));
      availableAt = new Date(outcome.closed_at).toISOString();
    } else {
      availableAt = new Date(git(sourceRepo, ['show', '-s', '--format=%cI', parsed.commit])).toISOString();
    }
    if (entry.source_available_at && entry.source_available_at !== availableAt) {
      throw new Error(`Git source time mismatch for ${entry.source_ref}`);
    }
    return { kind: parsed.kind, identity: entry.source_identity, source_available_at: availableAt };
  }
  if (parsed.kind === 'pr') {
    const identity = GIT_IDENTITY.exec(entry.source_identity);
    if (!identity || identity[1] !== parsed.commit || identity[2]) {
      throw new Error(`PR identity does not bind its commit for ${entry.source_ref}`);
    }
    git(sourceRepo, ['cat-file', '-e', `${parsed.commit}^{commit}`]);
    const availableAt = new Date(git(sourceRepo, ['show', '-s', '--format=%cI', parsed.commit])).toISOString();
    if (entry.source_available_at && entry.source_available_at !== availableAt) {
      throw new Error(`PR source time mismatch for ${entry.source_ref}`);
    }
    return { kind: parsed.kind, identity: entry.source_identity, source_available_at: availableAt };
  }
  const folder = parsed.recordKind === 'ticket' ? 'tickets' : 'outcomes';
  const path = resolve(sourceRepo, '.vibehub', folder, `${parsed.id}.yaml`);
  if (!existsSync(path) || hashFile(path) !== parsed.identity || entry.source_identity !== parsed.identity) {
    throw new Error(`VibeHub record digest mismatch for ${entry.source_ref}`);
  }
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.recordKind !== 'outcome' || !record.closed_at) {
    throw new Error(`Local Ticket time needs a Codex phase locator for ${entry.source_ref}`);
  }
  const availableAt = new Date(record.closed_at).toISOString();
  if (entry.source_available_at && entry.source_available_at !== availableAt) {
    throw new Error(`VibeHub record time mismatch for ${entry.source_ref}`);
  }
  return { kind: parsed.kind, identity: parsed.identity, source_available_at: availableAt };
}

export function verifyProvenanceLedger({ ledger, events, state, sourceRepo, codexTurns } = {}) {
  const eventById = new Map(events.map(item => [item.event_id, item]));
  const stateById = new Map(state.map(item => [item.id, item]));
  if (ledger.events.length !== eventById.size || ledger.state.length !== stateById.size) {
    throw new Error('Provenance ledger does not cover the fixture exactly');
  }
  const entries = [...ledger.events, ...ledger.state];
  for (const entry of entries) {
    if (!SHA256.test(entry.source_identity) && !GIT_IDENTITY.test(entry.source_identity)) {
      throw new Error(`Invalid source identity for ${entry.source_ref}`);
    }
    const subject = entry.event_id ? eventById.get(entry.event_id) : stateById.get(entry.state_id);
    if (!subject || subject.source_ref && subject.source_ref !== entry.source_ref
      || subject.source?.ref && subject.source.ref !== entry.source_ref) {
      throw new Error(`Source reference mismatch for ${entry.source_ref}`);
    }
    const subjectTime = entry.event_id ? subject.timestamp : subject.available_at;
    if (!Number.isFinite(Date.parse(entry.source_available_at))
      || Date.parse(subjectTime) < Date.parse(entry.source_available_at)
      || (!entry.event_id && subjectTime !== entry.source_available_at)) {
      throw new Error(`Source availability mismatch for ${entry.source_ref}`);
    }
    resolveProvenanceEntry(entry, { sourceRepo, codexTurns });
  }
  return { events: ledger.events.length, state: ledger.state.length, resolved: entries.length };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const fixture = resolve(argument('--fixture') ?? 'research/phase0-replay/fixtures/peel');
    const sourceRepo = argument('--source-repo');
    const turnIndex = argument('--codex-turn-index');
    const result = verifyProvenanceLedger({
      ledger: JSON.parse(readFileSync(resolve(fixture, 'provenance.json'), 'utf8')),
      events: readFileSync(resolve(fixture, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
      state: JSON.parse(readFileSync(resolve(fixture, 'state.json'), 'utf8')),
      sourceRepo: sourceRepo && resolve(sourceRepo),
      codexTurns: turnIndex ? JSON.parse(readFileSync(resolve(turnIndex), 'utf8')) : [],
    });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
