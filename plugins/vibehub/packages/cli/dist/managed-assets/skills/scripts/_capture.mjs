import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_CAPTURE_LIMIT = 16 * 1024 * 1024;

/**
 * Run a child with bounded, file-backed output.
 *
 * Pipes are drained asynchronously, but only the first `maxBytes` combined
 * bytes are retained. The child is killed as soon as a chunk crosses the
 * bound. `observedBytes` includes the whole chunk that exposed the overflow,
 * while `retainedBytes` never exceeds the declared limit.
 */
export async function captureCommand(command, args, options = {}) {
  const limit=options.maxBytes??DEFAULT_CAPTURE_LIMIT;
  if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError("maxBytes must be a positive safe integer");
  const temp=fs.mkdtempSync(path.join(options.tempRoot??os.tmpdir(),"vibehub-capture-"));
  const stdoutPath=path.join(temp,"stdout"),stderrPath=path.join(temp,"stderr");
  let stdoutFd,stderrFd,child,overflow=false;
  let observedStdoutBytes=0,observedStderrBytes=0,retainedStdoutBytes=0,retainedStderrBytes=0;
  try{
    stdoutFd=fs.openSync(stdoutPath,"w");stderrFd=fs.openSync(stderrPath,"w");
    const outcome=await new Promise(resolve=>{
      child=spawn(command,args,{cwd:options.cwd,env:options.env??process.env,stdio:["pipe","pipe","pipe"]});
      const retain=(stream,fd)=>chunk=>{
        if(stream==="stdout")observedStdoutBytes+=chunk.length;else observedStderrBytes+=chunk.length;
        const retained=retainedStdoutBytes+retainedStderrBytes;
        const writable=Math.max(0,Math.min(chunk.length,limit-retained));
        if(writable>0){
          fs.writeSync(fd,chunk,0,writable);
          if(stream==="stdout")retainedStdoutBytes+=writable;else retainedStderrBytes+=writable;
        }
        if(!overflow&&observedStdoutBytes+observedStderrBytes>limit){overflow=true;child.kill("SIGKILL");}
      };
      child.stdout.on("data",retain("stdout",stdoutFd));
      child.stderr.on("data",retain("stderr",stderrFd));
      child.stdin.on("error",()=>{});
      child.stdin.end(options.input);
      child.once("error",error=>resolve({error,status:null,signal:null}));
      child.once("close",(status,signal)=>resolve({status,signal}));
    });
    fs.closeSync(stdoutFd);stdoutFd=undefined;fs.closeSync(stderrFd);stderrFd=undefined;
    const observedBytes=observedStdoutBytes+observedStderrBytes,retainedBytes=retainedStdoutBytes+retainedStderrBytes;
    if(overflow)return {kind:"overflow",status:outcome.status,signal:outcome.signal,stdout:"",stderr:"",observedStdoutBytes,observedStderrBytes,observedBytes,retainedStdoutBytes,retainedStderrBytes,retainedBytes,limit};
    const stdout=fs.readFileSync(stdoutPath,"utf8"),stderr=fs.readFileSync(stderrPath,"utf8");
    const sizes={observedStdoutBytes,observedStderrBytes,observedBytes,retainedStdoutBytes,retainedStderrBytes,retainedBytes,limit};
    if(outcome.error)return {kind:"spawn_error",status:outcome.status,signal:outcome.signal,stdout,stderr,error:outcome.error,...sizes};
    if(outcome.signal)return {kind:"signal",status:outcome.status,signal:outcome.signal,stdout,stderr,...sizes};
    return {kind:"exit",status:outcome.status??1,signal:null,stdout,stderr,...sizes};
  }finally{
    if(child&&!child.killed&&child.exitCode===null)child.kill("SIGKILL");
    if(stdoutFd!==undefined)fs.closeSync(stdoutFd);if(stderrFd!==undefined)fs.closeSync(stderrFd);
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
