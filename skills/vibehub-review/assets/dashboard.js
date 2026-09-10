(() => {
  'use strict';
  const $ = (id) => document.getElementById(id), NS = 'http://www.w3.org/2000/svg';
  const token = location.hash.slice(1);
  const { stageFor, goalScope, workflowFor, executionSummary, mergeTicketSources } = VibeHubDashboardGraph;
  let selectedGoal = new URLSearchParams(location.search).get('goal'), view = new URLSearchParams(location.search).get('view') === 'canvas' ? 'canvas' : 'board';
  let canvasObserver=null, lastUpdated=null;
  let surface = new URLSearchParams(location.search).get('surface') || (selectedGoal ? 'tickets' : 'goals'), contextRecords = [], contextRooms = [], contextErrors = [], contextLoading = false, contextGeneration = 0;
  const roomExpanded = new Map();
  let projectChoices=[], activeProjectChoice=-1;
  let data = null, selected = null, items = [], edges = [], filter = 'all', generation = 0, lastFocused = null, repositoryItems = [], repositoryEdges = [], sourceWarnings = [];
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const status = (text) => { $('status').textContent = text; };
  document.querySelector('.brand').href = `/dashboard#${token}`;
  async function api(path) {
    if (!token) throw new Error('Open the complete dashboard link printed by the launcher.');
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error?.message || 'Could not read this source.');
    return result.data;
  }
  function selectedTree() { return data?.projects.flatMap((p) => p.worktrees).find((t) => t.id === selected); }
  function inspectorLink(ticketId, workspaceId = selected) {
    const url = new URL('/', location.origin); url.searchParams.set('workspace', workspaceId);
    if (ticketId) url.searchParams.set('ticket', ticketId);
    url.hash = token; return url.href;
  }
  function navigateHome() {
    if (!data) return;
    closeNavigation();
    contextGeneration++; selected = null; selectedGoal = null; surface='goals'; view='board'; resetFilters(); const url = new URL(location); url.searchParams.delete('workspace'); url.searchParams.delete('goal'); url.searchParams.set('surface','goals'); url.searchParams.set('view','board'); history.replaceState(null, '', url);
    showPersonal(); renderNav(); loadRepositoryTickets();
  }
  function renderNav() {
    if (!data) return;
    renderGoals(); renderSwitchers();
    $('home').setAttribute('aria-current',String(!selectedGoal && surface==='goals'));
    const query = $('project-search').value.toLowerCase(), project=projectForTree();
    $('projects').replaceChildren(); $('project-count').textContent=project ? new Set(project.worktrees.map(t=>t.branch)).size : '';
    if(!project) { $('projects').append(el('p','Choose a project to explore its branches.','nav-empty')); return; }
    const branches=[...new Set(project.worktrees.map(t=>t.branch))];
    for(const branch of branches) {
      const trees=project.worktrees.filter(t=>t.branch===branch);
      if(query&&!`${branch} ${trees.map(t=>t.path).join(' ')}`.toLowerCase().includes(query)) continue;
      const button=el('button',undefined,'branch-link'); button.type='button'; button.disabled=trees.every(t=>!t.available);
      button.setAttribute('aria-current',String(selectedTree()?.branch===branch));
      button.append(el('span','⑂','tree-indicator'),el('span',branch,'tree-name'),el('small',`${trees.length} ${trees.length===1?'worktree':'worktrees'}`));
      button.addEventListener('click',()=>{closeNavigation(); const tree=trees.find(t=>t.id===selected)||trees.find(t=>t.available); if(tree) selectWorkspace(tree);}); $('projects').append(button);
    }
  }

  function personalItems() {
    return data.personal.tickets.map(t => ({...t, state:['done','archived','completed'].includes((t.state||'').toLowerCase()) ? t.state.toUpperCase() : t.attention==='needs_you' ? 'NEEDS YOU' : t.working ? 'WORKING' : (t.state||'unknown').toUpperCase()}));
  }
  function resetFilters() {
    filter = 'all'; $('search').value = ''; $('status-filter').value='all';
    document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===filter)));
  }
  function segmentedProgress(done,total,label) {
    const meter=el('span',undefined,'segmented-progress'); meter.setAttribute('role','progressbar'); meter.setAttribute('aria-label',label);
    meter.setAttribute('aria-valuemin','0'); meter.setAttribute('aria-valuemax',String(Math.max(1,total))); meter.setAttribute('aria-valuenow',String(done)); meter.setAttribute('aria-valuetext',`${done} of ${total} tickets complete`);
    const filled=total?Math.round(done/total*20):0;
    for(let i=0;i<20;i++){const segment=el('span',undefined,`progress-segment${i<filled?' filled':''}`);segment.setAttribute('aria-hidden','true');meter.append(segment);}
    return meter;
  }
  function goalStatus(goal) {
    const children=goalTickets(goal), groups=executionSummary(children,items,edges), own=workflowFor(goal,items,edges);
    if(!children.length||own.lane==='completed') return own;
    const lane=['attention','running','ready','planned','waiting'].find(key=>groups[key].length)||'completed';
    const labels={attention:'Needs you',running:'Agent working',ready:'Agent ready',planned:'Needs planning',waiting:'Waiting',completed:'Completed'};
    return {...own,lane,label:labels[lane]};
  }
  function renderGoals() {
    const goals=items.filter(t=>t.type==='goal');
    $('goal-count').textContent=goals.length; $('total').textContent=goals.length; $('goal-nav').replaceChildren();
    for(const goal of goals) {
      const children=goalTickets(goal), groups=executionSummary(children,items,edges), workflow=goalStatus(goal);
      const button=el('button',undefined,'goal-link'); button.type='button'; button.setAttribute('aria-current',String(selectedGoal===goal.id));
      const copy=el('span',undefined,'goal-copy'); copy.append(el('small',workflow.label,'goal-stage'),el('span',goal.title,'goal-title'),segmentedProgress(groups.completed.length,children.length,`${goal.title} progress`),el('small',`${groups.completed.length} of ${children.length} tickets complete`));
      if(groups.attention.length) copy.append(el('small',`${groups.attention.length} need you`,'goal-attention'));
      button.append(copy); button.addEventListener('click',()=>{closeNavigation();selectGoal(goal.id);}); $('goal-nav').append(button);
    }
    if(!goals.length) $('goal-nav').append(el('p','No goals in this workspace yet. Start with New goal.','nav-empty'));
  }
  function renderSwitchers() {
    const project = data.projects.find(p=>p.worktrees.some(t=>t.id===selected)), tree=selectedTree();
    function options(id, entries, value, disabled=false) {
      const select=$(id); select.replaceChildren();
      entries.forEach(([key,label])=>{ const option=el('option',label); option.value=key; select.append(option); });
      select.value=value; select.disabled=disabled;
    }
    options('project-select',[['','All projects'],...data.projects.map(p=>[p.id,p.name])],project?.id||'');
    const branches=[...new Set(project?.worktrees.map(t=>t.branch)||[])];
    options('branch-select',project ? branches.map(b=>[b,b]) : [['','All branches']],tree?.branch||'',!project);
    const trees=project?.worktrees.filter(t=>t.branch===tree?.branch)||[];
    options('worktree-select',project ? trees.map(t=>[t.id,`${t.path}${t.available?'':' (unavailable)'}`]) : [['','All worktrees']],tree?.id||'',!project);
    $('worktree-select').closest('label').hidden=!project || trees.length<2;
    renderProjectPicker();
  }
  function renderProjectPicker() {
    const current=projectForTree(); $('project-trigger').disabled=!data;
    $('project-selected-name').textContent=current?.name||'All projects';
    const branches=current?new Set(current.worktrees.map(t=>t.branch)).size:0, trees=current?.worktrees.length||0;
    $('project-selected-description').textContent=current?`${branches} ${branches===1?'branch':'branches'} · ${trees} ${trees===1?'worktree':'worktrees'}`:`${data?.projects.length||0} connected projects`;
    if($('project-popover').matches(':popover-open'))renderProjectOptions();
  }
  function positionProjectPicker() {
    const rect=$('project-trigger').getBoundingClientRect(), panel=$('project-popover'), width=Math.min(360,innerWidth-24), left=Math.max(12,Math.min(rect.left,innerWidth-width-12));
    panel.style.width=`${width}px`;panel.style.left=`${left}px`;
    const below=innerHeight-rect.bottom-16, above=rect.top-16;
    const useBelow=below>=240||below>=above, available=Math.max(120,useBelow?below:above);
    panel.style.maxHeight=`${available}px`;
    panel.style.top=useBelow?`${rect.bottom+6}px`:'auto';panel.style.bottom=useBelow?'auto':`${innerHeight-rect.top+6}px`;
  }
  function renderProjectOptions() {
    const query=$('project-query').value.trim().toLowerCase(), current=projectForTree()?.id||'';
    const choices=[{id:'',name:'All projects',path:'Goals across connected projects'},...(data?.projects||[])];
    projectChoices=choices.filter(p=>`${p.name} ${p.path}`.toLowerCase().includes(query));
    activeProjectChoice=projectChoices.findIndex(p=>p.id===current);if(activeProjectChoice<0)activeProjectChoice=projectChoices.length?0:-1;
    $('project-options').replaceChildren();
    projectChoices.forEach((project,index)=>{
      const option=el('div',undefined,'project-option');option.id=`project-option-${index}`;option.setAttribute('role','option');option.setAttribute('aria-selected',String(project.id===current));
      const icon=el('span',project.id?'▱':'▦','project-avatar');icon.setAttribute('aria-hidden','true');
      const copy=el('span',undefined,'project-option-copy');copy.append(el('strong',project.name),el('small',project.path));
      const check=el('span',project.id===current?'✓':'','project-option-check');check.setAttribute('aria-hidden','true');option.append(icon,copy,check);
      option.addEventListener('pointerdown',event=>event.preventDefault());option.addEventListener('click',()=>chooseProject(index));
      option.addEventListener('pointermove',()=>setActiveProject(index,false));$('project-options').append(option);
    });
    $('project-picker-status').textContent=projectChoices.length?'':query?'No projects found. Try another name or path.':'No connected projects.';
    setActiveProject(activeProjectChoice,false);
  }
  function setActiveProject(index,scroll=true) {
    activeProjectChoice=index;const options=[...$('project-options').children];options.forEach((node,i)=>node.classList.toggle('is-active',i===index));
    if(index>=0&&options[index]){$('project-query').setAttribute('aria-activedescendant',options[index].id);if(scroll)options[index].scrollIntoView({block:'nearest'});}else $('project-query').removeAttribute('aria-activedescendant');
  }
  function closeProjectPicker(restore=false){if($('project-popover').matches(':popover-open'))$('project-popover').hidePopover();if(restore)$('project-trigger').focus();}
  function openProjectPicker(){if(!data)return;$('project-query').value='';renderProjectOptions();positionProjectPicker();$('project-popover').showPopover();$('project-query').focus();}
  function chooseProject(index){const choice=projectChoices[index];if(!choice)return;closeProjectPicker(true);if(choice.id===(projectForTree()?.id||''))return;$('project-select').value=choice.id;$('project-select').dispatchEvent(new Event('change',{bubbles:true}));}
  function projectForTree() { return data?.projects.find(p=>p.worktrees.some(t=>t.id===selected)); }
  function matchesProject(item, project) { return (item.projects||[]).some(ref=>ref===project.name || ref===project.path || project.worktrees.some(t=>ref===t.path)); }
  function personalForProject(project) {
    const all=personalItems(), ids=new Set(all.filter(t=>matchesProject(t,project)).map(t=>t.id));
    for(const goal of all.filter(t=>t.type==='goal' && ids.has(t.id))) for(const id of goalScope(goal.id,all)) ids.add(id);
    return all.filter(t=>ids.has(t.id));
  }
  async function selectGoal(id) {
    closeNavigation();
    const goal=items.find(t=>t.id===id && t.type==='goal') || personalItems().find(t=>t.id===id && t.type==='goal');
    if(!goal) return;
    const project=data.projects.find(p=>matchesProject(goal,p));
    if(project && !project.worktrees.some(t=>t.id===selected)) {
      const tree=project.worktrees.find(t=>t.available && t.branch==='main')||project.worktrees.find(t=>t.available);
      if(tree) { await selectWorkspace(tree); if(selected!==tree.id) return; }
    } else if(!items.some(t=>t.id===id)) { selected=null; showPersonal(); }
    selectedGoal=id; surface='tickets'; view='board'; closeDetail(false); resetFilters();
    const url=new URL(location); url.searchParams.set('goal',id); url.searchParams.set('surface','tickets'); url.searchParams.set('view','board'); history.replaceState(null,'',url);
    $('heading').textContent=goal.title; $('breadcrumb').textContent=`${project?.name||'Personal'} / Goals / ${goal.title}`;
    renderNav(); renderWork();
  }
  function scopeItems() {
    if(selectedGoal) { const ids=goalScope(selectedGoal,items); return items.filter(t=>ids.has(t.id) && t.type!=='goal'); }
    if(surface==='goals') return items.filter(t=>t.type==='goal');
    if(surface==='tickets') {
      const assigned=new Set(); for(const goal of items.filter(t=>t.type==='goal')) for(const id of goalScope(goal.id,items)) assigned.add(id);
      return items.filter(t=>t.type!=='goal' && !assigned.has(t.id));
    }
    return items;
  }
  function renderHierarchy() {
    if(!selectedGoal) $('heading').textContent=surface==='authority'?'Context':surface==='contexts'?'Context':surface==='goals'?(projectForTree()?`${projectForTree().name} goals`:'Goals'):'Unassigned tickets';
    $('breadcrumb').textContent=projectForTree()?`${projectForTree().name} / ${selectedTree().branch}`:'Workspace';
    $('back-goals').hidden=!selectedGoal; $('search').placeholder=surface==='authority'?'Find a canonical resource…':surface==='contexts'?'Find a Room or context…':selectedGoal || surface==='tickets'?'Find a ticket…':'Find a goal…';
    document.querySelectorAll('[data-surface]').forEach(b=>{const active=selectedGoal?b.dataset.surface==='tickets':(b.dataset.surface===surface||(b.dataset.surface==='contexts'&&surface==='authority'));b.setAttribute('aria-pressed',String(active));if(b.dataset.surface==='tickets')b.textContent=selectedGoal?'Tickets':'Unassigned tickets';});
    const goal=items.find(t=>t.id===selectedGoal); $('goal-outcome').textContent=goal?.outcome||''; $('goal-outcome').hidden=!goal?.outcome;
    if(goal) $('heading').textContent=goal.title;
    $('list-title').textContent=surface==='authority'?'Canonical project resources':surface==='contexts'?'Recorded context':surface==='goals'&&view==='board'?'Goal overview':`${selectedGoal?'Ticket':surface==='goals'?'Goal':'Unassigned ticket'} ${view==='board'?'board':'graph'}`;
    document.querySelector('[data-view=board]').textContent=surface==='goals'?'Overview':'Board';
    document.title=`VibeHub · ${$('heading').textContent}`;
    document.querySelector('.start').hidden=['contexts','authority'].includes(surface);
    $('view-description').textContent=selectedGoal?'Executable tickets for this goal. Start with anything that needs you.':surface==='goals'?'Choose an outcome to see its progress and next steps.':surface==='authority'?'Shared project references: design, infrastructure, data, and contracts.':surface==='contexts'?'Decisions and knowledge saved for this project, organized into Rooms.':'Executable work that has not been assigned to a goal.';
    document.querySelector('.view-controls').hidden=['contexts','authority'].includes(surface);
    document.querySelector('.tabs').hidden=['contexts','authority'].includes(surface);
    $('focus-mode').hidden=['contexts','authority'].includes(surface);
    $('legend').hidden=['contexts','authority'].includes(surface) || view!=='canvas';
    $('legend').textContent=surface==='goals'?'Select a goal to explore its tickets. Lines show recorded goal dependencies and sub-goal membership.':'Flow runs top to bottom · Colored lines connect prerequisite tickets · Dashed lines show membership.';
  }
  async function loadContexts() {
    const turn=++contextGeneration; contextRecords=[]; contextRooms=[]; contextErrors=[]; contextLoading=true; renderWork();
    const trees=selected ? [selectedTree()].filter(Boolean) : data.projects.flatMap(p=>p.worktrees);
    for(const tree of trees.filter(t=>t.hasTickets && t.available)) {
      try { const result=await api(`/api/contexts?workspace=${encodeURIComponent(tree.id)}`); if(turn!==contextGeneration) return;
        const project=data.projects.find(p=>p.worktrees.some(t=>t.id===tree.id));
        for(const room of result.rooms) {
          const scope={room:room.room,roomDescription:room.description,parent:room.parent,workspace:tree.id,worktree:tree.path,branch:tree.branch,project:project.name};
          contextRooms.push({...scope,key:`${tree.id}:${room.room}`});
          // Room explorer includes descendants; the dashboard lists each record in its owning Room.
          for(const context of room.contexts) {
            const owner=context.path?.replace(/\\/g,'/').match(/(?:^|\/)\.vibehub\/rooms\/(.+)\/[^/]+\.yaml$/)?.[1];
            if(owner && owner!==room.room) continue;
            contextRecords.push({...context,...scope});
          }
        }
      } catch(error) { if(turn!==contextGeneration) return; contextErrors.push(`${tree.path}: ${error.message}`); }
    }
    if(turn!==contextGeneration) return; contextLoading=false; if(['contexts','authority'].includes(surface)) renderWork();
  }
  // Each Context kind has a different "what matters": a decision is its exact
  // words, a constraint is where it must hold, an authority is what it governs,
  // a change is which truth it touched. The card and the detail lead with that.
  const CONTEXT_KINDS={
    authority:{label:'Authority',hint:'Golden truth. Follow it; change it only by its rules.'},
    decision:{label:'Decision',hint:'What was decided, in the words it was decided with.'},
    constraint:{label:'Constraint',hint:'Must hold in every Ticket it reaches.'},
    intent:{label:'Intent',hint:'What the work is for.'},
    contract:{label:'Contract',hint:'A long-range promise other work builds on.'},
    convention:{label:'Convention',hint:'How work is normally done here.'},
    change:{label:'Change',hint:'What moved, and which truth it touched.'},
    note:{label:'Note',hint:'Supporting reference.'},
  };
  const contextKind=type=>CONTEXT_KINDS[type]||{label:type,hint:''};
  const shortRef=ref=>ref.startsWith('conversation:')?`conversation ${ref.slice('conversation:'.length)}`:ref.startsWith('distill:')?`distilled from ${ref.slice('distill:'.length)}`:ref;
  const artifactRefs=record=>(record.evidence||[]).map(e=>e.ref).filter(ref=>/[\/.]/.test(ref)&&!/^(conversation|distill|test|command):/.test(ref));
  const findRecord=(record,id)=>contextRecords.find(c=>c.workspace===record.workspace&&c.context_id===id);
  const supersededBy=record=>contextRecords.filter(c=>c.workspace===record.workspace&&(c.relations||[]).some(r=>r.type==='supersedes'&&r.target_context_id===record.context_id)).map(c=>c.context_id);
  const relationsOf=(record,type)=>(record.relations||[]).filter(r=>r.type===type).map(r=>r.target_context_id);
  const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
  function contextLead(record) {
    const lines=[]; const line=(text,cls)=>{ if(text) lines.push({text,cls}); };
    const a=record.authority;
    switch(record.type) {
      case 'authority': if(a){ line(`Governs ${a.governs.join(', ')}`,'lead-strong'); line(`Canonical ${a.canonical.join(', ')}`,'lead-strong'); line(`${plural(a.update_rules.length,'update rule')} · ${plural(a.validation.length,'check')}${a.approval==='human'?' · a person decides changes':''}`); } break;
      case 'decision': if(record.source?.quote) line(`“${record.source.quote}”`,'lead-quote'); else line(record.detail,'lead-preview'); { const older=relationsOf(record,'supersedes'); if(older.length) line(`Replaces ${older.join(', ')}`,'lead-warn'); } break;
      case 'constraint': line(record.detail,'lead-strong lead-preview'); break;
      case 'change': { const touched=relationsOf(record,'relates_to').filter(id=>findRecord(record,id)?.type==='authority'); if(touched.length) line(`Touches golden truth ${touched.join(', ')}`,'lead-warn'); const artifacts=artifactRefs(record); if(artifacts.length) line(`Changed ${artifacts.join(', ')}`,'lead-strong'); if(!touched.length&&!artifacts.length) line(record.detail,'lead-preview'); } break;
      case 'contract': line(record.detail,'lead-preview'); { const deps=relationsOf(record,'depends_on'); if(deps.length) line(`Builds on ${deps.join(', ')}`); } break;
      default: line(record.detail,'lead-preview');
    }
    return lines;
  }
  function contextFacts(record) {
    const facts=[]; const used=record.consumingTickets||[];
    facts.push({text:used.length?`Read by ${plural(used.length,'Ticket')}`:'Not read by any Ticket yet',cls:used.length?'fact-strong':'fact-muted'});
    const newer=supersededBy(record); if(newer.length) facts.push({text:`Superseded by ${newer.join(', ')}`,cls:'fact-warn'});
    if(record.source?.ref) facts.push({text:`From ${shortRef(record.source.ref)}`});
    facts.push({text:plural((record.evidence||[]).length,'evidence item')});
    return facts;
  }
  function authorityPreview(context) {
    const section=el('section',undefined,'authority-preview'), toolbar=el('div',undefined,'preview-toolbar');
    const label=el('label','File'), select=el('select');select.setAttribute('aria-label','Canonical file');
    context.authority.canonical.forEach((ref,index)=>{const option=el('option',ref);option.value=String(index);select.append(option);});label.append(select);
    const toggle=el('button','Source');toggle.type='button';toggle.disabled=true;toggle.setAttribute('aria-pressed','false');
    toolbar.append(label,toggle);const body=el('div',undefined,'preview-document'), notice=el('p',undefined,'preview-notice');notice.setAttribute('role','status');
    section.append(toolbar,notice,body);let revision=0,current=null,source=false;
    const draw=()=>{VibeHubPreview.render(body,current,source);toggle.textContent=source?'Preview':'Source';toggle.setAttribute('aria-pressed',String(source));};
    const load=async()=>{const turn=++revision;current=null;source=false;toggle.disabled=true;toggle.textContent='Source';toggle.setAttribute('aria-pressed','false');body.replaceChildren();notice.textContent='Loading canonical file…';
      try {const query=new URLSearchParams({workspace:context.workspace,context:context.context_id,artifact:select.value});const data=await api(`/api/authority-preview?${query}`);
        if(turn!==revision||!section.isConnected)return;current=data;notice.textContent=`${context.branch} · Read-only preview`;toggle.hidden=data.kind==='image';toggle.disabled=false;draw();
      }catch(error){if(turn===revision&&section.isConnected)notice.textContent=error.message;}
    };
    toggle.addEventListener('click',()=>{if(current){source=!source;draw();}});select.addEventListener('change',load);load();return section;
  }
  function detailTabs(views,initial) {
    const nav=el('nav',undefined,'detail-view-tabs');nav.setAttribute('aria-label','Detail views');
    const rows=[...$('detail-meta').querySelectorAll('dt')].map(dt=>({dt,dd:dt.nextElementSibling}));
    const named=new Set(views.flatMap(([,labels])=>labels||[]));
    for(const [name,labels] of views) {const button=el('button',name);button.type='button';button.addEventListener('click',()=>select(name,labels));nav.append(button);}
    function select(name,labels){for(const button of nav.children)button.setAttribute('aria-pressed',String(button.textContent===name));for(const {dt,dd} of rows){const visible=labels?labels.includes(dt.textContent):!named.has(dt.textContent);dt.hidden=!visible;dd.hidden=!visible;}
      $('detail-outcome').hidden=name==='Preview'||name==='Record details'||!$('detail-outcome').textContent;
    }
    $('detail-meta').before(nav);select(initial,views.find(([name])=>name===initial)[1]);
  }
  function showContext(context,trigger) {
    closeDetail(false); lastFocused=trigger; const kind=contextKind(context.type);
    $('detail-kind').textContent=`${kind.label.toUpperCase()} · ${context.state}${kind.hint?` — ${kind.hint}`:''}`;
    $('detail-title').textContent=context.summary; $('detail-outcome').textContent=context.detail||''; $('detail-outcome').hidden=!context.detail; $('detail-meta').replaceChildren(); $('detail-actions').replaceChildren();
    const meta=$('detail-meta');
    const row=(label,content,cls)=>{ if(content===undefined||content===null||content===''||(Array.isArray(content)&&!content.length)) return; const dd=el('dd',undefined,cls); if(Array.isArray(content)) for(const item of content) dd.append(item); else dd.textContent=content; meta.append(el('dt',label),dd); };
    const list=(items,tag='ul')=>{ const node=el(tag,undefined,'detail-list'); for(const item of items) node.append(el('li',item)); return [node]; };
    const contextLinks=ids=>ids.map(id=>{ const target=findRecord(context,id); const chip=el('button',target?`${contextKind(target.type).label} · ${target.summary}`:id,'detail-chip'); chip.type='button'; chip.disabled=!target; if(target) chip.addEventListener('click',()=>showContext(target,trigger)); return chip; });
    const ticketChips=ids=>ids.map(id=>{ const chip=el('span',id,'detail-chip detail-chip-ticket'); return chip; });
    const evidenceList=()=>[(()=>{ const node=el('ul',undefined,'detail-list detail-evidence'); for(const item of context.evidence||[]) { const li=el('li'); li.append(el('code',item.ref),el('span',item.note)); node.append(li); } return node; })()];
    const used=context.consumingTickets||[], newer=supersededBy(context), older=relationsOf(context,'supersedes'), deps=relationsOf(context,'depends_on'), related=relationsOf(context,'relates_to');
    const a=context.authority;
    const sections={
      words:()=>row('Exact words',context.source?.quote?`“${context.source.quote}”`:undefined,'detail-quote'),
      used:()=>row(context.type==='constraint'?'Must hold in':'Read by',used.length?ticketChips(used):'No Ticket reads this record yet.',used.length?undefined:'detail-muted'),
      lineage:()=>{ row('Superseded by',contextLinks(newer)); row('Replaces',contextLinks(older)); },
      governs:()=>{ if(!a) return; row('Canonical preview',[authorityPreview(context)],'canonical-preview'); row('Governs',list(a.governs)); row('Update rules',list(a.update_rules,'ol')); row('Validation',list(a.validation)); row('Approval',a.approval==='human'?'A person decides before a canonical artifact changes.':'No sign-off; the update rules are the discipline.',a.approval==='human'?'detail-warn':undefined); },
      touches:()=>{ const truth=related.filter(id=>findRecord(context,id)?.type==='authority'); row('Touches golden truth',contextLinks(truth)); row('Changed artifacts',list(artifactRefs(context))); },
      relations:()=>{ row('Builds on',contextLinks(deps)); row('Related',contextLinks(related.filter(id=>context.type!=='change'||findRecord(context,id)?.type!=='authority'))); },
      evidence:()=>row('Evidence',(context.evidence||[]).length?evidenceList():undefined),
      source:()=>{ row('Source',context.source?.ref?shortRef(context.source.ref):undefined); row('Captured',context.source?.captured_at); },
      where:()=>{ row('Room',context.room); row('Record',context.path); row('Worktree',context.worktree); row('Tags',(context.tags||[]).join(', ')); },
    };
    const order={
      authority:['governs','used','lineage','relations','evidence','source','where'],
      decision:['words','lineage','used','relations','evidence','source','where'],
      constraint:['used','lineage','relations','evidence','source','where'],
      change:['touches','relations','used','evidence','source','where'],
      contract:['used','relations','lineage','evidence','words','source','where'],
    }[context.type]||['words','used','lineage','relations','evidence','source','where'];
    for(const name of order) sections[name]();
    if(a) {
      $('inspector').classList.add('reference-dialog');$('detail-kind').textContent=`Project authority · ${authorityCategory(context)}`;$('detail-title').textContent=referenceTitle(context);
      detailTabs([['Preview',['Canonical preview']],['Update rules',['Governs','Update rules','Validation','Approval','Read by']],['Record details',null]],'Preview');
    } else {
      $('detail-kind').textContent=`${kind.label} · ${context.state}`;
      detailTabs([['Overview',null],['Record details',['Evidence','Source','Captured','Room','Record','Worktree','Tags']]],'Overview');
    }
    const link=el('a','Open Room explorer ↗'); const url=new URL('/',location.origin); url.searchParams.set('workspace',context.workspace); url.searchParams.set('surface','rooms'); url.searchParams.set('room',context.room); url.hash=token; link.href=url.href; $('detail-actions').append(link); if(!$('inspector').open) $('inspector').showModal(); $('inspector').scrollTop=0; $('close-detail').focus();
  }
  function referenceTitle(record) {
    if(record.summary.length<=65)return record.summary;
    const file=record.authority?.canonical[0]?.split('/').pop()?.replace(/\.[^.]+$/,'').replace(/[-_]/g,' ');
    return file?file.charAt(0).toUpperCase()+file.slice(1):record.summary;
  }
  function authorityCategory(record) {
    const text=`${record.context_id} ${record.tags?.join(' ')} ${record.authority?.canonical.join(' ')}`.toLowerCase();
    if(/design|token|theme/.test(text)) return 'Design system';
    if(/infra|architecture|topology/.test(text)) return 'Infrastructure';
    if(/data.model|schema|database|datatable/.test(text)) return 'Data model';
    return 'Contracts & standards';
  }
  function renderContextTabs() {
    const nav=el('nav',undefined,'context-subnav');nav.setAttribute('aria-label','Context views');
    for(const [key,label] of [['contexts','Rooms'],['authority','Project authority']]) {const button=el('button',label);button.type='button';button.setAttribute('aria-pressed',String(surface===key));button.addEventListener('click',()=>changeSurface(key));nav.append(button);}
    $('work').append(nav);
  }
  function renderAuthorities() {
    renderContextTabs();
    const query=$('search').value.trim().toLowerCase(), records=contextRecords.filter(c=>c.type==='authority').filter(c=>`${c.summary} ${c.detail} ${authorityCategory(c)} ${c.authority?.canonical.join(' ')}`.toLowerCase().includes(query));
    $('count').textContent=plural(records.length,'canonical resource');
    const intro=el('div',undefined,'reference-heading');intro.append(el('h2','Project authority'),el('p','Open a reference to preview it and see how it should be updated.'));$('work').append(intro);
    if(contextLoading)$('work').append(el('p','Reading canonical project resources…','context-notice'));
    if(contextErrors.length){const warning=el('details',undefined,'context-errors');warning.append(el('summary',`${contextErrors.length} sources could not be read`));contextErrors.forEach(error=>warning.append(el('p',error)));$('work').append(warning);}
    if(!records.length&&!contextLoading)$('work').append(el('p',query?'No matching canonical resources.':'No Authority recorded for this project yet. Record a canonical artifact and its scope, update rules, and validation to make it available here.','empty'));
    const grid=el('div',undefined,'authority-grid');
    const categories=['Design system','Infrastructure','Data model','Contracts & standards'];
    for(const record of [...records].sort((a,b)=>categories.indexOf(authorityCategory(a))-categories.indexOf(authorityCategory(b))||a.summary.localeCompare(b.summary))) {
      const a=record.authority, card=el('button',undefined,'authority-card');card.type='button';card.dataset.category=authorityCategory(record);
      const top=el('span',undefined,'authority-card-top');top.append(el('span',authorityCategory(record),'authority-category'),el('span',record.state==='active'?'Canonical':record.state,'authority-badge'));
      card.append(top,el('strong',referenceTitle(record),'authority-title'),el('span',record.summary===referenceTitle(record)?record.detail:record.summary,'authority-description'));
      const files=el('span',undefined,'reference-file');files.append(el('span',plural(a.canonical.length,'document')),el('span',a.canonical.map(path=>path.split('.').pop().toUpperCase()).filter((x,i,all)=>all.indexOf(x)===i).join(' · ')));card.append(files);
      const footer=el('span',undefined,'authority-card-footer');footer.append(el('span',a?.approval==='human'?'Owner approval for changes':'Update rules included'),el('span','Open reference →'));card.append(footer);
      if(!selected)card.append(el('small',`${record.project} · ${record.branch}`,'authority-scope'));
      card.addEventListener('click',()=>showContext(record,card));grid.append(card);
    }
    $('work').append(grid);
  }
  let roomRailCleanup=null;
  const contextTypeExpanded=new Map();
  function renderContexts() {
    renderContextTabs();
    const query=$('search').value.trim().toLowerCase(), records=contextRecords.filter(c=>c.type!=='authority').filter(c=>`${c.context_id} ${c.summary} ${c.detail||''} ${c.room} ${c.roomDescription||''} ${c.type} ${(c.tags||[]).join(' ')} ${c.project}`.toLowerCase().includes(query));
    const groups=new Map(); for(const record of records) { const key=`${record.workspace}:${record.room}`; if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(record); }
    const orderedRooms=[...contextRooms].sort((a,b)=>a.project.localeCompare(b.project)||a.worktree.localeCompare(b.worktree)||a.room.localeCompare(b.room));
    const matches=orderedRooms.filter(room=>!query||groups.has(room.key)||`${room.room} ${room.roomDescription||''} ${room.project}`.toLowerCase().includes(query)).map(room=>room.key);
    const fullHierarchy=VibeHubRooms.hierarchy(orderedRooms), tones=new Map(fullHierarchy.map(room=>[room.key,room.tone]));
    const rooms=VibeHubRooms.hierarchy(VibeHubRooms.matchingRooms(orderedRooms,matches)).map(room=>({...room,tone:tones.get(room.key)}));
    $('list-title').textContent='Context by Room'; $('count').textContent=`${rooms.length} ${rooms.length===1?'room':'rooms'} · ${records.length} records`;
    const toolbar=el('div',undefined,'rooms-toolbar');
    const controls=el('div',undefined,'room-controls');
    for(const [label,open] of [['Expand all',true],['Collapse all',false]]) {const button=el('button',label);button.type='button';button.disabled=!rooms.length;button.addEventListener('click',()=>{for(const room of rooms)roomExpanded.set(room.key,open);document.querySelectorAll('.room-group,.context-type-group').forEach(node=>{node.open=open;if(node.dataset.groupKey)contextTypeExpanded.set(node.dataset.groupKey,open);});});controls.append(button);}
    toolbar.append(el('p','Rooms branch from their parent. Select a record to read it.','rooms-hint'),controls); $('work').append(toolbar);

    if(contextLoading) $('work').append(el('p','Reading Rooms from connected worktrees…','context-notice'));
    if(contextErrors.length) { const details=el('details',undefined,'context-errors'); details.append(el('summary',`${contextErrors.length} worktrees could not be read`)); for(const error of contextErrors) details.append(el('p',error)); $('work').append(details); }
    if(!rooms.length && !contextLoading) $('work').append(el('p',query?'No Rooms or Context records match your search.':'No Rooms recorded in this workspace yet. Context saved through VibeHub will appear in its Room.','empty'));
    const list=el('div',undefined,'room-groups room-branches'), entries=[];
    list.style.setProperty('--room-depth',Math.max(0,...rooms.map(room=>room.depth)));
    for(const room of rooms) {
      const group=groups.get(room.key)||[], section=el('details',undefined,'room-group'); section.open=query?true:roomExpanded.get(room.key)!==false;
      const summary=el('summary',undefined,'room-heading');section.classList.add(`tone-${room.tone}`);
      const copy=el('span',undefined,'room-heading-copy');copy.append(el('strong',room.room.split('/').pop(),'room-name'),el('span',room.parent?`in ${room.parent}`:selected?'Root Room':`${room.project} · ${room.branch}`,'room-location'));
      const count=el('span',`${group.length} ${group.length===1?'record':'records'}`,'room-record-count'), chevron=el('span','⌄','room-chevron');chevron.setAttribute('aria-hidden','true');summary.append(copy,count,chevron);section.append(summary);
      section.addEventListener('toggle',()=>{if(!query&&section.isConnected)roomExpanded.set(room.key,section.open);});
      const body=el('div',undefined,'room-contents');
      if(room.roomDescription)body.append(el('p',room.roomDescription,'room-description'));
      if(room.parent)body.append(el('p',`Parent Room: ${room.parent}`,'room-parent'));
      for(const {type,records:typeRecords} of VibeHubRooms.groupByType(group)) {
        const kind=contextKind(type), typeKey=`${room.key}:${type}`;
        const typeGroup=el('details',undefined,`context-type-group kind-${type}`);
        typeGroup.dataset.groupKey=typeKey;typeGroup.open=query?true:contextTypeExpanded.get(typeKey)!==false;
        const typeHeading=el('summary',undefined,'context-type-heading');
        const label={decision:'Decisions',constraint:'Constraints',contract:'Contracts',intent:'Intents',convention:'Conventions',change:'Changes',note:'Notes'}[type]||kind.label;
        typeHeading.append(el('strong',label),el('span',String(typeRecords.length),'context-type-count'));
        const chevron=el('span','⌄','context-type-chevron');chevron.setAttribute('aria-hidden','true');typeHeading.append(chevron);
        typeGroup.append(typeHeading);
        typeGroup.addEventListener('toggle',()=>{if(!query&&typeGroup.isConnected)contextTypeExpanded.set(typeKey,typeGroup.open);});
        const rows=el('ul',undefined,'context-rows');rows.setAttribute('aria-label',`${room.room} ${label}`);
        for(const record of typeRecords) {
          const row=el('li'), button=el('button',undefined,`context-row kind-${record.type}`);button.type='button';
          button.append(el('strong',record.summary,'context-row-title'));
          const meta=el('span',undefined,'context-row-meta');
          if(record.state!=='active')meta.append(el('span',record.state,'context-state'));
          const used=record.consumingTickets||[];if(used.length)meta.append(el('span',plural(used.length,'ticket'),'context-row-used'));
          button.append(meta);const arrow=el('span','→','context-row-arrow');arrow.setAttribute('aria-hidden','true');button.append(arrow);
          button.addEventListener('click',()=>showContext(record,button));row.append(button);rows.append(row);
        }
        typeGroup.append(rows);body.append(typeGroup);
      }
      if(!group.length)body.append(el('p',query?'No matching records in this Room.':'No Context recorded in this Room yet.','room-empty'));
      const link=el('a','Open Room explorer ↗','room-explorer-link'), url=new URL('/',location.origin);url.searchParams.set('workspace',room.workspace);url.searchParams.set('surface','rooms');url.searchParams.set('room',room.room);url.hash=token;link.href=url.href;body.append(link);
      section.append(body); list.append(section);entries.push({room,section});
    }
    $('work').append(list);
    roomRailCleanup=VibeHubRooms.connect(list,entries);
  }
  function renderSummary() {
    const scoped=selectedGoal ? [items.find(t=>t.id===selectedGoal),...scopeItems()].filter(Boolean) : items, tickets=scoped.filter(t=>t.type!=='goal');
    $('activity-summary').replaceChildren();
    for (const [label,value] of [['Running',tickets.filter(t=>stageFor(t)==='running').length],['Needs you',tickets.filter(t=>stageFor(t)==='attention').length],['Open goals',scoped.filter(t=>t.type==='goal' && stageFor(t)!=='completed').length]]) {
      const stat=el('span'); stat.append(el('strong',value),document.createTextNode(` ${label}`)); $('activity-summary').append(stat);
    }
    $('activity-summary').append(el('span','Recorded status · refresh to update','snapshot-note'));
  }
  function showWarnings() {
    const warnings = [...data.warnings, ...data.personal.warnings, ...sourceWarnings];
    $('warnings').hidden = !warnings.length; $('source-alert').hidden=!warnings.length; $('source-alert').textContent=warnings.length; $('source-alert').title=`${warnings.length} source issues`; const list = $('warnings').querySelector('ul'); list.replaceChildren();
    for (const warning of warnings) list.append(el('li', `${warning.path}: ${warning.message}`));
  }
  function showPersonal() {
    generation++; $('work').removeAttribute('aria-busy'); selected = null; $('heading').textContent = 'All work'; $('breadcrumb').textContent = 'Personal workspace';
    $('request-scope').textContent = 'Copy into your agent to plan executable tickets and surface human decisions early.';
    $('list-title').textContent = 'Goals & tickets';
    items = personalItems();
    edges = items.flatMap((t) => t.relations.filter((r) => ['depends_on', 'task_of', 'sub_goal_of'].includes(r.type)).map((r) => ({ from: r.target, to: t.id, membership: r.type !== 'depends_on' })));
    const worktrees = data.projects.reduce((sum,p) => sum + p.worktrees.length, 0);
    const goals = items.filter((t) => t.type === 'goal').length;
    status(`${data.projects.length} projects · ${worktrees} worktrees · ${goals} goals · ${items.length} personal tickets`);
    const merged = mergeTicketSources(items, repositoryItems, repositoryEdges); items = merged.items; edges.push(...merged.edges);
    $('total').textContent = items.length;
    if (selectedGoal) { const goal=items.find(t=>t.id===selectedGoal && t.type==='goal'); if(goal) { $('heading').textContent=goal.title; $('breadcrumb').textContent='Goals / '+(goal.projects.join(' · ')||'Personal'); $('list-title').textContent='Goal work'; } }
    renderGoals(); renderSwitchers(); renderWork();
  }
  async function selectWorkspace(tree) {
    closeNavigation();
    const turn = ++generation; const keepContext=['contexts','authority'].includes(surface), previousSurface=surface; selectedGoal=null; surface=keepContext?previousSurface:'goals'; view='board'; selected = tree.id; resetFilters(); closeDetail(false);
    const url = new URL(location); url.searchParams.set('workspace', tree.id); url.searchParams.delete('goal'); url.searchParams.set('surface',surface); url.searchParams.set('view',view); contextGeneration++; history.replaceState(null, '', url);
    $('heading').textContent = tree.branch; $('breadcrumb').textContent = tree.path;
    $('request-scope').textContent = 'The brief includes this worktree. Copy it into your agent to plan.';
    $('list-title').textContent = 'Goal graph'; items = personalForProject(projectForTree()); edges = items.flatMap(t=>(t.relations||[]).filter(r=>['depends_on','task_of','sub_goal_of'].includes(r.type)).map(r=>({from:r.target,to:t.id,membership:r.type!=='depends_on'}))); $('work').replaceChildren();
    renderNav(); status('Reading this checkout…'); $('work').setAttribute('aria-busy', 'true'); $('count').textContent = 'Reading…';
    try {
      if (!tree.hasTickets) {
        status(`${projectForTree().name} · Personal VibeHub goals and tickets`);
        renderWork(); return;
      }
      const state = await api(`/api/state?workspace=${encodeURIComponent(tree.id)}`);
      if (turn !== generation) return;
      const nativeItems = state.graph.tickets.map((t) => ({ id: t.ticketId, title: t.ticketId.replace(/^ticket-/, '').replaceAll('-', ' '), outcome: t.outcome,
        type: 'ticket', state: t.capabilities.operational.summary.label,
        nextAction: t.capabilities.nextAction.summary, projects: [state.project.name], relations: [],
        path: `${tree.path}/.vibehub/tickets/${t.ticketId}.yaml`, ticket: true }));
      const merged = mergeTicketSources(items, nativeItems, state.graph.relations.map((r) => ({ from: r.prerequisiteTicketId, to: r.dependentTicketId })));
      items = merged.items; edges.push(...merged.edges);
      status(`${state.project.name} · ${tree.branch} · ${items.length} tickets in the current graph`);
      renderWork();
    } catch (error) {
      if (turn !== generation) return;
      status('This checkout needs attention. Other projects remain available.');
      renderWork('Could not read this ticket graph', error.message);
    } finally { if (turn === generation) { $('work').removeAttribute('aria-busy'); if(keepContext) loadContexts(); } }
  }
  function goalTickets(goal) { const ids=goalScope(goal.id,items); return items.filter(t=>t.type!=='goal' && ids.has(t.id)); }
  function matches(item) {
    const query=$('search').value.toLowerCase(), workflow=item.type==='goal'?goalStatus(item):workflowFor(item,items,edges);
    const laneMatch=filter==='all' || workflow.lane===filter || (item.type==='goal' && executionSummary(goalTickets(item),items,edges)[filter]?.length);
    return laneMatch && `${item.id} ${item.title} ${item.projects.join(' ')}`.toLowerCase().includes(query);
  }
  function setWorkFilter(next) { filter=filter===next?'all':next; $('status-filter').value=filter; renderWork(); }
  function continuationBrief(goal) {
    const children=goalTickets(goal), groups=executionSummary(children,items,edges);
    const section=(name,rows)=>`${name}:\n${rows.map(r=>`- ${r.item.originalId||r.item.id}: ${r.item.title} (${r.label})\n  Source: ${r.item.path}`).join('\n')||'- None recorded'}`;
    return `Continue this VibeHub goal: ${goal.title}\n${goal.outcome||''}\nGoal source: ${goal.path}\n${selectedTree()?`Working directory: ${selectedTree().path}\n`:''}
Keep planning records local. Do not push, open PRs, mirror Issues, or share records unless I explicitly request it. Publishing code does not authorize publishing these records. Read the current records before acting. Break remaining work into executable tickets with clear acceptance and direct dependencies. Surface actionable human decisions early, prepare the information needed to decide, and keep independent agent work moving. Refine uncertain downstream work when its prerequisites resolve. Execute eligible tickets, record evidence, and use independent closeout. Stop only the affected work at human boundaries; never infer approval. Report progress and blockers without constraining the model's response.\n\n${section('Needs human input',groups.attention)}\n\n${section('Already working — inspect before starting duplicate work',groups.running)}\n\n${section('Agent-ready work',groups.ready)}\n\n${section('Needs planning',groups.planned)}\n\n${section('Waiting',groups.waiting)}`;
  }
  function renderGoalProgress() {
    const bar=$('goal-progress'), goal=items.find(t=>t.id===selectedGoal);
    bar.replaceChildren(); bar.hidden=!goal || ['contexts','authority'].includes(surface); if(bar.hidden) return;
    const children=goalTickets(goal), groups=executionSummary(children,items,edges);
    const progress=el('div',undefined,'execution-progress');
    progress.append(el('strong',`${groups.completed.length}/${children.length}`),el('span','tickets complete'));
    progress.append(segmentedProgress(groups.completed.length,children.length,'Overall goal progress')); bar.append(progress);
    const stages=el('div',undefined,'execution-stages');
    for(const [key,label] of [['attention','Needs you'],['running','Working'],['ready','Agent ready'],['waiting','Waiting'],['planned','To plan']]) {
      if(!groups[key].length) continue;
      const button=el('button',`${groups[key].length} ${label}`,`execution-stat stage-${key}`); button.type='button'; button.setAttribute('aria-pressed',String(filter===key)); button.addEventListener('click',()=>setWorkFilter(key)); stages.append(button);
    }
    bar.append(stages);
    const copy=el('button',children.length?'Copy next steps':'Copy planning brief','continue-goal'); copy.type='button'; copy.title='Copy instructions into your coding agent'; copy.addEventListener('click',()=>copyText(continuationBrief(goal))); bar.append(copy);
  }
  function renderWork(emptyTitle, emptyText) {
    if (!data) return;
    roomRailCleanup?.();roomRailCleanup=null;
    canvasObserver?.disconnect(); canvasObserver=null; $('work').replaceChildren(); $('work').classList.remove('with-queue'); renderGoals(); renderHierarchy(); renderSummary(); renderGoalProgress(); if(surface==='authority') {renderAuthorities();return;} if(surface==='contexts') { renderContexts(); return; } const visible = scopeItems().filter(matches);
    $('legend').hidden = view !== 'canvas';
    document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
    $('count').textContent = `${visible.length} ${surface==='goals'?(visible.length===1?'goal':'goals'):(visible.length===1?'ticket':'tickets')}`;
    document.title=`VibeHub · ${$('heading').textContent}`;
    if (!visible.length) {
      const box = el('div', undefined, 'empty');
      box.append(el('strong', emptyTitle || (items.length ? (surface==='goals' && !$('search').value ? 'No goals recorded for this project' : 'No matching work') : 'No connected work yet')),
        el('span', emptyText || (items.length ? (surface==='goals' && !$('search').value ? 'Goals use explicit project references. Existing tickets without a goal are available in Unassigned tickets.' : 'Try another filter or search.') : data.personal.connected ? 'Projects appear here after connecting them to VibeHub. You can still start a freeform request above.' : 'Connect a project to VibeHub to see its work here. A connected personal store can also supply goals and tickets.')));
      $('work').append(box); return;
    }
    if (view === 'board') { if(surface==='goals')renderGoalOverview(visible);else renderBoard(visible); return; }
    const availableWidth=$('work').clientWidth;
    const layout = VibeHubDashboardGraph.layoutGraph(visible, edges, { maxWidth: Math.max(416, availableWidth) });
    if (layout.cyclic.length) $('work').append(el('p', 'This graph contains a dependency cycle. Review the source relations.', 'cycle'));
    const frame = el('div', undefined, 'canvas-frame');
    const controls = el('div', undefined, 'canvas-controls');
    const hint = el('span', 'Drag to pan · Ctrl/⌘ + scroll to zoom', 'canvas-hint'), zoomLabel = el('span', '100%', 'zoom-label');
    const viewport = el('div', undefined, 'canvas-viewport'); viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Ticket canvas. Scroll to explore, or use the zoom controls.');
    const extent = el('div', undefined, 'canvas-extent'), canvas = el('div', undefined, 'card-canvas');
    canvas.style.width = `${layout.width}px`; canvas.style.height = `${layout.height}px`;
    const graph = svg('svg', { width: layout.width, height: layout.height, 'aria-hidden': 'true' });
    const branchColors = ['var(--flow-blue)','var(--flow-green)','var(--flow-yellow)','var(--purple)'];
    const edgeElements=[];
    for (const edge of layout.connections) {
      const color = branchColors[edge.color];
      const path=svg('path', { d: edge.d, fill: 'none', stroke: color,
        'stroke-width': edge.membership ? 2 : 3.5, 'stroke-linecap':'round', 'stroke-linejoin':'round',
        'stroke-dasharray': edge.membership ? '4 7' : 'none' }); graph.append(path); edgeElements.push({edge,path});
      if (!edge.membership) {
        const point=svg('circle', { cx:edge.waypoint.x, cy:edge.waypoint.y, r:7, fill:'var(--bg)', stroke:color, 'stroke-width':2 });
        graph.append(point); edgeElements.push({edge,path:point});
      }
    }
    canvas.append(graph);
    const visibleIds = new Set(visible.map(t => t.id)), nodes = new Map(layout.nodes.map(n => [n.id,n]));
    const cardButtons=new Map();
    function highlight(id) {
      canvas.classList.toggle('has-focus',!!id); const related=new Set([id]);
      for(const {edge,path} of edgeElements) { const match=edge.from===id || edge.to===id; path.classList.toggle('is-related',match); if(match) { related.add(edge.from); related.add(edge.to); } }
      for(const [key,button] of cardButtons) button.classList.toggle('is-related',related.has(key));
    }
    layout.items.forEach(item => {
      const node = nodes.get(item.id), workflow=workflowFor(item,items,edges), done = workflow.lane==='completed';
      const button = el('button', undefined, `work-card ${done ? 'is-done' : item.state === 'READY' ? 'is-ready' : ''} ${item.type === 'goal' ? 'is-goal' : ''}`);
      button.type = 'button'; button.setAttribute('aria-pressed', 'false'); button.dataset.lane=workflow.lane;
      button.style.setProperty('--branch-color', branchColors[node.color]);
      button.style.left = `${node.x}px`; button.style.top = `${node.y}px`;
      const hidden = edges.filter(e => (e.to === item.id && !visibleIds.has(e.from)) || (e.from === item.id && !visibleIds.has(e.to))).length;
      const top = el('span', undefined, 'card-top');
      top.append(el('span', item.originalId || item.id, 'card-id'), el('span', item.type === 'goal' ? '◇ GOAL' : 'TICKET', 'card-kind'));
      const title = el('span', item.title, 'card-title');
      button.title = `${item.title}\n${item.originalId || item.id}\n${item.projects.join(' · ')}${hidden ? `\n${hidden} links outside this view` : ''}`;
      const footer = el('span', undefined, 'card-footer');
      footer.append(el('span', item.type==='goal' ? `${items.filter(t=>t.type!=='goal' && goalScope(item.id,items).has(t.id)).length} tickets · Open graph →` : `${node.incoming} in · ${node.outgoing} out${hidden ? ` · +${hidden} hidden` : ''}`, 'card-count'),
        el('span', `${done ? '●' : '○'} ${item.type==='goal'?item.state:workflow.label}`, 'state'));
      button.append(top, title, el('span', item.projects.join(' · ') || 'Personal', 'card-project'));

      if(item.type==='goal') {
        const children=items.filter(t=>t.type!=='goal' && goalScope(item.id,items).has(t.id)), completed=children.filter(t=>stageFor(t)==='completed').length;
        button.append(segmentedProgress(completed,children.length,`${item.title} progress`));
        const groups=executionSummary(children,items,edges), signal=groups.attention.length?`${groups.attention.length} need your input`:groups.running.length?`${groups.running.length} agent working`:groups.ready.length?`${groups.ready.length} ready for agent`:children.length?`${completed} of ${children.length} complete`:'Ready to break down';
        button.querySelector('.card-project').textContent=`${item.projects.join(' · ')||'Personal'} · ${signal}`;
        button.querySelector('.card-project').classList.toggle('needs-input',!!groups.attention.length);
      }
      button.append(footer);
      if (layout.connections.some(e => e.to === item.id)) button.append(el('span', undefined, 'port port-in'));
      if (layout.connections.some(e => e.from === item.id)) button.append(el('span', undefined, 'port port-out'));
      cardButtons.set(item.id,button); button.addEventListener('pointerenter',()=>highlight(item.id)); button.addEventListener('focus',()=>highlight(item.id)); button.addEventListener('pointerleave',()=>{ if(document.activeElement!==button) highlight(null); }); button.addEventListener('blur',()=>highlight(null));
      button.addEventListener('click', () => item.type==='goal' ? selectGoal(item.id) : showDetail(item, button)); canvas.append(button);
    });
    let scale = 1, offsetX=0, offsetY=0;
    function zoom(next, anchorX=viewport.clientWidth/2, anchorY=viewport.clientHeight/2) {
      const graphX=(viewport.scrollLeft+anchorX-offsetX)/scale, graphY=(viewport.scrollTop+anchorY-offsetY)/scale;
      scale=Math.max(.05,Math.min(1.75,next));
      offsetX=Math.max(0,(viewport.clientWidth-layout.width*scale)/2); offsetY=Math.max(0,(viewport.clientHeight-layout.height*scale)/2);
      canvas.style.transform=`translate(${offsetX}px,${offsetY}px) scale(${scale})`;
      extent.style.width=`${Math.max(viewport.clientWidth,layout.width*scale)}px`; extent.style.height=`${Math.max(viewport.clientHeight,layout.height*scale)}px`;
      viewport.scrollLeft=graphX*scale+offsetX-anchorX; viewport.scrollTop=graphY*scale+offsetY-anchorY; zoomLabel.textContent=`${Math.round(scale*100)}%`;
    }
    function fit() { zoom(Math.min(1,(viewport.clientWidth-48)/layout.width,(viewport.clientHeight-80)/layout.height)); viewport.scrollTo(0,0); }
    for(const [text,label,action] of [['−','Zoom out',()=>zoom(scale/1.2)],['+','Zoom in',()=>zoom(scale*1.2)],['Fit','Fit graph',fit],['1:1','Actual size',()=>zoom(1)]]) {
      const button=el('button',text); button.type='button'; button.setAttribute('aria-label',label); button.addEventListener('click',action); controls.append(button);
    }
    controls.append(zoomLabel);
    viewport.addEventListener('wheel',event=>{
      if(!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); const rect=viewport.getBoundingClientRect(); zoom(scale*Math.exp(-event.deltaY*.008),event.clientX-rect.left,event.clientY-rect.top);
    },{passive:false});
    viewport.addEventListener('keydown',event=>{
      if(event.key==='f' || event.key==='F') { event.preventDefault(); fit(); }
      if(event.key==='+' || event.key==='=') { event.preventDefault(); zoom(scale*1.2); }
      if(event.key==='-') { event.preventDefault(); zoom(scale/1.2); }
      if(event.key==='0') { event.preventDefault(); zoom(1); }
    });
    let drag = null;
    viewport.addEventListener('pointerdown', event => {
      if (event.target.closest('button') || event.pointerType !== 'mouse' || event.button !== 0) return;
      drag = { x:event.clientX, y:event.clientY, left:viewport.scrollLeft, top:viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
    });
    viewport.addEventListener('pointermove', event => { if (drag) { viewport.scrollLeft = drag.left+drag.x-event.clientX; viewport.scrollTop = drag.top+drag.y-event.clientY; } });
    const endDrag = () => { drag = null; viewport.classList.remove('dragging'); };
    viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('lostpointercapture', endDrag);
    extent.append(canvas); viewport.append(extent); frame.append(viewport, controls, hint); $('work').prepend(frame); zoom(1);
    const entry = [...layout.nodes].sort((a,b) => a.y-b.y || a.x-b.x)[0];
    viewport.scrollTop = Math.max(0, entry.y-48);
    viewport.scrollLeft = Math.max(0, entry.x-48);
    const initialFit=Math.min(1,(viewport.clientWidth-48)/layout.width,(viewport.clientHeight-80)/layout.height);
    if(initialFit>=.8) fit();
    else {
      zoom(Math.min(1,(viewport.clientWidth-24)/(entry.width+96)));
      viewport.scrollTo(Math.max(0,(entry.x-48)*scale),Math.max(0,(entry.y-48)*scale));
    }
    const observer=canvasObserver=new ResizeObserver(()=>{ if(frame.isConnected) zoom(scale); else observer.disconnect(); }); observer.observe(viewport);
  }

  function renderGoalOverview(visible) {
    const grid=el('div',undefined,'goal-overview');grid.setAttribute('role','region');grid.setAttribute('aria-label','Project goals');
    const priority=['attention','running','ready','planned','waiting','completed'];
    for(const goal of [...visible].sort((a,b)=>priority.indexOf(goalStatus(a).lane)-priority.indexOf(goalStatus(b).lane)||a.title.localeCompare(b.title))) {
      const children=goalTickets(goal), groups=executionSummary(children,items,edges), workflow=goalStatus(goal);
      const card=el('button',undefined,`goal-overview-card stage-${workflow.lane}`);card.type='button';
      const top=el('span',undefined,'goal-overview-meta');top.append(el('span','GOAL','card-id'),el('span',workflow.label,'goal-overview-status'));
      const title=el('span',undefined,'goal-overview-title');title.append(el('strong',goal.title),el('span','↗'));
      card.append(top,title);
      if(goal.outcome&&goal.outcome!==goal.title)card.append(el('span',goal.outcome,'goal-overview-outcome'));
      card.append(el('span',`${groups.completed.length} of ${children.length} tickets complete`,'goal-card-count'),segmentedProgress(groups.completed.length,children.length,`${goal.title} progress`));
      const footer=el('span',undefined,'goal-overview-footer');footer.append(el('span',groups.attention.length?`${groups.attention.length} need you`:groups.running.length?`${groups.running.length} agent working`:workflow.label,groups.attention.length?'goal-attention':''),el('span',`View ${children.length} tickets →`));card.append(footer);
      card.addEventListener('click',()=>selectGoal(goal.id));grid.append(card);
    }
    $('work').append(grid);
  }
  function renderBoard(visible) {
    const board=el('div',undefined,'work-board'); board.tabIndex=0;board.setAttribute('role','region');board.setAttribute('aria-label',`${surface==='goals'?'Goal':'Ticket'} board; scroll horizontally for all six lanes`);
    for (const [key,title,description] of [['attention','Needs you','Actionable human decisions'],['running','Agent working','Recorded active work'],['ready','Agent ready','Executable work and closeout'],['planned','Needs planning','Refine acceptance or replan'],['waiting','Waiting','Unresolved prerequisites'],['completed','Completed','Recorded completions']]) {
      const column=el('section',undefined,`board-column stage-${key}`), group=visible.filter(t=>(t.type==='goal'?goalStatus(t):workflowFor(t,items,edges)).lane===key);
      const heading=el('h3'); heading.append(el('span',title),el('span',group.length,'column-count')); column.append(heading,el('p',description,'column-description'));
      for(const item of group) {
        const button=el('button',undefined,`board-card ${item.type==='goal'?'goal-board-card':'ticket-board-card'}`); button.type='button'; button.setAttribute('aria-pressed','false');
        const top=el('span',undefined,'card-top'); top.append(el('span',item.originalId||item.id,'card-id'),el('span',item.type==='goal'?'◇ GOAL':'TICKET','card-kind'));
        button.append(top,el('span',item.title,'board-title'));
        if(item.type==='goal') {
          const children=goalTickets(item), groups=executionSummary(children,items,edges);
          button.append(el('span',`${groups.completed.length} of ${children.length} tickets complete`,'goal-card-count'),segmentedProgress(groups.completed.length,children.length,`${item.title} progress`));
          button.append(el('span',groups.attention.length?`${groups.attention.length} need you · Open goal →`:'Open goal →','goal-card-action'));
        } else {
          const workflow=workflowFor(item,items,edges);
          if(item.outcome && item.outcome!==item.title) button.append(el('span',item.outcome,'ticket-summary'));
          button.append(el('span',workflow.lane==='attention'?'Needs you →':workflow.label,'board-state'),el('span',workflow.lane==='attention'?'Review decision':'View task →','ticket-action'));
        }
        button.append(el('span',item.projects.join(' · ')||'Personal','card-project'));
        button.addEventListener('click',()=>item.type==='goal' ? selectGoal(item.id) : showDetail(item,button)); column.append(button);
      }
      if(!group.length) column.append(el('p',key==='attention'?'No decisions waiting on you.':key==='running'?'No recorded agent activity.':key==='completed'?'Completed tickets will appear here.':'No tickets here.','lane-empty'));
      board.append(column);
    }
    $('work').append(board);
  }
  async function copyText(text) {
    const trigger=document.activeElement;
    try { await navigator.clipboard.writeText(text); status('Copied. Paste into your coding agent.');
      if(trigger?.tagName==='BUTTON') { const label=trigger.textContent; trigger.textContent='Copied'; setTimeout(()=>{trigger.textContent=label;},1800); }
    }
    catch { document.querySelector('.start').open = true; $('request').value = text; $('request').focus(); $('request').select(); status('Clipboard unavailable. The text is selected; copy it manually.'); }
  }
  let ticketDetailCleanup=null;
  function showDetail(item, trigger) {
    const focusOrigin=trigger.closest('#inspector')?lastFocused:trigger;
    closeDetail(false);
    document.querySelectorAll('.work-card[aria-pressed=true],.board-card[aria-pressed=true]').forEach(card => card.setAttribute('aria-pressed', 'false'));
    trigger.setAttribute('aria-pressed', 'true');lastFocused=focusOrigin;
    const workflow=workflowFor(item,items,edges), workspace=item.workspace||selected;
    $('inspector').classList.add('ticket-dialog');
    $('detail-kind').textContent=`Ticket · ${workflow.label}`;
    $('detail-title').textContent=item.title;$('detail-outcome').hidden=true;
    $('detail-meta').replaceChildren();$('detail-actions').replaceChildren();
    const content=el('div',undefined,'ticket-content');$('detail-meta').before(content);
    const related=(ids)=>ids.map(id=>items.find(item=>item.id===id)||{id,title:id,type:'missing'});
    ticketDetailCleanup=VibeHubTicket.mount({container:content,item,workflow,
      dependencies:related(edges.filter(e=>!e.membership&&e.to===item.id).map(e=>e.from)),
      dependents:related(edges.filter(e=>!e.membership&&e.from===item.id).map(e=>e.to)),
      goals:related(item.relations.filter(r=>['task_of','sub_goal_of'].includes(r.type)).map(r=>r.target)),
      navigate:(target,button)=>{if(target.type==='missing')return;if(target.type==='goal'){closeDetail();selectGoal(target.id);}else showDetail(target,button);},
      copy:copyText,contractUrl:item.ticket?inspectorLink(item.originalId||item.id,workspace):null,
      loadDetails:async()=>{
        const query=new URLSearchParams({workspace}), state=await api(`/api/state?${query}`);
        query.set('snapshotId',state.graph.snapshotId);query.set('kind','ticket');query.set('ticketId',item.originalId||item.id);
        const result=await api(`/api/subject?${query}`);return result.subject.contextPackage;
      },
    });
    if(!$('inspector').open)$('inspector').showModal();$('inspector').scrollTop=0;$('close-detail').focus();
  }
  function closeDetail(restore = true) {
    ticketDetailCleanup?.();ticketDetailCleanup=null;document.querySelector('.ticket-content')?.remove();
    document.querySelector('.detail-view-tabs')?.remove();document.querySelector('.ticket-next-step')?.remove();
    $('inspector').classList.remove('reference-dialog','ticket-dialog');if($('inspector').open)$('inspector').close();
    lastFocused?.setAttribute('aria-pressed','false');if(restore&&lastFocused?.isConnected)lastFocused.focus();
  }
  async function loadRepositoryTickets() {
    const turn = generation;
    repositoryItems = []; repositoryEdges = []; sourceWarnings = [];
    const trees = data.projects.flatMap((project) => project.worktrees.filter((t) => t.hasTickets && t.available).map((tree) => ({ ...tree, projectName: project.name })));
    for (const tree of trees) {
      if (turn !== generation) return;
      try {
        const graph = await api(`/api/tickets?workspace=${encodeURIComponent(tree.id)}`);
        if (turn !== generation) return;
        const key = (id) => `${tree.id}:${id}`;
        repositoryItems.push(...graph.tickets.map((t) => ({ id: key(t.ticketId), originalId: t.ticketId, workspace: tree.id,
          title: t.ticketId.replace(/^ticket-/, '').replaceAll('-', ' '), outcome: t.outcome, type: 'ticket',
          state: t.capabilities.operational.summary.label, nextAction: t.capabilities.nextAction.summary,
          projects: [tree.projectName, tree.branch], relations: [], ticket: true,
          path: `${tree.path}/.vibehub/tickets/${t.ticketId}.yaml` })));
        repositoryEdges.push(...graph.relations.map((r) => ({ from: key(r.prerequisiteTicketId), to: key(r.dependentTicketId) })));
      } catch (error) { sourceWarnings.push({ path: tree.path, message: error.message }); }
    }
    if (turn !== generation) return;
    showPersonal(); showWarnings();
    status(`${data.projects.length} projects · ${data.projects.reduce((n,p) => n+p.worktrees.length,0)} worktrees · ${items.filter(t=>t.type==='goal').length} goals · ${items.length} tickets${sourceWarnings.length ? ` · ${sourceWarnings.length} checkout errors` : ''}`);
  }
  async function refresh() {
    if($('refresh').disabled) return;
    const restore={goal:selectedGoal,surface,view,filter,search:$('search').value};
    $('refresh').disabled=true; $('refresh-dashboard').disabled=true; status('Refreshing projects and worktrees…');
    try {
      data=await api('/api/dashboard'); showWarnings(); renderNav(); const tree=selectedTree();
      if(tree) { await selectWorkspace(tree); if(selected!==tree.id) return; if(restore.goal) { await selectGoal(restore.goal); if(selectedGoal!==restore.goal) return; } }
      else { showPersonal(); await loadRepositoryTickets(); if(selected) return; }
      surface=restore.surface; view=restore.view; filter=restore.filter; $('status-filter').value=filter; $('search').value=restore.search;
      const url=new URL(location); url.searchParams.set('surface',surface); url.searchParams.set('view',view); history.replaceState(null,'',url);
      lastUpdated=new Date(); renderWork(); if(['contexts','authority'].includes(surface)) await loadContexts();
    } catch(error) { status(error.message); }
    finally { $('refresh').disabled=false; $('refresh-dashboard').disabled=false; }
  }
  function closeNavigation(){closeProjectPicker();if(!$('navigation-dialog').open)return;document.querySelector('.shell').prepend(document.querySelector('.sidebar'));$('navigation-dialog').close();$('navigation-toggle').focus();}
  $('project-trigger').addEventListener('click',()=>{$('project-popover').matches(':popover-open')?closeProjectPicker(true):openProjectPicker();});
  $('project-trigger').addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();openProjectPicker();if(event.key==='ArrowUp')setActiveProject(projectChoices.length-1);}});
  $('project-query').addEventListener('input',renderProjectOptions);
  $('project-query').addEventListener('keydown',event=>{
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(projectChoices.length)setActiveProject((activeProjectChoice+(event.key==='ArrowDown'?1:-1)+projectChoices.length)%projectChoices.length);}
    if(event.key==='Enter'){event.preventDefault();chooseProject(activeProjectChoice);}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeProjectPicker(true);}
    if(event.key==='Tab'){closeProjectPicker(true);}
  });
  $('project-popover').addEventListener('toggle',()=>{const open=$('project-popover').matches(':popover-open');$('project-trigger').setAttribute('aria-expanded',String(open));$('project-query').setAttribute('aria-expanded',String(open));});
  window.addEventListener('resize',()=>{if($('project-popover').matches(':popover-open'))positionProjectPicker();});
  document.querySelector('.sidebar-scroll').addEventListener('scroll',()=>{if($('project-popover').matches(':popover-open'))positionProjectPicker();});
  $('navigation-toggle').addEventListener('click',()=>{$('navigation-dialog').append(document.querySelector('.sidebar'));$('navigation-dialog').showModal();$('close-navigation').focus();});
  $('close-navigation').addEventListener('click',closeNavigation);
  $('navigation-dialog').addEventListener('cancel',event=>{event.preventDefault();closeNavigation();});
  matchMedia('(min-width: 769px)').addEventListener('change',event=>{if(event.matches)closeNavigation();});
  document.querySelector('.skip').addEventListener('click', (event) => { event.preventDefault(); $('main').tabIndex = -1; $('main').focus(); });
  $('refresh-dashboard').addEventListener('click',refresh);
  $('home').addEventListener('click', () => { closeNavigation(); closeDetail(false); changeSurface('goals'); });
  function changeSurface(next) {
    closeNavigation();
    if(selectedGoal && next==='tickets') { surface='tickets'; closeDetail(false); renderWork(); return; }
    contextGeneration++; surface=next; selectedGoal=null; view='board'; closeDetail(false); resetFilters();
    const url=new URL(location); url.searchParams.delete('goal'); url.searchParams.set('surface',next); url.searchParams.set('view','board'); history.replaceState(null,'',url);
    $('heading').textContent=projectForTree()?.name||'All work'; $('breadcrumb').textContent=selectedTree()?.path||'Connected workspace';
    renderNav(); renderWork(); if(['contexts','authority'].includes(next)) loadContexts();
  }
  document.querySelectorAll('[data-surface]').forEach(b=>b.addEventListener('click',()=>changeSurface(b.dataset.surface)));
  $('back-goals').addEventListener('click',()=>changeSurface('goals'));
  $('status-filter').addEventListener('change',()=>{ filter=$('status-filter').value; renderWork(); });
  $('focus-mode').addEventListener('click',()=>{ const active=document.querySelector('.shell').classList.toggle('focus-mode'); $('focus-mode').setAttribute('aria-pressed',String(active)); $('focus-mode').textContent=active?'Restore':'Expand'; });
  document.addEventListener('click',event=>{ for(const menu of document.querySelectorAll('#workspace-menu,.start')) if(!menu.contains(event.target)) menu.open=false; });
  $('project-search').addEventListener('input',renderNav);
  $('project-select').addEventListener('change',()=>{ const project=data.projects.find(p=>p.id===$('project-select').value); if(!project) return navigateHome(); const tree=project.worktrees.find(t=>t.available && t.branch==='main')||project.worktrees.find(t=>t.available)||project.worktrees[0]; if(tree) selectWorkspace(tree); });
  $('branch-select').addEventListener('change',()=>{ const project=data.projects.find(p=>p.id===$('project-select').value); const tree=project?.worktrees.find(t=>t.branch===$('branch-select').value && t.available)||project?.worktrees.find(t=>t.branch===$('branch-select').value); if(tree) selectWorkspace(tree); });
  $('worktree-select').addEventListener('change',()=>{ const tree=data.projects.flatMap(p=>p.worktrees).find(t=>t.id===$('worktree-select').value); if(tree) selectWorkspace(tree); });
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{ view=button.dataset.view; const url=new URL(location); url.searchParams.set('view',view); history.replaceState(null,'',url); closeDetail(false); renderWork(); }));
  const systemTheme=matchMedia('(prefers-color-scheme: dark)');
  const updateTheme=()=>{ $('theme-status').textContent=`System · ${systemTheme.matches?'Dark':'Light'}`; }; systemTheme.addEventListener('change',updateTheme); updateTheme();
  $('refresh').addEventListener('click', refresh); $('search').addEventListener('input', () => renderWork());
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === button))); renderWork(); }));
  $('copy-request').addEventListener('click', () => {
    const request=$('request').value.trim(); if(!request) { $('request').focus(); return; }
    const tree=selectedTree();
    copyText(`Plan this goal with VibeHub: ${request}\n${tree?`Working directory: ${tree.path}\n`:''}\nKeep this goal, its tickets, and Context local by default; do not push, create GitHub Issues, or share planning records without explicit permission. Never force-add ignored records. Keep the goal distinct from its executable tickets. Give each ticket a clear outcome, acceptance, and direct dependencies. Identify human decisions early, prepare actionable options, and place gating decisions ahead of dependent implementation. Leave uncertain downstream acceptance as draft until the decision is made. Keep independent agent work executable. Show me the plan and the human decisions, then continue eligible work without inferring approvals. Keep recorded status and evidence current so I can monitor progress. VibeHub remains optional and must not restrict model responses.`);
  });
  $('close-detail').addEventListener('click', () => closeDetail()); document.addEventListener('keydown', (e) => { if (e.key === 'Escape') {
    for(const menu of document.querySelectorAll('.header-actions details[open]')) { menu.open=false; menu.querySelector('summary').focus(); }
  } });
  $('inspector').addEventListener('cancel',event=>{ event.preventDefault(); closeDetail(); });
  $('inspector').addEventListener('keydown',event=>{
    if(event.key!=='Tab') return;
    const controls=[...$('inspector').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);
    const first=controls[0], last=controls.at(-1);
    if(event.shiftKey && document.activeElement===first) { event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
  });
  const outsideDetail=event=>{ const rect=$('inspector').getBoundingClientRect(); return event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom; };
  let backdropPressed=false;
  $('inspector').addEventListener('pointerdown',event=>{ backdropPressed=event.target===$('inspector') && outsideDetail(event); });
  $('inspector').addEventListener('click',event=>{ if(backdropPressed && event.target===$('inspector') && outsideDetail(event)) closeDetail(); backdropPressed=false; });
  // Renew only after real interaction in a visible tab, never on a timer.
  let lastSessionActivity=0, sessionRenewing=false;
  const sessionNotice=el('p',undefined,'session-notice');sessionNotice.hidden=true;
  sessionNotice.setAttribute('role','status');document.querySelector('.workspace-header').after(sessionNotice);
  async function renewActiveSession(event) {
    if(document.visibilityState!=='visible'||(event&&!event.isTrusted)||sessionRenewing||Date.now()-lastSessionActivity<60_000)return;
    lastSessionActivity=Date.now();sessionRenewing=true;
    try {await api('/api/session-active');sessionNotice.hidden=true;}
    catch {sessionNotice.textContent='The local session is unavailable. Reopen the dashboard through VibeHub to reconnect. Your saved work is unchanged.';sessionNotice.hidden=false;}
    finally {sessionRenewing=false;}
  }
  for(const name of ['pointerdown','pointermove','keydown','wheel','touchstart'])document.addEventListener(name,renewActiveSession,{passive:true});
  document.addEventListener('visibilitychange',event=>{if(document.visibilityState==='visible')renewActiveSession(event);});
  renewActiveSession();
  selected = new URLSearchParams(location.search).get('workspace'); refresh();
})();
