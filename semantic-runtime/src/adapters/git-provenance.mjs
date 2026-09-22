import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, realpathSync, opendirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { sourceObjectKey } from '../core/event-provenance.mjs';
import { createGitCommit, createRefMovement } from '../core/git-provenance.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const invalid = message => { throw new TypeError(`GitProvenance: ${message}`); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const b64 = bytes => bytes.toString('base64');
export const GIT_SELECTED_READ_LIMITS = Object.freeze({ paths: 32, path_components: 16, path_bytes: 4096,
  record_bytes: 64 * 1024, total_record_bytes: 256 * 1024, tree_bytes: 1024 * 1024,
  raw_object_bytes: 4 * 1024 * 1024, commands: 128, command_ms: 10000, git_io_ms: 30000, pack_entries: 512 });
const selectedFailure = (status, reason) => Object.assign(new Error('Git selected object unavailable'), { status, reason });
const limited = () => { throw selectedFailure('unsupported', 'limit_exceeded'); };
function selectedInput(value, fields) {
  if (!value || typeof value !== 'object' || isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('invalid selected request');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(k => typeof k !== 'string' || !fields.includes(k) || !Object.hasOwn(descriptors[k], 'value') || !descriptors[k].enumerable)) invalid('invalid selected request');
  return Object.fromEntries(fields.map(k => [k, descriptors[k].value]));
}
function selectedPath(path) {
  if (typeof path !== 'string' || !path.length || Buffer.byteLength(path) > GIT_SELECTED_READ_LIMITS.path_bytes
    || Buffer.from(path).toString('utf8') !== path || path.includes('\0') || path.includes('\\')
    || path.split('/').some(p => !p || p === '.' || p === '..') || path.split('/').length > GIT_SELECTED_READ_LIMITS.path_components) invalid('invalid selected path');
  return path.split('/').map(p => Buffer.from(p));
}
function parseTree(raw, format) {
  const width = format === 'sha1' ? 20 : 32, entries = [], names = new Set(); let offset = 0;
  while (offset < raw.length) {
    const space = raw.indexOf(32, offset), nul = raw.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 1 + width > raw.length) throw selectedFailure('unsupported', 'unsupported_object');
    const mode = raw.subarray(offset, space).toString('ascii'), name = raw.subarray(space + 1, nul);
    if (!['40000', '100644', '100755', '120000', '160000'].includes(mode) || name.includes(47) || ['.', '..'].includes(name.toString('latin1')) || names.has(b64(name))) throw selectedFailure('unsupported', 'unsupported_object');
    names.add(b64(name)); entries.push({ name, mode: mode.padStart(6, '0'), type: mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob', oid: raw.subarray(nul + 1, nul + 1 + width).toString('hex') });
    offset = nul + 1 + width;
  }
  return entries;
}
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
  #authorizeCommit;
  #selectedCache = new Map();
  #selectedInfo = new Map();
  #selectedPaths = new Set();
  #recordObjects = new Set();
  #metrics = { commands: 0, raw_object_bytes: 0, record_bytes: 0, objects_read: 0, selected_paths: 0,
    commits_read: 0, trees_read: 0, blobs_read: 0, git_io_ms: 0 };
  constructor({ repository_path, repository, object_directory, authorize_commit }) {
    if (typeof repository_path !== 'string' || !isAbsolute(repository_path) || repository_path.includes('\0')) invalid('absolute repository_path required');
    const object = { kind: 'git_commit', ...repository, oid: '0'.repeat(repository?.object_format === 'sha256' ? 64 : 40) };
    sourceObjectKey(object);
    this.#path = repository_path;
    this.#repository = Object.freeze({ tenant_id: object.tenant_id, repository_id: object.repository_id, object_format: object.object_format });
    if (authorize_commit !== undefined && typeof authorize_commit !== 'function') invalid('invalid trusted commit guard');
    this.#authorizeCommit = authorize_commit;
    if (object_directory !== undefined) {
      // Trusted enrollment capability, never a client-controlled path. Enter scratch immediately.
      if (typeof object_directory !== 'string' || !isAbsolute(object_directory) || object_directory.includes('\0')) invalid('absolute object_directory required');
      this.#objects = object_directory; this.#selectedStore(); return;
    }
    const format = this.#run(['rev-parse', '--show-object-format']).toString('utf8').trim();
    if (format !== repository.object_format) invalid('repository object format mismatch');
    this.#objects = this.#run(['rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString('utf8').trim();
    if (!isAbsolute(this.#objects) || this.#objects.includes('\0')) invalid('unsupported object directory');
    this.#objects = realpathSync(this.#objects);
  }
  #run(args, { maxBuffer = MAX_BYTES, timeout = 10000, stderr = 'pipe', killSignal = 'SIGTERM' } = {}) {
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
      encoding: 'buffer', maxBuffer, timeout, killSignal, stdio: ['ignore', 'pipe', stderr],
      });
    } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
  #object(oid) { if (typeof oid !== 'string') invalid('full commit OID required'); const value = { kind: 'git_commit', ...this.#repository, oid }; sourceObjectKey(value); return value; }
  #authorizeSelectedCommit(object) {
    if (!this.#authorizeCommit) return;
    try { const result = this.#authorizeCommit(Object.freeze({ ...object })); if (result !== undefined && result !== true) throw selectedFailure('unavailable', 'access_denied'); }
    catch { throw selectedFailure('unavailable', 'access_denied'); }
  }
  #selectedStore(oid) {
    const directory = p => { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(p) !== p) throw selectedFailure('unsupported', 'unsupported_object_store'); };
    directory(this.#objects);
    for (const name of ['info', 'pack']) {
      const path = join(this.#objects, name); try { directory(path); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (name === 'info') for (const file of ['alternates', 'http-alternates']) {
        try { const s = lstatSync(join(path, file)); if (!s.isFile() || s.isSymbolicLink() || s.size) throw selectedFailure('unsupported', 'unsupported_object_store'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      else {
        const dir = opendirSync(path); let count = 0;
        try { let entry; while ((entry = dir.readSync())) { if (++count > GIT_SELECTED_READ_LIMITS.pack_entries) limited();
          const s = lstatSync(join(path, entry.name)); if (!s.isFile() || s.isSymbolicLink()) throw selectedFailure('unsupported', 'unsupported_object_store'); } }
        finally { dir.closeSync(); }
      }
    }
    if (oid) {
      const path = join(this.#objects, oid.slice(0, 2));
      try { directory(path); const s = lstatSync(join(path, oid.slice(2))); if (!s.isFile() || s.isSymbolicLink()) throw selectedFailure('unsupported', 'unsupported_object_store'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  #selectedRun(args, maxBuffer) {
    const L = GIT_SELECTED_READ_LIMITS;
    if (this.#metrics.commands >= L.commands || this.#metrics.git_io_ms >= L.git_io_ms) limited();
    this.#metrics.commands++; const start = performance.now();
    try { return this.#run(args, { maxBuffer, stderr: 'ignore', killSignal: 'SIGKILL', timeout: Math.max(1, Math.min(L.command_ms, Math.floor(L.git_io_ms - this.#metrics.git_io_ms))) }); }
    catch (e) {
      if (['ENOBUFS', 'ETIMEDOUT'].includes(e.code) || e.signal === 'SIGTERM') limited();
      throw selectedFailure('unavailable', e.status === 128 ? 'object_unavailable' : 'read_failed');
    } finally { this.#metrics.git_io_ms += performance.now() - start; if (this.#metrics.git_io_ms > L.git_io_ms) limited(); }
  }
  #info(oid) {
    if (this.#selectedInfo.has(oid)) return this.#selectedInfo.get(oid);
    this.#selectedStore(oid);
    const type = this.#selectedRun(['cat-file', '-t', oid], 128).toString('ascii').trim();
    const sizeText = this.#selectedRun(['cat-file', '-s', oid], 128).toString('ascii').trim(), size = Number(sizeText);
    if (!['commit', 'tree', 'blob', 'tag'].includes(type) || !/^\d+$/.test(sizeText) || !Number.isSafeInteger(size)) throw selectedFailure('unsupported', 'unsupported_object');
    const result = { type, size }; this.#selectedInfo.set(oid, result); return result;
  }
  #selectedRaw(oid, type, maxBytes, commitObject) {
    this.#authorizeSelectedCommit(commitObject);
    const cached = this.#selectedCache.get(oid);
    if (cached) { if (cached.type !== type) throw selectedFailure('unsupported', 'unsupported_object'); if (cached.raw.length > maxBytes) limited(); return cached.raw; }
    const info = this.#info(oid); if (info.type !== type) throw selectedFailure('unsupported', 'unsupported_object');
    if (info.size > maxBytes || this.#metrics.raw_object_bytes + info.size > GIT_SELECTED_READ_LIMITS.raw_object_bytes) limited();
    this.#authorizeSelectedCommit(commitObject);
    this.#selectedStore(oid); // Metadata-only cache entries never waive the pre-content filesystem check.
    const raw = this.#selectedRun(['cat-file', type, oid], Math.max(1, info.size + 1));
    this.#metrics.raw_object_bytes += raw.length;
    if (raw.length !== info.size || createHash(this.#repository.object_format).update(`${type} ${raw.length}\0`).update(raw).digest('hex') !== oid) throw selectedFailure('unsupported', 'object_hash_mismatch');
    this.#metrics.objects_read++; this.#metrics[`${type}s_read`]++; this.#selectedCache.set(oid, { type, raw }); return raw;
  }
  #selectedCommit(oid) {
    this.#authorizeSelectedCommit(this.#object(oid));
    const raw = this.#selectedRaw(oid, 'commit', GIT_SELECTED_READ_LIMITS.raw_object_bytes, this.#object(oid));
    let record; try { record = parseCommit(raw, this.#object(oid)); } catch { throw selectedFailure('unsupported', 'unsupported_object'); }
    const pattern = new RegExp(`^[0-9a-f]{${this.#repository.object_format === 'sha1' ? 40 : 64}}$`);
    if (!pattern.test(record.tree_oid) || record.parent_oids.length > 128 || record.parent_oids.some(p => !pattern.test(p)) || new Set(record.parent_oids).size !== record.parent_oids.length) throw selectedFailure('unsupported', 'unsupported_object');
    this.#authorizeSelectedCommit(this.#object(oid)); return record;
  }
  #selectedResult(error, result) {
    return { ...result, status: ['unsupported', 'unavailable'].includes(error.status) ? error.status : 'unavailable',
      reason: ['limit_exceeded', 'unsupported_object', 'object_hash_mismatch', 'unsupported_entry', 'unsupported_object_store', 'object_unavailable', 'read_failed', 'access_denied'].includes(error.reason) ? error.reason : 'read_failed', bytes: null };
  }
  #selectedFile(input, content) {
    const { commit_oid, path } = selectedInput(input, ['commit_oid', 'path']), object = this.#object(commit_oid), parts = selectedPath(path);
    const result = { status: 'resolved', reason: null, object, path, raw_commit_digest: null, tree_oid: null,
      tree_chain: [], entry: null, content_digest: null, bytes: null };
    try {
      const key = JSON.stringify([commit_oid, path]);
      if (!this.#selectedPaths.has(key)) { if (this.#selectedPaths.size >= GIT_SELECTED_READ_LIMITS.paths) limited(); this.#selectedPaths.add(key); this.#metrics.selected_paths++; }
      const commit = this.#selectedCommit(commit_oid); result.raw_commit_digest = commit.raw_commit_digest; result.tree_oid = commit.tree_oid; let treeOid = commit.tree_oid;
      const finish = value => { this.#authorizeSelectedCommit(object); return value; };
      for (let i = 0; i < parts.length; i++) {
        this.#authorizeSelectedCommit(object);
        const raw = this.#selectedRaw(treeOid, 'tree', GIT_SELECTED_READ_LIMITS.tree_bytes, object); result.tree_chain.push({ oid: treeOid, digest: digest(raw) });
        const entry = parseTree(raw, this.#repository.object_format).find(e => e.name.equals(parts[i]));
        if (!entry) return finish({ ...result, status: 'absent', reason: 'path_absent' });
        if (i < parts.length - 1) {
          if (entry.type === 'tree') { treeOid = entry.oid; continue; }
          if (['100644', '100755'].includes(entry.mode)) return finish({ ...result, status: 'absent', reason: 'path_absent' });
          throw selectedFailure('unsupported', 'unsupported_entry');
        }
        result.entry = { mode: entry.mode, type: entry.type, oid: entry.oid };
        if (!['100644', '100755'].includes(entry.mode)) throw selectedFailure('unsupported', 'unsupported_entry');
        this.#authorizeSelectedCommit(object);
        const info = this.#info(entry.oid); if (info.type !== 'blob') throw selectedFailure('unsupported', 'unsupported_object'); result.entry.size = info.size;
        if (content) {
          const L = GIT_SELECTED_READ_LIMITS;
          if (info.size > L.record_bytes || (!this.#recordObjects.has(key) && this.#metrics.record_bytes + info.size > L.total_record_bytes)) limited();
          const bytes = this.#selectedRaw(entry.oid, 'blob', L.record_bytes, object);
          if (!this.#recordObjects.has(key)) { this.#recordObjects.add(key); this.#metrics.record_bytes += bytes.length; }
          result.content_digest = digest(bytes); result.bytes = Buffer.from(bytes);
        }
        return finish(result);
      }
    } catch (e) {
      try { this.#authorizeSelectedCommit(object); } catch (denied) { e = denied; }
      if (e.reason === 'access_denied') return this.#selectedResult(e, { ...result, raw_commit_digest: null, tree_oid: null, tree_chain: [], entry: null, content_digest: null });
      return this.#selectedResult(e, result);
    }
  }
  /** One instance represents one bounded refresh; the caller supplies grants and selected paths. */
  readFileAtCommit(input) { return this.#selectedFile(input, true); }
  /** Tree membership plus available regular blob metadata, without reading large artifact content. */
  readEntryAtCommit(input) { return this.#selectedFile(input, false); }
  metrics() { return Object.freeze({ ...this.#metrics }); }
  proveDescendant(input) {
    const { ancestor_oid, descendant_oid } = selectedInput(input, ['ancestor_oid', 'descendant_oid']); this.#object(ancestor_oid); this.#object(descendant_oid);
    const before = this.#metrics.commits_read; let unavailable = null;
    try {
      // The retained ancestor is a comparison pin, not authority to re-open its revoked content.
      this.#selectedCommit(descendant_oid);
      if (ancestor_oid === descendant_oid) return { status: 'same', reason: null, commits_read: this.#metrics.commits_read - before };
      const pending = [descendant_oid], seen = new Set();
      while (pending.length) {
        const oid = pending.shift(); if (seen.has(oid)) continue; seen.add(oid);
        let commit; try { commit = this.#selectedCommit(oid); } catch (e) { if (['limit_exceeded', 'access_denied'].includes(e.reason)) throw e; unavailable = e; continue; }
        for (const parent of commit.parent_oids) { if (parent === ancestor_oid) return { status: 'descendant', reason: null, commits_read: this.#metrics.commits_read - before }; if (!seen.has(parent)) pending.push(parent); }
      }
      if (unavailable) throw unavailable;
      return { status: 'not_descendant', reason: null, commits_read: this.#metrics.commits_read - before };
    } catch (e) { const r = this.#selectedResult(e, {}); return { status: r.status, reason: r.reason, commits_read: this.#metrics.commits_read - before }; }
  }
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
