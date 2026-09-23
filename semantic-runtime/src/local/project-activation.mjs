import { DomainStore } from '../adapters/sqlite/domain-store.mjs';
import { AccessAuthority, LOCAL_AUDIENCE } from '../domain/identity/access-authority.mjs';
import { GIT_ENROLLMENT_NAMESPACE } from './git-projects.mjs';

export const ACTIVATION_NAMESPACE = 'project-activation';
export const ACTIVATION_STAGES = Object.freeze(['capture', 'dispatch', 'result', 'delivery']);
const codes = new Set(['activation_unauthorized', 'invalid_activation_input', 'invalid_activation_state',
  'project_not_enrolled', 'invalid_execution_membership', 'activation_epoch_exhausted', 'async_activation_callback']);
const fail = code => Object.assign(new Error(`Project activation: ${code}`), { code });
const integer = n => Number.isSafeInteger(n) && n >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(value);
const initial = () => ({ schema_version: 1, enabled: false, epoch: 0, transition_ref: null,
  disabled_since: null, last_gap: null, updated_at_ms: null });
function state(row) {
  if (!row) return initial();
  const s = row.value;
  if (!s || s.schema_version !== 1 || typeof s.enabled !== 'boolean' || !integer(s.epoch) || s.epoch < 1
    || s.transition_ref !== `transition-${s.epoch}` || !integer(s.updated_at_ms)
    || (s.enabled ? s.disabled_since !== null : !s.disabled_since || s.disabled_since.transition_ref !== s.transition_ref
      || s.disabled_since.epoch !== s.epoch || !integer(s.disabled_since.at_ms))
    || s.last_gap !== null && (!s.last_gap || !id(s.last_gap.from_transition) || !id(s.last_gap.to_transition)
      || !integer(s.last_gap.from_ms) || !integer(s.last_gap.to_ms) || s.last_gap.backfill !== 'none')) throw fail('invalid_activation_state');
  return s;
}

/** Durable local Project switch. Consumers own actual capture, sends and queues. */
export class ProjectActivation {
  #store; #authority; #now;
  constructor({ store, authority, now = () => Date.now() }) {
    if (!(store instanceof DomainStore) || !(authority instanceof AccessAuthority) || typeof now !== 'function') throw fail('invalid_activation_input');
    this.#store = store; this.#authority = authority; this.#now = now;
  }
  #grant(context, action, { write = false, switcher = false, enrollment = false } = {}) {
    const g = this.#authority.inspect(context);
    if (!g || g.audience !== LOCAL_AUDIENCE || !g.actions.includes(action) || !g.actions.includes('store:read')
      || write && !g.actions.includes('store:write') || enrollment && !g.actions.includes('project:inspect')
      || switcher && !['human', 'service'].includes(g.kind)) throw fail('activation_unauthorized');
    return g;
  }
  #transaction(context, fn) {
    let ownCode;
    try { return this.#store.transaction(context, tx => {
      try { return fn(tx); } catch (error) { if (codes.has(error?.code)) ownCode = error.code; throw error; }
    }); } catch (error) { if (ownCode) throw fail(ownCode); throw error; }
  }
  #membership(tx, execution) {
    // Same store/transaction as the activation and admitted write: no Git I/O.
    const record = tx.getRecord(GIT_ENROLLMENT_NAMESPACE, 'catalog'), catalog = record?.value;
    if (!catalog || catalog.schema_version !== 1 || !Array.isArray(catalog.checkouts)) throw fail('project_not_enrolled');
    const live = catalog.checkouts.filter(c => c?.state === 'active' && Array.isArray(c.worktrees));
    if (!live.some(c => c.worktrees.some(w => w?.state === 'active'))) throw fail('project_not_enrolled');
    if (execution === undefined) return record.version;
    if (!execution || Object.keys(execution).length !== 3
      || !['repository_id', 'checkout_id', 'worktree_id'].every(k => id(execution[k]))) throw fail('invalid_execution_membership');
    const checkout = live.find(c => c.repository_id === execution.repository_id && c.checkout_id === execution.checkout_id);
    if (!checkout?.worktrees.some(w => w?.state === 'active' && w.worktree_id === execution.worktree_id)) throw fail('invalid_execution_membership');
    return record.version;
  }
  get(context) {
    this.#grant(context, 'activation:read');
    const row = this.#store.getRecord(context, ACTIVATION_NAMESPACE, 'state');
    return { version: row?.version ?? null, state: state(row) };
  }
  setEnabled(context, { enabled, expectedVersion } = {}) {
    const grant = this.#grant(context, 'activation:write', { write: true, switcher: true, enrollment: enabled === true });
    if (typeof enabled !== 'boolean' || expectedVersion !== null && (!integer(expectedVersion) || expectedVersion < 1)) throw fail('invalid_activation_input');
    return this.#transaction(context, tx => {
      this.#grant(context, 'activation:write', { write: true, switcher: true, enrollment: enabled });
      const row = tx.getRecord(ACTIVATION_NAMESPACE, 'state'), current = state(row);
      if ((row?.version ?? null) !== expectedVersion) throw Object.assign(new Error('Activation version conflict'), { code: 'cas_conflict' });
      if (enabled) this.#membership(tx);
      if (current.enabled === enabled) return { version: row?.version ?? null, state: current, changed: false };
      if (current.epoch === Number.MAX_SAFE_INTEGER) throw fail('activation_epoch_exhausted');
      const epoch = current.epoch + 1, now = this.#now();
      if (!integer(now)) throw fail('invalid_activation_input');
      const transition_ref = `transition-${epoch}`;
      const next = { schema_version: 1, enabled, epoch, transition_ref, updated_at_ms: now,
        disabled_since: enabled ? null : { epoch, transition_ref, at_ms: now },
        last_gap: enabled && current.disabled_since ? { from_transition: current.disabled_since.transition_ref,
          to_transition: transition_ref, from_ms: current.disabled_since.at_ms, to_ms: now, backfill: 'none' } : current.last_gap };
      const version = tx.compareAndSwap(ACTIVATION_NAMESPACE, 'state', expectedVersion, next);
      tx.appendSource(ACTIVATION_NAMESPACE, transition_ref, 'activation-transition', {
        actor: grant.principal_id, previous_transition_ref: current.transition_ref, previous_epoch: current.epoch, state: next });
      if (!enabled) tx.enqueue(ACTIVATION_NAMESPACE, `cancel-${epoch}`, {
        schema_version: 1, kind: 'cancel-before-epoch', disabled_epoch: epoch, before_epoch: epoch,
        transition_ref, recovery_default: 'leave_cancelled', ack_owner: 'app-cancellation-coordinator' });
      return { version, state: next, changed: true };
    });
  }
  withAdmission(context, { epoch, stage, execution } = {}, operation) {
    this.#grant(context, 'activation:admit', { write: true, enrollment: true });
    if (!integer(epoch) || !ACTIVATION_STAGES.includes(stage) || typeof operation !== 'function') throw fail('invalid_activation_input');
    if (operation.constructor?.name === 'AsyncFunction') throw fail('async_activation_callback');
    return this.#transaction(context, tx => {
      this.#grant(context, 'activation:admit', { write: true, enrollment: true });
      const activationRow = tx.getRecord(ACTIVATION_NAMESPACE, 'state'), current = state(activationRow);
      if (!current.enabled) return { admitted: false, reason: 'project_disabled', epoch: current.epoch };
      if (current.epoch !== epoch) return { admitted: false, reason: 'stale_activation_epoch', epoch: current.epoch };
      const enrollmentVersion = this.#membership(tx, execution);
      const value = operation(tx);
      if (value && typeof value.then === 'function') {
        Promise.resolve(value).catch(() => {}); throw fail('async_activation_callback');
      }
      this.#grant(context, 'activation:admit', { write: true, enrollment: true });
      // Trusted consumers must not change activation/enrollment inside an admitted callback.
      const afterRow = tx.getRecord(ACTIVATION_NAMESPACE, 'state'), after = state(afterRow);
      if (!after.enabled || after.epoch !== epoch || afterRow.version !== activationRow.version
        || this.#membership(tx, execution) !== enrollmentVersion) throw fail('invalid_activation_state');
      return { admitted: true, epoch, value };
    });
  }
}
