import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_ROOTS = Object.freeze(['src', 'scripts', 'test', 'research', 'spikes', 'policies', 'docs']);
const ROOT_INVENTORY_EXCLUDES = new Set(['.env.local']);
const BASELINE_PATH = 'docs/architecture/runtime-layout-baseline-v1.json';

export const STANDALONE_COPY_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'index.ts',
  'src',
  'scripts',
  'test',
  'policies',
  BASELINE_PATH,
]);

const normalize = path => path.split(sep).join('/');
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);
const hash = value => createHash('sha256').update(value).digest('hex');

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walkAst(child, visit));
    else if (value && typeof value === 'object') walkAst(value, visit);
  }
}

function readAst(path) {
  const source = readFileSync(path, 'utf8');
  return {
    source,
    ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }),
  };
}

function listFiles(root, directory) {
  const found = [];
  const start = resolve(root, directory);
  if (!existsSync(start)) return found;
  const scan = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.local' || entry.name === '.env.local') continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) found.push(normalize(relative(root, path)));
    }
  };
  scan(start);
  return found;
}

function listRootFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && !ROOT_INVENTORY_EXCLUDES.has(entry.name))
    .map(entry => entry.name)
    .sort();
}

function capabilityFromName(path) {
  const name = path.split('/').at(-1).replace(/\.(?:test\.)?(?:mjs|js|json|md|html|css|swift|sql|yaml)$/, '');
  if (/query/.test(name)) return 'query';
  if (/context/.test(name)) return 'context';
  if (/exploration|branch-scope/.test(name)) return 'explorations';
  if (/graph/.test(name)) return 'graph';
  if (/judge|provider/.test(name)) return 'judge';
  if (/git|source|event|causal|canonical/.test(name)) return 'sources';
  if (/identity|auth|service-access/.test(name)) return 'identity';
  if (/worker|work-request|reconciliation/.test(name)) return 'work';
  if (/policy|observability/.test(name)) return 'decisions';
  if (/app|setup|service|session|transport|ui/.test(name)) return 'app';
  if (/project|activation|ingress/.test(name)) return 'project';
  return 'support';
}

function sourceDestination(path) {
  const basename = path.split('/').at(-1);
  if (path === 'src/index.mjs') return 'src/index.mjs';
  if (path === 'src/cli.mjs') return `research/phase0-replay/${basename}`;
  if (path.startsWith('src/core/')) {
    if (['replay.mjs', 'evaluation.mjs', 'policy.mjs', 'contracts.mjs'].includes(basename)) {
      return `research/phase0-replay/src/${basename}`;
    }
    return `src/domain/${capabilityFromName(path)}/${basename}`;
  }
  if (path.startsWith('src/adapters/')) {
    if (basename === 'sqlite-store.mjs') return `research/phase0-replay/adapters/${basename}`;
    if (/git/.test(basename)) return `src/adapters/git/${basename}`;
    return `src/adapters/providers/${basename}`;
  }
  if (path.startsWith('src/local/setup-ui/')) return `src/app/local/ui/${basename}`;
  if (['cli.mjs', 'service.mjs', 'setup-http.mjs', 'app-setup.mjs', 'app-session.mjs', 'auth.mjs'].includes(basename)) {
    return `src/app/local/${basename}`;
  }
  if (['keychain-helper.swift', 'macos-secret-store.mjs'].includes(basename)) return `src/adapters/secrets/${basename}`;
  if (['domain-store.mjs', 'graph-storage.mjs'].includes(basename)) return `src/adapters/sqlite/${basename}`;
  if (/git|physical/.test(basename)) return `src/adapters/git/${basename}`;
  if (/provider/.test(basename)) return `src/adapters/providers/${basename}`;
  return `src/application/${capabilityFromName(path)}/${basename}`;
}

function scriptDestination(path) {
  const basename = path.split('/').at(-1);
  if (/^probe-(?:codex|claude)-host/.test(basename)) {
    const host = basename.includes('codex') ? 'codex' : 'claude';
    return `research/host-probes/${host}/${basename}`;
  }
  if (/^(?:benchmark-peel|compare-peel|verify-peel)/.test(basename)) return `research/phase0-replay/${basename}`;
  if (/^(?:check-jev|smoke-)/.test(basename)) return `verification/live/jev/${basename}`;
  return `tools/${basename}`;
}

function testDestination(path) {
  const basename = path.split('/').at(-1);
  if (path.startsWith('test/fixtures/peel/')) return `research/phase0-replay/fixtures/${basename}`;
  if (path.startsWith('test/fixtures/')) return path;
  if (path.startsWith('test/helpers/')) return `test/support/${basename}`;
  if (path === 'test/helpers.mjs') return 'test/support/index.mjs';
  if (/^(?:codex|claude)-host-probe/.test(basename)) {
    const host = basename.includes('codex') ? 'codex' : 'claude';
    return `research/host-probes/${host}/test/${basename}`;
  }
  if (/^(?:jev-.+-check|synthetic-jev-check|context-judge-jev-check|query-jev-check)/.test(basename)) {
    return `verification/live/jev/test/${basename}`;
  }
  if (/^(?:replay|cli|peel-fixture|judge-comparison|jev-route-comparison)/.test(basename)) {
    return `research/phase0-replay/test/${basename}`;
  }
  return `test/${capabilityFromName(path)}/${basename}`;
}

function documentDestination(path) {
  const basename = path.split('/').at(-1);
  if (path.startsWith('docs/history/')) return path;
  if (path.startsWith('docs/measurements/')) {
    if (/^(?:codex|claude)-host/.test(basename)) {
      const host = basename.includes('codex') ? 'codex' : 'claude';
      return `research/host-probes/${host}/reports/${basename}`;
    }
    return `verification/reports/${capabilityFromName(path)}/${basename}`;
  }
  if (basename === '01_thought_log_semantic_runtime.md') return `docs/history/${basename}`;
  if (['02_prd_vibehub_semantic_runtime.md', 'online-delivery-plan.md'].includes(basename)) return `docs/product/${basename}`;
  if (['03_tech_design_semantic_runtime.md', 'local-app-integration-notes.md'].includes(basename)) return `docs/architecture/${basename}`;
  if (basename.startsWith('runtime-layout-')) return `docs/architecture/${basename}`;
  if (basename === 'project-exploration-ux-v0.md') return `research/ux/project-exploration/${basename}`;
  if (basename === 'platform-evaluation-v0.md') return `research/platform/node-postgres/${basename}`;
  if (/^(?:codex|claude)-host-probe/.test(basename)) {
    const host = basename.includes('codex') ? 'codex' : 'claude';
    return `research/host-probes/${host}/${basename}`;
  }
  if (basename === 'phase0-contracts.md') return `research/phase0-replay/${basename}`;
  if (basename === 'jev-synthetic-check.md') return `verification/live/jev/${basename}`;
  if (/^(?:local-|provider-settings|service-auth)/.test(basename)) return `docs/operations/${basename}`;
  return `docs/contracts/${basename}`;
}

function inventoryRecord(path) {
  if (!path.includes('/')) {
    if (path === 'index.ts') return { path, current_role: 'gateway-example', intended_destination: 'research/examples/ai-gateway/index.ts' };
    if (path === '.env.example') return { path, current_role: 'configuration-example', intended_destination: path };
    if (path === 'README.md') return { path, current_role: 'component-documentation', intended_destination: path };
    if (path === 'AGENTS.md') return { path, current_role: 'component-instructions', intended_destination: path };
    return { path, current_role: 'component-metadata', intended_destination: path };
  }
  if (path.startsWith('src/')) return { path, current_role: 'production', intended_destination: sourceDestination(path) };
  if (path.startsWith('scripts/')) return { path, current_role: 'tooling-or-runner', intended_destination: scriptDestination(path) };
  if (path.startsWith('test/')) return { path, current_role: 'test-or-fixture', intended_destination: testDestination(path) };
  if (path.startsWith('research/ux/')) return { path, current_role: 'ux-research', intended_destination: path };
  if (path.startsWith('research/platform/')) return { path, current_role: 'platform-research', intended_destination: path };
  if (path.startsWith('research/host-probes/')) return { path, current_role: 'host-research', intended_destination: path };
  if (path.startsWith('research/')) return { path, current_role: 'research', intended_destination: path };
  if (path.startsWith('spikes/platform-node-postgres/')) return { path, current_role: 'platform-research', intended_destination: `research/platform/node-postgres/${path.slice('spikes/platform-node-postgres/'.length)}` };
  if (path.startsWith('policies/')) return { path, current_role: 'phase0-research', intended_destination: `research/phase0-replay/policies/${path.slice('policies/'.length)}` };
  return { path, current_role: 'documentation-or-report', intended_destination: documentDestination(path) };
}

function rootExports(root) {
  const { ast } = readAst(resolve(root, 'src/index.mjs'));
  const names = [];
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    for (const specifier of node.specifiers ?? []) names.push(specifier.exported.name ?? specifier.exported.value);
    if (node.declaration?.type === 'VariableDeclaration') {
      for (const declaration of node.declaration.declarations) {
        if (declaration.id?.type === 'Identifier') names.push(declaration.id.name);
      }
    } else if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.declaration?.type) && node.declaration.id?.name) {
      names.push(node.declaration.id.name);
    }
  }
  return names.sort();
}

function contractConstants(root) {
  const records = [];
  for (const path of listFiles(root, 'src').filter(item => item.endsWith('.mjs'))) {
    const absolute = resolve(root, path);
    const { source, ast } = readAst(absolute);
    for (const node of ast.body) {
      if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration') continue;
      for (const declaration of node.declaration.declarations) {
        const name = declaration.id?.name;
        if (!name || !/(?:_VERSION|_SCHEMA|_NAMESPACE)$/.test(name)) continue;
        const initializer = declaration.init;
        if (initializer?.type === 'Literal') records.push({ module: path, name, value: initializer.value });
        else records.push({ module: path, name, source_sha256: hash(source.slice(initializer?.start ?? node.start, initializer?.end ?? node.end)) });
      }
    }
  }
  return records.sort((left, right) => left.module.localeCompare(right.module) || left.name.localeCompare(right.name));
}

function productionGraph(root) {
  const files = listFiles(root, 'src').filter(path => /\.(?:mjs|cjs|js|ts)$/.test(path)).sort();
  const nodes = new Set(files);
  const edgeKeys = new Set();
  for (const from of files) {
    const absolute = resolve(root, from);
    const { ast } = readAst(absolute);
    walkAst(ast, node => {
      if (!['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type)) return;
      const specifier = node.source?.value;
      if (typeof specifier !== 'string' || !specifier.startsWith('.')) return;
      const target = normalize(relative(root, fileURLToPath(new URL(specifier, pathToFileURL(absolute)))));
      if (nodes.has(target)) edgeKeys.add(`${from}\0${target}`);
    });
  }
  const edges = [...edgeKeys].map(key => {
    const [from, to] = key.split('\0');
    return { from, to };
  });
  edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));

  const adjacency = new Map(files.map(path => [path, []]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let next = 0;
  const visit = node => {
    indices.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length) {
      const item = stack.pop();
      onStack.delete(item);
      component.push(item);
      if (item === node) break;
    }
    if (component.length > 1 || (adjacency.get(node) ?? []).includes(node)) components.push(component.sort());
  };
  for (const node of files) if (!indices.has(node)) visit(node);
  components.sort((left, right) => left[0].localeCompare(right[0]));
  return { edges, strongly_connected_components: components };
}

export function inspectProductionGraph(root = scriptRoot) {
  return productionGraph(resolve(root));
}

export function readRuntimeLayoutBaseline(root = scriptRoot) {
  const path = resolve(root, BASELINE_PATH);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function commandMode(name) {
  if (name === 'start' || name === 'app' || name === 'status') return 'local-runtime';
  if (name === 'example:gateway' || name === 'replay:jev' || name.startsWith('smoke:')
    || name.startsWith('check:jev:') || name === 'benchmark:peel:compare'
    || name === 'benchmark:peel:compare:gateway' || name.startsWith('benchmark:peel:jev')) return 'explicit-live';
  return 'offline';
}

export function inspectRuntimeLayout(root = scriptRoot) {
  root = resolve(root);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const inventory = INVENTORY_ROOTS.flatMap(area => listFiles(root, area))
    .concat(listRootFiles(root))
    .map(inventoryRecord)
    .sort((left, right) => left.path.localeCompare(right.path));
  const graph = productionGraph(root);
  return {
    schema_version: 1,
    inventory_roots: [...INVENTORY_ROOTS, '<runtime-root-files>'],
    inventory,
    root_exports: rootExports(root),
    npm_commands: Object.entries(manifest.scripts ?? {})
      .map(([name, command]) => ({ name, command, mode: commandMode(name) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    contract_constants: contractConstants(root),
    standalone_copy_paths: [...STANDALONE_COPY_PATHS],
    production_import_edges: graph.edges,
    production_sccs: graph.strongly_connected_components,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function itemKey(item) {
  return typeof item === 'string' ? item : JSON.stringify(stable(item));
}

function compareSection(name, expected, actual, errors) {
  const expectedItems = new Map((expected ?? []).map(item => [itemKey(item), item]));
  const actualItems = new Map((actual ?? []).map(item => [itemKey(item), item]));
  const removed = [...expectedItems.keys()].filter(key => !actualItems.has(key)).slice(0, 12);
  const added = [...actualItems.keys()].filter(key => !expectedItems.has(key)).slice(0, 12);
  if (removed.length) errors.push(`${name}: removed or changed ${removed.join(', ')}`);
  if (added.length) errors.push(`${name}: added or changed ${added.join(', ')}`);
}

export function checkRuntimeLayout(root = scriptRoot) {
  root = resolve(root);
  const baseline = readRuntimeLayoutBaseline(root);
  if (!baseline) return { ok: false, inventory_checked: false, errors: [`missing Runtime layout baseline: ${BASELINE_PATH}`] };
  const current = inspectRuntimeLayout(root);
  const errors = [];
  for (const section of ['inventory_roots', 'root_exports', 'npm_commands', 'contract_constants', 'standalone_copy_paths', 'production_import_edges', 'production_sccs']) {
    compareSection(section, baseline[section], current[section], errors);
  }
  const inventoryChecked = INVENTORY_ROOTS.every(area => existsSync(resolve(root, area))) && existsSync(resolve(root, 'index.ts'));
  if (inventoryChecked) compareSection('inventory', baseline.inventory, current.inventory, errors);
  return { ok: errors.length === 0, inventory_checked: inventoryChecked, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print-current')) {
    console.log(JSON.stringify(inspectRuntimeLayout(), null, 2));
  } else {
    const result = checkRuntimeLayout();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
