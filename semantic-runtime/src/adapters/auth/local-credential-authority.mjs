import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AccessAuthority, LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';
import { identifier, normalizeScope } from '../../domain/shared/contracts.mjs';
import { PRINCIPAL_KINDS, evaluateServiceAccess, evaluateMaterialization } from '../../domain/identity/service-access.mjs';

export { LOCAL_AUDIENCE } from '../../domain/identity/access-authority.mjs';

const digest = token => createHash('sha256').update(token).digest('hex');
const denied = () => ({ allowed: false, reason: 'unauthenticated' });
const copy = value => structuredClone(value);

/** Trusted process capability owner. No token creation/refresh HTTP endpoint. */
export class LocalCredentialAuthority extends AccessAuthority {
  #grants = new Map();
  #contexts = new WeakMap();
  #now;
  constructor({ now = Date.now } = {}) { super(); this.#now = now; }

  issue({ principal_id, kind, scope, audience = LOCAL_AUDIENCE, actions, ttl_ms = 900_000 }) {
    identifier(principal_id, 'principal'); identifier(audience, 'audience');
    if (!PRINCIPAL_KINDS.includes(kind)) throw new Error('Invalid principal kind');
    if (!Number.isSafeInteger(ttl_ms) || ttl_ms < 1 || ttl_ms > 3_600_000) throw new Error('Credential expiry must be within one hour');
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 64) throw new Error('Explicit actions required');
    actions.forEach(action => identifier(action, 'action'));
    scope = normalizeScope(scope);
    const now = this.#now();
    for (const [key, grant] of this.#grants) if (grant.expires_at <= now) this.#grants.delete(key);
    if (this.#grants.size >= 1024) throw new Error('Active credential limit reached');
    const credential = `vh_local_${randomBytes(32).toString('base64url')}`;
    const grant = { credential_id: randomUUID(), principal_id, kind, ...scope, audience,
      actions: [...new Set(actions)], expires_at: now + ttl_ms };
    this.#grants.set(digest(credential), grant);
    return { credential, credential_id: grant.credential_id, expires_at: grant.expires_at };
  }

  #get(key) {
    const grant = this.#grants.get(key);
    if (!grant || grant.expires_at <= this.#now()) { this.#grants.delete(key); return null; }
    return grant;
  }

  authorize(credential, request) {
    if (typeof credential !== 'string' || !/^vh_local_[A-Za-z0-9_-]{43}$/.test(credential)) return denied();
    const key = digest(credential), grant = this.#get(key);
    if (!grant) return denied();
    const decision = evaluateServiceAccess(grant, request);
    if (!decision.allowed) return decision;
    const context = Object.freeze({});
    this.#contexts.set(context, { key, request: copy(request) });
    return { ...decision, context };
  }

  inspect(context) {
    const binding = this.#contexts.get(context);
    const grant = binding && this.#get(binding.key);
    return grant && evaluateServiceAccess(grant, binding.request).allowed ? copy(grant) : null;
  }

  materialize(context, input) {
    const grant = this.inspect(context);
    return grant ? evaluateMaterialization(grant, input) : denied();
  }

  revoke(credentialId) {
    for (const [key, grant] of this.#grants) if (grant.credential_id === credentialId) return this.#grants.delete(key);
    return false;
  }
  close() { this.#grants.clear(); this.#contexts = new WeakMap(); }
}
