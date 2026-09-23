import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DomainStore, migrateDomainStore } from '../src/adapters/sqlite/domain-store.mjs';
import { LocalCredentialAuthority, LOCAL_AUDIENCE } from '../src/adapters/auth/local-credential-authority.mjs';
import { scopedReference } from '../src/domain/identity/service-access.mjs';
import { GitProjectRegistry } from '../src/adapters/git/git-projects.mjs';
import { ExplorationInputs, EXPLORATION_NAMESPACE, readExplorationOwner } from '../src/application/explorations/exploration-inputs.mjs';
import { GraphInputs, graphHash, graphErrorCode } from '../src/application/graph/graph-inputs.mjs';

const scope = { tenant_id: 'synthetic', project_id: 'exploration-metadata' }, NS = EXPLORATION_NAMESPACE;
const actions = ['store:read','store:write','graph:read','graph:write','graph:publish','ingress:read','source:invalidation:read','exploration:read','exploration:write','project:inspect','project:enroll'];
function git(folder,...args) { return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid',...args],
  {cwd:folder,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:folder,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim(); }
function fixture(t,{unborn=false}={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'vh-exploration-inputs-'))),folder=join(root,'project');mkdirSync(folder);
  git(folder,'init','--initial-branch=main');
  if(!unborn){writeFileSync(join(folder,'file.txt'),'Synthetic fixture.\n');git(folder,'add','.');git(folder,'commit','-m','initial');}
  const filePath=join(root,'domain.sqlite');migrateDomainStore({filePath});
  const authority=new LocalCredentialAuthority(), issued=authority.issue({scope,principal_id:'owner',kind:'service',actions,ttl_ms:3600000});
  const context=authority.authorize(issued.credential,{scope,audience:LOCAL_AUDIENCE,action:'store:read',kinds:['service'],boundary:'object',reference:scopedReference('object',scope,'fixture')}).context;
  const store=new DomainStore({filePath,authority,namespaces:[NS,'working-graph','git-enrollment']}),registry=new GitProjectRegistry({store,authority});
  registry.enroll(context,{folder,expectedVersion:null});
  const publisher=store.transaction(context,view=>new GraphInputs({store,authority}).registerPublisher(view,context,{epoch:1,run_key:'metadata-fixture'}));
  const inputs=new ExplorationInputs({store,authority,config_digest:graphHash({profile:'synthetic'})});
  const f={root,folder,filePath,authority,issued,context,store,registry,inputs,publisher};
  t.after(()=>{store.close();authority.close();rmSync(root,{recursive:true,force:true});});
  f.selected=()=>{const row=registry.get(context),c=row.value.checkouts[0],w=c.worktrees.find(w=>w.path===folder);return{row,c,w,execution:{repository_id:c.repository_id,checkout_id:c.checkout_id,worktree_id:w.worktree_id}};};
  return f;
}
function tx(f,fn,read=false) { let code;try{return f.store[read?'readSnapshot':'transaction'](f.context,v=>{try{return fn(v);}catch(e){code=graphErrorCode(e);throw e;}});}catch(e){if(code)throw Object.assign(new Error(code),{code});throw e;} }
function request(f,key,overrides={}) { const {row,execution}=f.selected(); return {epoch:1,idempotency_key:key,publisher_ref:f.publisher.publisher_ref,execution,expected_catalog_version:row.version,
  expected_binding_version:tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true).binding_version,exploration_id:null,shared_base:null,...overrides}; }
// Metadata-unit harness only. Graph genesis/effects are tested by the separately
// owned public-facade conformance suite; these rows do not claim a Graph commit.
function bind(f,r) {
  const old=tx(f,v=>f.inputs.prior(v,f.context,{kind:'bind',request:r}),true);if(old)return{...old.result,status:'duplicate',receipt:old.receipt};
  const observation=f.inputs.preflight(f.context,{kind:'bind',request:r});
  return tx(f,v=>{
    const b=f.inputs.bind(v,f.context,{request:r,observation,shared:{source_fence:0,origin_base:observation.origin_base,project_selection:observation.project_selection}});
    const result={status:'applied',exploration_id:b.route.exploration_id,generation_id:b.generation_id,execution_workspace_id:b.route.execution_workspace_id,binding_version:b.route.binding_version,graph_revision:null};
    const out=f.inputs.finish(v,f.context,b.route,{result,graph_request:b.graph_request});return{...result,receipt:out.receipt};
  });
}
function refresh(f){const {row,c}=f.selected();return f.registry.refresh(f.context,{checkout_id:c.checkout_id,expectedVersion:row.version});}
function raw(f,fn){const db=new DatabaseSync(f.filePath);try{return fn(db);}finally{db.close();}}
function restoreRecord(f,key,row){raw(f,db=>db.prepare('INSERT OR REPLACE INTO records(tenant_id,project_id,namespace,key,version,value) VALUES (?,?,?,?,?,?)').run(scope.tenant_id,scope.project_id,NS,key,row.version,JSON.stringify(row.value)));}

test('individual origins, fresh binding identities and exact actor/key retry survive switching and restart',t=>{
  const f=fixture(t),r=request(f,'first'),a=bind(f,r);
  const origin=tx(f,v=>f.inputs.getExploration(v,f.context,{exploration_id:a.exploration_id}),true);
  assert.equal(origin.origin.git_base.state,'commit');assert.equal(origin.origin.git_base.commit,git(f.folder,'rev-parse','HEAD'));
  assert.equal(origin.origin.publisher_execution_id,f.publisher.execution_id);assert.equal(origin.origin.publisher_session_id,f.publisher.session_id);
  const b=bind(f,request(f,'second'));assert.notEqual(a.exploration_id,b.exploration_id);
  assert.notEqual(a.execution_workspace_id,b.execution_workspace_id);
  const items=tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:32}),true).items;
  assert.equal(items.length,2);assert.equal(items[0].binding_summary.stored_current_count,0);assert.equal(items[1].binding_summary.stored_current_count,1);
  const original=tx(f,v=>f.inputs.getExploration(v,f.context,{exploration_id:a.exploration_id}),true);assert.deepEqual(original,origin);
  f.inputs=new ExplorationInputs({store:f.store,authority:f.authority,config_digest:graphHash({profile:'synthetic'})});
  renameSync(f.folder,join(f.root,'removed-path'));
  const duplicate=bind(f,r);assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.execution_workspace_id,a.execution_workspace_id);
  assert.throws(()=>bind(f,{...r,epoch:2}),{code:'exploration_idempotency_conflict'});
});

test('physical preflight catches an unrefreshed checkout switch; registry refresh requires explicit new binding',t=>{
  const f=fixture(t),a=bind(f,request(f,'first'));
  git(f.folder,'switch','-c','alternative');
  assert.throws(()=>f.inputs.preflight(f.context,{kind:'bind',request:request(f,'before-refresh')}),{code:'exploration_physical_changed'});
  refresh(f);const {execution}=f.selected();assert.equal(tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true).status,'rebind_required');
  const b=bind(f,request(f,'rebind',{exploration_id:a.exploration_id}));assert.equal(b.exploration_id,a.exploration_id);assert.notEqual(b.execution_workspace_id,a.execution_workspace_id);
  assert.equal(tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true).status,'bound');
});

test('unborn and detached observations preserve honest bases and require explicit first-commit rebind',t=>{
  const f=fixture(t,{unborn:true}),a=bind(f,request(f,'unborn'));
  let origin=tx(f,v=>f.inputs.getExploration(v,f.context,{exploration_id:a.exploration_id}),true);
  assert.deepEqual(origin.origin.git_base,{state:'unborn',commit:null});assert.equal(origin.origin.observed_git.ref_incarnation_id,null);
  writeFileSync(join(f.folder,'first'),'first');git(f.folder,'add','.');git(f.folder,'commit','-m','first');refresh(f);
  assert.equal(tx(f,v=>f.inputs.getBinding(v,f.context,{execution:f.selected().execution}),true).status,'rebind_required');
  bind(f,request(f,'first-commit',{exploration_id:a.exploration_id}));
  origin=tx(f,v=>f.inputs.getExploration(v,f.context,{exploration_id:a.exploration_id}),true);assert.equal(origin.origin.git_base.commit,null);
  git(f.folder,'checkout','--detach');refresh(f);const detached=bind(f,request(f,'detached'));
  origin=tx(f,v=>f.inputs.getExploration(v,f.context,{exploration_id:detached.exploration_id}),true);
  assert.equal(origin.origin.observed_git.detached,true);assert.equal(origin.origin.observed_git.ref_incarnation_id,null);
});

test('external linked worktree and packed refs use selected physical identity without reading config or executing helpers',t=>{
  const f=fixture(t),external=join(f.root,'outside-folder');git(f.folder,'worktree','add','-b','linked',external);refresh(f);git(f.folder,'pack-refs','--all');
  const {row,c}=f.selected(),w=c.worktrees.find(w=>w.path===external),execution={repository_id:c.repository_id,checkout_id:c.checkout_id,worktree_id:w.worktree_id};
  const config=join(c.common_dir,'config'),saved=readFileSync(config);renameSync(config,`${config}.saved`);
  execFileSync('mkfifo',[config]);
  const start=performance.now(),r={...request(f,'linked'),execution,expected_catalog_version:row.version,expected_binding_version:null};
  // request() uses retained registry only; source FIFO config must never open.
  const observation=f.inputs.preflight(f.context,{kind:'bind',request:r});assert.deepEqual(observation.execution,execution);assert(performance.now()-start<1000);
  rmSync(config);renameSync(`${config}.saved`,config);
});

test('actual HEAD FIFO and metadata symlink refuse promptly without following them',t=>{
  const f=fixture(t),r=request(f,'first'),head=join(f.selected().w.git_dir,'HEAD'),saved=readFileSync(head);
  renameSync(head,`${head}.saved`);execFileSync('mkfifo',[head]);
  let start=performance.now();assert.throws(()=>f.inputs.preflight(f.context,{kind:'bind',request:r}),{code:'exploration_physical_changed'});assert(performance.now()-start<1000);
  rmSync(head);symlinkSync(`${head}.saved`,head);
  assert.throws(()=>f.inputs.preflight(f.context,{kind:'bind',request:r}),{code:'exploration_physical_changed'});
  rmSync(head);writeFileSync(head,saved);rmSync(`${head}.saved`);
});

test('branded physical proof, catalog CAS and post-callback binding fence roll back metadata',t=>{
  const f=fixture(t),r=request(f,'first'),observation=f.inputs.preflight(f.context,{kind:'bind',request:r}),shared={source_fence:0,origin_base:null,project_selection:{version:null,pin:null}};
  assert.throws(()=>tx(f,v=>f.inputs.bind(v,f.context,{request:r,observation:{...observation},shared})),{code:'invalid_exploration_input'});
  assert.equal(f.store.getRecord(f.context,NS,'format'),null);
  refresh(f); // unchanged refresh keeps catalog version; a real HEAD change advances it.
  writeFileSync(join(f.folder,'changed'),'change');git(f.folder,'add','.');git(f.folder,'commit','-m','change');refresh(f);
  assert.throws(()=>tx(f,v=>f.inputs.bind(v,f.context,{request:r,observation,shared})),{code:'exploration_catalog_conflict'});
  const next=request(f,'current'),proof=f.inputs.preflight(f.context,{kind:'bind',request:next});
  assert.throws(()=>tx(f,v=>{
    const b=f.inputs.bind(v,f.context,{request:next,observation:proof,shared});
    const catalog=v.getRecord('git-enrollment','catalog');v.compareAndSwap('git-enrollment','catalog',catalog.version,catalog.value);
    f.inputs.assertUnchanged(v,f.context,b.route);
  }),{code:'exploration_catalog_conflict'});
  assert.equal(f.store.getRecord(f.context,NS,'format'),null);
});

test('bounded pagination pins high water and source/owner/format corruption fails closed',t=>{
  const f=fixture(t);for(let i=0;i<5;i++)bind(f,request(f,`create-${i}`));
  const first=tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:2}),true);bind(f,request(f,'later'));
  const second=tx(f,v=>f.inputs.list(v,f.context,{cursor:first.cursor,limit:2}),true),third=tx(f,v=>f.inputs.list(v,f.context,{cursor:second.cursor,limit:2}),true);
  assert.equal(third.items.length,1);assert.equal(third.cursor,null);
  const selected=first.items[0];assert.equal(tx(f,v=>readExplorationOwner(v,{scope,generation_id:selected.generation_id}),true).exploration_id,selected.exploration_id);
  assert.throws(()=>tx(f,v=>f.inputs.list(v,f.context,{cursor:{...first.cursor,scope:{...scope,project_id:'foreign'}},limit:2}),true),{code:'invalid_exploration_input'});
  const raw=new DatabaseSync(f.filePath);t.after(()=>raw.close());raw.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(NS,'format');
  assert.throws(()=>tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:2}),true),{code:'exploration_corrupt'});
});

test('inert input rejects proxies/getters before execution, exact formats and opaque grants apply',t=>{
  const f=fixture(t),r=request(f,'first');let calls=0;
  const getter={...r};Object.defineProperty(getter,'epoch',{enumerable:true,get(){calls++;return 1;}});
  const proxy=new Proxy(r,{get(){calls++;},getPrototypeOf(){calls++;},ownKeys(){calls++;return[];}});
  for(const invalid of [getter,proxy,{...r,extra:true},{...r,exploration_id:'existing',shared_base:{}},{...r,expected_catalog_version:null}])assert.throws(()=>f.inputs.parse('bind',invalid));
  assert.equal(calls,0);assert.throws(()=>f.inputs.grant({...f.context}),{code:'exploration_unauthorized'});
  bind(f,r);const changed=new ExplorationInputs({store:f.store,authority:f.authority,config_digest:graphHash({profile:'different'})});
  assert.throws(()=>tx(f,v=>changed.list(v,f.context,{cursor:null,limit:1}),true),{code:'exploration_configuration_mismatch'});
  f.authority.revoke(f.issued.credential_id);assert.throws(()=>f.inputs.grant(f.context),{code:'exploration_unauthorized'});
});

test('same principal under a different credential kind cannot inherit an existing operation receipt',t=>{
  const f=fixture(t),r=request(f,'first');bind(f,r);
  const human=f.authority.issue({scope,principal_id:'owner',kind:'human',actions,ttl_ms:3600000});
  const context=f.authority.authorize(human.credential,{scope,audience:LOCAL_AUDIENCE,action:'store:read',kinds:['human'],boundary:'object',reference:scopedReference('object',scope,'fixture')}).context;
  let code;assert.throws(()=>f.store.readSnapshot(context,v=>{try{return f.inputs.prior(v,context,{kind:'bind',request:r});}catch(e){code=e.code;throw e;}}));
  assert.equal(code,'exploration_unauthorized');
});

test('Project metadata reports latest binding unavailable after actual worktree removal without erasing origin',t=>{
  const f=fixture(t),external=join(f.root,'external');git(f.folder,'worktree','add','-b','temporary',external);refresh(f);
  const {row,c}=f.selected(),w=c.worktrees.find(w=>w.path===external),execution={repository_id:c.repository_id,checkout_id:c.checkout_id,worktree_id:w.worktree_id};
  const r=request(f,'external',{execution,expected_catalog_version:row.version,expected_binding_version:null}),b=bind(f,r);
  const before=tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:32}),true).items[0];assert.equal(before.binding_summary.last_binding_status,'bound');
  git(f.folder,'worktree','remove',external);refresh(f);
  const after=tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:32}),true).items[0];assert.equal(after.binding_summary.last_binding_status,'unavailable');
  assert.deepEqual(after.origin,before.origin);assert.equal(after.binding_summary.stored_current_count,1);assert.equal(after.exploration_id,b.exploration_id);
});

test('missing, zero and positively lowered exploration horizon cannot hide retained indexed origins',t=>{
  const f=fixture(t);for(let i=0;i<3;i++)bind(f,request(f,`origin-${i}`));
  const head=f.store.getRecord(f.context,NS,'index-head');
  for(const mode of ['missing',0,2]){
    if(mode==='missing')raw(f,db=>db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(NS,'index-head'));
    else restoreRecord(f,'index-head',{...head,value:{sequence:mode}});
    assert.throws(()=>tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:32}),true),{code:'exploration_corrupt'});
    assert.throws(()=>bind(f,request(f,`after-${mode}`)),{code:'exploration_corrupt'});
    restoreRecord(f,'index-head',head);
  }
  assert.equal(tx(f,v=>f.inputs.list(v,f.context,{cursor:null,limit:32}),true).items.length,3);
});

test('immutable per-execution version witnesses reject missing/lowered current binding pointers',t=>{
  const f=fixture(t),first=bind(f,request(f,'first'));
  const key=raw(f,db=>db.prepare("SELECT key FROM records WHERE namespace=? AND key LIKE 'binding-current/%'").get(NS).key);
  const old=f.store.getRecord(f.context,NS,key);bind(f,request(f,'second'));const current=f.store.getRecord(f.context,NS,key);
  const execution=f.selected().execution;
  raw(f,db=>db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(NS,key));
  assert.throws(()=>tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true),{code:'exploration_corrupt'});
  restoreRecord(f,key,old);
  assert.throws(()=>tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true),{code:'exploration_corrupt'});
  restoreRecord(f,key,current);
  assert.notEqual(tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true).binding.execution_workspace_id,first.execution_workspace_id);
  raw(f,db=>db.prepare("DELETE FROM sources WHERE namespace=? AND id=(SELECT MAX(id) FROM sources WHERE namespace=? AND kind='execution-workspace-version')").run(NS,NS));
  assert.throws(()=>tx(f,v=>f.inputs.getBinding(v,f.context,{execution}),true),{code:'exploration_corrupt'});
});

test('immutable selection declarations prevent pointer clearing, rollback and witness disagreement',t=>{
  const f=fixture(t);bind(f,request(f,'first'));
  // Fixed metadata wire only; actual CanonicalSourceReader proof authorization
  // is exercised by the public-facade security suite, not replaced by this test.
  const pin={at:{schema_version:2,kind:'graph_commit',scope,generation_id:'canonical',commit_digest:`sha256:${'1'.repeat(64)}`},
    address:{schema_version:1,kind:'semantic_revision',scope,generation_id:'canonical',entity_kind:'entity',entity_id:'canonical-selection',revision_digest:`sha256:${'2'.repeat(64)}`},record_keys:[]};
  function select(key,expected){return tx(f,v=>{
    const shared={source_fence:0,origin_base:null,project_selection:f.inputs.projectSelection(v,f.context)},request={epoch:1,idempotency_key:key,expected_version:expected,pin};
    const result=f.inputs.setProjectSelection(v,f.context,{request,shared});
    return f.inputs.finish(v,f.context,result.route,{result:{version:result.version,pin}});
  });}
  select('select-first',null);const first=f.store.getRecord(f.context,NS,'project-selection');select('select-second',1);const second=f.store.getRecord(f.context,NS,'project-selection');
  raw(f,db=>db.prepare('DELETE FROM records WHERE namespace=? AND key=?').run(NS,'project-selection'));
  assert.throws(()=>tx(f,v=>f.inputs.projectSelection(v,f.context),true),{code:'exploration_corrupt'});
  assert.throws(()=>select('clear-known',null),{code:'exploration_corrupt'});
  restoreRecord(f,'project-selection',first);
  assert.throws(()=>tx(f,v=>f.inputs.projectSelection(v,f.context),true),{code:'exploration_corrupt'});
  restoreRecord(f,'project-selection',second);
  assert.equal(tx(f,v=>f.inputs.projectSelection(v,f.context),true).version,2);
  raw(f,db=>db.prepare("DELETE FROM sources WHERE namespace=? AND kind='project-selection-declaration'").run(NS));
  assert.throws(()=>tx(f,v=>f.inputs.projectSelection(v,f.context),true),{code:'exploration_corrupt'});
});

test('paired generation ownership rejects either single-row loss through a legacy Graph-only store',t=>{
  const f=fixture(t),b=bind(f,request(f,'first'));
  const legacy=new DomainStore({filePath:f.filePath,authority:f.authority,namespaces:['working-graph']});
  try{
    const owner=legacy.readSnapshot(f.context,v=>readExplorationOwner(v,{scope,generation_id:b.generation_id}));assert.equal(owner.exploration_id,b.exploration_id);
    for(const kind of ['exploration-generation-owner','exploration-generation-owner-witness']){
      const saved=raw(f,db=>db.prepare('SELECT * FROM sources WHERE namespace=? AND kind=?').get('working-graph',kind));
      raw(f,db=>db.prepare('DELETE FROM sources WHERE namespace=? AND kind=?').run('working-graph',kind));
      let code;assert.throws(()=>legacy.readSnapshot(f.context,v=>{try{return readExplorationOwner(v,{scope,generation_id:b.generation_id});}catch(e){code=e.code;throw e;}}));assert.equal(code,'exploration_corrupt');
      raw(f,db=>db.prepare('INSERT INTO sources VALUES (?,?,?,?,?,?)').run(saved.tenant_id,saved.project_id,saved.namespace,saved.id,saved.kind,saved.value));
    }
  }finally{legacy.close();}
});
