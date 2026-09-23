export const LOCAL_AUDIENCE = 'vibehub-local-api';

/** Pure application port for an authority that owns opaque access contexts. */
export class AccessAuthority {
  constructor() {
    if (new.target === AccessAuthority) throw new TypeError('AccessAuthority is abstract');
  }

  issue() { throw new TypeError('AccessAuthority.issue is not implemented'); }
  authorize() { throw new TypeError('AccessAuthority.authorize is not implemented'); }
  inspect() { throw new TypeError('AccessAuthority.inspect is not implemented'); }
  materialize() { throw new TypeError('AccessAuthority.materialize is not implemented'); }
  revoke() { throw new TypeError('AccessAuthority.revoke is not implemented'); }
  close() { throw new TypeError('AccessAuthority.close is not implemented'); }
}
