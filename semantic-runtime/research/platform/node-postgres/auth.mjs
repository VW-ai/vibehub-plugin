import { sign, verify } from 'node:crypto';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function issue(privateKey, claims) {
  const message = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(claims)}`;
  return `${message}.${sign(null, Buffer.from(message), privateKey).toString('base64url')}`;
}
export function authenticate(header, publicKey, scope) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 4096) throw new Error('unauthorized');
  const parts = header.slice(7).split('.');
  if (parts.length !== 3) throw new Error('unauthorized');
  const [head, body, signature] = parts;
  let h, c;
  try { h = JSON.parse(Buffer.from(head, 'base64url')); c = JSON.parse(Buffer.from(body, 'base64url')); } catch { throw new Error('unauthorized'); }
  if (!h || !c || typeof h !== 'object' || typeof c !== 'object' || Array.isArray(h) || Array.isArray(c)) throw new Error('unauthorized');
  if (h.alg !== 'EdDSA' || h.typ !== 'JWT' || !verify(null, Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url'))) throw new Error('unauthorized');
  if (c.iss !== 'synthetic-spike' || c.aud !== 'semantic-runtime-spike' || typeof c.sub !== 'string' || !Number.isSafeInteger(c.exp) || c.exp <= Math.floor(Date.now() / 1000)) throw new Error('unauthorized');
  if (c.tenant_id !== scope.tenant_id || c.project_id !== scope.project_id) throw new Error('forbidden');
  return c;
}
