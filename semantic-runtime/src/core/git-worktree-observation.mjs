import { isProxy } from 'node:util/types';
/** Bounded Git work signals, not filesystem snapshots or semantic completion. */
export const GIT_SENSOR_LIMITS = Object.freeze({ bindings: 128, paths: 256, path_bytes: 4096,
  index_bytes: 8 * 1024 * 1024, command_bytes: 2 * 1024 * 1024, snapshot_bytes: 48 * 1024,
  command_ms: 5000, sample_ms: 15000, debounce_ms: 250, maximum_wait_ms: 2000, submit_attempts: 3 });
export const SENSOR_CODES = Object.freeze(['invalid_sensor_input', 'invalid_git_observation', 'sensor_unauthorized', 'sensor_closed',
  'sensor_busy', 'binding_limit', 'unknown_binding', 'invalid_sensor_source', 'project_disabled', 'stale_activation_epoch',
  'membership_gap', 'source_changed', 'unsupported_profile', 'capture_limit', 'capture_timeout', 'capture_cancelled',
  'capture_failed', 'unstable_capture', 'delivery_failed', 'delivery_unknown', 'retry_exhausted', 'process_start', 'hint_overflow',
  'source_access_denied', 'store_unavailable', 'store_busy', 'store_closed', 'cursor_capacity', 'ingress_capacity']);
export const sensorError = code => Object.assign(new Error(`Git sensor: ${code}`), { code });
export const sensorAssert = (condition, code = 'invalid_sensor_input') => { if (!condition) throw sensorError(code); };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function sensorInput(value, max = GIT_SENSOR_LIMITS.snapshot_bytes) {
  const seen = new Set(); let nodes = 0;
  const walk = (v, depth) => {
    sensorAssert(++nodes <= 25000 && depth <= 16 && !isProxy(v));
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number') { sensorAssert(Number.isFinite(v)); return; }
    sensorAssert((plain(v) || Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype) && !seen.has(v));
    sensorAssert(!Object.getOwnPropertySymbols(v).length);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k === 'length') continue;
      sensorAssert(Object.hasOwn(d, 'value') && d.enumerable && (!Array.isArray(v) || /^(0|[1-9]\d*)$/.test(k) && Number(k) < v.length));
    }
    if (Array.isArray(v)) sensorAssert(Object.keys(v).length === v.length);
    seen.add(v); for (const c of Object.values(v)) walk(c, depth + 1); seen.delete(v);
  };
  walk(value, 0); const text = JSON.stringify(value); sensorAssert(Buffer.byteLength(text) <= max, 'capture_limit');
  sensorAssert(Buffer.from(text).toString('utf8') === text); return JSON.parse(text);
}
export function sensorFields(v, required, optional = []) {
  sensorAssert(plain(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)));
}
export const sensorId = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const digest = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v;
function path(v) {
  sensorAssert(typeof v === 'string'); const bytes = Buffer.from(v, 'base64');
  sensorAssert(bytes.toString('base64') === v && bytes.length > 0 && bytes.length <= GIT_SENSOR_LIMITS.path_bytes
    && !bytes.includes(0) && bytes[0] !== 47 && bytes[0] !== 92);
  for (const c of bytes.toString('latin1').split('/')) sensorAssert(c && c !== '.' && c !== '..' && !c.includes('\\'));
}
export function validateGitWorktreeObservation(value) {
  try {
    const v = sensorInput(value);
    sensorFields(v, ['schema_version', 'kind', 'comparison_profile', 'observed_at', 'capture_started_at', 'catalog', 'identity',
      'physical', 'head', 'index_digest', 'staged', 'unstaged', 'unmerged', 'untracked', 'submodule_worktrees', 'mapping', 'consistency', 'gap_summary']);
    sensorAssert(v.schema_version === 1 && v.kind === 'git_worktree_snapshot' && v.comparison_profile === 'isolated-raw-v1');
    sensorAssert(time(v.observed_at) && time(v.capture_started_at));
    sensorFields(v.catalog, ['version', 'source_ref']); sensorAssert(integer(v.catalog.version) && v.catalog.version > 0 && v.catalog.source_ref === `catalog-v${v.catalog.version}`);
    sensorFields(v.identity, ['repository_id', 'checkout_id', 'worktree_id', 'source_installation_id']); sensorAssert(Object.values(v.identity).every(sensorId));
    sensorFields(v.physical, ['common', 'admin', 'worktree']); sensorAssert(Object.values(v.physical).every(x => typeof x === 'string' && /^\d+:\d+:\d+$/.test(x)));
    sensorFields(v.head, ['state', 'object_format', 'oid', 'branch_base64']); sensorAssert(['sha1', 'sha256'].includes(v.head.object_format));
    const oid = x => typeof x === 'string' && new RegExp(`^[a-f0-9]{${v.head.object_format === 'sha1' ? 40 : 64}}$`).test(x);
    sensorAssert(['branch', 'detached', 'unborn'].includes(v.head.state) && (v.head.state === 'unborn' ? v.head.oid === null : oid(v.head.oid)));
    sensorAssert(v.head.state === 'detached' ? v.head.branch_base64 === null : typeof v.head.branch_base64 === 'string');
    if (v.head.branch_base64 !== null) { path(v.head.branch_base64); sensorAssert(Buffer.from(v.head.branch_base64, 'base64').subarray(0, 11).toString() === 'refs/heads/'); }
    sensorAssert(v.index_digest === null || digest(v.index_digest)); let count = 0;
    for (const plane of [v.staged, v.unstaged]) {
      sensorFields(plane, ['digest', 'rename_detection', 'changes']); sensorAssert(digest(plane.digest) && plane.rename_detection === 'disabled' && Array.isArray(plane.changes));
      for (const c of plane.changes) { sensorFields(c, ['path_base64', 'status', 'old_mode', 'new_mode', 'old_oid', 'new_oid', 'binary']); path(c.path_base64);
        sensorAssert(['A', 'D', 'M', 'T', 'U'].includes(c.status) && /^[0-7]{6}$/.test(c.old_mode) && /^[0-7]{6}$/.test(c.new_mode)
          && [c.old_oid, c.new_oid].every(x => x === null || oid(x)) && ['yes', 'no', 'unknown'].includes(c.binary)); count++; }
    }
    sensorAssert(Array.isArray(v.unmerged) && Array.isArray(v.untracked));
    for (const c of v.unmerged) { sensorFields(c, ['path_base64', 'stage', 'mode', 'oid']); path(c.path_base64); sensorAssert([1, 2, 3].includes(c.stage) && /^[0-7]{6}$/.test(c.mode) && oid(c.oid)); count++; }
    for (const c of v.untracked) { sensorFields(c, ['path_base64', 'kind', 'size', 'mode']); path(c.path_base64); sensorAssert(['file', 'symlink'].includes(c.kind) && integer(c.size) && integer(c.mode)); count++; }
    sensorAssert(count <= GIT_SENSOR_LIMITS.paths, 'capture_limit');
    sensorFields(v.mapping, ['host_session', 'execution', 'exploration', 'ref_incarnation_id', 'ref_assurance']);
    sensorAssert(v.mapping.host_session === 'unknown' && v.mapping.execution === 'unknown' && v.mapping.exploration === 'unmapped'
      && (v.mapping.ref_incarnation_id === null || sensorId(v.mapping.ref_incarnation_id))
      && v.mapping.ref_assurance === (v.mapping.ref_incarnation_id === null ? 'unmapped' : 'catalog_observed'));
    sensorAssert(v.consistency === 'observed_stable_endpoints' && v.submodule_worktrees === 'not_observed');
    sensorFields(v.gap_summary, ['preceding_interval', 'reasons']); sensorAssert(v.gap_summary.preceding_interval === 'unknown' && Array.isArray(v.gap_summary.reasons) && v.gap_summary.reasons.length <= SENSOR_CODES.length);
    const reasons = new Set(); for (const r of v.gap_summary.reasons) { sensorFields(r, ['code', 'count']); sensorAssert(SENSOR_CODES.includes(r.code) && !reasons.has(r.code) && integer(r.count) && r.count > 0); reasons.add(r.code); }
    return true;
  } catch (e) { if (e?.code === 'capture_limit') throw e; throw sensorError('invalid_git_observation'); }
}
