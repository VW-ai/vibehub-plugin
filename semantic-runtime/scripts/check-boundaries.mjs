import { parse } from 'acorn';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);

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
      if (entry.isSymbolicLink()) {
        errors.push(`${relative(root, path)}: source symlinks are not allowed`);
      } else if (entry.isDirectory()) scan(path);
      else if (/\.(?:mjs|cjs|js|ts)$/.test(entry.name)) found.push(path);
    }
  }
  for (const area of ['src', 'scripts', 'test']) scan(resolve(root, area));
  const example = resolve(root, 'index.ts');
  if (existsSync(example)) found.push(example);
  return found;
}

// This is a dependency check, not a security sandbox. Filesystem/process access
// in adapters still needs ordinary code review and explicit input paths.
export function checkBoundaries(root = defaultRoot) {
  root = realpathSync(root);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const errors = [];
  const runtimeDeps = Object.keys(manifest.dependencies ?? {});
  const allDeps = [...runtimeDeps, ...Object.keys(manifest.devDependencies ?? {})];
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
    const core = within(resolve(root, 'src/core'), path);
    const production = within(resolve(root, 'src'), path) || path === resolve(root, 'index.ts');
    const fail = message => errors.push(`${name}: ${message}`);
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
        if (core && specifier !== 'node:crypto') fail(`core cannot import host/storage module ${specifier}`);
        return;
      }
      if (specifier.startsWith('.')) {
        const target = fileURLToPath(new URL(specifier, pathToFileURL(path)));
        if (!within(root, target) || (existsSync(target) && !within(root, realpathSync(target)))) {
          fail(`import escapes component: ${specifier}`);
        } else if (!existsSync(target)) fail(`missing import: ${specifier}`);
        else if (core && !within(resolve(root, 'src/core'), realpathSync(target))) {
          fail(`core cannot import adapters/tooling: ${specifier}`);
        } else if (production && !within(resolve(root, 'src'), realpathSync(target))) {
          fail(`production code cannot import tests/tooling: ${specifier}`);
        }
        return;
      }
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!(production ? runtimeDeps : allDeps).includes(packageName)) fail(`undeclared dependency: ${specifier}`);
      const dependency = resolve(root, 'node_modules', packageName);
      if (!existsSync(dependency) || !within(resolve(root, 'node_modules'), realpathSync(dependency))) {
        fail(`dependency must be installed inside this component: ${specifier}`);
      }
    });
  }
  return { ok: errors.length === 0, files: paths.length, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkBoundaries();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
