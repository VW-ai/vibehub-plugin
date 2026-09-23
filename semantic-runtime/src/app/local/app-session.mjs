import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const failure = code => Object.assign(new Error(`Local setup: ${code}`), { code });
const digest = token => createHash('sha256').update(token).digest();
const same = (record, token) => record && typeof token === 'string'
  && /^[A-Za-z0-9_-]{43}$/.test(token) && timingSafeEqual(record.digest, digest(token));

/** One launcher terminal is the approval authority. No HTTP caller gets this object. */
export class AppSessions {
  #origin; #available; #pending = null; #active = null; #closed = false; #now; #notify;
  constructor({ origin, available = false, onPending = () => {}, now = () => Date.now() }) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || typeof available !== 'boolean'
      || typeof onPending !== 'function' || typeof now !== 'function') throw failure('invalid_setup_config');
    this.#origin = origin; this.#available = available; this.#notify = onPending; this.#now = now;
    this.cookieName = `vh_setup_${randomBytes(12).toString('hex')}`;
    Object.defineProperty(this, 'cookieName', { writable: false, configurable: false });
  }
  #time() { const now = this.#now(); if (!Number.isSafeInteger(now) || now < 0) throw failure('setup_unavailable'); return now; }
  #expire() {
    const now = this.#time();
    if (this.#pending?.expires <= now) this.#pending = null;
    if (this.#active?.expires <= now) this.#active = null;
  }
  #token(cookie) {
    if (cookie === undefined) return null;
    if (typeof cookie !== 'string' || cookie.length > 8192) throw failure('setup_unauthorized');
    const values = cookie.split(';').map(item => item.trim()).filter(item => item.startsWith(`${this.cookieName}=`));
    if (values.length > 1) throw failure('setup_unauthorized');
    return values.length ? values[0].slice(this.cookieName.length + 1) : null;
  }
  #cookie(token) {
    return `${this.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/v1/setup`;
  }
  #check(origin) {
    if (this.#closed || origin !== this.#origin) throw failure('setup_unauthorized');
    this.#expire();
  }
  status(cookie, origin) {
    this.#check(origin); const token = this.#token(cookie);
    if (same(this.#active, token)) return { data: { state: 'paired', pairing_available: this.#available } };
    if (same(this.#pending, token)) {
      if (this.#pending.approved) {
        const sessionToken = randomBytes(32).toString('base64url');
        const expires = this.#time() + 3_600_000;
        this.#active = { digest: digest(sessionToken), expires, owner: Object.freeze({ expires_at: expires }) };
        this.#pending = null;
        return { data: { state: 'paired', pairing_available: this.#available }, cookie: this.#cookie(sessionToken) };
      }
      return { data: { state: 'pending', code: this.#pending.code, pairing_available: this.#available } };
    }
    return { data: { state: 'unpaired', pairing_available: this.#available } };
  }
  begin(cookie, origin) {
    const current = this.status(cookie, origin);
    if (current.data.state !== 'unpaired') return current;
    if (!this.#available) throw failure('pairing_unavailable');
    if (this.#pending) throw failure('pairing_busy');
    const token = randomBytes(32).toString('base64url'), code = randomBytes(4).toString('hex').toUpperCase();
    this.#pending = { digest: digest(token), code, expires: this.#time() + 120_000, approved: false };
    try { this.#notify(code); } catch { this.#pending = null; throw failure('pairing_unavailable'); }
    return { data: { state: 'pending', code, pairing_available: true }, cookie: this.#cookie(token) };
  }
  // Trusted in-process launcher hook; the comparison code is not a web credential.
  approve(code) {
    if (this.#closed || !this.#available) return false;
    this.#expire();
    if (!this.#pending || this.#pending.approved || code !== this.#pending.code) return false;
    this.#active = null; this.#pending.approved = true; return true;
  }
  owner(cookie, origin) {
    this.#check(origin);
    if (!same(this.#active, this.#token(cookie))) throw failure('setup_unauthorized');
    const selected = this.#active;
    return () => {
      this.#check(origin);
      if (this.#active !== selected) throw failure('setup_unauthorized');
      return selected.owner;
    };
  }
  revoke() { this.#pending = null; this.#active = null; }
  disable() { this.#available = false; this.revoke(); }
  close() { this.#closed = true; this.revoke(); }
}
