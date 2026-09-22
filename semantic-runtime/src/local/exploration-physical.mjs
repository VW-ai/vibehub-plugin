import { openSync, closeSync, readSync, fstatSync, lstatSync, constants } from 'node:fs';
import { isAbsolute, join, resolve, parse, sep } from 'node:path';

const fail = () => Object.assign(new Error('Exploration Git metadata is unavailable or changed'), { code: 'exploration_physical_changed' });
const check = condition => { if (!condition) throw fail(); };
const oid = value => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
function components(path, optional = false) {
  check(typeof path === 'string' && isAbsolute(path) && path === resolve(path) && !/[\x00-\x1f\x7f]/.test(path));
  const root = parse(path).root; let current = root;
  for (const piece of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, piece);
    let s; try { s = lstatSync(current, { bigint: true }); }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw fail(); }
    check(!s.isSymbolicLink()); if (current !== path) check(s.isDirectory());
  }
  return lstatSync(path, { bigint: true });
}
function text(path, maximum = 4096, optional = false) {
  if (!components(path, optional)) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    check(before.isFile() && before.size <= BigInt(maximum));
    const bytes = Buffer.alloc(maximum + 1), n = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd, { bigint: true });
    check(n <= maximum && BigInt(n) === before.size && before.size === after.size && before.mtimeNs === after.mtimeNs);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n));
  } catch { throw fail(); } finally { if (fd !== undefined) closeSync(fd); }
}
function directory(path, identity) {
  const s = components(path); check(s.isDirectory());
  if (identity !== undefined) check(`${s.dev}:${s.ino}:${s.birthtimeNs}` === identity);
}
function refOid(common, name) {
  check(name.startsWith('refs/heads/') && name.length <= 1024 && name.split('/').every(p => p && p !== '.' && p !== '..') && !/[\s\x00-\x1f\x7f\\]/.test(name));
  const loose = text(join(common, name), 4096, true);
  if (loose !== null) { const value = loose.trim(); check(oid(value)); return value; }
  const packed = text(join(common, 'packed-refs'), 1048576, true); if (packed === null) return null;
  let result = null;
  for (const line of packed.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' '); check(space > 0);
    if (line.slice(space + 1) === name) { check(result === null && oid(line.slice(0, space))); result = line.slice(0, space); }
  }
  return result;
}

/** Bounded selected HEAD/ref observation. Never reads config/index or runs Git. */
export function observeExplorationGit({ checkout, worktree, ref }) {
  try {
    directory(worktree.path); directory(checkout.common_dir, checkout.common_identity); directory(worktree.git_dir, worktree.identity);
    const marker = join(worktree.path, '.git'), stat = components(marker);
    if (stat.isDirectory()) check(marker === worktree.git_dir);
    else {
      const value = text(marker).trim(); check(/^gitdir: [^\r\n]+$/.test(value));
      check(resolve(worktree.path, value.slice(8)) === worktree.git_dir);
    }
    const common = text(join(worktree.git_dir, 'commondir'), 4096, true);
    check((common === null ? worktree.git_dir : resolve(worktree.git_dir, common.trim())) === checkout.common_dir);
    const rawHead = text(join(worktree.git_dir, 'HEAD')), headText = rawHead.trim();
    let head, branch, detached, unborn;
    if (headText.startsWith('ref: ')) {
      branch = headText.slice(5); head = refOid(checkout.common_dir, branch); detached = false; unborn = head === null;
      check(worktree.branch === branch && !worktree.detached && worktree.unborn === unborn && worktree.head === head);
      if (unborn) check(ref === null);
      else check(ref && ref.state === 'active' && ref.name === branch && ref.oid === head);
    } else {
      check(oid(headText)); head = headText; branch = null; detached = true; unborn = false;
      check(worktree.detached && !worktree.unborn && worktree.branch === null && worktree.head === head && ref === null);
    }
    check(text(join(worktree.git_dir, 'HEAD')) === rawHead);
    if (branch) check(refOid(checkout.common_dir, branch) === head);
    directory(checkout.common_dir, checkout.common_identity); directory(worktree.git_dir, worktree.identity);
    return { head, ref_incarnation_id: ref?.ref_incarnation_id ?? null, ref_name: branch, detached, unborn, assurance: 'observed' };
  } catch { throw fail(); }
}
