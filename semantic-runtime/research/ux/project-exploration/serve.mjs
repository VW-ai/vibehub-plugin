// Static synthetic preview only. No Runtime APIs, credentials or filesystem browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const port=Number(process.argv[2]??51987);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Use a port from 1024 to 65535.');
const files=new Map([['/',['index.html','text/html']],['/index.html',['index.html','text/html']],['/style.css',['style.css','text/css']],['/app.mjs',['app.mjs','text/javascript']],['/fixtures.mjs',['fixtures.mjs','text/javascript']]]);
const server=createServer(async(req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer'};
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,headers);res.end();return;}
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host)){res.writeHead(403,headers);res.end();return;}
  const file=files.get(req.url?.split('?')[0]);
  if(!file){res.writeHead(404,headers);res.end('Preview resource not found.');return;}
  try{const bytes=await readFile(fileURLToPath(new URL(file[0],import.meta.url)));res.writeHead(200,{...headers,'Content-Type':`${file[1]}; charset=utf-8`});res.end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(500,headers);res.end('Preview unavailable.');}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Preview port is already in use; choose another port.':'Preview failed to start.');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Synthetic UX preview: http://127.0.0.1:${port}/ (not the Runtime service)`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
