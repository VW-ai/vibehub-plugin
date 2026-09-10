#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, parseUiFlags, startVibeHubUi } from './vh-ui.mjs';

function canonical(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

// Reuse only a capability already supplied by the calling agent's session.
// Never send its bearer to an arbitrary host, follow redirects, or scan ports.
export async function reusableDashboard(url, { repoRoot, roots = [], personalStore = null } = {}) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || !parsed.port || parsed.username || parsed.password
    || !/^#[a-f0-9]{64}$/u.test(parsed.hash)) return null;
  try {
    const response = await fetch(`${parsed.origin}/api/dashboard`, {
      headers: { Authorization: `Bearer ${parsed.hash.slice(1)}` },
      redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (!result.ok || !Array.isArray(result.data?.projects)) return null;
    const knownRoots = (result.data.roots || []).map(canonical);
    if (roots.some((root) => !knownRoots.includes(canonical(root)))) return null;
    if (personalStore && canonical(result.data.personalStore || '') !== canonical(personalStore)) return null;
    const repo = canonical(repoRoot);
    const containsRepo = result.data.projects.some((project) => project.worktrees.some((tree) => canonical(tree.path) === repo));
    if (!containsRepo && !knownRoots.includes(repo)) return null;
    return { origin: parsed.origin, url: `${parsed.origin}/dashboard${parsed.hash}`, reused: true, readOnly: true };
  } catch { return null; }
}

export function personalStoreFromConfig(configPath = join(homedir(), '.config', 'vibehub-personal', 'config.yaml')) {
  if (!existsSync(configPath)) return { path: null, warning: null };
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (config.kind !== 'personal_hub_config' || typeof config.data_root !== 'string' || !config.data_root.trim()) throw new Error('Invalid personal hub configuration');
    return { path: resolve(config.data_root), warning: null };
  } catch (error) { return { path: null, warning: `Personal goals were not connected: ${error.message}` }; }
}

export async function enterVibeHub({ repoRoot, roots = [], personalStore = null, reuseUrl = null, open = true, openUrl = openBrowser, port = 0 } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required');
  const reused = await reusableDashboard(reuseUrl, { repoRoot, roots, personalStore });
  if (reused) return { ...reused, handle: null };
  const handle = startVibeHubUi({ repoRoot, dashboardRoots: [...new Set([repoRoot, ...roots].map(resolvePath))], personalStore, port });
  try {
    const ready = await handle.ready;
    if (open) openUrl(ready.url);
    return { ...ready, reused: false, readOnly: true, handle };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
function resolvePath(path) { return resolve(path); }

export function parseStartFlags(argv) {
  const uiArgs = [], roots = [];
  let reuseUrl = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reuse-url') {
      if (reuseUrl !== null || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--reuse-url requires one complete dashboard URL');
      reuseUrl = argv[++i];
    } else {
      if (argv[i] === '--root' && argv[i + 1]) roots.push(resolve(argv[i + 1]));
      uiArgs.push(argv[i]);
    }
  }
  const flags = parseUiFlags(['--dashboard', ...uiArgs]);
  return { ...flags, roots, reuseUrl };
}

async function launch(argv) {
  const flags = parseStartFlags(argv);
  const personal = flags.personalStore ? { path: flags.personalStore, warning: null } : personalStoreFromConfig();
  const result = await enterVibeHub({ repoRoot: flags.repo, roots: flags.roots, personalStore: personal.path, reuseUrl: flags.reuseUrl, open: flags.open, port: flags.port });
  const { handle, ...ready } = result;
  if (flags.json) process.stdout.write(`${JSON.stringify({ ok: true, ...ready, warning: personal.warning })}\n`);
  else process.stdout.write(`VibeHub dashboard${ready.reused ? ' (already running)' : ''}\n${ready.url}\n${personal.warning ? `${personal.warning}\n` : ''}`);
  if (!handle) return;
  const close = () => void handle.close();
  process.once('SIGINT', close); process.once('SIGTERM', close);
  await handle.closed;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  launch(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Dashboard unavailable; continue the requested work: ${error.message}\n`);
    process.exitCode = 1;
  });
}
