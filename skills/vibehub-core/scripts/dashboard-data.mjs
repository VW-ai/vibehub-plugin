import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ignored = new Set(['node_modules', 'vendor', 'dist', 'build', 'Library']);
const id = (path) => createHash('sha256').update(path).digest('hex').slice(0, 20);
function git(path, args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).trim();
}

// Explicit roots only. Do not follow directory symlinks or scan inside a repo.
// Connected registered worktrees are included even outside a scan root.
// The VibeHub version marker denotes an opted-in checkout, even if its data
// needs repair. Merely existing under a discovery root is not a connection.
export function discoverDashboard(roots, { projectRefs = [] } = {}) {
  const projects = new Map(), visited = new Set(), warnings = [];
  let examined = 0;
  function visit(path, depth) {
    if (++examined > 10000) throw new Error('Discovery reached 10,000 directories; choose narrower roots.');
    try {
      if (lstatSync(path).isSymbolicLink()) return;
      path = realpathSync(path);
      if (visited.has(path)) return;
      visited.add(path);
      if (existsSync(join(path, '.git'))) {
        const common = realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir'])));
        if (projects.has(common)) return;
        const entries = git(path, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
        const worktrees = [];
        for (const entry of entries) {
          const fields = entry.split('\0');
          const location = fields.find((f) => f.startsWith('worktree '))?.slice(9);
          if (!location) continue;
          const branch = fields.find((f) => f.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') || 'detached';
          const available = existsSync(location) && !lstatSync(location).isSymbolicLink();
          worktrees.push({ id: id(location), path: location, branch, available,
            hasTickets: available && existsSync(join(location, '.vibehub', 'version.yaml')) });
        }
        const main = worktrees[0]?.path || path;
        projects.set(common, { id: id(common), name: basename(main), path: main, worktrees });
        return;
      }
      if (depth >= 4) return;
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) visit(join(path, entry.name), depth + 1);
      }
    } catch (error) { warnings.push({ path, message: error.message }); }
  }
  for (const root of roots) visit(resolve(root), 0);
  const discovered = [...projects.values()];
  const linked = project => projectRefs.some(ref => ref === project.path || (ref === project.name && discovered.filter(p=>p.name===ref).length===1));
  return { projects: discovered
    .map(project => ({ ...project, connectedVia: linked(project) ? 'personal' : 'repository', worktrees: project.worktrees.filter(tree => tree.hasTickets || linked(project)) }))
    .filter(project => project.worktrees.length)
    .sort((a,b) => a.name.localeCompare(b.name)), warnings };
}

// The personal hub writes JSON-compatible YAML. Malformed records are reported,
// never converted or silently written back to the user's store.
export function readPersonalStore(root) {
  if (!root) return { connected: false, tickets: [], warnings: [] };
  const tickets = [], warnings = [], seen = new Set();
  try {
    const directory = join(realpathSync(root), 'tickets');
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Personal tickets directory must not be a symlink');
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.yaml')).sort()) {
      const path = join(directory, file);
      try {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (record.kind !== 'personal_ticket' || typeof record.personal_ticket_id !== 'string' || typeof record.title !== 'string') throw new Error('Unsupported personal ticket record');
        if (seen.has(record.personal_ticket_id)) throw new Error('Duplicate personal ticket identity');
        if ((record.project_refs !== undefined && (!Array.isArray(record.project_refs) || record.project_refs.some((p) => typeof p !== 'string')))
          || (record.relations !== undefined && (!Array.isArray(record.relations) || record.relations.some((r) => !r || typeof r.type !== 'string' || typeof r.target !== 'string')))
          || (record.state !== undefined && typeof record.state !== 'string')
          || (record.desired_outcome !== undefined && typeof record.desired_outcome !== 'string')) throw new Error('Malformed personal ticket fields');
        seen.add(record.personal_ticket_id);
        tickets.push({ id: record.personal_ticket_id, title: record.title,
          outcome: record.desired_outcome || '', type: record.type || 'task', state: record.state,
          attention: record.attention, working: Boolean(record.work), projects: record.project_refs || [],
          externalKeys: Array.isArray(record.external_keys) ? record.external_keys.filter(k => k && typeof k.system === 'string' && typeof k.key === 'string') : [],
          relations: record.relations || [], path });
      } catch (error) { warnings.push({ path, message: error.message }); }
    }
  } catch (error) { warnings.push({ path: root, message: error.message }); }
  return { connected: true, tickets, warnings };
}
