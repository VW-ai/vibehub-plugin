import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSessions, startSession, updateSession, sessionDirectory, ticketSessionCapability } from '../skills/vibehub-core/scripts/session-store.mjs';
import { buildUiSnapshot, startVibeHubUi } from '../skills/vibehub-core/scripts/vh-ui.mjs';
import { root, run, tempRepo, ticket } from './helpers.mjs';
const runner=join(root,'skills/vibehub-core/scripts/vh-session.mjs');
const storeUrl=pathToFileURL(join(root,'skills/vibehub-core/scripts/session-store.mjs')).href;
const ok=r=>{assert.equal(r.status,0,r.stdout||r.stderr);return r.envelope.data;};
const start={ticket_id:'work',agent_id:'agent-one',agent_name:'Agent One',provider:'test-provider',state:'running'};
function fixture(){const repo=tempRepo('agent-session');assert.equal(spawnSync('git',['init','-q',repo]).status,0);ok(run(repo,'project','init'));ok(run(repo,'ticket','apply',{validation:{independent:false,note:'fixture'},tickets:[ticket('work'),ticket('dependent',['work'])]}));return repo;}
function report(repo,started,patch={},options={}){const current=readSessions(repo).sessions.find(s=>s.session_id===started.session.session_id);return updateSession(repo,{session_id:current.session_id,token:started.token,expected_revision:current.revision,...patch},options);}

test('state reports, heartbeat freshness and meaningful activity are separate from canonical Ticket state',()=>{
 const repo=fixture(),now=Date.now(),before=readFileSync(join(repo,'.vibehub/tickets/work.yaml'),'utf8');
 const s=startSession(repo,{...start,freshness_ms:1000},{now});
 const state=ok(run(repo,'ticket','get',{ticket_id:'work'}));assert.equal(state.ticket_state.state,'READY');assert.equal(state.agent_sessions.sessions.length,1);
 let r=report(repo,s,{}, {now:now+100,heartbeat:true});assert.equal(r.last_activity_at,s.session.last_activity_at);assert.notEqual(r.last_reported_at,s.session.last_reported_at);
 r=report(repo,s,{state:'waiting_human'},{now:now+200});assert.equal(r.last_activity_at,r.last_reported_at);
 assert.equal(readSessions(repo,{now:now+1200}).sessions[0].effective_state,'disconnected');
 r=report(repo,s,{state:'running',activity:true},{now:now+1300});assert.equal(readSessions(repo,{now:now+1301}).sessions[0].fresh,true);
 r=report(repo,s,{state:'completed'},{now:now+1400});assert.equal(readSessions(repo,{now:now+999999}).sessions[0].effective_state,'completed');
 assert.throws(()=>report(repo,s,{state:'running'},{now:now+1500}),{code:'invalid_transition'});
 assert.equal(readFileSync(join(repo,'.vibehub/tickets/work.yaml'),'utf8'),before);
 assert.equal(ok(run(repo,'ticket','get',{ticket_id:'work'})).ticket_state.state,'READY');
 assert.equal(ok(run(repo,'ticket','get',{ticket_id:'dependent'})).ticket_state.state,'BLOCKED');
 assert.deepEqual(readdirSync(join(repo,'.vibehub/outcomes')),[]);
 assert.doesNotMatch(JSON.stringify(readSessions(repo)),/token|token_hash/);
 const status=spawnSync('git',['-C',repo,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).stdout;assert.doesNotMatch(status,/vibehub-runtime|agent_session/);
});

test('invalid identities, stale revisions, unauthorized writers and heartbeat activity are rejected without mutation',()=>{
 const repo=fixture(),s=startSession(repo,start);const file=join(sessionDirectory(repo),`${s.session.session_id}.json`),before=readFileSync(file,'utf8');
 for(const patch of [{ticket_id:'../escape'},{ticket_id:'missing'},{agent_id:''},{freshness_ms:0},{source:'process'},{state:'completed'}]) assert.throws(()=>startSession(repo,{...start,...patch}));
 for(const patch of [{token:'a'.repeat(64)},{expected_revision:2},{state:'thinking'},{state:'running',activity:'yes'},{ticket_id:'dependent'}]) assert.throws(()=>updateSession(repo,{session_id:s.session.session_id,token:s.token,expected_revision:1,...patch}));
 assert.throws(()=>report(repo,s,{activity:true},{heartbeat:true}),{code:'invalid_session'});
 assert.equal(readFileSync(file,'utf8'),before);
 assert.throws(()=>report(repo,s,{}, {now:Date.parse(s.session.started_at)-1}),{code:'invalid_session'});
});

test('concurrent reports cannot overwrite a newer revision',async()=>{
 const repo=fixture(),s=startSession(repo,start),input=join(repo,'report.json');writeFileSync(input,JSON.stringify({session_id:s.session.session_id,token:s.token,expected_revision:1,state:'waiting_tool'}));
 const invoke=()=>new Promise(resolve=>{const child=spawn(process.execPath,[runner,'report','--repo',repo,'--input',input],{stdio:['ignore','pipe','pipe']});child.on('exit',code=>resolve(code));});
 const codes=await Promise.all([invoke(),invoke()]);assert.equal(codes.filter(code=>code===0).length,1);assert.equal(readSessions(repo).sessions[0].revision,2);
});

test('worktrees isolate observations and malformed records are visible errors, not live presence',()=>{
 const repo=fixture(),s=startSession(repo,start);spawnSync('git',['-C',repo,'add','.']);assert.equal(spawnSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.test','commit','-qm','fixture']).status,0);
 const other=join(tempRepo('agent-other'),'checkout');assert.equal(spawnSync('git',['-C',repo,'worktree','add','--detach',other],{encoding:'utf8'}).status,0);
 try{assert.notEqual(sessionDirectory(repo),sessionDirectory(other));assert.equal(readSessions(other).sessions.length,0);assert.throws(()=>updateSession(other,{session_id:s.session.session_id,token:s.token,expected_revision:1,state:'paused'}),{code:'not_found'});}
 finally{spawnSync('git',['-C',repo,'worktree','remove','--force',other]);}
 writeFileSync(join(sessionDirectory(repo),'broken.json'),'{');const snapshot=readSessions(repo);assert.equal(snapshot.errors.length,1);assert.equal(snapshot.sessions.length,1);
 const cap=ticketSessionCapability(readSessions(repo,{now:Date.now()+400000}),'work');assert.equal(cap.summary,null);
});

test('session heartbeats never change semantic snapshot IDs; authenticated endpoint omits writer credentials',async(t)=>{
 const repo=fixture(),before=buildUiSnapshot(repo),s=startSession(repo,start),after=buildUiSnapshot(repo);
 assert.equal(after.state.graph.snapshotId,before.state.graph.snapshotId);assert.equal(after.graph.tickets.find(t=>t.ticketId==='work').workState.state,'READY');
 const host=startVibeHubUi({repoRoot:repo});t.after(()=>host.close());const ready=await host.ready;
 const denied=await fetch(`${ready.origin}/api/sessions`);assert.equal(denied.status,401);
 const response=await fetch(`${ready.origin}/api/sessions`,{headers:{authorization:`Bearer ${host.token}`}});const data=(await response.json()).data;
 assert.equal(data.tickets.work.sessions[0].session_id,s.session.session_id);assert.doesNotMatch(JSON.stringify(data),/token|token_hash/);
 const write=await fetch(`${ready.origin}/api/sessions`,{method:'POST',headers:{authorization:`Bearer ${host.token}`}});assert.equal(write.status,405);
});

function runCommand(repo,code,extra={}){const input=join(repo,'start.json');writeFileSync(input,JSON.stringify({...start,...extra}));return spawnSync(process.execPath,[runner,'run','--repo',repo,'--input',input,'--',process.execPath,'-e',code],{encoding:'utf8',timeout:15000});}

test('foreground wrapper observes real process I/O, waiting reports, heartbeat and exit without storing output',()=>{
 const repo=fixture();
 const result=runCommand(repo,`(async()=>{const {readSessions,updateSession}=await import(${JSON.stringify(storeUrl)});const s=readSessions(process.env.VB_SESSION_REPO).sessions[0];updateSession(process.env.VB_SESSION_REPO,{session_id:s.session_id,token:process.env.VB_SESSION_TOKEN,expected_revision:s.revision,state:'waiting_tool'});console.log('child output stays in terminal');setTimeout(()=>{const current=readSessions(process.env.VB_SESSION_REPO).sessions[0];if(current.state!=='waiting_tool'||current.revision<3||current.last_activity_at===current.last_reported_at)process.exit(7);},1200);})()`,{freshness_ms:1000});
 assert.equal(result.status,0,result.stderr+result.stdout);assert.match(result.stdout,/child output stays in terminal/);const s=readSessions(repo).sessions[0];assert.equal(s.source,'process');assert.equal(s.state,'completed');assert.ok(s.revision>=4);assert.doesNotMatch(readFileSync(join(sessionDirectory(repo),`${s.session_id}.json`),'utf8'),/child output stays/);
 assert.equal(ok(run(repo,'ticket','get',{ticket_id:'work'})).ticket_state.state,'READY');
 const failure=runCommand(repo,'process.exit(7)');assert.equal(failure.status,7);assert.equal(readSessions(repo).sessions[0].state,'failed');
 const input=join(repo,'missing-start.json');writeFileSync(input,JSON.stringify(start));const missing=spawnSync(process.execPath,[runner,'run','--repo',repo,'--input',input,'--','/nonexistent/vibehub-command'],{encoding:'utf8'});assert.notEqual(missing.status,0);assert.equal(readSessions(repo).sessions[0].state,'failed');
});

test('foreground wrapper cancellation records cancelled and does not close the Ticket',async()=>{
 const repo=fixture(),input=join(repo,'start.json');writeFileSync(input,JSON.stringify(start));
 const child=spawn(process.execPath,[runner,'run','--repo',repo,'--input',input,'--',process.execPath,'-e',"console.log('ready-to-cancel');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
 const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('child did not start')),5000);child.stdout.on('data',chunk=>{if(String(chunk).includes('ready-to-cancel')){clearTimeout(timeout);resolve();}});});
 const exited=new Promise(resolve=>child.on('exit',code=>resolve(code)));
 await ready;child.kill('SIGTERM');assert.equal(await exited,143);assert.equal(readSessions(repo).sessions[0].state,'cancelled');assert.equal(ok(run(repo,'ticket','get',{ticket_id:'work'})).ticket_state.state,'READY');
});

test('child reports cannot finalize an observed process before its actual failing exit',()=>{
 const repo=fixture();
 const result=runCommand(repo,`(async()=>{const {readSessions,updateSession}=await import(${JSON.stringify(storeUrl)});const s=readSessions(process.env.VB_SESSION_REPO).sessions[0];try {updateSession(process.env.VB_SESSION_REPO,{session_id:s.session_id,token:process.env.VB_SESSION_TOKEN,expected_revision:s.revision,state:'completed'});process.exit(9);} catch(error) {if(error.code!=='session_unauthorized')process.exit(8);} process.exit(7);})()`);
 assert.equal(result.status,7,result.stderr+result.stdout);
 assert.equal(readSessions(repo).sessions[0].state,'failed');
 assert.equal(ok(run(repo,'ticket','get',{ticket_id:'work'})).ticket_state.state,'READY');
});

test('cancellation cleans up a signal-ignoring descendant after its leader exits', {skip:process.platform==='win32'}, async(t)=>{
 const repo=fixture(),input=join(repo,'start.json');writeFileSync(input,JSON.stringify(start));
 const grandchild="process.on('SIGTERM',()=>{});console.log('descendant:'+process.pid);setInterval(()=>{},1000)";
 const leader=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
 const child=spawn(process.execPath,[runner,'run','--repo',repo,'--input',input,'--',process.execPath,'-e',leader],{stdio:['ignore','pipe','pipe']});
 let descendant;
 t.after(()=>{try{if(descendant)process.kill(descendant,'SIGKILL');}catch{}try{child.kill('SIGKILL');}catch{}});
 const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('descendant did not start')),5000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/descendant:(\d+)/);if(match){descendant=Number(match[1]);clearTimeout(timeout);resolve();}});});
 const exited=new Promise(resolve=>child.on('exit',resolve));
 await ready;child.kill('SIGTERM');assert.equal(await exited,143);
 await new Promise(resolve=>setTimeout(resolve,150));
 assert.throws(()=>process.kill(descendant,0),{code:'ESRCH'});
 assert.equal(readSessions(repo).sessions[0].state,'cancelled');
});
