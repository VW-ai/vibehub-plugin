const denied = () => ({ allowed: false, reason: 'unauthenticated' });

/** Parse the local HTTP credential once, then delegate policy to the authority. */
export function authorizeLocalRequest(authority, request, policy) {
  // Multiple Authorization fields are rejected rather than letting Node choose one.
  const count = (request.rawHeaders ?? []).filter((_, i, headers) => i % 2 === 0 && headers[i].toLowerCase() === 'authorization').length;
  const value = request.headers.authorization;
  if (count !== 1 || typeof value !== 'string' || !value.startsWith('Bearer ')) return denied();
  return authority.authorize(value.slice(7), policy);
}
