#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepository, assertValid } from './vh.mjs';
import { readSessions, startSession, updateSession, TERMINAL_SESSION_STATES } from './session-store.mjs';

export async function runTrackedCommand(repo, input, command, args = []) {
  const repository=loadRepository(resolve(repo));
  assertValid(repository.errors);
  if (!repository.tickets.documents.has(input.ticket_id)) throw new Error('Ticket does not exist in this worktree');
  const {session,token,processOwnerToken}=startSession(repo,{...input,state:'running',message:'Foreground process started.'},{source:'process'});
  const env={...process.env,VB_SESSION_ID:session.session_id,VB_SESSION_TOKEN:token,VB_SESSION_REPO:resolve(repo)};
  let interrupted=null, timer=null, killTimer=null, settled=false, pendingFinish=null, groupCleanupDone=false;
  const ownGroup=process.platform !== 'win32' && !process.stdin.isTTY;
  const child=spawn(command,args,{cwd:repo,env,stdio:'inherit',shell:false,detached:ownGroup});
  const sendSignal=(signal)=>{
    if (!child.pid) return;
    try { if (!ownGroup) child.kill(signal); else process.kill(-child.pid,signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const report=(patch={},heartbeat=false)=>{
    // Another explicit reporter may have advanced the record between pulses.
    for (let attempt=0;attempt<3;attempt++) {
      const current=readSessions(repo).sessions.find(item=>item.session_id===session.session_id);
      if (!current || TERMINAL_SESSION_STATES.has(current.state)) return;
      try { return updateSession(repo,{session_id:session.session_id,token,expected_revision:current.revision,...patch},{heartbeat,processOwnerToken}); }
      catch (error) { if (!['session_conflict','session_busy'].includes(error.code)) throw error; }
    }
    throw new Error('Session reporter is busy; heartbeat not recorded.');
  };
  const stop=(signal)=>{
    interrupted=signal;
    sendSignal(signal);
    if (!killTimer) { killTimer=setTimeout(()=>{sendSignal('SIGKILL');groupCleanupDone=true;if(pendingFinish)pendingFinish();},3000); killTimer.unref(); }
  };
  const onInt=()=>stop('SIGINT'),onTerm=()=>stop('SIGTERM');
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  process.stderr.write(`VibeHub session ${session.session_id} → ${session.ticket_id}\n`);
  return await new Promise((resolveResult,rejectResult)=>{
    const finish=(code,signal,spawnError=null)=>{
      if (settled) return;
      // The leader may exit before a descendant handles cancellation. Keep the
      // wrapper alive through group cleanup instead of abandoning its children.
      if (interrupted && ownGroup && !groupCleanupDone && child.pid) {
        let groupAlive=false;
        try { process.kill(-child.pid,0); groupAlive=true; } catch(cause) { if(cause.code!=='ESRCH')groupAlive=true; }
        if (groupAlive) { pendingFinish=()=>finish(code,signal,spawnError);killTimer?.ref();return; }
      }
      settled=true;
      if(timer)clearInterval(timer);if(killTimer)clearTimeout(killTimer);
      process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);
      const state=interrupted ? 'cancelled' : spawnError || code !== 0 ? 'failed' : 'completed';
      try { report({state,activity:true,message:spawnError ? 'Process could not start.' : `Process ended${signal ? ` with ${signal}` : ` with exit ${code}`}.`}); }
      catch(error){ process.stderr.write(`VibeHub session final report failed: ${error.message}\n`); }
      if (spawnError) rejectResult(spawnError);
      else resolveResult({session_id:session.session_id,state,exit_code:interrupted ? (interrupted==='SIGINT'?130:143) : code ?? 1,signal});
    };
    child.once('error',cause=>finish(null,null,cause));
    child.once('exit',(code,signal)=>finish(code,signal));
    timer=setInterval(()=>{try{report({},true);}catch(error){process.stderr.write(`VibeHub heartbeat failed: ${error.message}\n`);}},Math.min(5000,Math.floor(session.freshness_ms/3)));
    timer.unref();
  });
}

async function main() {
  const argv=process.argv.slice(2),operation=argv.shift();
  let repo=process.env.VB_SESSION_REPO || process.cwd(), input={}, command=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--'){command=argv.slice(i+1);break;}
    if(argv[i]==='--repo'&&argv[i+1])repo=resolve(argv[++i]);
    else if(argv[i]==='--input'&&argv[i+1])input=JSON.parse(readFileSync(argv[++i],'utf8'));
    else throw new Error('Usage: vh-session.mjs <start|report|heartbeat|list|run> --repo <path> [--input <json>] [-- <command> ...]');
  }
  let data;
  if(operation==='list') data=readSessions(repo);
  else if(operation==='run'){
    if(!command.length)throw new Error('run requires an executable after --');
    data=await runTrackedCommand(repo,input,command[0],command.slice(1));process.exitCode=data.exit_code;
  } else if(operation==='start') {
    const repository=loadRepository(resolve(repo));assertValid(repository.errors);
    data=startSession(repo,input);
  } else if(['report','heartbeat'].includes(operation)) {
    // A child launched by run inherits these credentials. Never put them in
    // Tickets, URLs, browser payloads, command arguments or transcript prose.
    const sessionId=input.session_id ?? process.env.VB_SESSION_ID;
    const token=input.token ?? process.env.VB_SESSION_TOKEN;
    // The calling adapter must supply its last seen revision to prevent stale
    // reports. A pulse with no payload can safely reread for a pure heartbeat.
    const expected=input.expected_revision ?? (operation==='heartbeat' ? readSessions(repo).sessions.find(s=>s.session_id===sessionId)?.revision : undefined);
    data=updateSession(repo,{...input,session_id:sessionId,token,expected_revision:expected},{heartbeat:operation==='heartbeat'});
  } else throw new Error('Unknown session operation');
  process.stdout.write(`${JSON.stringify({ok:true,data})}\n`);
}
if(process.argv[1]&&realpathSync(resolve(process.argv[1]))===realpathSync(fileURLToPath(import.meta.url))){
  main().catch(error=>{process.stderr.write(`${JSON.stringify({ok:false,error:{code:error.code||'session_error',message:error.message}})}\n`);process.exitCode=1;});
}
