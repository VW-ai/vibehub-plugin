import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverDashboard, readPersonalStore } from '../skills/vibehub-core/scripts/dashboard-data.mjs';
import { startVibeHubUi, parseUiFlags } from '../skills/vibehub-core/scripts/vh-ui.mjs';
import '../skills/vibehub-review/assets/dashboard-graph.js';
import { run, ticket, room, context, writeRoom } from './helpers.mjs';
const { layoutGraph } = globalThis.VibeHubDashboardGraph;
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'vh-dashboard-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function git(repo, ...args) { return execFileSync('git', ['-c','core.fsmonitor=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }); }
function repoAt(root, name) { const repo = join(root,name); mkdirSync(repo); git(repo,'init'); git(repo,'-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','Initial'); return repo; }
test('dashboard shows only connected worktrees, including external ones, without duplicates', (t) => {
  const root = fixture(t), repo = repoAt(root,'project'), external = fixture(t), worktree = join(external,'tree with spaces');
  git(repo,'worktree','add','-b','feature',worktree); symlinkSync(external, join(root,'symlink'));
  for(const path of [repo,worktree]) { mkdirSync(join(path,'.vibehub')); writeFileSync(join(path,'.vibehub','version.yaml'),'broken but connected'); }
  git(repo,'worktree','add','-b','unconnected',join(external,'unconnected'));
  repoAt(root,'unrelated');
  const result = discoverDashboard([root,repo]);
  assert.equal(result.projects.length,1); assert.equal(result.projects[0].worktrees.length,2);
  assert.equal(result.projects[0].worktrees[1].path,realpathSync(worktree));
  assert.equal(result.projects[0].worktrees[1].branch,'feature');
  assert.equal(result.projects[0].worktrees[0].hasTickets,true);
});
test('personal reader keeps goals and relations, isolates invalid records and never follows record symlinks', (t) => {
  const root=fixture(t); mkdirSync(join(root,'tickets'));
  const record={kind:'personal_ticket', personal_ticket_id:'goal', title:'A goal', type:'goal', state:'draft', relations:[]};
  writeFileSync(join(root,'tickets','goal.yaml'),JSON.stringify(record));
  writeFileSync(join(root,'tickets','bad.yaml'),'broken');
  symlinkSync(join(root,'tickets','goal.yaml'),join(root,'tickets','alias.yaml'));
  const result=readPersonalStore(root); assert.equal(result.tickets.length,1); assert.equal(result.tickets[0].type,'goal'); assert.equal(result.warnings.length,1);
});
test('card canvas preserves splits and merges, with non-overlapping cards and top-to-bottom dependencies', () => {
  const items=['merge','left','root','right'].map(id=>({id}));
  const edges=[{from:'root',to:'left'},{from:'root',to:'right'},{from:'left',to:'merge'},{from:'right',to:'merge'}];
  const graph=layoutGraph(items,edges); const order=graph.items.map(t=>t.id);
  assert.equal(graph.connections.length,4); assert.deepEqual(graph.cyclic,[]);
  for(const edge of edges) assert.ok(order.indexOf(edge.from)<order.indexOf(edge.to));
  const positions=new Map(graph.nodes.map(n=>[n.id,n]));
  for(const edge of graph.connections) {
    const from=positions.get(edge.from), to=positions.get(edge.to);
    assert.ok(from.y+from.height < to.y);
    assert.equal(edge.sx,from.x+from.width/2); assert.equal(edge.tx,to.x+to.width/2);
    assert.equal(edge.sy,from.y+from.height); assert.equal(edge.ty,to.y);
  }
  for(const a of graph.nodes) for(const b of graph.nodes) if(a.id!==b.id)
    assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
  const left=positions.get('left'),right=positions.get('right'),merge=positions.get('merge');
  assert.equal(merge.x,(left.x+right.x)/2);
  assert.equal(graph.connections.find(e=>e.from==='root' && e.to==='left').color, graph.connections.find(e=>e.from==='left' && e.to==='merge').color);
  assert.notEqual(graph.connections.find(e=>e.from==='root' && e.to==='left').color,graph.connections.find(e=>e.from==='root' && e.to==='right').color);
  assert.deepEqual(layoutGraph([...items].reverse(),[...edges].reverse()),graph);
});
test('disconnected components pack without overlaps and long edges route outside cards', () => {
  const items=['a','b','c',...Array.from({length:20},(_,i)=>`isolated-${i}`)].map(id=>({id}));
  const graph=layoutGraph(items,[{from:'a',to:'b'},{from:'b',to:'c'},{from:'a',to:'c',membership:true}]);
  assert.equal(graph.nodes.length,items.length);
  for(const a of graph.nodes) {
    assert.ok(a.x>=0 && a.y>=0 && a.x+a.width<=graph.width && a.y+a.height<=graph.height);
    for(const b of graph.nodes) if(a.id!==b.id)
      assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
  }
  assert.equal(graph.connections.filter(e=>e.membership).length,1);
  assert.equal(graph.nodes.find(n=>n.id==='c').incoming,1);
  assert.ok(graph.connections.find(e=>e.from==='a' && e.to==='c').d.includes('Q'));
});
test('narrow canvases wrap separate components without breaking connected ticket flows', () => {
  const items=['root','child','separate'].map(id=>({id}));
  const graph=layoutGraph(items,[{from:'root',to:'child'}],{maxWidth:416});
  const [root,child,separate]=['root','child','separate'].map(id=>graph.nodes.find(n=>n.id===id));
  assert.equal(root.x,child.x);
  assert.ok(child.y>root.y+root.height);
  assert.ok(separate.y>child.y+child.height);
  assert.ok(graph.width<=416);
  assert.equal(graph.connections.length,1);
});
test('open goals appear before completed goals on the canvas', () => {
  const graph=layoutGraph([{id:'a',type:'goal',state:'ARCHIVED'},{id:'z',type:'goal',state:'DRAFT'}],[],{maxWidth:416});
  assert.ok(graph.nodes.find(n=>n.id==='z').y < graph.nodes.find(n=>n.id==='a').y);
});
test('filtered graph keeps matching children and excludes edges with absent endpoints', () => {
  const graph=layoutGraph([{id:'child'}],[{from:'parent',to:'child'}]);
  assert.equal(graph.items[0].id,'child'); assert.equal(graph.connections.length,0);
});
test('dependency cycles remain visible instead of dropping tickets', () => {
  const graph=layoutGraph([{id:'a'},{id:'b'}],[{from:'a',to:'b'},{from:'b',to:'a'}]);
  assert.equal(graph.items.length,2); assert.equal(graph.connections.length,2); assert.equal(graph.cyclic.length,2);
});
test('dashboard host works without VibeHub setup and limits workspace access to discovered paths', async (t) => {
  const root=fixture(t), repo=repoAt(root,'plain');
  const host=startVibeHubUi({repoRoot:root,dashboardRoots:[root]}); const ready=await host.ready; t.after(()=>host.close());
  assert.ok(ready.url.includes('/dashboard#'));
  assert.equal((await fetch(`${ready.origin}/api/dashboard`)).status,401);
  const headers={Authorization:`Bearer ${host.token}`};
  const home=await (await fetch(`${ready.origin}/api/dashboard`,{headers})).json(); assert.deepEqual(home.data.projects,[]);
  assert.equal((await fetch(`${ready.origin}/api/state?workspace=/etc`,{headers})).status,404);
  assert.equal((await fetch(`${ready.origin}/api/state`,{headers})).status,400);
  assert.equal((await fetch(`${ready.origin}/api/dashboard`,{method:'POST',headers})).status,405);
  repoAt(root,'second');
  assert.equal(run(repo,'project','init').status,0);
  const refreshed=await (await fetch(`${ready.origin}/api/dashboard`,{headers})).json(); assert.equal(refreshed.data.projects.length,1); assert.equal(refreshed.data.projects[0].path,realpathSync(repo));
});
test('dashboard arguments require explicit mode and accept multiple bounded roots', () => {
  const flags=parseUiFlags(['--dashboard','--root','/tmp/one','--root','/tmp/two']);
  assert.deepEqual(flags.dashboardRoots,['/tmp/one','/tmp/two']);
  assert.throws(()=>parseUiFlags(['--root','/tmp']),/require --dashboard/);
  assert.throws(()=>parseUiFlags(['--dashboard','--ticket','a']),/Select Ticket/);
});

test('workspace-scoped reads distinguish identical ticket IDs and isolate corrupt sources', async (t) => {
  const root = fixture(t), first = repoAt(root, 'first'), second = repoAt(root, 'second');
  for (const [repo, label] of [[first, 'First checkout'], [second, 'Second checkout']]) {
    assert.equal(run(repo, 'project', 'init').status, 0);
    const record = { ...ticket('same-id'), outcome: label };
    assert.equal(run(repo, 'ticket', 'apply', { validation: { independent: false, note: 'test fixture' }, tickets: [record] }).status, 0);
  }
  const host = startVibeHubUi({ repoRoot: root, dashboardRoots: [root] });
  const ready = await host.ready; t.after(() => host.close());
  const headers = { Authorization: `Bearer ${host.token}` };
  const get = async (path) => (await fetch(`${ready.origin}${path}`, { headers })).json();
  const home = await get('/api/dashboard');
  const ids = home.data.projects.map((p) => p.worktrees[0].id);
  const one = await get(`/api/tickets?workspace=${ids[0]}`), two = await get(`/api/tickets?workspace=${ids[1]}`);
  assert.equal(one.data.tickets[0].outcome, 'First checkout');
  assert.equal(two.data.tickets[0].outcome, 'Second checkout');
  writeFileSync(join(first, '.vibehub', 'tickets', 'same-id.yaml'), 'broken');
  assert.equal((await get(`/api/tickets?workspace=${ids[0]}`)).ok, false);
  assert.equal((await get(`/api/tickets?workspace=${ids[1]}`)).ok, true);
  assert.equal((await get('/api/dashboard')).data.projects.length, 2);
});

test('board separates recorded activity from blockers and completed work', () => {
  const {stageFor}=globalThis.VibeHubDashboardGraph;
  assert.equal(stageFor({state:'ARCHIVED',working:true}),'completed');
  assert.equal(stageFor({state:'WORKING',attention:'needs_you'}),'attention');
  assert.equal(stageFor({state:'READY',working:true}),'running');
  assert.equal(stageFor({state:'BLOCKED'}),'planned');
  assert.equal(stageFor({state:'READY'}),'planned');
  assert.equal(stageFor({state:'READY',nextAction:{action:'NEEDS_HUMAN'}}),'attention');
});
test('goal selection follows nested membership only and terminates on cycles', () => {
  const {goalScope}=globalThis.VibeHubDashboardGraph;
  const items=[{id:'goal',relations:[{type:'sub_goal_of',target:'sub'}]},
    {id:'sub',relations:[{type:'sub_goal_of',target:'goal'}]},
    {id:'ticket',relations:[{type:'task_of',target:'sub'}]},
    {id:'unrelated',relations:[{type:'depends_on',target:'goal'}]}];
  assert.deepEqual([...goalScope('goal',items)],['goal','sub','ticket']);
});


test('explicit personal project links connect a repository without sweeping in unrelated repos', t => {
  const root=fixture(t), linked=repoAt(root,'linked'); repoAt(root,'unrelated');
  const result=discoverDashboard([root],{projectRefs:['linked']});
  assert.equal(result.projects.length,1); assert.equal(result.projects[0].path,realpathSync(linked));
  assert.equal(result.projects[0].connectedVia,'personal'); assert.equal(result.projects[0].worktrees[0].hasTickets,false);
});
test('recorded Context endpoint is authenticated, workspace scoped, and returns full provenance', async t => {
  const root=fixture(t), one=repoAt(root,'one'), two=repoAt(root,'two');
  for(const [repo,detail] of [[one,'First recorded detail'],[two,'Second recorded detail']]) {
    assert.equal(run(repo,'project','init').status,0); writeRoom(repo,'decisions',room('decisions'));
    writeFileSync(join(repo,'.vibehub','rooms','decisions','decision-use-tickets.yaml'),JSON.stringify(context({detail})));
  }
  const host=startVibeHubUi({repoRoot:root,dashboardRoots:[root]}); const ready=await host.ready; t.after(()=>host.close());
  const headers={Authorization:`Bearer ${host.token}`}; const home=await (await fetch(`${ready.origin}/api/dashboard`,{headers})).json();
  const read=async index=>(await (await fetch(`${ready.origin}/api/contexts?workspace=${home.data.projects[index].worktrees[0].id}`,{headers})).json());
  const first=await read(0), second=await read(1);
  assert.equal(first.ok,true); assert.equal(first.data.rooms[0].contexts[0].detail,'First recorded detail');
  assert.equal(second.data.rooms[0].contexts[0].detail,'Second recorded detail');
  assert.equal(first.data.rooms[0].contexts[0].source.ref,'conversation:2026-07-31');
  assert.equal((await fetch(`${ready.origin}/api/contexts`)).status,401);
  assert.equal((await fetch(`${ready.origin}/api/contexts?workspace=unknown`,{headers})).status,404);
});

test('execution view preserves human authority and separates waiting, planning, execution, and closeout', () => {
  const {workflowFor,executionSummary}=globalThis.VibeHubDashboardGraph;
  const items=[
    {id:'decision',type:'ticket',state:'READY',nextAction:{action:'NEEDS_HUMAN'}},
    {id:'waiting',type:'ticket',state:'NEEDS YOU',nextAction:{action:'WAIT'}},
    {id:'execute',type:'ticket',state:'READY',nextAction:{action:'EXECUTE'}},
    {id:'review',type:'ticket',state:'READY',nextAction:{action:'CLOSE_OUT'}},
    {id:'draft',type:'ticket',state:'READY',nextAction:{action:'REFINE'}},
    {id:'replan',type:'ticket',state:'READY',nextAction:{action:'REPLAN'}},
    {id:'unknown',type:'ticket',state:'TODO'},
    {id:'running',type:'ticket',state:'WORKING'},
    {id:'done',type:'ticket',state:'DONE',nextAction:{action:'DONE'}},
  ];
  const edges=[{from:'decision',to:'waiting'}], groups=executionSummary(items,items,edges);
  assert.deepEqual(groups.attention.map(r=>r.item.id),['decision']);
  assert.deepEqual(groups.ready.map(r=>r.item.id),['execute','review']);
  assert.deepEqual(groups.planned.map(r=>r.item.id),['draft','replan','unknown']);
  assert.deepEqual(groups.waiting.map(r=>r.item.id),['waiting']);
  assert.equal(groups.completed.length,1); assert.equal(groups.running.length,1);
  assert.equal(workflowFor(items[3],items,edges).label,'Ready for review');
});
test('decision queue sorts by unfinished downstream impact and ignores goal membership', () => {
  const {executionSummary}=globalThis.VibeHubDashboardGraph;
  const items=[{id:'a',state:'NEEDS YOU'},{id:'z',state:'NEEDS YOU'},{id:'child',state:'TODO'},{id:'later',state:'TODO'},{id:'complete',state:'DONE'}];
  const edges=[{from:'z',to:'child'},{from:'child',to:'later'},{from:'later',to:'child'},{from:'a',to:'complete'},{from:'a',to:'child',membership:true}];
  const summary=executionSummary(items,items,edges);
  assert.deepEqual(summary.attention.map(r=>r.item.id),['z','a']);
  assert.equal(summary.attention[0].downstream.length,2);
  assert.equal(summary.attention[1].downstream.length,0);
  assert.equal(summary.waiting.length,2);
});
test('canvas puts independent human decisions before completed history without changing dependencies', () => {
  const items=[{id:'a',state:'DONE'},{id:'z',state:'NEEDS YOU'}];
  const graph=layoutGraph(items,[],{maxWidth:416});
  assert.ok(graph.nodes.find(n=>n.id==='z').y < graph.nodes.find(n=>n.id==='a').y);
});

test('explicit native bindings preserve goal membership and remap dependency edges without duplicates', () => {
  const { mergeTicketSources, goalScope, executionSummary } = globalThis.VibeHubDashboardGraph;
  const personal = [{id:'goal',type:'goal',relations:[]},
    {id:'decision',type:'task',title:'Choose sharing',relations:[{type:'task_of',target:'goal'}],externalKeys:[{system:'vibehub-ticket',key:'/demo/.vibehub/tickets/choice.yaml'}]},
    {id:'build',type:'task',title:'Build sharing',working:true,relations:[{type:'task_of',target:'goal'}],externalKeys:[{system:'vibehub-ticket',key:'/demo/.vibehub/tickets/build.yaml'}]}];
  const native = [{id:'tree:choice',originalId:'choice',path:'/demo/.vibehub/tickets/choice.yaml',nextAction:{action:'NEEDS_HUMAN'}},
    {id:'tree:build',originalId:'build',path:'/demo/.vibehub/tickets/build.yaml',nextAction:{action:'WAIT'}}];
  const merged=mergeTicketSources(personal,native,[{from:'tree:choice',to:'tree:build'}]);
  assert.equal(merged.items.length,3);
  assert.deepEqual(merged.edges,[{from:'decision',to:'build'}]);
  assert.equal(goalScope('goal',merged.items).size,3);
  const groups=executionSummary(merged.items,merged.items,merged.edges);
  assert.equal(groups.attention[0].item.title,'Choose sharing');
  assert.equal(groups.waiting[0].item.working,false);
  assert.deepEqual(groups.attention[0].downstream,['build']);
  assert.equal(mergeTicketSources(personal,[{...native[0],path:'/other/.vibehub/tickets/choice.yaml'}],[]).items.length,4);
  assert.equal(mergeTicketSources([...personal,{...personal[1],id:'ambiguous'}],native,[]).items.length,5);
  assert.equal(mergeTicketSources(personal,[native[0],{...native[0],id:'duplicate'}],[]).items.length,5);
});

test('authority previews require authentication and a recorded file inside the selected worktree', async t => {
  const root=fixture(t), repo=repoAt(root,'preview');
  assert.equal(run(repo,'project','init').status,0);
  mkdirSync(join(repo,'docs'));writeFileSync(join(repo,'docs','model.md'),'# Data model\n\n| Field | Type |\n| --- | --- |\n| id | UUID |\n');
  writeFileSync(join(repo,'docs','unused.txt'),'not a canonical artifact');
  writeRoom(repo,'product',room('product',{anchors:['docs']}));
  const record=context({context_id:'authority-preview',type:'authority',authority:{governs:['docs'],canonical:['docs/model.md'],update_rules:['Update the model first.'],validation:['Confirm field types.']}});
  assert.equal(run(repo,'context','put',record,['--room','product']).status,0);
  const host=startVibeHubUi({repoRoot:root,dashboardRoots:[root]});const ready=await host.ready;t.after(()=>host.close());
  const headers={Authorization:`Bearer ${host.token}`};
  const home=await (await fetch(`${ready.origin}/api/dashboard`,{headers})).json();
  const workspace=home.data.projects[0].worktrees[0].id;
  const endpoint=`${ready.origin}/api/authority-preview?workspace=${workspace}&context=authority-preview`;
  assert.equal((await fetch(endpoint)).status,401);
  const result=await (await fetch(endpoint,{headers})).json();
  assert.equal(result.data.ref,'docs/model.md');assert.match(result.data.content,/UUID/);
  assert.equal((await fetch(`${endpoint}&artifact=1`,{headers})).status,404);
  assert.equal((await fetch(`${endpoint}&artifact=../docs/unused.txt`,{headers})).status,404);
  assert.equal((await fetch(endpoint.replace('context=authority-preview','context=unknown'),{headers})).status,404);
  const outside=join(root,'private.txt');writeFileSync(outside,'must not escape');
  rmSync(join(repo,'docs','model.md'));symlinkSync(outside,join(repo,'docs','model.md'));
  const denied=await fetch(endpoint,{headers});assert.notEqual(denied.status,200);assert.doesNotMatch(await denied.text(),/must not escape/);
});

test('authenticated dashboard activity renews the idle deadline, then an idle host closes', async t => {
  const root=fixture(t);
  const host=startVibeHubUi({repoRoot:root,dashboardRoots:[root],tokenLifetimeMs:500});
  const ready=await host.ready;t.after(()=>host.close());
  const headers={Authorization:`Bearer ${host.token}`};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  await pause(300);
  const active=await fetch(`${ready.origin}/api/session-active`,{headers});
  assert.equal(active.status,200);
  assert.equal((await active.json()).data.idleTimeoutMs,500);
  await pause(300);
  assert.equal((await fetch(`${ready.origin}/health`)).status,200,'active session survives its original deadline');
  await host.closed;
  await assert.rejects(fetch(`${ready.origin}/health`));
});

test('unauthenticated activity cannot keep a dashboard host alive', async t => {
  const root=fixture(t);
  const host=startVibeHubUi({repoRoot:root,dashboardRoots:[root],tokenLifetimeMs:400});
  const ready=await host.ready;t.after(()=>host.close());
  let ended=false;host.closed.then(()=>{ended=true;});
  const interval=setInterval(()=>{fetch(`${ready.origin}/api/session-active`).catch(()=>{});},50);
  t.after(()=>clearInterval(interval));
  await new Promise(resolve=>setTimeout(resolve,650));
  assert.equal(ended,true);
});
