import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// A child enables deliberate GC without changing the normal test runner's flags.
// Only in-memory SQLite and a temporary synthetic DomainStore are used.
test('selected SQLite ranges retain their statement through forced GC and release after normal and overflow exits', () => {
  const moduleURL = relative => new URL(relative, import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { mkdtempSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { DomainStore, migrateDomainStore } from ${JSON.stringify(moduleURL('../src/local/domain-store.mjs'))};
    import { LocalCredentialAuthority, LOCAL_AUDIENCE } from ${JSON.stringify(moduleURL('../src/adapters/auth/local-credential-authority.mjs'))};
    import { scopedReference } from ${JSON.stringify(moduleURL('../src/core/service-access.mjs'))};
    const directory=mkdtempSync(join(tmpdir(),'vh-sqlite-gc-')),filePath=join(directory,'store.sqlite');
    migrateDomainStore({filePath});
    const authority=new LocalCredentialAuthority(),scope={tenant_id:'synthetic',project_id:'statement-lifetime'};
    const grant=authority.issue({principal_id:'fixture',kind:'service',scope,actions:['store:read','store:write'],ttl_ms:900000});
    const context=authority.authorize(grant.credential,{scope,audience:LOCAL_AUDIENCE,action:'store:read',kinds:['service'],boundary:'object',reference:scopedReference('object',scope,'gc-test')}).context;
    const store=new DomainStore({filePath,authority,namespaces:['range']});
    const db=new DatabaseSync(':memory:'),probe=db.prepare('SELECT 1'),prototype=Object.getPrototypeOf(probe),originalIterate=prototype.iterate;
    let nextCalls=0;
    function gcIterator(iterator){
      // This wrapper retains only the iterator, deliberately not the statement.
      return {next(){nextCalls++;global.gc();return iterator.next();},return(){return iterator.return();},[Symbol.iterator](){return this;}};
    }
    prototype.iterate=function(...args){return gcIterator(originalIterate.apply(this,args));};
    try {
      store.transaction(context,tx=>{for(let i=0;i<3;i++)tx.appendSource('range','row-'+i,'fixture',{i});for(let i=0;i<2;i++)tx.appendSource('range','wide-'+i,'fixture',{text:'x'.repeat(600000)});});
      const range={lower:'row-',upper:'row.',order:'asc',limit:3,after:null};
      for(let i=0;i<12;i++)assert.deepEqual(store.getSourceRange(context,'range',range).rows.map(r=>r.value.i),[0,1,2]);
      assert.throws(()=>store.getSourceRange(context,'range',{...range,lower:'wide-',upper:'wide.',limit:2}),e=>e.code==='store_page_too_large');
      assert.equal(store.getSourceRange(context,'range',{...range,lower:'wide-',upper:'wide.',limit:1}).rows.length,1);
      assert.equal(store.readSnapshot(context,tx=>tx.getSourceRange('range',range)).rows.length,3);
      assert.ok(nextCalls>=56);
    }finally{prototype.iterate=originalIterate;store.close();db.close();rmSync(directory,{recursive:true,force:true});}
    process.stdout.write('forced-gc-range-ok');
  `;
  const output = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(output, 'forced-gc-range-ok');
});
