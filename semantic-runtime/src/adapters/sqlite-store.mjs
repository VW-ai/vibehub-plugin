import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, fingerprint, normalizeScope, requireValue, sameScope } from '../core/contracts.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  manifest TEXT NOT NULL, report TEXT,
  PRIMARY KEY (tenant_id, project_id, run_id)
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, event_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, metadata TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, event_id)
) STRICT;
CREATE TABLE IF NOT EXISTS run_events (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, event_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, run_id, event_id),
  FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES runs,
  FOREIGN KEY (tenant_id, project_id, event_id) REFERENCES events
) STRICT;
CREATE TABLE IF NOT EXISTS decisions (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  event_id TEXT NOT NULL, decision_id TEXT NOT NULL, audit TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, run_id, decision_id),
  FOREIGN KEY (tenant_id, project_id, run_id, event_id) REFERENCES run_events
) STRICT;
CREATE TABLE IF NOT EXISTS candidates (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, decision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'candidate'), record TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, run_id, candidate_id),
  FOREIGN KEY (tenant_id, project_id, run_id, decision_id) REFERENCES decisions
) STRICT;
CREATE TABLE IF NOT EXISTS relations (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, target_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('EVIDENCE_FOR', 'RELEVANT_TO')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY (tenant_id, project_id, run_id, candidate_id, target_id, type),
  FOREIGN KEY (tenant_id, project_id, run_id, candidate_id) REFERENCES candidates
) STRICT;
`;

const scopeArgs = scope => {
  const normalized = normalizeScope(scope);
  return [normalized.tenant_id, normalized.project_id];
};

export class SqliteCandidateStore {
  constructor(path, { readOnly = false } = {}) {
    if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const application = this.db.prepare('PRAGMA application_id').get().application_id;
      const empty = this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n === 0;
      const existing = application === 0x56485352 && version === 1;
      requireValue(existing || (!readOnly && empty && application === 0 && version === 0), 'Not a supported candidate store');
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA application_id = 1447580498; PRAGMA user_version = 1; COMMIT;`);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  startRun(manifest) {
    this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, NULL)')
      .run(...scopeArgs(manifest), manifest.run_id, canonical(manifest));
  }

  appendEvent(scope, runId, event, { decisions, candidates }) {
    requireValue(sameScope(scope, event), 'Store scope mismatch');
    const args = scopeArgs(scope);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.db.prepare('SELECT manifest FROM runs WHERE tenant_id = ? AND project_id = ? AND run_id = ?').get(...args, runId);
      requireValue(run && JSON.parse(run.manifest).status === 'running', 'Run is not writable');
      const hash = fingerprint(event);
      const prior = this.db.prepare('SELECT input_hash FROM events WHERE tenant_id = ? AND project_id = ? AND event_id = ?').get(...args, event.event_id);
      requireValue(!prior || prior.input_hash === hash, 'Event identity changed across runs');
      // Store pointers and hashes, not private source text or an invented summary.
      const { payload, ...metadata } = event;
      metadata.payload_hash = fingerprint(payload);
      this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)')
        .run(...args, event.event_id, hash, canonical(metadata));
      this.db.prepare('INSERT INTO run_events VALUES (?, ?, ?, ?)').run(...args, runId, event.event_id);
      for (const decision of decisions) {
        requireValue(decision.event_id === event.event_id, 'Decision event mismatch');
        this.db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?)')
          .run(...args, runId, event.event_id, decision.decision_id, canonical(decision));
      }
      for (const candidate of candidates) {
        requireValue(candidate.state === 'candidate' && candidate.event_id === event.event_id, 'Only candidate state is writable');
        this.db.prepare('INSERT INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(...args, runId, candidate.candidate_id, candidate.decision_id, candidate.state, canonical(candidate));
        for (const relation of candidate.relations) {
          this.db.prepare('INSERT INTO relations VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(...args, runId, candidate.candidate_id, relation.target_id, relation.type, relation.confidence);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishRun(scope, runId, status, report) {
    requireValue(['complete', 'failed'].includes(status), 'Invalid run status');
    const args = [...scopeArgs(scope), runId];
    const row = this.db.prepare('SELECT manifest FROM runs WHERE tenant_id = ? AND project_id = ? AND run_id = ?').get(...args);
    requireValue(row, 'Run not found in scope');
    const manifest = JSON.parse(row.manifest);
    requireValue(manifest.status === 'running', 'Run is already finished');
    manifest.status = status;
    manifest.finished_at = new Date().toISOString();
    this.db.prepare('UPDATE runs SET manifest = ?, report = ? WHERE tenant_id = ? AND project_id = ? AND run_id = ?')
      .run(canonical(manifest), canonical(report), ...args);
  }

  readRun(scope, runId) {
    const args = [...scopeArgs(scope), runId];
    const row = this.db.prepare('SELECT manifest, report FROM runs WHERE tenant_id = ? AND project_id = ? AND run_id = ?').get(...args);
    requireValue(row, 'Run not found in scope');
    const read = (table, column, order) => this.db.prepare(`SELECT ${column} FROM ${table} WHERE tenant_id = ? AND project_id = ? AND run_id = ? ORDER BY ${order}`)
      .all(...args).map(item => JSON.parse(item[column]));
    return {
      manifest: JSON.parse(row.manifest), report: row.report ? JSON.parse(row.report) : null,
      decisions: read('decisions', 'audit', 'event_id, decision_id'),
      candidates: read('candidates', 'record', 'candidate_id'),
      events: this.db.prepare(`SELECT e.metadata FROM events e JOIN run_events r
        USING (tenant_id, project_id, event_id) WHERE r.tenant_id = ? AND r.project_id = ? AND r.run_id = ?
        ORDER BY r.event_id`).all(...args).map(item => JSON.parse(item.metadata)),
    };
  }

  close() { this.db.close(); }
}
