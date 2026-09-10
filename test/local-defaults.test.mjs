import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {helper,run,ticket,root} from './helpers.mjs';
import {projectSharing} from '../skills/vibehub-core/scripts/vh.mjs';
import * as published from '../scripts/sync-github-issues.mjs';
const bundleRoot=mkdtempSync(join(tmpdir(),'vibehub-opt-in-bundle-'));
after(()=>rmSync(bundleRoot,{recursive:true,force:true}));
for(const [source,destination] of [
  ['templates/github/sync-github-issues.mjs','sync-github-issues.mjs'],
  ['scripts/vh.mjs','scripts/vh.mjs'],['scripts/revision-contract.mjs','scripts/revision-contract.mjs'],
  ['contracts/versions.json','contracts/versions.json'],['contracts/dependency-hygiene.json','contracts/dependency-hygiene.json'],
]) { const target=join(bundleRoot,destination); mkdirSync(dirname(target),{recursive:true}); copyFileSync(join(root,'skills/vibehub-core',source),target); }
const bundled=await import(pathToFileURL(join(bundleRoot,'sync-github-issues.mjs')));

function fixture(t) {const repo=mkdtempSync(join(tmpdir(),'vibehub-local-default-')); t.after(()=>rmSync(repo,{recursive:true,force:true})); return repo;}
function init(repo) {const result=spawnSync(process.execPath,[helper,'project','init','--repo',repo],{encoding:'utf8'}); assert.equal(result.status,0,result.stdout+result.stderr); return JSON.parse(result.stdout).data;}
function git(repo,...args) {const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8'}); assert.equal(result.status,0,result.stderr); return result.stdout;}
test('new local tickets validate without GitHub and stay out of normal staging',t=>{
  const repo=fixture(t), initialized=init(repo);
  assert.equal(initialized.sharing.default,'local');
  const record=ticket('private-plan');
  const applied=spawnSync(process.execPath,[helper,'ticket','apply','--repo',repo,'--input','-'],{encoding:'utf8',input:JSON.stringify({validation:{independent:false,note:'Local mode fixture'},tickets:[record]})});
  assert.equal(applied.status,0,applied.stdout+applied.stderr);
  assert.equal(run(repo,'project','validate').status,0);
  assert.equal(run(repo,'ticket','graph').status,0);
  // Exclusion also works when Git is initialized after VibeHub.
  git(repo,'init','-q'); writeFileSync(join(repo,'code.txt'),'public code\n'); git(repo,'add','-A');
  assert.equal(git(repo,'ls-files').trim(),'code.txt');
  assert.match(git(repo,'check-ignore','.vibehub/tickets/private-plan.yaml'),/private-plan.yaml/);
  const before=readFileSync(join(repo,'.vibehub','.gitignore'),'utf8'); init(repo);
  assert.equal(readFileSync(join(repo,'.vibehub','.gitignore'),'utf8'),before);
});
test('local default preserves tracked records and reports that they remain shared',t=>{
  const repo=fixture(t); git(repo,'init','-q'); init(repo);
  git(repo,'add','-f','.vibehub/version.yaml');
  const before=git(repo,'ls-files'); const state=init(repo).sharing;
  assert.equal(state.tracked_records,1); assert.match(state.notice,/Existing tracked/);
  assert.equal(git(repo,'ls-files'),before); assert.equal(projectSharing(repo).default,'local');
});
test('explicit shared initialization does not create a local exclusion or enable GitHub',t=>{
  const repo=fixture(t); const result=run(repo,'project','init',{sharing:'shared'});
  assert.equal(result.status,0); assert.equal(existsSync(join(repo,'.vibehub','.gitignore')),false);
  assert.equal(result.envelope.data.sharing.github,'opt-in');
});
for(const [name,module] of [['repository',published],['bundled',bundled]]) {
  test(`${name} issue publisher requires explicit mode and destination before reading any repository`,async()=>{
    assert.throws(()=>module.parseArgs([]),/disabled by default/);
    assert.throws(()=>module.parseArgs(['--github','owner/repo']),/disabled by default/);
    assert.throws(()=>module.parseArgs(['--publish']),/destination is never inferred/);
    assert.throws(()=>module.parseArgs(['--publish','--dry-run','--github','owner/repo']),/either/);
    assert.equal(module.parseArgs(['--publish','--github','owner/repo']).publish,true);
    assert.equal(module.parseArgs(['--dry-run','--github','owner/repo']).publish,false);
    await assert.rejects(module.sync({repoRoot:'/does-not-exist',github:'owner/repo'}),/disabled by default/);
  });
}
test('both Actions workflows require a repository opt-in and explicit publication mode',()=>{
  for(const file of ['.github/workflows/sync-issues.yml','skills/vibehub-core/templates/github/sync-issues.yml']) {
    const source=readFileSync(join(root,file),'utf8');
    assert.match(source,/if: \$\{\{ vars\.VIBEHUB_GITHUB_SYNC == 'true' \}\}/);
    assert.match(source,/--dry-run.*--publish/);
  }
});
