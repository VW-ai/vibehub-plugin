// Reproduce outside the parent repo with separate Runtime and spike lockfiles.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)), runtime=resolve(here,'../../..');
const temp=mkdtempSync(join(tmpdir(),'vh-platform-standalone-')), target=join(temp,'semantic-runtime'), spike=join(target,'research/platform/node-postgres');
const report=resolve(process.argv[2]??join(runtime,'.local/platform-spike/standalone-report.json'));
const npm=process.env.SPIKE_NPM_CLI;
if(!npm)throw new Error('Set SPIKE_NPM_CLI to the npm-cli.js bundled with Node 24');
const env={PATH:process.env.PATH,TMPDIR:temp,LANG:'C',LC_ALL:'C',SPIKE_PG_BIN:process.env.SPIKE_PG_BIN};
try {
  mkdirSync(spike,{recursive:true});
  for(const file of ['src','package.json','package-lock.json'])cpSync(join(runtime,file),join(target,file),{recursive:true});
  for(const file of ['package.json','package-lock.json','auth.mjs','service.mjs','executor.mjs','run.mjs','check.mjs','schema.sql','fixture.json'])cpSync(join(here,file),join(spike,file));
  for(const cwd of [target,spike])execFileSync(process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund','--cache',join(temp,'npm-cache')],{cwd,env,stdio:'inherit'});
  execFileSync(process.execPath,[join(spike,'check.mjs')],{cwd:spike,env,stdio:'inherit'});
  execFileSync(process.execPath,[join(spike,'run.mjs'),report],{cwd:spike,env,stdio:'inherit'});
} finally {rmSync(temp,{recursive:true,force:true});}
