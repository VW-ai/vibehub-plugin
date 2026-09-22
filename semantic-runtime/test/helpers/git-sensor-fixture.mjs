import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DomainStore, migrateDomainStore } from '../../src/local/domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../../src/local/auth.mjs';
import { scopedReference } from '../../src/core/service-access.mjs';
import { GitProjectRegistry } from '../../src/local/git-projects.mjs';
import { ProjectActivation } from '../../src/local/project-activation.mjs';
import { DurableIngress } from '../../src/local/durable-ingress.mjs';
import { LocalGitWorktreeSensor } from '../../src/local/git-worktree-sensor.mjs';
export const SENSOR_SCOPE = { tenant_id: 'synthetic', project_id: 'git-sensor' };
export const SENSOR_ACTIONS = ['store:read', 'store:write', 'project:inspect', 'project:enroll', 'activation:read', 'activation:write', 'activation:admit',
  'ingress:register', 'ingress:read', 'ingress:submit', 'sensor:capture', 'sensor:read'];
export function git(folder, ...args) { return execFileSync('git', ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], {
  cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: folder, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim(); }
export function sensorFixture(t, { unborn = false, format = 'sha1', enabled = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vh-git-sensor-test-'))), folder = join(root, 'project'); mkdirSync(folder);
  git(folder, 'init', '--initial-branch=main', `--object-format=${format}`);
  if (!unborn) { writeFileSync(join(folder, 'note.txt'), 'first line\n'); git(folder, 'add', 'note.txt'); git(folder, 'commit', '-m', 'synthetic'); }
  const filePath = join(root, 'domain.sqlite'); migrateDomainStore({ filePath }); const handles = [], clock = { auth: 1000, mono: 0 };
  const connect = () => {
    const authority = new LocalCredentialAuthority({ now: () => clock.auth });
    const issue = ({ principal = 'owner', actions = SENSOR_ACTIONS, scope = SENSOR_SCOPE, ttl_ms = 3600000 } = {}) => {
      const issued = authority.issue({ principal_id: principal, kind: 'service', scope, actions, ttl_ms });
      const granted = authority.authorize(issued.credential, { scope, action: actions[0], audience: LOCAL_AUDIENCE, kinds: ['service'], boundary: 'object', reference: scopedReference('object', scope, 'sensor-test') });
      assert(granted.allowed); return { context: granted.context, issued };
    };
    const store = new DomainStore({ filePath, authority, namespaces: ['git-enrollment', 'project-activation', 'durable-ingress', 'source-invalidation'] });
    const f = { authority, issue, store, ...issue(), registry: new GitProjectRegistry({ store, authority }), activation: new ProjectActivation({ store, authority }),
      ingress: new DurableIngress({ store, authority }), sensor: new LocalGitWorktreeSensor({ store, authority, monotonicNow: () => clock.mono }) };
    handles.push(f); return f;
  };
  const f = { root, folder, filePath, clock, ...connect(), reopen: connect };
  f.registry.enroll(f.context, { folder, expectedVersion: null });
  if (enabled) f.activation.setEnabled(f.context, { enabled: true, expectedVersion: null });
  f.register = (path = folder, extra = {}) => {
    const row = f.registry.get(f.context), c = row.value.checkouts.find(c => c.worktrees.some(w => w.path === path)), w = c.worktrees.find(w => w.path === path && w.state === 'active');
    return f.ingress.registerSource(f.context, { partition: { ...SENSOR_SCOPE, source_installation_id: row.value.installation_id, partition_id: `part-${crypto.randomUUID()}` },
      producer: { producer_id: 'git-sensor', epoch: 'epoch-1' }, producer_principal_id: 'owner', start_sequence: 0,
      mapping: { schema_version: 1, mapping_id: 'git-sensor', revision: 'v1', event_types: { git_worktree_snapshot: 'GIT_DIFF' } },
      execution: { repository_id: c.repository_id, checkout_id: c.checkout_id, worktree_id: w.worktree_id },
      access: { enabled: true, allowed_principal_ids: ['owner', 'reader'], sensitivity: 'normal', allow_snapshots: true }, ...extra });
  };
  f.capture = async (source, { sensor = f.sensor, context = f.context } = {}) => { sensor.hint({ registration_id: source.registration_id });
    return (await sensor.drain(context, { limit: 1, force: true })).results[0]; };
  f.metadata = event_id => JSON.parse(f.ingress.readSnapshot(f.context, { event_id }).text);
  f.refresh = () => { const row = f.registry.get(f.context); return f.registry.refresh(f.context, { checkout_id: row.value.checkouts[0].checkout_id, expectedVersion: row.version }); };
  t.after(() => { for (const h of handles) { h.sensor.close(); h.store.close(); h.authority.close(); } rmSync(root, { recursive: true, force: true }); }); return f;
}
