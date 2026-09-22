// Deliberately synthetic UX state, never a Runtime contract or authorization layer.
export const explorations = [
  { id:'A', name:'Local-first', branch:'codex/local-first', path:'/demo/atlas', person:'Mira', summary:'A quiet local runtime, with context ready when you need it.', sessions:[['Codex · implementation','active'],['Claude · review','dormant']] },
  { id:'B', name:'Remote queue', branch:'codex/queue-study', path:'/demo/worktrees/queue', person:'Noah', summary:'An independent exploration of retry and recovery semantics.', sessions:[['Claude · queue study','active']] },
  { id:'C', name:'Independent review', branch:'codex/review', path:'/demo/worktrees/review', person:'Iris', summary:'Checks the result against the pinned Ticket contract.', sessions:[['Codex · acceptance','dormant']] },
];
export const workspaces = [...explorations.map(e=>[e.id,`${e.id} · ${e.name}`]),['D','D · archive-spike (deleted)']];
export const ticketFilters = [['relevant','Current-relevant'],['created','Created here'],['participated','Participated here'],['finished','Execution finished here'],['accepted','Accepted here'],['project','Project-wide'],['archived','Archived in this workspace']];
export const tickets = [
  {id:'T-24',title:'Make recovery bounded and explicit',status:'In progress',created:'A',participants:['A','B'],finished:[],accepted:[],relevant:['A','B'],blocker:'T-18',goal:'Resume only selected, previously persisted work after a Project is re-enabled.',constraint:'No private-session backfill. Keep the prior activation epoch and exact input references.',acceptance:'A stale result cannot mutate context; explicit recovery creates a new job identity.',attempts:[['1','A','Exploration ended · no acceptance'],['2','B','Execution active · contract v2']]},
  {id:'T-21',title:'Preserve coding when the app is offline',status:'Accepted',created:'A',participants:['A','B','C'],finished:['B'],accepted:['C'],relevant:['A','B','C'],goal:'Let native coding continue while context enrichment is paused.',constraint:'Never silently claim missed messages were captured.',acceptance:'Independent review verifies the offline/gap interaction.',attempts:[['1','A','Incomplete · contract v1'],['2','B','Execution finished · contract v2'],['Review','C','Independently accepted · contract v2']]},
  {id:'T-18',title:'Confirm provider retry limits',status:'Blocked',created:'D',participants:['B'],finished:[],accepted:[],relevant:['B'],goal:'Set a bounded retry ceiling from measured provider behavior.',constraint:'Do not infer rate limits from a successful single call.',acceptance:'Selected-route measurements or an explicit unresolved result.',attempts:[['1','D','Origin workspace deleted; history retained']]},
  {id:'T-09',title:'Retain exact source references',status:'Accepted',created:'D',participants:['D','C'],finished:['D'],accepted:['C'],relevant:['C'],goal:'Keep authorized historical references after worktree cleanup.',constraint:'A removed workspace never rewrites original provenance.',acceptance:'References still resolve or return a permission-aware tombstone.',attempts:[['1','D','Execution finished'],['Review','C','Independently accepted']]},
];
export const notices = [
  {id:'n-ab',from:'A',to:'B',title:'Local-first baseline has a new revision',ref:'ctx-local@2',before:'A local Worker is always required.',after:'Native coding continues without a Worker; enrichment may wait.',why:'B is exploring recovery for the same Runtime delivery Room.'},
  {id:'n-ba',from:'B',to:'A',title:'Retry limits need an explicit budget',ref:'ctx-queue@1',before:'Retry while the task remains useful.',after:'Queue study proposes a maximum of three attempts before review.',why:'A also dispatches bounded background work. This is a proposal, not a Project rule.'},
];
export const contexts = [
  {id:'ctx-local@2',title:'Keep native coding available without a Worker',role:'Decision',scope:'A · Local-first',state:'Current',origin:'A / Codex implementation / source message demo:42',rationale:'The user must keep working during Runtime or provider interruption.',relation:'supersedes ctx-local@1 in A only',base:'Project background v3',meaning:'Applies to local development; does not decide remote deployment.'},
  {id:'ctx-queue@1',title:'Explore an explicit queue retry budget',role:'Proposal',scope:'B · Remote queue',state:'Current',origin:'B / Claude queue study / source message demo:57',rationale:'Bound cost and prevent indefinite retries.',relation:'branched from ctx-local@1; B remains current',base:'Project background v2 · update available',meaning:'Alternative exploration; not adopted by A or Project.'},
  {id:'ctx-local@1',title:'Require a local Worker for every run',role:'Decision',scope:'A · Local-first',state:'Superseded',origin:'A / Codex implementation / source message demo:12',rationale:'Earlier assumption before offline behavior was considered.',relation:'superseded by ctx-local@2; also parent of ctx-queue@1',base:'Project background v2',meaning:'Historical in A. Its descendant in B is independently current.'},
  {id:'ctx-source@3',title:'Source text cannot grant permission',role:'Constraint',scope:'Project · all explorations',state:'Current',origin:'D / archive-spike (deleted) / source policy demo:8',rationale:'Collected content is evidence, not service authority.',relation:'Project revision 3; origin remains D after deletion',base:'Project background v3',meaning:'Still applies when hidden or visually archived.'},
  {id:'ctx-online@1',title:'Assume the Worker is always online',role:'Observation',scope:'B · Remote queue',state:'Invalidated',origin:'B / synthetic availability observation demo:5',rationale:'A later availability observation disproved this assumption.',relation:'invalidated by observation demo:61; never erased',base:'Project background v2',meaning:'Not eligible as current context.'},
  {id:'ctx-conflict@1',title:'Reconcile the recovery policy',role:'Open question',scope:'Room · Runtime delivery',state:'Unresolved conflict',origin:'A + B / competing cited proposals',rationale:'Three attempts versus one attempt remains undecided.',relation:'compares ctx-local@2 and ctx-queue@1; no winning revision',base:'Two exploration bases',meaning:'No automatic merge, even after a Git merge.'},
];
export function initialState(){return {view:'overview',project:'atlas',scenario:'ready',workspace:'A',viewer:'Mira',filter:'relevant',enabled:{atlas:true,notebook:false},runtime:true,epoch:5,gaps:[],hidden:{},archived:{},contextHidden:[],contextArchived:[],noticeStates:{},adoptions:[],provider:'typesafe',keyConfigured:false,executor:'codex',workerReady:true,folder:'git',enrolled:true,claudeConnected:false,request:'offered',requestReceipt:false};}
export const preferenceKey = (state,filter=state.filter)=>[state.viewer,state.project,state.workspace,filter].join('|');
export function ticketReason(ticket, state){
  const ws=state.workspace;
  if(state.filter==='project')return 'Included in Project-wide view';
  if(state.filter==='archived')return (state.archived[[state.viewer,state.project,ws].join('|')]??[]).includes(ticket.id)?`Archived for ${state.viewer} in workspace ${ws}`:null;
  const fields={created:'created',participated:'participants',finished:'finished',accepted:'accepted',relevant:'relevant'};
  const v=ticket[fields[state.filter]];
  if(!(Array.isArray(v)?v.includes(ws):v===ws))return null;
  return {created:`Created in ${ws}`,participated:`Participated in ${ws}`,finished:`Execution finished in ${ws}; acceptance is separate`,accepted:`Independently accepted in ${ws}`,relevant:`Active participation or retained outcome applies in ${ws}`}[state.filter];
}
export function ticketProjection(state){
  const hidden=state.hidden[preferenceKey(state)]??[];
  const archived=state.archived[[state.viewer,state.project,state.workspace].join('|')]??[];
  return tickets.flatMap(t=>{const reason=ticketReason(t,state);return reason&&!hidden.includes(t.id)&&(state.filter==='archived'||!archived.includes(t.id))?[{...t,reason,blockerReference:t.blocker?tickets.find(x=>x.id===t.blocker):null}]:[];});
}
export function changePreference(state,ticketId,operation){
  const next=structuredClone(state), key=preferenceKey(state), archiveKey=[state.viewer,state.project,state.workspace].join('|');
  if(operation==='hide')next.hidden[key]=[...new Set([...(next.hidden[key]??[]),ticketId])];
  if(operation==='restore-hidden')next.hidden[key]=(next.hidden[key]??[]).filter(id=>id!==ticketId);
  if(operation==='archive')next.archived[archiveKey]=[...new Set([...(next.archived[archiveKey]??[]),ticketId])];
  if(operation==='restore-archive')next.archived[archiveKey]=(next.archived[archiveKey]??[]).filter(id=>id!==ticketId);
  return next;
}
export function blockedAction(state){return !state.runtime||!state.enabled[state.project]||['offline','denied','stale','unavailable','auth','quota','failure'].includes(state.scenario);}
export function changeNoticeState(state,noticeId,nextStatus){
  const notice=notices.find(n=>n.id===noticeId);
  if(!notice||!['seen','deferred','continued own path','adopted'].includes(nextStatus))throw new Error('Unknown fixture notice transition');
  const next=structuredClone(state);
  // Adoption is a retained receipt, never overwritten by a later view preference.
  if(next.noticeStates[noticeId]==='adopted')return next;
  next.noticeStates[noticeId]=nextStatus;
  if(nextStatus==='adopted'&&!next.adoptions.some(a=>a.ref===notice.ref&&a.to===notice.to))next.adoptions.push({id:`demo-adoption-${next.adoptions.length+1}`,ref:notice.ref,to:notice.to});
  return next;
}
