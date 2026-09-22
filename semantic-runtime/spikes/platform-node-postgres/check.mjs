import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { validateWorkerAdmission, validateWorkerJob } from '../../src/index.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(resolve(here,'package.json')));
const deps=new Set([...Object.keys(manifest.dependencies),...Object.keys(manifest.devDependencies)]);
const builtins=new Set(builtinModules.map(x=>x.replace(/^node:/,'')));
let imports=0;
function checkImport(spec) {
  assert.equal(typeof spec,'string','computed imports are outside the spike boundary');imports++;
  if(spec.startsWith('node:')) {assert(builtins.has(spec.slice(5)));return;}
  if(spec.startsWith('.')) {const target=realpathSync(resolve(here,spec));assert(target.startsWith(here+'/')||target===realpathSync(resolve(here,'../../src/index.mjs')),'Only the Runtime public entry may be imported outside the spike');return;}
  assert(deps.has(spec),'undeclared or deep dependency import');
}
function walk(node) {if(!node||typeof node!=='object')return;if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)checkImport(node.source.value);if(node.type==='ImportExpression')checkImport(node.source.type==='Literal'?node.source.value:null);if(node.type==='CallExpression'&&node.callee?.name==='require')throw new Error('CommonJS require is outside the spike contract');for(const v of Object.values(node))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}
const files=readdirSync(here).filter(x=>x.endsWith('.mjs'));
for(const f of files)walk(parse(readFileSync(resolve(here,f),'utf8'),{ecmaVersion:'latest',sourceType:'module'}));
const fixture=JSON.parse(readFileSync(resolve(here,'fixture.json')));validateWorkerJob(fixture.job);assert.equal(validateWorkerAdmission(fixture.job,fixture.admission).status,'allowed');
console.log(JSON.stringify({status:'passed',files:files.length,imports,fixture:'public Worker protocol admitted'}));
