import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sourceObjectKey } from '../core/event-provenance.mjs';
import { createGitCommit, createRefMovement } from '../core/git-provenance.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const invalid = message => { throw new TypeError(`GitProvenance: ${message}`); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const b64 = bytes => bytes.toString('base64');
function person(bytes) {
  const match = /^(.*) <([^<>]*)> (-?\d+) ([+-]\d{4})$/.exec(bytes.toString('latin1'));
  if (!match) invalid('unsupported commit identity');
  return { name_base64: b64(Buffer.from(match[1], 'latin1')), email_base64: b64(Buffer.from(match[2], 'latin1')),
    timestamp_seconds: Number(match[3]), timezone: match[4] };
}
function parseCommit(raw, object) {
  if (createHash(object.object_format).update(Buffer.from(`commit ${raw.length}\0`)).update(raw).digest('hex') !== object.oid) invalid('commit OID mismatch');
  const end = raw.indexOf('\n\n'); if (end < 0) invalid('unsupported commit headers');
  const headers = raw.subarray(0, end).toString('latin1').split('\n').filter(line => !line.startsWith(' '));
  const all = name => headers.filter(line => line.startsWith(`${name} `)).map(line => line.slice(name.length + 1));
  const one = name => { const values = all(name); if (values.length !== 1) invalid('unsupported commit headers'); return values[0]; };
  return { schema_version: 1, kind: 'git_commit_record', object, tree_oid: one('tree'), parent_oids: all('parent'),
    author: person(Buffer.from(one('author'), 'latin1')), committer: person(Buffer.from(one('committer'), 'latin1')),
    raw_commit_digest: digest(raw), message_base64: b64(raw.subarray(end + 2)) };
}
function parseDiff(raw, format) {
  const tokens = []; let start = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0) { tokens.push(raw.subarray(start, i)); start = i + 1; }
  if (start !== raw.length || tokens.length % 2) invalid('unsupported diff output');
  const changes = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/.exec(tokens[i].toString('ascii'));
    if (!match) invalid('unsupported diff entry');
    const width = format === 'sha1' ? 40 : 64;
    if (match[3].length !== width || match[4].length !== width) invalid('abbreviated diff OID');
    changes.push({ status: match[5], path_base64: b64(tokens[i + 1]), old_mode: match[1], new_mode: match[2],
      old_oid: /^0+$/.test(match[3]) ? null : match[3], new_oid: /^0+$/.test(match[4]) ? null : match[4] });
  }
  return changes;
}

/** Read-only local Git adapter. Repository identity is explicitly supplied, never guessed from remotes. */
export class GitProvenance {
  #path;
  #repository;
  #objects;
  constructor({ repository_path, repository }) {
    if (typeof repository_path !== 'string' || !isAbsolute(repository_path) || repository_path.includes('\0')) invalid('absolute repository_path required');
    const object = { kind: 'git_commit', ...repository, oid: '0'.repeat(repository?.object_format === 'sha256' ? 64 : 40) };
    sourceObjectKey(object);
    this.#path = repository_path;
    this.#repository = Object.freeze({ tenant_id: object.tenant_id, repository_id: object.repository_id, object_format: object.object_format });
    const format = this.#run(['rev-parse', '--show-object-format']).toString('utf8').trim();
    if (format !== repository.object_format) invalid('repository object format mismatch');
    this.#objects = this.#run(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString('utf8').trim();
    if (!isAbsolute(this.#objects) || this.#objects.includes('\0')) invalid('unsupported object directory');
  }
  #run(args) {
    // No inherited Git config, credentials, replacement refs, lazy fetch, external diff,
    // textconv, hooks or shell command interpolation. Only read-only commands below.
    let scratch;
    try {
      if (this.#objects !== undefined) {
        // Git versions without --no-lazy-fetch can mutate promisor configuration
        // even when transport is denied. Read the object store through minimal,
        // private metadata with no remotes rather than loading source config.
        scratch = mkdtempSync(join(tmpdir(), 'runtime-git-read-'));
        mkdirSync(join(scratch, 'objects')); mkdirSync(join(scratch, 'refs'));
        writeFileSync(join(scratch, 'HEAD'), 'ref: refs/heads/runtime-read-only\n');
        writeFileSync(join(scratch, 'config'), this.#repository.object_format === 'sha256'
          ? '[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n'
          : '[core]\nrepositoryformatversion = 0\nbare = true\n');
      }
      return execFileSync('git', ['--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-C', scratch ?? this.#path,
        ...(scratch ? [`--git-dir=${scratch}`] : []), ...args], {
      env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
        // Older Git ignores GIT_NO_LAZY_FETCH. Its transport whitelist still
        // overrides protocol.<name>.allow, including local files and helpers.
        GIT_ALLOW_PROTOCOL: '', ...(scratch ? { GIT_OBJECT_DIRECTORY: this.#objects } : {}) },
      encoding: 'buffer', maxBuffer: MAX_BYTES, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
  #object(oid) { const value = { kind: 'git_commit', ...this.#repository, oid }; sourceObjectKey(value); return value; }
  #rawCommit(oid) {
    const object = this.#object(oid);
    const unresolved = reason => ({ schema_version: 1, kind: 'unresolved_git_commit', object, reason });
    try {
      const type = this.#run(['cat-file', '-t', oid]).toString('utf8').trim();
      if (type !== 'commit') return unresolved('not_commit');
      const record = parseCommit(this.#run(['cat-file', 'commit', oid]), object);
      const bases = record.parent_oids.length ? record.parent_oids.map(parent => ({ kind: 'parent', oid: parent }))
        : [{ kind: 'empty_tree', oid: createHash(object.object_format).update('tree 0\0').digest('hex') }];
      // Unsupported or over-budget metadata stays an unresolved object pointer,
      // including during ancestry traversal; never smuggle it into the DAG.
      createGitCommit({ ...record, changed_paths: bases.map(base => ({ base, status: 'unresolved', reason: 'read_failed', changes: [] })) });
      return record;
    } catch (error) {
      if (error instanceof TypeError) return unresolved('unsupported_commit');
      if (error.code === 'ENOBUFS') return unresolved('limit_exceeded');
      // Git uses 128 both for absent objects and some operational failures. Never
      // manufacture a missing/GC diagnosis from the error text or return fabricated data.
      return unresolved(error.status === 128 ? 'object_unavailable' : 'read_failed');
    }
  }
  readCommit(oid) {
    const record = this.#rawCommit(oid);
    if (record.kind === 'unresolved_git_commit') return createGitCommit(record);
    const bases = record.parent_oids.length ? record.parent_oids.map(parent => ({ kind: 'parent', oid: parent }))
      : [{ kind: 'empty_tree', oid: createHash(this.#repository.object_format).update('tree 0\0').digest('hex') }];
    record.changed_paths = bases.map(base => {
      const unresolved = reason => ({ base, status: 'unresolved', reason, changes: [] });
      const parent = base.kind === 'parent' ? this.#rawCommit(base.oid) : null;
      if (parent?.kind === 'unresolved_git_commit') return unresolved('base_unavailable');
      try {
        const args = ['diff-tree', '--no-commit-id', '--raw', '-z', '-r', '--no-renames', '--no-ext-diff', '--no-textconv',
          '--no-abbrev', '--no-relative', '--ignore-submodules=none', '--no-color', '-O/dev/null'];
        // Exact trees avoid shallow/graft revision rewriting. Git recognizes the
        // format-specific empty tree without creating an object in the repository.
        const revisions = [parent?.tree_oid ?? base.oid, record.tree_oid];
        const changes = parseDiff(this.#run([...args, ...revisions, '--']), this.#repository.object_format);
        if (changes.length > 4096 || changes.some(change => Buffer.from(change.path_base64, 'base64').length > 4096)) return unresolved('limit_exceeded');
        const diff = { base, status: 'resolved', reason: null, changes };
        // Apply the public shape limits while still inside this base's failure
        // boundary. Unsupported diff details cannot erase valid commit metadata.
        createGitCommit({ ...record, changed_paths: bases.map(item => item === base ? diff
          : { base: item, status: 'unresolved', reason: 'read_failed', changes: [] }) });
        return diff;
      } catch (error) { return unresolved(error.code === 'ENOBUFS' ? 'limit_exceeded' : error.status === 128 ? 'tree_unavailable' : 'read_failed'); }
    });
    return createGitCommit(record);
  }
  /** Explicit bounded raw-object traversal ignores replace refs and shallow graft rewriting. */
  readAncestry({ oids, max_commits = 4096 }) {
    if (!Array.isArray(oids) || oids.length > 128 || !Number.isSafeInteger(max_commits) || max_commits < 1 || max_commits > 4096) invalid('invalid ancestry budget');
    oids.forEach(oid => this.#object(oid));
    const pending = [...oids]; const seen = new Set(); const commits = []; const unresolved = [];
    while (pending.length && seen.size < max_commits) {
      const oid = pending.shift(); if (seen.has(oid)) continue; seen.add(oid);
      const record = this.#rawCommit(oid);
      if (record.kind === 'unresolved_git_commit') { unresolved.push(createGitCommit(record)); continue; }
      commits.push({ commit: record.object, parents: record.parent_oids.map(parent => this.#object(parent)), parents_complete: true });
      for (const parent of record.parent_oids) if (!seen.has(parent)) pending.push(parent);
    }
    return Object.freeze({ commits: Object.freeze(commits.map(item => Object.freeze({ ...item,
      commit: Object.freeze(item.commit), parents: Object.freeze(item.parents.map(Object.freeze)) }))),
    unresolved: Object.freeze(unresolved), truncated: pending.some(oid => !seen.has(oid)) });
  }
  readRefMovement({ ref, before_oid, after_oid, reported_operation, event, max_commits = 4096 }) {
    const before = before_oid === null ? null : this.#object(before_oid);
    const after = after_oid === null ? null : this.#object(after_oid);
    const ancestry = this.readAncestry({ oids: [before_oid, after_oid].filter(oid => oid !== null), max_commits });
    const movement = createRefMovement({ ref: { ...this.#repository, name: ref }, before, after,
      commits: ancestry.commits, reported_operation, event });
    return Object.freeze({ movement, unresolved: ancestry.unresolved, truncated: ancestry.truncated });
  }
}
