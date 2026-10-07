(() => {
  'use strict';
  const $ = (id) => document.getElementById(id),
    NS = 'http://www.w3.org/2000/svg';
  const token = location.hash.slice(1);
  const {
    stageFor,
    goalScope,
    workflowFor,
    executionSummary,
    mergeTicketSources,
    fromRepositoryGraph,
    personalWork,
    workModel,
    visibleWork,
  } = VibeHubDashboardGraph;
  const params = new URLSearchParams(location.search);
  const ui = {
    selected: params.get('workspace'),
    selectedGoal: params.get('goal'),
    surface: params.get('surface') || (params.get('goal') ? 'tickets' : 'goals'),
    view: params.get('view') === 'canvas' ? 'canvas' : 'board',
    scope: params.get('scope') === 'unassigned' ? 'unassigned' : 'all',
    lanes: new Set((params.get('filters') || '').split(',').filter(Boolean)),
    direction: params.get('direction') === 'ttb' ? 'ttb' : 'ltr',
    history: params.get('history') === 'all' ? 'all' : 'active',
    ticket: null,
    context: null,
    camera: null,
    theme: 'system',
    railWidth: 268,
    inspectorWidth: 400,
  };
  let canvasObserver = null,
    currentSource = null;
  let contextRecords = [],
    contextRooms = [],
    contextErrors = [],
    contextLoading = false,
    contextGeneration = 0;
  const roomExpanded = new Map(),
    pathExpanded = new Map();
  let projectChoices = [],
    activeProjectChoice = -1;
  let data = null,
    items = [],
    edges = [],
    generation = 0,
    navigationRevision = 0,
    lastFocused = null,
    repositoryItems = [],
    repositoryEdges = [],
    sourceWarnings = [];
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const svg = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const status = (text) => {
    $('status').textContent = text;
  };
  document.querySelector('.brand').href = `/dashboard#${token}`;
  document.querySelector('.skip').href = location.href;
  async function api(path) {
    if (!token) throw new Error('Open the complete dashboard link printed by the launcher.');
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error?.message || 'Could not read this source.');
    return result.data;
  }
  function selectedTree() {
    return data?.projects.flatMap((p) => p.worktrees).find((t) => t.id === ui.selected);
  }
  function inspectorLink(ticketId, workspaceId = ui.selected) {
    const url = new URL('/', location.origin);
    url.searchParams.set('workspace', workspaceId);
    if (ticketId) url.searchParams.set('ticket', ticketId);
    url.hash = token;
    return url.href;
  }
  function navigateHome() {
    if (!data) return;
    navigationRevision++;
    closeNavigation();
    contextGeneration++;
    currentSource = null;
    ui.selected = null;
    ui.selectedGoal = null;
    ui.surface = 'goals';
    ui.view = 'board';
    resetFilters();
    syncUrl();
    showPersonal();
    renderNav();
    loadRepositoryTickets();
  }
  function renderNav() {
    if (!data) return;
    renderGoals();
    renderSwitchers();
    $('home').setAttribute('aria-current', String(!ui.selectedGoal && ui.surface === 'goals'));
    const query = $('project-search').value.toLowerCase(),
      project = projectForTree();
    $('projects').replaceChildren();
    $('project-count').textContent = project ? new Set(project.worktrees.map((t) => t.branch)).size : '';
    if (!project) {
      $('projects').append(el('p', 'Choose a project to explore its branches.', 'nav-empty'));
      return;
    }
    const branches = [...new Set(project.worktrees.map((t) => t.branch))];
    for (const branch of branches) {
      const trees = project.worktrees.filter((t) => t.branch === branch);
      if (query && !`${branch} ${trees.map((t) => t.path).join(' ')}`.toLowerCase().includes(query)) continue;
      const button = el('button', undefined, 'branch-link');
      button.type = 'button';
      button.disabled = trees.every((t) => !t.available);
      button.setAttribute('aria-current', String(selectedTree()?.branch === branch));
      button.append(
        el('span', '⑂', 'tree-indicator'),
        el('span', branch, 'tree-name'),
        el('small', `${trees.length} ${trees.length === 1 ? 'worktree' : 'worktrees'}`),
      );
      button.addEventListener('click', () => {
        closeNavigation();
        const tree = trees.find((t) => t.id === ui.selected) || trees.find((t) => t.available);
        if (tree) selectWorkspace(tree);
      });
      $('projects').append(button);
    }
  }

  function personalItems() {
    return personalWork(data.personal.tickets);
  }
  function resetFilters() {
    ui.lanes.clear();
    $('search').value = '';
    ui.camera = null;
  }
  function isGroup(item) {
    return ['goal', 'epic'].includes(item.type);
  }
  function syncUrl() {
    const url = new URL(location);
    for (const [key, value] of Object.entries({
      workspace: ui.selected,
      goal: ui.selectedGoal,
      surface: ui.surface,
      view: ui.view,
      scope: ui.scope,
      direction: ui.direction,
      history: ui.history,
      filters: [...ui.lanes].join(','),
    })) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
  }
  function currentView() {
    return visibleWork(workModel(items, edges), {
      surface: ui.surface,
      scope: ui.scope,
      parent: ui.selectedGoal,
      view: ui.view,
      lanes: ui.lanes,
      history: ui.history,
      query: $('search').value,
    });
  }
  const LANES = {
    attention: ['Needs you', 'pending'],
    running: ['In progress', 'running'],
    ready: ['Open', 'play'],
    waiting: ['Blocked', 'lock'],
    completed: ['Done', 'check'],
  };
  function icon(name) {
    const node = svg('svg', { class: 'icon', 'aria-hidden': 'true' });
    node.append(svg('use', { href: `#icon-${name}` }));
    return node;
  }
  function stateMark(lane) {
    const node = el('span', undefined, `state-mark stage-${lane}`);
    node.title = LANES[lane][0];
    node.setAttribute('aria-label', LANES[lane][0]);
    node.append(icon(LANES[lane][1]));
    return node;
  }
  function renderFilters() {
    const hidden = ['contexts', 'authority'].includes(ui.surface);
    $('status-filters').hidden = hidden;
    $('status-filters').replaceChildren();
    if (hidden) return;
    const scope = visibleWork(workModel(items, edges), {
      surface: ui.surface,
      scope: ui.scope,
      parent: ui.selectedGoal,
      view: 'board',
      query: $('search').value,
    });
    const all = el('button', 'All statuses');
    all.type = 'button';
    all.setAttribute('aria-pressed', String(!ui.lanes.size));
    all.addEventListener('click', () => {
      navigationRevision++;
      ui.lanes.clear();
      ui.camera = null;
      syncUrl();
      renderWork();
    });
    $('status-filters').append(all);
    for (const [lane, [label, name]] of Object.entries(LANES)) {
      const button = el('button', undefined, `stage-${lane}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(ui.lanes.has(lane)));
      button.append(
        icon(name),
        el('span', label),
        el('small', scope.items.filter((item) => scope.laneFor(item) === lane).length),
      );
      button.addEventListener('click', () => setWorkFilter(lane));
      $('status-filters').append(button);
    }
  }
  function pathActions(actions, key, { toggleChildren } = {}) {
    const wrap = el('div', undefined, 'path-disclosure');
    if (!actions) return wrap;
    const button = el('button', undefined, 'icon-button');
    button.type = 'button';
    button.title = 'Show path';
    button.setAttribute('aria-label', 'Show path');
    button.append(icon('folder'));
    const value = el('span', actions.absolutePath || actions.path, 'path-value');
    const draw = () => {
      const open = pathExpanded.get(key) === true;
      value.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    };
    draw();
    button.addEventListener('click', () => {
      const open = !pathExpanded.get(key);
      pathExpanded.set(key, open);
      draw();
      toggleChildren?.(open);
    });
    wrap.append(button);
    for (const [href, label, name] of [
      [actions.githubHref, 'Open on GitHub', 'github'],
      [actions.editorHref, 'Open in editor', 'editor'],
    ]) {
      if (!href) continue;
      const link = el('a', undefined, 'icon-button');
      link.href = href;
      link.title = label;
      link.setAttribute('aria-label', label);
      if (name === 'github') {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      link.append(icon(name));
      wrap.append(link);
    }
    const copy = el('button', undefined, 'icon-button');
    copy.type = 'button';
    copy.title = 'Copy path';
    copy.setAttribute('aria-label', 'Copy path');
    copy.append(icon('context'));
    copy.addEventListener('click', () => copyText(actions.absolutePath || actions.path));
    wrap.append(copy, value);
    return wrap;
  }
  function renderSource() {
    $('checkout-actions').replaceChildren(
      pathActions(currentSource?.actions?.worktree, `checkout:${ui.selected}`),
    );
    const target = $('repository-actions');
    target.replaceChildren();
    if (currentSource?.actions?.repository) {
      const link = el('a', undefined, 'icon-button');
      link.href = currentSource.actions.repository;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = 'Open repository on GitHub';
      link.setAttribute('aria-label', link.title);
      link.append(icon('github'));
      target.append(link);
    }
  }

  function segmentedProgress(done, total, label) {
    const meter = el('span', undefined, 'segmented-progress');
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', label);
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(Math.max(1, total)));
    meter.setAttribute('aria-valuenow', String(done));
    meter.setAttribute('aria-valuetext', `${done} of ${total} tickets complete`);
    const filled = total ? Math.round((done / total) * 20) : 0;
    for (let i = 0; i < 20; i++) {
      const segment = el('span', undefined, `progress-segment${i < filled ? ' filled' : ''}`);
      segment.setAttribute('aria-hidden', 'true');
      meter.append(segment);
    }
    return meter;
  }
  function goalStatus(goal) {
    const own = workflowFor(goal, items, edges);
    const lane = visibleWork(workModel(items, edges), {}).laneFor(goal);
    const label = goal.source?.kind === 'native' && lane === 'completed' ? 'All tasks done' : LANES[lane][0];
    return { ...own, lane, label };
  }

  function renderGoals() {
    const goals = items.filter(isGroup);
    $('goal-count').textContent = goals.length;
    $('total').textContent = goals.filter((goal) => goal.type === 'goal').length;
    $('goal-nav').replaceChildren();
    for (const goal of goals) {
      const children = goalTickets(goal),
        groups = executionSummary(children, items, edges),
        workflow = goalStatus(goal);
      const button = el('button', undefined, `goal-link${goal.type === 'epic' ? ' is-epic' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-current', String(ui.selectedGoal === goal.id));
      const copy = el('span', undefined, 'goal-copy');
      copy.append(
        el('small', workflow.label, 'goal-stage'),
        el('span', goal.title, 'goal-title'),
        segmentedProgress(groups.completed.length, children.length, `${goal.title} progress`),
        el('small', `${groups.completed.length} of ${children.length} tickets complete`),
      );
      if (groups.attention.length)
        copy.append(el('small', `${groups.attention.length} need you`, 'goal-attention'));
      button.append(icon(goal.type === 'epic' ? 'context' : 'overview'), copy);
      button.addEventListener('click', () => {
        closeNavigation();
        selectGoal(goal.id);
      });
      $('goal-nav').append(button);
    }
    if (!goals.length)
      $('goal-nav').append(el('p', 'No goals in this workspace yet. Start with New goal.', 'nav-empty'));
  }
  function renderSwitchers() {
    const project = data.projects.find((p) => p.worktrees.some((t) => t.id === ui.selected)),
      tree = selectedTree();
    function options(id, entries, value, disabled = false) {
      const select = $(id);
      select.replaceChildren();
      entries.forEach(([key, label]) => {
        const option = el('option', label);
        option.value = key;
        select.append(option);
      });
      select.value = value;
      select.disabled = disabled;
    }
    options(
      'project-select',
      [['', 'All projects'], ...data.projects.map((p) => [p.id, p.name])],
      project?.id || '',
    );
    const branches = [...new Set(project?.worktrees.map((t) => t.branch) || [])];
    options(
      'branch-select',
      project ? branches.map((b) => [b, b]) : [['', 'All branches']],
      tree?.branch || '',
      !project,
    );
    const trees = project?.worktrees.filter((t) => t.branch === tree?.branch) || [];
    options(
      'worktree-select',
      project
        ? trees.map((t) => [t.id, `${t.path}${t.available ? '' : ' (unavailable)'}`])
        : [['', 'All worktrees']],
      tree?.id || '',
      !project,
    );
    $('worktree-select').closest('label').hidden = !project || trees.length < 2;
    renderProjectPicker();
  }
  function renderProjectPicker() {
    const current = projectForTree();
    $('project-trigger').disabled = !data;
    $('project-selected-name').textContent = current?.name || 'All projects';
    const branches = current ? new Set(current.worktrees.map((t) => t.branch)).size : 0,
      trees = current?.worktrees.length || 0;
    $('project-selected-description').textContent = current
      ? `${branches} ${branches === 1 ? 'branch' : 'branches'} · ${trees} ${trees === 1 ? 'worktree' : 'worktrees'}`
      : `${data?.projects.length || 0} connected projects`;
    if ($('project-popover').matches(':popover-open')) renderProjectOptions();
  }
  function positionProjectPicker() {
    const rect = $('project-trigger').getBoundingClientRect(),
      panel = $('project-popover'),
      width = Math.min(360, innerWidth - 24),
      left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    const below = innerHeight - rect.bottom - 16,
      above = rect.top - 16;
    const useBelow = below >= 240 || below >= above,
      available = Math.max(120, useBelow ? below : above);
    panel.style.maxHeight = `${available}px`;
    panel.style.top = useBelow ? `${rect.bottom + 6}px` : 'auto';
    panel.style.bottom = useBelow ? 'auto' : `${innerHeight - rect.top + 6}px`;
  }
  function renderProjectOptions() {
    const query = $('project-query').value.trim().toLowerCase(),
      current = projectForTree()?.id || '';
    const choices = [
      { id: '', name: 'All projects', path: 'Goals across connected projects' },
      ...(data?.projects || []),
    ];
    projectChoices = choices.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(query));
    activeProjectChoice = projectChoices.findIndex((p) => p.id === current);
    if (activeProjectChoice < 0) activeProjectChoice = projectChoices.length ? 0 : -1;
    $('project-options').replaceChildren();
    projectChoices.forEach((project, index) => {
      const option = el('div', undefined, 'project-option');
      option.id = `project-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(project.id === current));
      const icon = el('span', project.id ? '▱' : '▦', 'project-avatar');
      icon.setAttribute('aria-hidden', 'true');
      const copy = el('span', undefined, 'project-option-copy');
      const available = project.worktrees?.filter((tree) => tree.available).length;
      copy.append(
        el('strong', project.name),
        el(
          'small',
          project.id
            ? `${available} available worktrees${available < project.worktrees.length ? ' · Some unavailable' : ''}`
            : 'Across all connected projects',
        ),
      );
      option.title = project.path;
      const check = el('span', project.id === current ? '✓' : '', 'project-option-check');
      check.setAttribute('aria-hidden', 'true');
      option.append(icon, copy, check);
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('click', () => chooseProject(index));
      option.addEventListener('pointermove', () => setActiveProject(index, false));
      $('project-options').append(option);
    });
    $('project-picker-status').textContent = projectChoices.length
      ? ''
      : query
        ? 'No projects found. Try another name or path.'
        : 'No connected projects.';
    setActiveProject(activeProjectChoice, false);
  }
  function setActiveProject(index, scroll = true) {
    activeProjectChoice = index;
    const options = [...$('project-options').children];
    options.forEach((node, i) => node.classList.toggle('is-active', i === index));
    if (index >= 0 && options[index]) {
      $('project-query').setAttribute('aria-activedescendant', options[index].id);
      if (scroll) options[index].scrollIntoView({ block: 'nearest' });
    } else $('project-query').removeAttribute('aria-activedescendant');
  }
  function closeProjectPicker(restore = false) {
    if ($('project-popover').matches(':popover-open')) $('project-popover').hidePopover();
    if (restore) $('project-trigger').focus();
  }
  function openProjectPicker() {
    if (!data) return;
    $('project-query').value = '';
    renderProjectOptions();
    positionProjectPicker();
    $('project-popover').showPopover();
    $('project-query').focus();
  }
  function chooseProject(index) {
    const choice = projectChoices[index];
    if (!choice) return;
    closeProjectPicker(true);
    if (choice.id === (projectForTree()?.id || '')) return;
    $('project-select').value = choice.id;
    $('project-select').dispatchEvent(new Event('change', { bubbles: true }));
  }
  function projectForTree() {
    return data?.projects.find((p) => p.worktrees.some((t) => t.id === ui.selected));
  }
  function matchesProject(item, project) {
    return (item.projects || []).some(
      (ref) => ref === project.name || ref === project.path || project.worktrees.some((t) => ref === t.path),
    );
  }
  function personalForProject(project) {
    const all = personalItems(),
      ids = new Set(all.filter((t) => matchesProject(t, project)).map((t) => t.id));
    for (const goal of all.filter((t) => t.type === 'goal' && ids.has(t.id)))
      for (const id of goalScope(goal.id, all)) ids.add(id);
    return all.filter((t) => ids.has(t.id));
  }
  async function selectGoal(id) {
    closeNavigation();
    const goal =
      items.find((t) => t.id === id && isGroup(t)) || personalItems().find((t) => t.id === id && isGroup(t));
    if (!goal) return;
    const revision = ++navigationRevision;
    const project = goal.workspace
      ? data.projects.find((project) => project.worktrees.some((tree) => tree.id === goal.workspace))
      : data.projects.find((project) => matchesProject(goal, project));
    const targetTree = goal.workspace
      ? project?.worktrees.find((tree) => tree.id === goal.workspace)
      : project?.worktrees.find((tree) => tree.id === ui.selected) ||
        project?.worktrees.find((tree) => tree.available && tree.branch === 'main') ||
        project?.worktrees.find((tree) => tree.available);
    if (targetTree && targetTree.id !== ui.selected) {
      await readWorkspace(targetTree);
      if (revision !== navigationRevision) return;
    } else if (!items.some((item) => item.id === id)) {
      ui.selected = null;
      showPersonal();
    }
    ui.selectedGoal = id;
    ui.surface = 'tickets';
    ui.view = 'board';
    closeDetail(false);
    resetFilters();

    $('heading').textContent = goal.title;
    $('breadcrumb').textContent = `${project?.name || 'Personal'} / Goals / ${goal.title}`;
    syncUrl();
    renderNav();
    renderWork();
  }
  function scopeItems() {
    return visibleWork(workModel(items, edges), {
      surface: ui.surface,
      scope: ui.scope,
      parent: ui.selectedGoal,
      view: 'board',
    }).items;
  }
  function renderHierarchy() {
    const context = ['contexts', 'authority'].includes(ui.surface),
      goal = items.find((t) => t.id === ui.selectedGoal);
    $('heading').textContent =
      goal?.title ||
      (context
        ? 'Context'
        : ui.surface === 'goals'
          ? 'Goals'
          : ui.scope === 'unassigned'
            ? 'Unassigned tickets'
            : 'All tickets');
    $('breadcrumb').textContent = projectForTree()
      ? `${projectForTree().name} / ${selectedTree().branch}`
      : 'All projects';
    $('back-goals').hidden = !goal;
    $('search').placeholder = context
      ? 'Find Context…'
      : ui.surface === 'goals'
        ? 'Find a goal…'
        : 'Find a ticket…';
    document
      .querySelectorAll('[data-surface]')
      .forEach((button) =>
        button.setAttribute(
          'aria-pressed',
          String(button.dataset.surface === (context ? 'contexts' : ui.surface)),
        ),
      );
    document
      .querySelectorAll('[data-ticket-scope]')
      .forEach((button) =>
        button.setAttribute(
          'aria-current',
          String(ui.surface === 'tickets' && !ui.selectedGoal && ui.scope === button.dataset.ticketScope),
        ),
      );
    $('goal-outcome').textContent = goal?.outcome || '';
    $('goal-outcome').hidden = !goal?.outcome;
    $('list-title').textContent = context
      ? 'Project Context'
      : ui.surface === 'goals'
        ? 'Goals'
        : ui.view === 'canvas'
          ? 'Ticket graph'
          : 'Ticket board';
    document.querySelector('.start').hidden = context;
    document.querySelector('.view-controls').hidden = context;
    $('focus-mode').hidden = context;
    $('graph-direction').hidden = ui.view !== 'canvas';
    $('history-scope').hidden = ui.view !== 'canvas';
    document
      .querySelectorAll('[data-direction]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.direction === ui.direction)),
      );
    document
      .querySelectorAll('[data-history]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.history === ui.history)),
      );
    $('legend').textContent =
      `${ui.direction === 'ltr' ? 'Left to right' : 'Top to bottom'} dependencies. Dashed lines show membership.`;
    document.title = `VibeHub · ${$('heading').textContent}`;
    renderSource();
    renderFilters();
  }

  async function loadContexts() {
    const turn = ++contextGeneration;
    contextRecords = [];
    contextRooms = [];
    contextErrors = [];
    contextLoading = true;
    renderWork();
    const trees = ui.selected ? [selectedTree()].filter(Boolean) : data.projects.flatMap((p) => p.worktrees);
    for (const tree of trees.filter((t) => t.hasTickets && t.available)) {
      try {
        const result = await api(`/api/contexts?workspace=${encodeURIComponent(tree.id)}`);
        if (turn !== contextGeneration) return;
        const project = data.projects.find((p) => p.worktrees.some((t) => t.id === tree.id));
        if (ui.selected === tree.id) {
          currentSource = result.source;
          renderSource();
        }
        for (const room of result.rooms) {
          const scope = {
            room: room.room,
            roomDescription: room.description,
            parent: room.parent,
            workspace: tree.id,
            worktree: tree.path,
            branch: tree.branch,
            project: project.name,
          };
          contextRooms.push({ ...scope, actions: room.actions, key: `${tree.id}:${room.room}` });
          for (const context of room.contexts) {
            const owner = context.path
              ?.replace(/\\/g, '/')
              .match(/(?:^|\/)\.vibehub\/rooms\/(.+)\/[^/]+\.yaml$/)?.[1];
            if (owner && owner !== room.room) continue;
            contextRecords.push({ ...context, ...scope, actions: context.actions });
          }
        }
      } catch (error) {
        if (turn !== contextGeneration) return;
        contextErrors.push(`${tree.path}: ${error.message}`);
      }
    }
    if (turn !== contextGeneration) return;
    contextLoading = false;
    if (['contexts', 'authority'].includes(ui.surface)) renderWork();
  }
  const CONTEXT_KINDS = {
    authority: { label: 'Authority', hint: 'Golden truth. Follow it; change it only by its rules.' },
    decision: { label: 'Decision', hint: 'What was decided, in the words it was decided with.' },
    constraint: { label: 'Constraint', hint: 'Must hold in every Ticket it reaches.' },
    intent: { label: 'Intent', hint: 'What the work is for.' },
    contract: { label: 'Contract', hint: 'A long-range promise other work builds on.' },
    convention: { label: 'Convention', hint: 'How work is normally done here.' },
    change: { label: 'Change', hint: 'What moved, and which truth it touched.' },
    note: { label: 'Note', hint: 'Supporting reference.' },
  };
  const contextKind = (type) => CONTEXT_KINDS[type] || { label: type, hint: '' };
  const shortRef = (ref) =>
    ref.startsWith('conversation:')
      ? `conversation ${ref.slice('conversation:'.length)}`
      : ref.startsWith('distill:')
        ? `distilled from ${ref.slice('distill:'.length)}`
        : ref;
  const artifactRefs = (record) =>
    (record.evidence || [])
      .map((e) => e.ref)
      .filter((ref) => /[\/.]/.test(ref) && !/^(conversation|distill|test|command):/.test(ref));
  const findRecord = (record, id) =>
    contextRecords.find((c) => c.workspace === record.workspace && c.context_id === id);
  const supersededBy = (record) =>
    contextRecords
      .filter(
        (c) =>
          c.workspace === record.workspace &&
          (c.relations || []).some(
            (r) => r.type === 'supersedes' && r.target_context_id === record.context_id,
          ),
      )
      .map((c) => c.context_id);
  const relationsOf = (record, type) =>
    (record.relations || []).filter((r) => r.type === type).map((r) => r.target_context_id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function contextLead(record) {
    const lines = [];
    const line = (text, cls) => {
      if (text) lines.push({ text, cls });
    };
    const a = record.authority;
    switch (record.type) {
      case 'authority':
        if (a) {
          line(`Governs ${a.governs.join(', ')}`, 'lead-strong');
          line(`Canonical ${a.canonical.join(', ')}`, 'lead-strong');
          line(
            `${plural(a.update_rules.length, 'update rule')} · ${plural(a.validation.length, 'check')}${a.approval === 'human' ? ' · a person decides changes' : ''}`,
          );
        }
        break;
      case 'decision':
        if (record.source?.quote) line(`“${record.source.quote}”`, 'lead-quote');
        else line(record.detail, 'lead-preview');
        {
          const older = relationsOf(record, 'supersedes');
          if (older.length) line(`Replaces ${older.join(', ')}`, 'lead-warn');
        }
        break;
      case 'constraint':
        line(record.detail, 'lead-strong lead-preview');
        break;
      case 'change':
        {
          const touched = relationsOf(record, 'relates_to').filter(
            (id) => findRecord(record, id)?.type === 'authority',
          );
          if (touched.length) line(`Touches golden truth ${touched.join(', ')}`, 'lead-warn');
          const artifacts = artifactRefs(record);
          if (artifacts.length) line(`Changed ${artifacts.join(', ')}`, 'lead-strong');
          if (!touched.length && !artifacts.length) line(record.detail, 'lead-preview');
        }
        break;
      case 'contract':
        line(record.detail, 'lead-preview');
        {
          const deps = relationsOf(record, 'depends_on');
          if (deps.length) line(`Builds on ${deps.join(', ')}`);
        }
        break;
      default:
        line(record.detail, 'lead-preview');
    }
    return lines;
  }
  function contextFacts(record) {
    const facts = [];
    const used = record.consumingTickets || [];
    facts.push({
      text: used.length ? `Read by ${plural(used.length, 'Ticket')}` : 'Not read by any Ticket yet',
      cls: used.length ? 'fact-strong' : 'fact-muted',
    });
    const newer = supersededBy(record);
    if (newer.length) facts.push({ text: `Superseded by ${newer.join(', ')}`, cls: 'fact-warn' });
    if (record.source?.ref) facts.push({ text: `From ${shortRef(record.source.ref)}` });
    facts.push({ text: plural((record.evidence || []).length, 'evidence item') });
    return facts;
  }
  function authorityPreview(context) {
    const section = el('section', undefined, 'authority-preview'),
      toolbar = el('div', undefined, 'preview-toolbar');
    const label = el('label', 'File'),
      select = el('select');
    select.setAttribute('aria-label', 'Canonical file');
    context.authority.canonical.forEach((ref, index) => {
      const option = el('option', ref);
      option.value = String(index);
      select.append(option);
    });
    label.append(select);
    const toggle = el('button', 'Source');
    toggle.type = 'button';
    toggle.disabled = true;
    toggle.setAttribute('aria-pressed', 'false');
    toolbar.append(label, toggle);
    const body = el('div', undefined, 'preview-document'),
      notice = el('p', undefined, 'preview-notice');
    notice.setAttribute('role', 'status');
    section.append(toolbar, notice, body);
    let revision = 0,
      current = null,
      source = false;
    const draw = () => {
      VibeHubPreview.render(body, current, source);
      toggle.textContent = source ? 'Preview' : 'Source';
      toggle.setAttribute('aria-pressed', String(source));
    };
    const load = async () => {
      const turn = ++revision;
      current = null;
      source = false;
      toggle.disabled = true;
      toggle.textContent = 'Source';
      toggle.setAttribute('aria-pressed', 'false');
      body.replaceChildren();
      notice.textContent = 'Loading canonical file…';
      try {
        const query = new URLSearchParams({
          workspace: context.workspace,
          context: context.context_id,
          artifact: select.value,
        });
        const data = await api(`/api/authority-preview?${query}`);
        if (turn !== revision || !section.isConnected) return;
        current = data;
        notice.textContent = `${context.branch} · Read-only preview`;
        toggle.hidden = data.kind === 'image';
        toggle.disabled = false;
        draw();
      } catch (error) {
        if (turn === revision && section.isConnected) notice.textContent = error.message;
      }
    };
    toggle.addEventListener('click', () => {
      if (current) {
        source = !source;
        draw();
      }
    });
    select.addEventListener('change', load);
    load();
    return section;
  }
  function detailTabs(views, initial) {
    const nav = el('nav', undefined, 'detail-view-tabs');
    nav.setAttribute('aria-label', 'Detail views');
    const rows = [...$('detail-meta').querySelectorAll('dt')].map((dt) => ({
      dt,
      dd: dt.nextElementSibling,
    }));
    const named = new Set(views.flatMap(([, labels]) => labels || []));
    for (const [name, labels] of views) {
      const button = el('button', name);
      button.type = 'button';
      button.addEventListener('click', () => select(name, labels));
      nav.append(button);
    }
    function select(name, labels) {
      for (const button of nav.children)
        button.setAttribute('aria-pressed', String(button.textContent === name));
      for (const { dt, dd } of rows) {
        const visible = labels ? labels.includes(dt.textContent) : !named.has(dt.textContent);
        dt.hidden = !visible;
        dd.hidden = !visible;
      }
      $('detail-outcome').hidden =
        name === 'Preview' || name === 'Record details' || !$('detail-outcome').textContent;
    }
    $('detail-meta').before(nav);
    select(initial, views.find(([name]) => name === initial)[1]);
  }
  function showContext(context, trigger) {
    navigationRevision++;
    closeDetail(false);
    ui.context = `${context.workspace}:${context.context_id}`;
    lastFocused = trigger;
    const kind = contextKind(context.type);
    $('detail-kind').textContent =
      `${kind.label.toUpperCase()} · ${context.state}${kind.hint ? ` — ${kind.hint}` : ''}`;
    $('detail-title').textContent = context.summary;
    $('detail-outcome').textContent = context.detail || '';
    $('detail-outcome').hidden = !context.detail;
    $('detail-meta').replaceChildren();
    $('detail-actions').replaceChildren();
    const meta = $('detail-meta');
    const row = (label, content, cls) => {
      if (
        content === undefined ||
        content === null ||
        content === '' ||
        (Array.isArray(content) && !content.length)
      )
        return;
      const dd = el('dd', undefined, cls);
      if (Array.isArray(content)) for (const item of content) dd.append(item);
      else dd.textContent = content;
      meta.append(el('dt', label), dd);
    };
    const list = (items, tag = 'ul') => {
      const node = el(tag, undefined, 'detail-list');
      for (const item of items) node.append(el('li', item));
      return [node];
    };
    const contextLinks = (ids) =>
      ids.map((id) => {
        const target = findRecord(context, id);
        const chip = el(
          'button',
          target ? `${contextKind(target.type).label} · ${target.summary}` : id,
          'detail-chip',
        );
        chip.type = 'button';
        chip.disabled = !target;
        if (target) chip.addEventListener('click', () => showContext(target, trigger));
        return chip;
      });
    const ticketChips = (ids) =>
      ids.map((id) => {
        const chip = el('span', id, 'detail-chip detail-chip-ticket');
        return chip;
      });
    const evidenceList = () => [
      (() => {
        const node = el('ul', undefined, 'detail-list detail-evidence');
        for (const item of context.evidence || []) {
          const li = el('li');
          li.append(el('code', item.ref), el('span', item.note));
          node.append(li);
        }
        return node;
      })(),
    ];
    const used = context.consumingTickets || [],
      newer = supersededBy(context),
      older = relationsOf(context, 'supersedes'),
      deps = relationsOf(context, 'depends_on'),
      related = relationsOf(context, 'relates_to');
    const a = context.authority;
    const sections = {
      words: () =>
        row('Exact words', context.source?.quote ? `“${context.source.quote}”` : undefined, 'detail-quote'),
      used: () =>
        row(
          context.type === 'constraint' ? 'Must hold in' : 'Read by',
          used.length ? ticketChips(used) : 'No Ticket reads this record yet.',
          used.length ? undefined : 'detail-muted',
        ),
      lineage: () => {
        row('Superseded by', contextLinks(newer));
        row('Replaces', contextLinks(older));
      },
      governs: () => {
        if (!a) return;
        row('Canonical preview', [authorityPreview(context)], 'canonical-preview');
        row('Governs', list(a.governs));
        row('Update rules', list(a.update_rules, 'ol'));
        row('Validation', list(a.validation));
        row(
          'Approval',
          a.approval === 'human'
            ? 'A person decides before a canonical artifact changes.'
            : 'No sign-off; the update rules are the discipline.',
          a.approval === 'human' ? 'detail-warn' : undefined,
        );
      },
      touches: () => {
        const truth = related.filter((id) => findRecord(context, id)?.type === 'authority');
        row('Touches golden truth', contextLinks(truth));
        row('Changed artifacts', list(artifactRefs(context)));
      },
      relations: () => {
        row('Builds on', contextLinks(deps));
        row(
          'Related',
          contextLinks(
            related.filter(
              (id) => context.type !== 'change' || findRecord(context, id)?.type !== 'authority',
            ),
          ),
        );
      },
      evidence: () => row('Evidence', (context.evidence || []).length ? evidenceList() : undefined),
      source: () => {
        row('Source', context.source?.ref ? shortRef(context.source.ref) : undefined);
        row('Captured', context.source?.captured_at);
      },
      where: () => {
        row('Room', context.room);
        row('Record', context.path);
        row('Worktree', context.worktree);
        row('Tags', (context.tags || []).join(', '));
      },
    };
    const order = {
      authority: ['governs', 'used', 'lineage', 'relations', 'evidence', 'source', 'where'],
      decision: ['words', 'lineage', 'used', 'relations', 'evidence', 'source', 'where'],
      constraint: ['used', 'lineage', 'relations', 'evidence', 'source', 'where'],
      change: ['touches', 'relations', 'used', 'evidence', 'source', 'where'],
      contract: ['used', 'relations', 'lineage', 'evidence', 'words', 'source', 'where'],
    }[context.type] || ['words', 'used', 'lineage', 'relations', 'evidence', 'source', 'where'];
    for (const name of order) sections[name]();
    if (a) {
      $('inspector').classList.add('reference-dialog');
      $('detail-kind').textContent = `Project authority · ${authorityCategory(context)}`;
      $('detail-title').textContent = referenceTitle(context);
      detailTabs(
        [
          ['Preview', ['Canonical preview']],
          ['Update rules', ['Governs', 'Update rules', 'Validation', 'Approval', 'Read by']],
          ['Record details', null],
        ],
        'Preview',
      );
    } else {
      $('detail-kind').textContent = `${kind.label} · ${context.state}`;
      detailTabs(
        [
          ['Overview', null],
          ['Record details', ['Evidence', 'Source', 'Captured', 'Room', 'Record', 'Worktree', 'Tags']],
        ],
        'Overview',
      );
    }
    $('detail-actions').append(pathActions(context.actions, `${context.workspace}:${context.context_id}`));
    openInspector();
    $('inspector').scrollTop = 0;
    $('close-detail').focus();
  }
  function referenceTitle(record) {
    if (record.summary.length <= 65) return record.summary;
    const file = record.authority?.canonical[0]
      ?.split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ');
    return file ? file.charAt(0).toUpperCase() + file.slice(1) : record.summary;
  }
  function authorityCategory(record) {
    const text =
      `${record.context_id} ${record.tags?.join(' ')} ${record.authority?.canonical.join(' ')}`.toLowerCase();
    if (/design|token|theme/.test(text)) return 'Design system';
    if (/infra|architecture|topology/.test(text)) return 'Infrastructure';
    if (/data.model|schema|database|datatable/.test(text)) return 'Data model';
    return 'Contracts & standards';
  }
  function renderContextTabs() {
    const nav = el('nav', undefined, 'context-subnav');
    nav.setAttribute('aria-label', 'Context views');
    for (const [key, label] of [
      ['contexts', 'Rooms'],
      ['authority', 'Project authority'],
    ]) {
      const button = el('button', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(ui.surface === key));
      button.addEventListener('click', () => changeSurface(key));
      nav.append(button);
    }
    $('work').append(nav);
  }
  function renderAuthorities() {
    renderContextTabs();
    const query = $('search').value.trim().toLowerCase(),
      records = contextRecords
        .filter((c) => c.type === 'authority')
        .filter((c) =>
          `${c.summary} ${c.detail} ${authorityCategory(c)} ${c.authority?.canonical.join(' ')}`
            .toLowerCase()
            .includes(query),
        );
    $('count').textContent = plural(records.length, 'canonical resource');
    const intro = el('div', undefined, 'reference-heading');
    intro.append(
      el('h2', 'Project authority'),
      el('p', 'Open a reference to preview it and see how it should be updated.'),
    );
    $('work').append(intro);
    if (contextLoading) $('work').append(el('p', 'Reading canonical project resources…', 'context-notice'));
    if (contextErrors.length) {
      const warning = el('details', undefined, 'context-errors');
      warning.append(el('summary', `${contextErrors.length} sources could not be read`));
      contextErrors.forEach((error) => warning.append(el('p', error)));
      $('work').append(warning);
    }
    if (!records.length && !contextLoading)
      $('work').append(
        el(
          'p',
          query
            ? 'No matching canonical resources.'
            : 'No Authority recorded for this project yet. Record a canonical artifact and its scope, update rules, and validation to make it available here.',
          'empty',
        ),
      );
    const grid = el('div', undefined, 'authority-grid');
    const categories = ['Design system', 'Infrastructure', 'Data model', 'Contracts & standards'];
    for (const record of [...records].sort(
      (a, b) =>
        categories.indexOf(authorityCategory(a)) - categories.indexOf(authorityCategory(b)) ||
        a.summary.localeCompare(b.summary),
    )) {
      const a = record.authority,
        card = el('button', undefined, 'authority-card');
      card.type = 'button';
      card.dataset.contextKey = `${record.workspace}:${record.context_id}`;
      card.dataset.category = authorityCategory(record);
      const top = el('span', undefined, 'authority-card-top');
      top.append(
        el('span', authorityCategory(record), 'authority-category'),
        el('span', record.state === 'active' ? 'Canonical' : record.state, 'authority-badge'),
      );
      card.append(
        top,
        el('strong', referenceTitle(record), 'authority-title'),
        el(
          'span',
          record.summary === referenceTitle(record) ? record.detail : record.summary,
          'authority-description',
        ),
      );
      const files = el('span', undefined, 'reference-file');
      files.append(
        el('span', plural(a.canonical.length, 'document')),
        el(
          'span',
          a.canonical
            .map((path) => path.split('.').pop().toUpperCase())
            .filter((x, i, all) => all.indexOf(x) === i)
            .join(' · '),
        ),
      );
      card.append(files);
      const footer = el('span', undefined, 'authority-card-footer');
      footer.append(
        el('span', a?.approval === 'human' ? 'Owner approval for changes' : 'Update rules included'),
        el('span', 'Open reference →'),
      );
      card.append(footer);
      if (!ui.selected) card.append(el('small', `${record.project} · ${record.branch}`, 'authority-scope'));
      card.addEventListener('click', () => showContext(record, card));
      grid.append(card);
    }
    $('work').append(grid);
  }
  let roomRailCleanup = null;
  const contextTypeExpanded = new Map();
  function renderContexts() {
    renderContextTabs();
    const query = $('search').value.trim().toLowerCase(),
      records = contextRecords.filter((c) =>
        `${c.context_id} ${c.summary} ${c.detail || ''} ${c.room} ${c.roomDescription || ''} ${c.type} ${(c.tags || []).join(' ')} ${c.project}`
          .toLowerCase()
          .includes(query),
      );
    const groups = new Map();
    for (const record of records) {
      const key = `${record.workspace}:${record.room}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    const orderedRooms = [...contextRooms].sort(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.worktree.localeCompare(b.worktree) ||
        a.room.localeCompare(b.room),
    );
    const matches = orderedRooms
      .filter(
        (room) =>
          !query ||
          groups.has(room.key) ||
          `${room.room} ${room.roomDescription || ''} ${room.project}`.toLowerCase().includes(query),
      )
      .map((room) => room.key);
    const fullHierarchy = VibeHubRooms.hierarchy(orderedRooms),
      tones = new Map(fullHierarchy.map((room) => [room.key, room.tone]));
    const rooms = VibeHubRooms.hierarchy(VibeHubRooms.matchingRooms(orderedRooms, matches)).map((room) => ({
      ...room,
      tone: tones.get(room.key),
    }));
    $('list-title').textContent = 'Context by Room';
    $('count').textContent =
      `${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'} · ${plural(records.length, 'record')}`;
    const toolbar = el('div', undefined, 'rooms-toolbar');
    const controls = el('div', undefined, 'room-controls');
    for (const [label, open] of [
      ['Expand all', true],
      ['Collapse all', false],
    ]) {
      const button = el('button', label);
      button.type = 'button';
      button.disabled = !rooms.length;
      button.addEventListener('click', () => {
        for (const room of rooms) roomExpanded.set(room.key, open);
        document.querySelectorAll('.room-group,.context-type-group').forEach((node) => {
          node.open = open;
          if (node.dataset.groupKey) contextTypeExpanded.set(node.dataset.groupKey, open);
        });
      });
      controls.append(button);
    }
    toolbar.append(
      el('p', 'Rooms branch from their parent. Select a record to read it.', 'rooms-hint'),
      controls,
    );
    $('work').append(toolbar);

    if (contextLoading)
      $('work').append(el('p', 'Reading Rooms from connected worktrees…', 'context-notice'));
    if (contextErrors.length) {
      const details = el('details', undefined, 'context-errors');
      details.append(el('summary', `${contextErrors.length} worktrees could not be read`));
      for (const error of contextErrors) details.append(el('p', error));
      $('work').append(details);
    }
    if (!rooms.length && !contextLoading)
      $('work').append(
        el(
          'p',
          query
            ? 'No Rooms or Context records match your search.'
            : 'No Rooms recorded in this workspace yet. Context saved through VibeHub will appear in its Room.',
          'empty',
        ),
      );
    const list = el('div', undefined, 'room-groups room-branches'),
      entries = [];
    list.style.setProperty('--room-depth', Math.max(0, ...rooms.map((room) => room.depth)));
    for (const room of rooms) {
      const group = groups.get(room.key) || [],
        section = el('details', undefined, 'room-group');
      section.style.setProperty('--depth', room.depth);
      section.open = query ? true : roomExpanded.get(room.key) !== false;
      const summary = el('summary', undefined, 'room-heading');
      section.classList.add(`tone-${room.tone}`);
      const copy = el('span', undefined, 'room-heading-copy');
      copy.append(
        el('strong', room.room.split('/').pop(), 'room-name'),
        el(
          'span',
          room.parent ? `in ${room.parent}` : ui.selected ? 'Root Room' : `${room.project} · ${room.branch}`,
          'room-location',
        ),
      );
      const count = el(
          'span',
          `${group.length} ${group.length === 1 ? 'record' : 'records'}`,
          'room-record-count',
        ),
        chevron = el('span', '⌄', 'room-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      summary.append(copy, count, chevron);
      section.append(summary);
      section.addEventListener('toggle', () => {
        if (!query && section.isConnected) roomExpanded.set(room.key, section.open);
      });
      const body = el('div', undefined, 'room-contents');
      const roomPaths = pathActions(room.actions, room.key, {
        toggleChildren: (open) => {
          for (const record of group) pathExpanded.set(`${record.workspace}:${record.context_id}`, open);
          renderWork();
        },
      });
      roomPaths.classList.add('room-path-actions');
      body.append(roomPaths);
      if (room.roomDescription) body.append(el('p', room.roomDescription, 'room-description'));
      if (room.parent) body.append(el('p', `Parent Room: ${room.parent}`, 'room-parent'));
      for (const { type, records: typeRecords } of VibeHubRooms.groupByType(group)) {
        const kind = contextKind(type),
          typeKey = `${room.key}:${type}`;
        const typeGroup = el('details', undefined, `context-type-group kind-${type}`);
        typeGroup.dataset.groupKey = typeKey;
        typeGroup.open = query ? true : contextTypeExpanded.get(typeKey) !== false;
        const typeHeading = el('summary', undefined, 'context-type-heading');
        const label =
          {
            authority: 'Project authority',
            decision: 'Decisions',
            constraint: 'Constraints',
            contract: 'Contracts',
            intent: 'Intents',
            convention: 'Conventions',
            change: 'Changes',
            note: 'Notes',
          }[type] || kind.label;
        typeHeading.append(el('strong', label), el('span', String(typeRecords.length), 'context-type-count'));
        const chevron = el('span', '⌄', 'context-type-chevron');
        chevron.setAttribute('aria-hidden', 'true');
        typeHeading.append(chevron);
        typeGroup.append(typeHeading);
        typeGroup.addEventListener('toggle', () => {
          if (!query && typeGroup.isConnected) contextTypeExpanded.set(typeKey, typeGroup.open);
        });
        const rows = el('ul', undefined, 'context-rows');
        rows.setAttribute('aria-label', `${room.room} ${label}`);
        for (const record of typeRecords) {
          const row = el('li'),
            button = el('button', undefined, `context-row kind-${record.type}`);
          button.type = 'button';
          button.dataset.contextKey = `${record.workspace}:${record.context_id}`;
          button.append(el('strong', record.summary, 'context-row-title'));
          const meta = el('span', undefined, 'context-row-meta');
          if (record.state !== 'active') meta.append(el('span', record.state, 'context-state'));
          const used = record.consumingTickets || [];
          if (used.length) meta.append(el('span', plural(used.length, 'ticket'), 'context-row-used'));
          button.append(meta);
          const arrow = el('span', '→', 'context-row-arrow');
          arrow.setAttribute('aria-hidden', 'true');
          button.append(arrow);
          button.addEventListener('click', () => showContext(record, button));
          row.append(button);
          const paths = pathActions(record.actions, `${record.workspace}:${record.context_id}`);
          paths.classList.add('context-path-actions');
          row.append(paths);
          rows.append(row);
        }
        typeGroup.append(rows);
        body.append(typeGroup);
      }
      if (!group.length)
        body.append(
          el(
            'p',
            query ? 'No matching records in this Room.' : 'No Context recorded in this Room yet.',
            'room-empty',
          ),
        );
      section.append(body);
      list.append(section);
      entries.push({ room, section });
    }
    $('work').append(list);
    roomRailCleanup = VibeHubRooms.connect(list, entries);
  }
  function renderSummary() {
    const scoped = ui.selectedGoal
        ? [items.find((t) => t.id === ui.selectedGoal), ...scopeItems()].filter(Boolean)
        : items,
      tickets = scoped.filter((t) => !isGroup(t));
    $('activity-summary').replaceChildren();
    for (const [label, value] of [
      ['Running', tickets.filter((t) => stageFor(t) === 'running').length],
      ['Needs you', tickets.filter((t) => stageFor(t) === 'attention').length],
      ['Open goals', scoped.filter((t) => t.type === 'goal' && stageFor(t) !== 'completed').length],
    ]) {
      const stat = el('span');
      stat.append(el('strong', value), document.createTextNode(` ${label}`));
      $('activity-summary').append(stat);
    }
    $('activity-summary').append(el('span', 'Recorded status · refresh to update', 'snapshot-note'));
  }
  function showWarnings() {
    const warnings = [...data.warnings, ...data.personal.warnings, ...sourceWarnings];
    $('warnings').hidden = !warnings.length;
    $('source-alert').hidden = !warnings.length;
    $('source-alert').textContent = warnings.length;
    $('source-alert').title = `${warnings.length} source issues`;
    const list = $('warnings').querySelector('ul');
    list.replaceChildren();
    for (const warning of warnings) list.append(el('li', `${warning.path}: ${warning.message}`));
  }
  function showPersonal() {
    generation++;
    $('work').removeAttribute('aria-busy');
    ui.selected = null;
    currentSource = null;
    $('heading').textContent = 'All work';
    $('breadcrumb').textContent = 'Personal workspace';
    $('request-scope').textContent =
      'Copy into your agent to plan executable tickets and surface human decisions early.';
    $('list-title').textContent = 'Goals & tickets';
    items = personalItems();
    edges = items.flatMap((t) =>
      t.relations
        .filter((r) => ['depends_on', 'task_of', 'sub_goal_of'].includes(r.type))
        .map((r) => ({ from: r.target, to: t.id, membership: r.type !== 'depends_on' })),
    );
    const worktrees = data.projects.reduce((sum, p) => sum + p.worktrees.length, 0);
    const goals = items.filter((t) => t.type === 'goal').length;
    status(
      `${data.projects.length} projects · ${worktrees} worktrees · ${goals} goals · ${items.length} personal tickets`,
    );
    const merged = mergeTicketSources(items, repositoryItems, repositoryEdges);
    items = merged.items;
    edges.push(...merged.edges);
    if (ui.selectedGoal) {
      const goal = items.find((t) => t.id === ui.selectedGoal && isGroup(t));
      if (goal) {
        $('heading').textContent = goal.title;
        $('breadcrumb').textContent = 'Goals / ' + (goal.projects.join(' · ') || 'Personal');
        $('list-title').textContent = 'Goal work';
      }
    }
    renderGoals();
    renderSwitchers();
    renderWork();
  }
  function selectWorkspace(tree) {
    navigationRevision++;
    return readWorkspace(tree);
  }
  async function readWorkspace(tree) {
    closeNavigation();
    const turn = ++generation;
    const keepContext = ['contexts', 'authority'].includes(ui.surface),
      previousSurface = ui.surface;
    ui.selectedGoal = null;
    ui.surface = keepContext ? previousSurface : 'goals';
    ui.view = 'board';
    ui.selected = tree.id;
    currentSource = null;
    resetFilters();
    closeDetail(false);
    contextGeneration++;
    syncUrl();
    $('heading').textContent = tree.branch;
    $('breadcrumb').textContent = tree.path;
    $('request-scope').textContent = 'The brief includes this worktree. Copy it into your agent to plan.';
    $('list-title').textContent = 'Goal graph';
    items = personalForProject(projectForTree());
    edges = items.flatMap((t) =>
      (t.relations || [])
        .filter((r) => ['depends_on', 'task_of', 'sub_goal_of'].includes(r.type))
        .map((r) => ({ from: r.target, to: t.id, membership: r.type !== 'depends_on' })),
    );
    $('work').replaceChildren();
    renderNav();
    status('Reading this checkout…');
    $('work').setAttribute('aria-busy', 'true');
    $('count').textContent = 'Reading…';
    try {
      if (!tree.hasTickets) {
        status(`${projectForTree().name} · Personal VibeHub goals and tickets`);
        renderWork();
        return;
      }
      const snapshot = await api(`/api/state?workspace=${encodeURIComponent(tree.id)}&scope=all`);
      if (turn !== generation) return;
      currentSource = snapshot.graph.source;
      const native = fromRepositoryGraph(tree, snapshot.graph, snapshot.project.name);
      const merged = mergeTicketSources(items, native.items, native.edges);
      items = merged.items;
      edges.push(...merged.edges);
      status(`${snapshot.project.name} · ${tree.branch} · ${items.length} tickets in the current graph`);
      renderWork();
    } catch (error) {
      if (turn !== generation) return;
      status('This checkout needs attention. Other projects remain available.');
      renderWork('Could not read this ticket graph', error.message);
    } finally {
      if (turn === generation) {
        $('work').removeAttribute('aria-busy');
        if (keepContext && ['contexts', 'authority'].includes(ui.surface)) loadContexts();
      }
    }
  }
  function goalTickets(goal) {
    const ids = goalScope(goal.id, items);
    return items.filter((t) => !isGroup(t) && ids.has(t.id));
  }
  function setWorkFilter(next) {
    navigationRevision++;
    if (ui.lanes.has(next)) ui.lanes.delete(next);
    else ui.lanes.add(next);
    ui.camera = null;
    syncUrl();
    renderWork();
  }

  function continuationBrief(goal) {
    const children = goalTickets(goal),
      groups = executionSummary(children, items, edges);
    const section = (name, rows) =>
      `${name}:\n${rows.map((r) => `- ${r.item.originalId || r.item.id}: ${r.item.title} (${r.label})\n  Source: ${r.item.path}`).join('\n') || '- None recorded'}`;
    return `Continue this VibeHub goal: ${goal.title}\n${goal.outcome || ''}\nGoal source: ${goal.path}\n${selectedTree() ? `Working directory: ${selectedTree().path}\n` : ''}
Read these tasks and their context before continuing. Use my chosen skills and working methods. Record meaningful progress, results and status with vibehub-ticket. Keep task records local unless I explicitly request sharing. Publishing code does not authorize sharing task records. Preserve recorded human decisions and never infer approval.\n\n${section('Needs human input', groups.attention)}\n\n${section('In progress', groups.running)}\n\n${section('Open tasks', groups.ready)}\n\n${section('Waiting on dependencies', groups.waiting)}`;
  }
  function renderGoalProgress() {
    const bar = $('goal-progress'),
      goal = items.find((t) => t.id === ui.selectedGoal);
    bar.replaceChildren();
    bar.hidden = !goal || ['contexts', 'authority'].includes(ui.surface);
    if (bar.hidden) return;
    const children = goalTickets(goal),
      groups = executionSummary(children, items, edges);
    const progress = el('div', undefined, 'execution-progress');
    progress.append(
      el('strong', `${groups.completed.length}/${children.length}`),
      el('span', 'tickets complete'),
    );
    progress.append(segmentedProgress(groups.completed.length, children.length, 'Overall goal progress'));
    bar.append(progress);
    const stages = el('div', undefined, 'execution-stages');
    for (const [key, label] of [
      ['attention', 'Needs you'],
      ['running', 'In progress'],
      ['ready', 'Open'],
      ['waiting', 'Waiting'],
    ]) {
      if (!groups[key].length) continue;
      const button = el('button', `${groups[key].length} ${label}`, `execution-stat stage-${key}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(ui.lanes.has(key)));
      button.addEventListener('click', () => setWorkFilter(key));
      stages.append(button);
    }
    bar.append(stages);
    const copy = el('button', children.length ? 'Copy next steps' : 'Copy planning brief', 'continue-goal');
    copy.type = 'button';
    copy.title = 'Copy instructions into your coding agent';
    copy.addEventListener('click', () => copyText(continuationBrief(goal)));
    bar.append(copy);
  }
  function renderWork(emptyTitle, emptyText) {
    if (!data) return;
    roomRailCleanup?.();
    roomRailCleanup = null;
    canvasObserver?.disconnect();
    canvasObserver = null;
    $('work').replaceChildren();
    $('work').classList.remove('with-queue');
    renderGoals();
    renderHierarchy();
    renderSummary();
    renderGoalProgress();
    if (ui.surface === 'authority') {
      renderAuthorities();
      return;
    }
    if (ui.surface === 'contexts') {
      renderContexts();
      return;
    }
    const projection = currentView(),
      visible = projection.items;
    $('legend').hidden = ui.view !== 'canvas';
    document
      .querySelectorAll('[data-view]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === ui.view)));
    $('count').textContent =
      `${projection.active ? 'Active · ' : ui.lanes.size ? 'Filtered · ' : ''}${projection.count}${projection.count !== projection.totalCount ? ` / ${projection.totalCount}` : ''} ${ui.surface === 'goals' ? 'goals' : 'items'}`;
    document.title = `VibeHub · ${$('heading').textContent}`;
    if (!visible.length && ui.view === 'board' && ui.surface === 'tickets' && !emptyTitle) {
      renderBoard(visible);
      return;
    }
    if (!visible.length) {
      const box = el('div', undefined, 'empty');
      box.append(
        el(
          'strong',
          emptyTitle ||
            (items.length
              ? ui.surface === 'goals' && !$('search').value
                ? 'No goals recorded for this project'
                : 'No matching work'
              : 'No connected work yet'),
        ),
        el(
          'span',
          emptyText ||
            (items.length
              ? ui.surface === 'goals' && !$('search').value
                ? 'Goals use explicit project references. Existing tickets without a goal are available in Unassigned tickets.'
                : 'Try another filter or search.'
              : data.personal.connected
                ? 'Projects appear here after connecting them to VibeHub. You can still start a freeform request above.'
                : 'Connect a project to VibeHub to see its work here. A connected personal store can also supply goals and tickets.'),
        ),
      );
      $('work').append(box);
      return;
    }
    if (ui.view === 'board') {
      if (ui.surface === 'goals') renderGoalOverview(visible);
      else renderBoard(visible);
      return;
    }
    const availableWidth = $('work').clientWidth;
    const layout = VibeHubDashboardGraph.layoutGraph(visible, edges, {
      maxWidth: Math.max(344, availableWidth),
      direction: ui.direction,
    });
    if (layout.cyclic.length)
      $('work').append(
        el('p', 'This graph contains a dependency cycle. Review the source relations.', 'cycle'),
      );
    const frame = el('div', undefined, 'canvas-frame');
    const controls = el('div', undefined, 'canvas-controls');
    const hint = el('span', 'Drag to pan · Ctrl/⌘ + scroll to zoom', 'canvas-hint'),
      zoomLabel = el('span', '100%', 'zoom-label');
    const viewport = el('div', undefined, 'canvas-viewport');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', 'Ticket canvas. Scroll to explore, or use the zoom controls.');
    const extent = el('div', undefined, 'canvas-extent'),
      canvas = el('div', undefined, 'card-canvas');
    canvas.style.width = `${layout.width}px`;
    canvas.style.height = `${layout.height}px`;
    const graph = svg('svg', { width: layout.width, height: layout.height, 'aria-hidden': 'true' });
    const branchColors = ['var(--flow-blue)', 'var(--flow-green)', 'var(--flow-yellow)', 'var(--purple)'];
    const edgeElements = [];
    for (const edge of layout.connections) {
      const color = branchColors[edge.color];
      const path = svg('path', {
        d: edge.d,
        fill: 'none',
        stroke: color,
        'stroke-width': edge.membership ? 2 : 3.5,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': edge.membership ? '4 7' : 'none',
      });
      graph.append(path);
      edgeElements.push({ edge, path });
      if (!edge.membership) {
        const point = svg('circle', {
          cx: edge.waypoint.x,
          cy: edge.waypoint.y,
          r: 7,
          fill: 'var(--canvas)',
          stroke: color,
          'stroke-width': 2,
        });
        graph.append(point);
        edgeElements.push({ edge, path: point });
      }
    }
    canvas.append(graph);
    const visibleIds = new Set(visible.map((t) => t.id)),
      nodes = new Map(layout.nodes.map((n) => [n.id, n]));
    const cardButtons = new Map();
    function highlight(id) {
      canvas.classList.toggle('has-focus', !!id);
      const related = new Set([id]);
      for (const { edge, path } of edgeElements) {
        const match = edge.from === id || edge.to === id;
        path.classList.toggle('is-related', match);
        if (match) {
          related.add(edge.from);
          related.add(edge.to);
        }
      }
      for (const [key, button] of cardButtons) button.classList.toggle('is-related', related.has(key));
    }
    layout.items.forEach((item) => {
      const node = nodes.get(item.id),
        workflow = isGroup(item) ? goalStatus(item) : workflowFor(item, items, edges),
        done = workflow.lane === 'completed';
      const button = el(
        'button',
        undefined,
        `work-card ${done ? 'is-done' : item.state === 'OPEN' ? 'is-open' : ''} ${isGroup(item) ? 'is-goal' : ''}`,
      );
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.dataset.lane = workflow.lane;
      button.style.setProperty('--branch-color', branchColors[node.color]);
      button.style.left = `${node.x}px`;
      button.style.top = `${node.y}px`;
      button.style.width = `${node.width}px`;
      button.style.height = `${node.height}px`;
      button.dataset.workKey = item.id;
      button.setAttribute('aria-pressed', String(ui.ticket === item.id));
      const hidden = projection.hidden.get(item.id) || 0;
      const top = el('span', undefined, 'card-top');
      top.append(el('span', item.originalId || item.id, 'card-id'));
      button.append(stateMark(workflow.lane));
      const title = el('span', item.title, 'card-title');
      button.title = `${item.title}\n${item.originalId || item.id}\n${item.projects.join(' · ')}${hidden ? `\n${hidden} links outside this view` : ''}`;
      const footer = el('span', undefined, 'card-footer');
      footer.append(
        el(
          'span',
          isGroup(item)
            ? `${items.filter((t) => !isGroup(t) && goalScope(item.id, items).has(t.id)).length} tickets · Open graph →`
            : `${node.incoming} in · ${node.outgoing} out${hidden ? ` · +${hidden} hidden` : ''}`,
          'card-count',
        ),
        el('span', workflow.label, 'state'),
      );
      button.append(top, title);

      button.append(footer);
      if (layout.connections.some((e) => e.to === item.id))
        button.append(el('span', undefined, 'port port-in'));
      if (layout.connections.some((e) => e.from === item.id))
        button.append(el('span', undefined, 'port port-out'));
      cardButtons.set(item.id, button);
      button.addEventListener('pointerenter', () => highlight(item.id));
      button.addEventListener('focus', () => highlight(item.id));
      button.addEventListener('pointerleave', () => {
        if (document.activeElement !== button) highlight(null);
      });
      button.addEventListener('blur', () => highlight(null));
      button.addEventListener('click', () =>
        isGroup(item) ? selectGoal(item.id) : showDetail(item, button),
      );
      canvas.append(button);
    });
    const cameraKey = [
      ui.selected,
      ui.selectedGoal,
      ui.scope,
      ui.surface,
      ui.direction,
      [...ui.lanes].join(','),
      ui.history,
      $('search').value,
    ].join('|');
    const savedCamera = ui.camera?.key === cameraKey ? ui.camera : null;
    let scale = savedCamera?.scale || 1,
      offsetX = 0,
      offsetY = 0;
    function zoom(next, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
      const graphX = (viewport.scrollLeft + anchorX - offsetX) / scale,
        graphY = (viewport.scrollTop + anchorY - offsetY) / scale;
      scale = Math.max(0.05, Math.min(1.75, next));
      offsetX = Math.max(0, (viewport.clientWidth - layout.width * scale) / 2);
      offsetY = Math.max(0, (viewport.clientHeight - layout.height * scale) / 2);
      canvas.style.transform = `translate(${offsetX}px,${offsetY}px) scale(${scale})`;
      extent.style.width = `${Math.max(viewport.clientWidth, layout.width * scale)}px`;
      extent.style.height = `${Math.max(viewport.clientHeight, layout.height * scale)}px`;
      viewport.scrollLeft = graphX * scale + offsetX - anchorX;
      viewport.scrollTop = graphY * scale + offsetY - anchorY;
      zoomLabel.textContent = `${Math.round(scale * 100)}%`;
      ui.camera = { key: cameraKey, scale, left: viewport.scrollLeft, top: viewport.scrollTop };
    }
    function fit() {
      zoom(
        Math.min(1, (viewport.clientWidth - 48) / layout.width, (viewport.clientHeight - 80) / layout.height),
      );
      viewport.scrollTo(0, 0);
    }
    for (const [text, label, action] of [
      ['−', 'Zoom out', () => zoom(scale / 1.2)],
      ['+', 'Zoom in', () => zoom(scale * 1.2)],
      ['Fit', 'Fit graph', fit],
      ['1:1', 'Actual size', () => zoom(1)],
    ]) {
      const button = el('button', text);
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.addEventListener('click', action);
      controls.append(button);
    }
    controls.append(zoomLabel);
    viewport.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        zoom(scale * Math.exp(-event.deltaY * 0.008), event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );
    viewport.addEventListener('keydown', (event) => {
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        fit();
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoom(scale * 1.2);
      }
      if (event.key === '-') {
        event.preventDefault();
        zoom(scale / 1.2);
      }
      if (event.key === '0') {
        event.preventDefault();
        zoom(1);
      }
    });
    viewport.addEventListener('scroll', () => {
      ui.camera = { key: cameraKey, scale, left: viewport.scrollLeft, top: viewport.scrollTop };
    });
    let drag = null;
    viewport.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button') || event.pointerType !== 'mouse' || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('dragging');
    });
    viewport.addEventListener('pointermove', (event) => {
      if (drag) {
        viewport.scrollLeft = drag.left + drag.x - event.clientX;
        viewport.scrollTop = drag.top + drag.y - event.clientY;
      }
    });
    const endDrag = () => {
      drag = null;
      viewport.classList.remove('dragging');
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('lostpointercapture', endDrag);
    extent.append(canvas);
    viewport.append(extent);
    frame.append(viewport, controls, hint);
    $('work').prepend(frame);
    zoom(1);
    if (savedCamera) {
      zoom(savedCamera.scale);
      viewport.scrollTo(savedCamera.left, savedCamera.top);
    } else fit();
    const observer = (canvasObserver = new ResizeObserver(() => {
      if (frame.isConnected) {
        const left = viewport.scrollLeft,
          top = viewport.scrollTop;
        zoom(scale);
        viewport.scrollTo(left, top);
      } else observer.disconnect();
    }));
    observer.observe(viewport);
  }

  function renderGoalOverview(visible) {
    const grid = el('div', undefined, 'goal-overview');
    grid.setAttribute('role', 'region');
    grid.setAttribute('aria-label', 'Project goals');
    const priority = ['attention', 'running', 'ready', 'waiting', 'completed'];
    for (const goal of [...visible].sort(
      (a, b) =>
        priority.indexOf(goalStatus(a).lane) - priority.indexOf(goalStatus(b).lane) ||
        a.title.localeCompare(b.title),
    )) {
      const children = goalTickets(goal),
        groups = executionSummary(children, items, edges),
        workflow = goalStatus(goal);
      const card = el('button', undefined, `goal-overview-card stage-${workflow.lane}`);
      card.type = 'button';
      const top = el('span', undefined, 'goal-overview-meta');
      top.append(el('span', 'GOAL', 'card-id'), el('span', workflow.label, 'goal-overview-status'));
      const title = el('span', undefined, 'goal-overview-title');
      title.append(icon(goal.type === 'epic' ? 'context' : 'overview'), el('strong', goal.title));
      card.append(top, title);
      if (goal.outcome && goal.outcome !== goal.title)
        card.append(el('span', goal.outcome, 'goal-overview-outcome'));
      card.append(
        el('span', `${groups.completed.length} of ${children.length} tickets complete`, 'goal-card-count'),
        segmentedProgress(groups.completed.length, children.length, `${goal.title} progress`),
      );
      const footer = el('span', undefined, 'goal-overview-footer');
      footer.append(
        el(
          'span',
          groups.attention.length
            ? `${groups.attention.length} need you`
            : groups.running.length
              ? `${groups.running.length} in progress`
              : workflow.label,
          groups.attention.length ? 'goal-attention' : '',
        ),
        el('span', `View ${children.length} tickets →`),
      );
      card.append(footer);
      card.addEventListener('click', () => selectGoal(goal.id));
      grid.append(card);
    }
    $('work').append(grid);
  }
  function workCard(item) {
    const workflow = isGroup(item) ? goalStatus(item) : workflowFor(item, items, edges);
    const button = el('button', undefined, 'board-card');
    button.type = 'button';
    button.dataset.workKey = item.id;
    button.setAttribute('aria-pressed', String(ui.ticket === item.id));
    const top = el('span', undefined, 'card-top');
    top.append(el('span', item.originalId || item.id, 'card-id'));
    button.append(top, stateMark(workflow.lane), el('span', item.title, 'board-title'));
    if (item.outcome && item.outcome !== item.title)
      button.append(el('span', item.outcome, 'ticket-summary'));
    button.addEventListener('click', () => (isGroup(item) ? selectGoal(item.id) : showDetail(item, button)));
    return button;
  }
  function renderBoard(visible) {
    const projection = currentView(),
      board = el('div', undefined, `work-board${projection.lanes.length === 1 ? ' is-solo' : ''}`);
    board.tabIndex = 0;
    board.setAttribute('role', 'region');
    board.setAttribute('aria-label', 'Ticket board');
    board.style.setProperty('--columns', projection.lanes.length);
    for (const lane of projection.lanes) {
      const column = el('section', undefined, `board-column stage-${lane}`),
        group = visible.filter((item) => projection.laneFor(item) === lane);
      const heading = el('h3');
      heading.append(
        icon(LANES[lane][1]),
        el('span', LANES[lane][0]),
        el('span', group.length, 'column-count'),
      );
      column.append(heading);
      const stack = el('div', undefined, 'column-stack');
      group.forEach((item) => stack.append(workCard(item)));
      if (!group.length) stack.append(el('p', 'No tickets', 'lane-empty'));
      column.append(stack);
      board.append(column);
    }
    $('work').append(board);
    const item = items.find((item) => item.id === ui.ticket);
    if (!item) return;
    const strip = el('div', undefined, 'relationship-strip');
    strip.setAttribute('aria-label', 'Selected Ticket relationships');
    for (const [label, ids] of [
      ['Depends on', edges.filter((e) => !e.membership && e.to === item.id).map((e) => e.from)],
      ['Selected', [item.id]],
      ['Unblocks', edges.filter((e) => !e.membership && e.from === item.id).map((e) => e.to)],
    ]) {
      if (strip.childElementCount) strip.append(icon('arrow'));
      const group = el('section', undefined, 'relationship-group');
      group.append(el('h3', label));
      for (const id of ids) {
        const target = items.find((t) => t.id === id);
        const button = el('button', target?.title || id);
        button.type = 'button';
        button.disabled = !target;
        button.addEventListener('click', () => showDetail(target, button));
        group.append(button);
      }
      if (!ids.length) group.append(el('p', 'None', 'lane-empty'));
      strip.append(group);
    }
    $('work').append(strip);
  }

  async function copyText(text) {
    const trigger = document.activeElement;
    try {
      await navigator.clipboard.writeText(text);
      status('Copied. Paste into your coding agent.');
      if (trigger?.tagName === 'BUTTON') {
        const contents = [...trigger.childNodes];
        trigger.textContent = 'Copied';
        setTimeout(() => {
          trigger.replaceChildren(...contents);
        }, 1800);
      }
    } catch {
      document.querySelector('.start').hidden = false;
      document.querySelector('.start').open = true;
      $('request').value = text;
      $('request').focus();
      $('request').select();
      status('Clipboard unavailable. The text is selected; copy it manually.');
    }
  }
  let ticketDetailCleanup = null;
  function showDetail(item, trigger) {
    navigationRevision++;
    const focusOrigin = trigger.closest('#inspector') ? lastFocused : trigger;
    ui.ticket = item.id;
    ui.context = null;
    closeDetail(false, true);
    if (ui.view === 'board') renderWork();
    document
      .querySelectorAll('.work-card[aria-pressed=true],.board-card[aria-pressed=true]')
      .forEach((card) => card.setAttribute('aria-pressed', 'false'));
    trigger.setAttribute('aria-pressed', 'true');
    lastFocused = focusOrigin.isConnected
      ? focusOrigin
      : [...document.querySelectorAll('[data-work-key]')].find(
          (button) => button.dataset.workKey === item.id,
        ) || $('heading');
    lastFocused.setAttribute('aria-pressed', 'true');
    const workflow = workflowFor(item, items, edges),
      workspace = item.workspace || ui.selected;
    $('inspector').classList.add('ticket-dialog');
    $('detail-kind').textContent = `Ticket · ${workflow.label}`;
    $('detail-title').textContent = item.title;
    $('detail-outcome').hidden = true;
    $('detail-meta').replaceChildren();
    $('detail-actions').replaceChildren();
    const content = el('div', undefined, 'ticket-content');
    $('detail-meta').before(content);
    const related = (ids) =>
      ids.map((id) => items.find((item) => item.id === id) || { id, title: id, type: 'missing' });
    ticketDetailCleanup = VibeHubTicket.mount({
      container: content,
      item,
      workflow,
      dependencies: related(edges.filter((e) => !e.membership && e.to === item.id).map((e) => e.from)),
      dependents: related(edges.filter((e) => !e.membership && e.from === item.id).map((e) => e.to)),
      goals: related(
        item.relations.filter((r) => ['task_of', 'sub_goal_of'].includes(r.type)).map((r) => r.target),
      ),
      navigate: (target, button) => {
        if (target.type === 'missing') return;
        if (isGroup(target)) {
          closeDetail();
          selectGoal(target.id);
        } else showDetail(target, button);
      },
      copy: copyText,
      contractUrl: item.ticket ? inspectorLink(item.originalId || item.id, workspace) : null,
      loadDetails: async () => {
        const query = new URLSearchParams({ workspace, scope: 'all' }),
          state = await api(`/api/state?${query}`);
        query.set('snapshotId', state.graph.snapshotId);
        query.set('kind', 'ticket');
        query.set('ticketId', item.originalId || item.id);
        const result = await api(`/api/subject?${query}`);
        return result.subject.contextPackage;
      },
    });
    openInspector();
    $('inspector').scrollTop = 0;
    $('close-detail').focus();
  }
  function openInspector() {
    const inspector = $('inspector'),
      narrow = matchMedia('(max-width: 960px)').matches;
    if (inspector.open && inspector.matches(':modal') !== narrow) inspector.close();
    document.querySelector('.shell').classList.add('inspector-open');
    $('inspector-resize').hidden = narrow;
    if (!inspector.open) {
      if (narrow) inspector.showModal();
      else inspector.show();
    }
    applyPanelWidths();
  }
  function applyPanelWidths() {
    const docked = $('inspector').open && !matchMedia('(max-width: 960px)').matches;
    const room = Math.max(0, innerWidth - 350 - (docked ? ui.inspectorWidth : 0));
    const rail = Math.min(ui.railWidth, Math.max(220, Math.min(520, room)));
    const inspector = Math.min(ui.inspectorWidth, Math.max(300, Math.min(720, innerWidth - rail - 350)));
    document.documentElement.style.setProperty('--rail-w', `${rail}px`);
    document.documentElement.style.setProperty('--inspector-w', `${inspector}px`);
    $('rail-resize').setAttribute('aria-valuenow', String(Math.round(rail)));
    $('inspector-resize').setAttribute('aria-valuenow', String(Math.round(inspector)));
  }
  function initializeAppearance() {
    try {
      const preferences = JSON.parse(localStorage.getItem('vibehub-dashboard-appearance') || '{}');
      if (['system', 'light', 'dark'].includes(preferences.theme)) ui.theme = preferences.theme;
      if (Number.isFinite(preferences.railWidth))
        ui.railWidth = Math.max(220, Math.min(520, preferences.railWidth));
      if (Number.isFinite(preferences.inspectorWidth))
        ui.inspectorWidth = Math.max(300, Math.min(720, preferences.inspectorWidth));
    } catch {}
    const save = () => {
      try {
        localStorage.setItem(
          'vibehub-dashboard-appearance',
          JSON.stringify({ theme: ui.theme, railWidth: ui.railWidth, inspectorWidth: ui.inspectorWidth }),
        );
      } catch {}
    };
    const system = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => {
      document.documentElement.dataset.theme =
        ui.theme === 'system' ? (system.matches ? 'dark' : 'light') : ui.theme;
      document
        .querySelectorAll('button[data-theme]')
        .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.theme === ui.theme)));
    };
    system.addEventListener('change', theme);
    document.querySelectorAll('button[data-theme]').forEach((button) =>
      button.addEventListener('click', () => {
        ui.theme = button.dataset.theme;
        theme();
        save();
      }),
    );
    theme();
    for (const [id, key, sign, min, max] of [
      ['rail-resize', 'railWidth', 1, 220, 520],
      ['inspector-resize', 'inspectorWidth', -1, 300, 720],
    ]) {
      const handle = $(id);
      let drag = null;
      const set = (value) => {
        ui[key] = Math.max(min, Math.min(max, value));
        applyPanelWidths();
      };
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag = { x: event.clientX, width: ui[key] };
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
        document.body.classList.add('is-resizing');
      });
      handle.addEventListener('pointermove', (event) => {
        if (drag) set(drag.width + (event.clientX - drag.x) * sign);
      });
      const end = () => {
        if (!drag) return;
        drag = null;
        handle.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing');
        save();
      };
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
        handle.addEventListener(event, end);
      handle.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        set(
          event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : ui[key] + (event.key === 'ArrowRight' ? 1 : -1) * sign * (event.shiftKey ? 40 : 10),
        );
        save();
      });
    }
    window.addEventListener('resize', () => {
      if ($('inspector').open) openInspector();
      else applyPanelWidths();
    });
    applyPanelWidths();
  }
  function closeDetail(restore = true, keepSelection = false) {
    if (!keepSelection) {
      ui.ticket = null;
      ui.context = null;
      document.querySelector('.relationship-strip')?.remove();
      document
        .querySelectorAll('[data-work-key][aria-pressed=true]')
        .forEach((button) => button.setAttribute('aria-pressed', 'false'));
    }
    document.querySelector('.shell').classList.remove('inspector-open');
    $('inspector-resize').hidden = true;
    ticketDetailCleanup?.();
    ticketDetailCleanup = null;
    document.querySelector('.ticket-content')?.remove();
    document.querySelector('.detail-view-tabs')?.remove();
    document.querySelector('.ticket-next-step')?.remove();
    $('detail-meta').replaceChildren();
    $('detail-actions').replaceChildren();
    $('inspector').classList.remove('reference-dialog', 'ticket-dialog');
    if ($('inspector').open) $('inspector').close();
    lastFocused?.setAttribute('aria-pressed', 'false');
    if (restore && lastFocused?.isConnected) lastFocused.focus();
  }
  async function loadRepositoryTickets() {
    const turn = generation;
    repositoryItems = [];
    repositoryEdges = [];
    sourceWarnings = [];
    const trees = data.projects.flatMap((project) =>
      project.worktrees
        .filter((t) => t.hasTickets && t.available)
        .map((tree) => ({ ...tree, projectName: project.name })),
    );
    for (const tree of trees) {
      if (turn !== generation) return;
      try {
        const graph = await api(`/api/tickets?workspace=${encodeURIComponent(tree.id)}&scope=all`);
        if (turn !== generation) return;
        const native = fromRepositoryGraph(tree, graph, tree.projectName);
        repositoryItems.push(...native.items);
        repositoryEdges.push(...native.edges);
      } catch (error) {
        sourceWarnings.push({ path: tree.path, message: error.message });
      }
    }
    if (turn !== generation) return;
    showPersonal();
    showWarnings();
    status(
      `${data.projects.length} projects · ${data.projects.reduce((n, p) => n + p.worktrees.length, 0)} worktrees · ${items.filter(isGroup).length} goals · ${items.length} tickets${sourceWarnings.length ? ` · ${sourceWarnings.length} checkout errors` : ''}`,
    );
  }
  async function refresh() {
    if ($('refresh').disabled) return;
    let revision = navigationRevision;
    let restore = { ...ui, lanes: new Set(ui.lanes), search: $('search').value };
    closeDetail(false);
    $('refresh').disabled = true;
    $('refresh-dashboard').disabled = true;
    status('Refreshing workspaces…');
    try {
      const discovered = await api('/api/dashboard');
      if (!data) {
        revision = navigationRevision;
        restore = { ...ui, lanes: new Set(ui.lanes), search: $('search').value };
      }
      if (revision !== navigationRevision) return;
      data = discovered;
      showWarnings();
      renderNav();
      const tree = selectedTree();
      if (tree) await readWorkspace(tree);
      else {
        showPersonal();
        await loadRepositoryTickets();
      }
      if (revision !== navigationRevision) return;
      const parent = items.find(
        (item) =>
          isGroup(item) && (item.id === restore.selectedGoal || item.originalId === restore.selectedGoal),
      );
      Object.assign(ui, {
        surface: restore.surface,
        view: restore.view,
        scope: restore.scope,
        lanes: restore.lanes,
        direction: restore.direction,
        history: restore.history,
        selectedGoal: parent?.id || null,
        camera: restore.camera,
        ticket: items.some((item) => item.id === restore.ticket) ? restore.ticket : null,
      });
      $('search').value = restore.search;
      syncUrl();
      renderNav();
      renderWork();
      if (['contexts', 'authority'].includes(ui.surface)) {
        await loadContexts();
        if (revision !== navigationRevision) return;
        const record = contextRecords.find(
          (record) => `${record.workspace}:${record.context_id}` === restore.context,
        );
        const trigger = [...document.querySelectorAll('[data-context-key]')].find(
          (button) => button.dataset.contextKey === restore.context,
        );
        if (record) showContext(record, trigger || $('heading'));
      }
      if (restore.ticket) {
        const item = items.find((t) => t.id === restore.ticket),
          trigger = [...document.querySelectorAll('[data-work-key]')].find(
            (button) => button.dataset.workKey === restore.ticket,
          );
        if (item) showDetail(item, trigger || $('heading'));
      }
    } catch (error) {
      if (revision === navigationRevision) status(error.message);
    } finally {
      $('refresh').disabled = false;
      $('refresh-dashboard').disabled = false;
    }
  }
  function closeNavigation() {
    closeProjectPicker();
    if (!$('navigation-dialog').open) return;
    document.querySelector('.shell').prepend(document.querySelector('.sidebar'));
    $('navigation-dialog').close();
    $('navigation-toggle').focus();
  }
  $('project-trigger').addEventListener('click', () => {
    $('project-popover').matches(':popover-open') ? closeProjectPicker(true) : openProjectPicker();
  });
  $('project-trigger').addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      openProjectPicker();
      if (event.key === 'ArrowUp') setActiveProject(projectChoices.length - 1);
    }
  });
  $('project-query').addEventListener('input', renderProjectOptions);
  $('project-query').addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (projectChoices.length)
        setActiveProject(
          (activeProjectChoice + (event.key === 'ArrowDown' ? 1 : -1) + projectChoices.length) %
            projectChoices.length,
        );
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      chooseProject(activeProjectChoice);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeProjectPicker(true);
    }
    if (event.key === 'Tab') {
      closeProjectPicker(true);
    }
  });
  $('project-popover').addEventListener('toggle', () => {
    const open = $('project-popover').matches(':popover-open');
    $('project-trigger').setAttribute('aria-expanded', String(open));
    $('project-query').setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('resize', () => {
    if ($('project-popover').matches(':popover-open')) positionProjectPicker();
  });
  document.querySelector('.sidebar-scroll').addEventListener('scroll', () => {
    if ($('project-popover').matches(':popover-open')) positionProjectPicker();
  });
  $('navigation-toggle').addEventListener('click', () => {
    $('navigation-dialog').append(document.querySelector('.sidebar'));
    $('navigation-dialog').showModal();
    $('close-navigation').focus();
  });
  $('close-navigation').addEventListener('click', closeNavigation);
  $('navigation-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeNavigation();
  });
  matchMedia('(min-width: 769px)').addEventListener('change', (event) => {
    if (event.matches) closeNavigation();
  });
  document.querySelector('.skip').addEventListener('click', (event) => {
    event.preventDefault();
    $('main').tabIndex = -1;
    $('main').focus();
  });
  $('refresh-dashboard').addEventListener('click', refresh);
  $('home').addEventListener('click', () => {
    closeNavigation();
    closeDetail(false);
    changeSurface('goals');
  });
  function changeSurface(next) {
    navigationRevision++;
    closeNavigation();
    if (ui.selectedGoal && next === 'tickets') {
      ui.surface = 'tickets';
      syncUrl();
      closeDetail(false);
      renderWork();
      return;
    }
    contextGeneration++;
    ui.surface = next;
    ui.selectedGoal = null;
    ui.view = 'board';
    closeDetail(false);
    resetFilters();
    syncUrl();
    $('heading').textContent = projectForTree()?.name || 'All work';
    $('breadcrumb').textContent = selectedTree()?.path || 'Connected workspace';
    renderNav();
    renderWork();
    if (data && ['contexts', 'authority'].includes(next)) loadContexts();
  }
  document
    .querySelectorAll('[data-surface]')
    .forEach((b) => b.addEventListener('click', () => changeSurface(b.dataset.surface)));
  $('back-goals').addEventListener('click', () => changeSurface('goals'));
  $('focus-mode').addEventListener('click', () => {
    const active = document.querySelector('.shell').classList.toggle('focus-mode');
    $('focus-mode').setAttribute('aria-pressed', String(active));
    $('focus-mode').setAttribute('aria-label', active ? 'Restore workspace' : 'Expand workspace');
  });
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll('#workspace-menu,.start'))
      if (!menu.contains(event.target)) menu.open = false;
  });
  $('project-search').addEventListener('input', renderNav);
  $('project-select').addEventListener('change', () => {
    const project = data.projects.find((p) => p.id === $('project-select').value);
    if (!project) return navigateHome();
    const tree =
      project.worktrees.find((t) => t.available && t.branch === 'main') ||
      project.worktrees.find((t) => t.available) ||
      project.worktrees[0];
    if (tree) selectWorkspace(tree);
  });
  $('branch-select').addEventListener('change', () => {
    const project = data.projects.find((p) => p.id === $('project-select').value);
    const tree =
      project?.worktrees.find((t) => t.branch === $('branch-select').value && t.available) ||
      project?.worktrees.find((t) => t.branch === $('branch-select').value);
    if (tree) selectWorkspace(tree);
  });
  $('worktree-select').addEventListener('change', () => {
    const tree = data.projects.flatMap((p) => p.worktrees).find((t) => t.id === $('worktree-select').value);
    if (tree) selectWorkspace(tree);
  });
  document.querySelectorAll('[data-view]').forEach((button) =>
    button.addEventListener('click', () => {
      navigationRevision++;
      ui.view = button.dataset.view;
      closeDetail(false);
      ui.camera = null;
      syncUrl();
      renderWork();
    }),
  );
  $('refresh').addEventListener('click', refresh);
  $('search').addEventListener('input', () => {
    navigationRevision++;
    ui.camera = null;
    renderWork();
  });
  document.querySelectorAll('[data-ticket-scope]').forEach((button) =>
    button.addEventListener('click', () => {
      ui.scope = button.dataset.ticketScope;
      ui.selectedGoal = null;
      changeSurface('tickets');
      syncUrl();
    }),
  );
  document.querySelectorAll('[data-direction]').forEach((button) =>
    button.addEventListener('click', () => {
      navigationRevision++;
      ui.direction = button.dataset.direction;
      ui.camera = null;
      syncUrl();
      renderWork();
    }),
  );
  document.querySelectorAll('[data-history]').forEach((button) =>
    button.addEventListener('click', () => {
      navigationRevision++;
      ui.history = button.dataset.history;
      ui.camera = null;
      syncUrl();
      renderWork();
    }),
  );
  $('copy-request').addEventListener('click', () => {
    const request = $('request').value.trim();
    if (!request) {
      $('request').focus();
      return;
    }
    const tree = selectedTree();
    copyText(
      `Record this goal and its tasks with VibeHub: ${request}\n${tree ? `Working directory: ${tree.path}\n` : ''}\nKeep the goal, tasks and Context local unless I explicitly request sharing. Never force-add ignored records. Record what each task is for, relevant context, and its direct dependencies. Completion criteria are useful when known; an unfinished idea can remain open. Use my chosen skills and working methods for any requested implementation. Record progress, results and status with vibehub-ticket. VibeHub remains optional.`,
    );
  });
  $('close-detail').addEventListener('click', () => closeDetail());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('inspector').open) closeDetail();
      for (const menu of document.querySelectorAll('.header-actions details[open]')) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    }
  });
  $('inspector').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDetail();
  });
  $('inspector').addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || !$('inspector').matches(':modal')) return;
    const controls = [
      ...$('inspector').querySelectorAll(
        'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]',
      ),
    ].filter((node) => node.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  const outsideDetail = (event) => {
    const rect = $('inspector').getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  let backdropPressed = false;
  $('inspector').addEventListener('pointerdown', (event) => {
    backdropPressed = event.target === $('inspector') && outsideDetail(event);
  });
  $('inspector').addEventListener('click', (event) => {
    if (backdropPressed && event.target === $('inspector') && outsideDetail(event)) closeDetail();
    backdropPressed = false;
  });
  let lastSessionActivity = 0,
    sessionRenewing = false;
  const sessionNotice = el('p', undefined, 'session-notice');
  sessionNotice.hidden = true;
  sessionNotice.setAttribute('role', 'status');
  document.querySelector('.workspace-header').after(sessionNotice);
  async function renewActiveSession(event) {
    if (
      document.visibilityState !== 'visible' ||
      (event && !event.isTrusted) ||
      sessionRenewing ||
      Date.now() - lastSessionActivity < 60_000
    )
      return;
    lastSessionActivity = Date.now();
    sessionRenewing = true;
    try {
      await api('/api/session-active');
      sessionNotice.hidden = true;
    } catch {
      sessionNotice.textContent =
        'The local session is unavailable. Reopen the dashboard through VibeHub to reconnect. Your saved work is unchanged.';
      sessionNotice.hidden = false;
    } finally {
      sessionRenewing = false;
    }
  }
  for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'])
    document.addEventListener(name, renewActiveSession, { passive: true });
  document.addEventListener('visibilitychange', (event) => {
    if (document.visibilityState === 'visible') renewActiveSession(event);
  });
  renewActiveSession();
  initializeAppearance();
  document.querySelectorAll('[data-icon]').forEach((node) => node.append(icon(node.dataset.icon)));
  refresh();
})();
