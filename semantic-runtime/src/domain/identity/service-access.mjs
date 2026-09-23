import { identifier, normalizeScope, sameScope, SENSITIVITIES } from '../../core/contracts.mjs';

export const PRINCIPAL_KINDS = Object.freeze(['human', 'host-adapter', 'service', 'connector', 'worker']);
const BOUNDARIES = ['http', 'object', 'queue', 'subscription'];
const deny = reason => ({ allowed: false, reason });
const isList = values => Array.isArray(values) && values.length <= 256
  && values.every(value => { try { identifier(value, 'list item'); return true; } catch { return false; } });

export function scopedReference(kind, scope, id) {
  if (!BOUNDARIES.includes(kind)) throw new Error('Invalid reference kind');
  const normalized = normalizeScope(scope);
  identifier(id, 'reference id');
  return Object.freeze({ schema_version: 1, kind, ...normalized, id,
    key: JSON.stringify([1, kind, normalized.tenant_id, normalized.project_id, id]) });
}

function validReference(reference, scope, kind) {
  if (!reference || Object.keys(reference).sort().join(',') !== 'id,key,kind,project_id,schema_version,tenant_id') return false;
  const expected = scopedReference(kind, scope, reference.id);
  return Object.keys(expected).every(key => expected[key] === reference[key]);
}

// A pure policy function; the transport must obtain grant from its credential authority.
export function evaluateServiceAccess(grant, request) {
  try {
    const scope = normalizeScope(request.scope);
    identifier(request.audience, 'audience'); identifier(request.action, 'action');
    if (!PRINCIPAL_KINDS.includes(grant.kind) || !isList(grant.actions)) return deny('invalid_grant');
    if (!sameScope(normalizeScope(grant), scope)) return deny('scope_denied');
    if (grant.audience !== request.audience) return deny('audience_denied');
    if (!Array.isArray(request.kinds) || !request.kinds.includes(grant.kind)) return deny('kind_denied');
    if (!grant.actions.includes(request.action)) return deny('action_denied');
    if (!validReference(request.reference, scope, request.boundary)) return deny('reference_denied');
    return { allowed: true, reason: 'allowed' };
  } catch { return deny('invalid_request'); }
}

/** Returns authorized pointers only, never text or model instructions. */
export function evaluateMaterialization(grant, { scope, sources, destination, tenant_policy } = {}) {
  try {
    scope = normalizeScope(scope);
    if (!sameScope(grant, scope) || !grant.actions.includes('source:read')) return deny('source_denied');
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 128) return deny('invalid_sources');
    if (!['local', 'provider'].includes(destination?.kind)) return deny('invalid_destination');
    if (!SENSITIVITIES.includes(tenant_policy?.max_sensitivity) || !isList(tenant_policy.allowed_providers)) return deny('invalid_policy');
    const external = destination.kind === 'provider';
    if (external && (!grant.actions.includes('model:dispatch') || !tenant_policy.allowed_providers.includes(destination.provider))) return deny('provider_denied');
    let highest = 0;
    const pointers = [];
    for (const source of sources) {
      if (!validReference(source.reference, scope, 'object')) return deny('scope_denied');
      identifier(source.acl?.revision, 'ACL revision');
      if (!isList(source.acl.allowed_principal_ids) || !source.acl.allowed_principal_ids.includes(grant.principal_id)) return deny('source_denied');
      if (!SENSITIVITIES.includes(source.sensitivity) || typeof source.local_only !== 'boolean' || !isList(source.allowed_providers)) return deny('invalid_source_policy');
      highest = Math.max(highest, SENSITIVITIES.indexOf(source.sensitivity));
      if (external && (source.local_only || !source.allowed_providers.includes(destination.provider))) return deny('provider_denied');
      pointers.push({ reference: { ...source.reference }, acl_revision: source.acl.revision });
    }
    if (highest > SENSITIVITIES.indexOf(tenant_policy.max_sensitivity)) return deny('sensitivity_denied');
    return { allowed: true, reason: 'allowed', sensitivity: SENSITIVITIES[highest], content_trust: 'untrusted', pointers };
  } catch { return deny('invalid_source_policy'); }
}

const CODES = new Set(['allowed', 'unauthenticated', 'scope_denied', 'audience_denied', 'kind_denied',
  'action_denied', 'reference_denied', 'invalid_request', 'source_denied', 'provider_denied',
  'invalid_sources', 'invalid_destination', 'invalid_policy', 'invalid_source_policy', 'sensitivity_denied']);
export function accessDiagnostic(result) {
  return { component: 'service-access', allowed: result?.allowed === true,
    reason: CODES.has(result?.reason) ? result.reason : 'invalid_request' };
}
