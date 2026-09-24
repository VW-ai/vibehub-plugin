import { parse } from 'acorn';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRuntimeLayout, inspectProductionGraph, readRuntimeLayoutBaseline } from './runtime-layout.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);
// Hashing and inert-value inspection have no filesystem, process, provider or
// storage capability. Keep the general util module and all I/O modules outside core.
const coreBuiltins = new Set(['node:crypto', 'node:util/types']);
const SCANNED_AREAS = Object.freeze(['src', 'scripts', 'test', 'tools', 'verification', 'research']);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function files(root, errors) {
  const found = [];
  function scan(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && ['node_modules', '.local'].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        errors.push(`${relative(root, path)}: source symlinks are not allowed`);
      } else if (entry.isDirectory()) scan(path);
      else if (/\.(?:mjs|cjs|js|ts)$/.test(entry.name)) found.push(path);
    }
  }
  for (const area of SCANNED_AREAS) scan(resolve(root, area));
  return found;
}

function targetRole(name) {
  if (name.startsWith('src/domain/')) return 'domain';
  if (name.startsWith('src/application/')) return 'application';
  if (name.startsWith('src/adapters/')) return 'adapters';
  if (name.startsWith('src/app/local/')) return 'app-local';
  return null;
}

function pathRole(root, path, layoutBaseline) {
  const name = relative(root, path).split(sep).join('/');
  const directRole = targetRole(name);
  if (directRole) return directRole;
  if (name.startsWith('src/core/')) return 'domain';
  if (name.startsWith('src/local/')) {
    const destination = layoutBaseline?.inventory?.find(record => record.path === name)?.intended_destination;
    const transitionalRole = typeof destination === 'string' ? targetRole(destination) : null;
    if (transitionalRole) return transitionalRole;
  }
  if (name.startsWith('test/')) return 'test';
  if (name.startsWith('tools/') || name.startsWith('scripts/')) return 'tools';
  if (name.startsWith('verification/')) return 'verification';
  if (name.startsWith('research/')) return 'research';
  return name.startsWith('src/') ? 'production' : 'other';
}

const componentKey = component => JSON.stringify([...component].sort());

function nearestPackageRoot(root, path) {
  let directory = dirname(path);
  while (within(root, directory)) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return root;
}

// This is a dependency check, not a security sandbox. Filesystem/process access
// in adapters still needs ordinary code review and explicit input paths.
export function checkBoundaries(root = defaultRoot) {
  root = realpathSync(root);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const errors = [];
  const runtimeDeps = Object.keys(manifest.dependencies ?? {});
  const allDeps = [...runtimeDeps, ...Object.keys(manifest.devDependencies ?? {})];
  const packageCache = new Map([[root, { manifest, runtimeDeps, allDeps }]]);
  let layoutBaseline = null;
  try {
    layoutBaseline = readRuntimeLayoutBaseline(root);
  } catch (error) {
    errors.push(`runtime layout baseline cannot be read: ${error.message}`);
  }
  const baselinedEdges = new Set((layoutBaseline?.production_import_edges ?? [])
    .map(edge => `${edge.from}\0${edge.to}`));
  const baselinedDirectionExceptions = [];
  if (manifest.imports || manifest.workspaces) errors.push('package aliases/workspaces need explicit boundary support');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
        errors.push(`${section}.${name}: use an exact registry version, not a sibling link or range`);
      }
    }
  }
  const paths = files(root, errors);
  for (const path of paths) {
    const name = relative(root, path);
    const role = pathRole(root, path, layoutBaseline);
    const domain = role === 'domain';
    const production = within(resolve(root, 'src'), path);
    const fail = message => errors.push(`${name}: ${message}`);
    const failDirection = (message, targetPath) => {
      const from = name.split(sep).join('/');
      const to = relative(root, targetPath).split(sep).join('/');
      if (baselinedEdges.has(`${from}\0${to}`)) {
        baselinedDirectionExceptions.push({ from, to, reason: message });
      } else fail(message);
    };
    let ast;
    try {
      ast = parse(readFileSync(path, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (error) {
      fail(`cannot check syntax: ${error.message}`);
      continue;
    }
    walk(ast, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
        && ['require', 'eval', 'createRequire'].includes(node.callee.name)) {
        fail('use statically checkable ESM imports');
      }
      let source;
      if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type)) {
        source = node.source;
      }
      if (!source) return;
      if (source.type !== 'Literal' || typeof source.value !== 'string') {
        fail('computed imports are not allowed');
        return;
      }
      const specifier = source.value;
      if (isBuiltin(specifier)) {
        if (domain && !coreBuiltins.has(specifier)) fail(`domain cannot import host, provider, or storage module ${specifier}`);
        return;
      }
      if (specifier.startsWith('.')) {
        const target = fileURLToPath(new URL(specifier, pathToFileURL(path)));
        if (!within(root, target) || (existsSync(target) && !within(root, realpathSync(target)))) {
          fail(`import escapes component: ${specifier}`);
        } else if (!existsSync(target)) fail(`missing import: ${specifier}`);
        else {
          const targetPath = realpathSync(target);
          const importedRole = pathRole(root, targetPath, layoutBaseline);
          if (domain && ['application', 'adapters', 'app-local', 'production'].includes(importedRole)) {
            failDirection(`domain cannot import ${importedRole}: ${specifier}`, targetPath);
          } else if (role === 'application' && importedRole === 'app-local') {
            failDirection(`application cannot import app-local: ${specifier}`, targetPath);
          } else if (role === 'adapters' && importedRole === 'app-local') {
            failDirection(`adapters cannot import app-local: ${specifier}`, targetPath);
          } else if (production && ['research', 'verification', 'test'].includes(importedRole)) {
            failDirection(`production code cannot import ${importedRole}: ${specifier}`, targetPath);
          } else if (production && !within(resolve(root, 'src'), targetPath)) {
            fail(`production code cannot import tests/tooling: ${specifier}`);
          }
        }
        return;
      }
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (domain) fail(`domain cannot import external package ${specifier}`);
      const packageRoot = production ? root : nearestPackageRoot(root, path);
      if (!packageCache.has(packageRoot)) {
        const owner = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
        const ownerRuntimeDeps = Object.keys(owner.dependencies ?? {});
        packageCache.set(packageRoot, {
          manifest: owner,
          runtimeDeps: ownerRuntimeDeps,
          allDeps: [...ownerRuntimeDeps, ...Object.keys(owner.devDependencies ?? {})],
        });
      }
      const dependencyNames = production ? packageCache.get(packageRoot).runtimeDeps : packageCache.get(packageRoot).allDeps;
      if (!dependencyNames.includes(packageName)) fail(`undeclared dependency: ${specifier}`);
      const dependencyRoot = resolve(packageRoot, 'node_modules');
      const dependency = resolve(dependencyRoot, packageName);
      if (!existsSync(dependency) || !within(dependencyRoot, realpathSync(dependency))) {
        fail(`dependency must be installed inside this component: ${specifier}`);
      }
    });
  }
  let graph = { edges: [], strongly_connected_components: [] };
  try {
    graph = inspectProductionGraph(root);
  } catch (error) {
    errors.push(`production import graph cannot be inspected: ${error.message}`);
  }
  const allowedSccs = new Set((layoutBaseline?.production_sccs ?? []).map(componentKey));
  for (const component of graph.strongly_connected_components) {
    if (!allowedSccs.has(componentKey(component))) {
      errors.push(`production dependency cycle is not baselined: ${component.join(' -> ')}`);
    }
  }
  if (manifest.name === '@vibehub/semantic-runtime') {
    try {
      const layout = checkRuntimeLayout(root);
      errors.push(...layout.errors.map(error => `runtime layout: ${error}`));
    } catch (error) {
      errors.push(`runtime layout cannot be checked: ${error.message}`);
    }
  }
  baselinedDirectionExceptions.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return {
    ok: errors.length === 0,
    files: paths.length,
    production_sccs: graph.strongly_connected_components,
    baselined_direction_exceptions: baselinedDirectionExceptions,
    errors,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkBoundaries();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
