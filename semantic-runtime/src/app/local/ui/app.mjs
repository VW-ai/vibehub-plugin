export const ROUTES = Object.freeze({
  typesafe: { name: 'TypeSafe', detail: 'Official JEV API', model: 'jev-latest' },
  vercel: { name: 'Vercel AI Gateway', detail: 'JEV through the Gateway', model: 'typesafe-ai/jev' },
  openrouter: { name: 'OpenRouter', detail: 'JEV through OpenRouter', model: 'typesafe/jev-1.13' },
});
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const route = provider => ({ provider, model: ROUTES[provider].model, capability: 'semantic-judge-v0' });
export function providerConfig(provider, { timeout_ms, max_attempts, fallbacks = [] }) {
  if (!Object.hasOwn(ROUTES, provider) || !Array.isArray(fallbacks) || fallbacks.some(p => !Object.hasOwn(ROUTES, p) || p === provider)
    || new Set(fallbacks).size !== fallbacks.length || !Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 120000
    || !Number.isInteger(max_attempts) || max_attempts < 1 || max_attempts > 3) throw Object.assign(new Error('Invalid settings'), { code: 'invalid_config' });
  return { primary: route(provider), fallbacks: fallbacks.map(route), timeout_ms, max_attempts };
}
export const credentialLabel = state => state === 'configured' ? 'Key configured · unverified' : state === 'error' ? 'Secure store unavailable' : 'No API key';
const MESSAGES = Object.freeze({
  pairing_unavailable: 'Pairing needs an interactive launch terminal. Run npm run app in a terminal, then return here.',
  pairing_busy: 'Another browser is waiting for approval. Finish that request in the launch terminal, or wait for it to expire.',
  preview_expired: 'This inspection has expired. Inspect the folder again before continuing.',
  invalid_preview: 'The folder inspection is no longer current. Inspect the folder again.',
  preview_changed: 'The folder changed after inspection. Inspect it again before enrolling.',
  cas_conflict: 'This project changed since it was loaded. Reload its current state before trying another change.',
  secure_store_unavailable: 'The secure store is unavailable. Check macOS Keychain access and Command Line Tools, then try again. No plaintext copy is saved.',
  settings_store_unavailable: 'Provider settings are unavailable. Check the launch terminal and local data directory, then reload.',
  unsupported_platform: 'Credential storage requires macOS Keychain in this version. Other project setup remains available.',
  invalid_credential: 'Enter a non-empty API key, at most 8 KiB, without line breaks.',
  invalid_config: 'Choose a supported route, a timeout from 100 to 120,000 ms, and 1–3 attempts.',
  invalid_folder: 'Enter the full absolute path to an existing local folder.',
  git_unavailable: 'Git is unavailable. Install the macOS Command Line Tools, restart the local app, then inspect this folder again.',
  git_initialize_failed: 'Git could not initialize this folder. Check its permissions, then inspect again before retrying.',
  discovery_changed: 'Git changed during inspection. Reload the project and refresh Git again.',
  enrollment_incomplete: 'The enrollment attempt is saved. Reload the project list and retry its saved enrollment.',
  project_not_found: 'This project is unavailable. Reload the project list.',
  setup_busy: 'The local app is handling other setup work. Reload to check its saved state before trying again.',
  setup_closed: 'The local app has stopped. Start it in the launch terminal and reconnect.',
  not_directory: 'That path is not an accessible folder. Check it and inspect again.',
  git_inspection_failed: 'Git could not inspect this folder. Check its path and Git availability, then inspect again.',
  project_not_enrolled: 'Finish enrolling a Git folder before enabling this project.',
  unknown_project: 'This project is unavailable. Reload the project list.',
  project_limit: 'This local app has reached its project limit. Existing projects remain available.',
  invalid_setup_input: 'Check the selected folder or settings and try again.',
  store_busy: 'The local database is busy. Reload to check the saved state before retrying.',
  store_unavailable: 'Local storage is unavailable. Check the launch terminal; saved files have not been removed.',
  store_closed: 'The local app has stopped. Start it in the launch terminal and reconnect.',
});
export const errorMessage = code => Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : 'The operation could not finish. Reload to check the current state before trying again.';

/** Small UI controller: ephemeral view state only. Keys never enter state or rendered data. */
export class SetupClient {
  #fetch; #changed; #clearSecret; #generation = 0; #timer; #disposed = false;
  constructor({ fetchImpl = (...args) => fetch(...args), onChange = () => {}, clearSecret = () => {} } = {}) {
    this.#fetch = fetchImpl; this.#changed = onChange; this.#clearSecret = clearSecret;
    this.state = { connection: 'connecting', session: { state: 'unpaired', pairing_available: false }, projects: [], capabilities: null,
      selectedProjectId: null, project: null, provider: 'typesafe', draft: { timeout_ms: 10000, max_attempts: 1, fallbacks: [] },
      adding: false, folder: '', name: '', preview: null, busy: false, loading: false, needsReload: false, error: null, notice: null };
  }
  #emit() { if (!this.#disposed) this.#changed(this.state); }
  #ticket() { return { generation: this.#generation, project_id: this.state.selectedProjectId }; }
  #current(ticket) { return !this.#disposed && ticket.generation === this.#generation && ticket.project_id === this.state.selectedProjectId; }
  #ready() { return !this.#disposed && this.state.session.state === 'paired' && this.state.connection === 'online'; }
  #invalidate() { this.#generation++; this.#clearSecret(); this.state.busy = false; this.state.loading = false; this.state.needsReload = false; }
  #forget() {
    this.#invalidate(); this.state.project = null; this.state.projects = []; this.state.preview = null; this.state.selectedProjectId = null;
    this.state.folder = ''; this.state.name = ''; this.state.capabilities = null; this.state.adding = false;
    this.state.notice = null;
    this.state.provider = 'typesafe'; this.state.draft = { timeout_ms: 10000, max_attempts: 1, fallbacks: [] };
  }
  async #request(path, body) {
    let response;
    // The first native Keychain operation may compile its helper (60s), then run (10s).
    // A Project read can inspect three configured providers serially after that compile.
    const timeout = body?.action === 'project.read' ? 95_000 : ['provider.replace', 'provider.remove'].includes(body?.action) ? 75_000 : 30_000;
    try { response = await this.#fetch(path, { credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-VibeHub-Setup': '1' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout) }); }
    catch { throw Object.assign(new Error('Local connection unavailable'), { code: 'offline' }); }
    let result; try { result = await response.json(); } catch { throw Object.assign(new Error('Invalid local response'), { code: 'invalid_response' }); }
    if (!response.ok || result.ok === false) throw Object.assign(new Error('Local request rejected'), {
      code: typeof result.error?.code === 'string' ? result.error.code : 'request_failed', status: response.status });
    return result;
  }
  async #action(action, input = {}) { return (await this.#request('/v1/setup/action', { action, input })).data; }
  #failure(error) {
    this.#clearSecret(); this.state.notice = null;
    if (error?.status === 401 || error?.code === 'setup_unauthorized') {
      this.#forget(); this.state.session = { state: 'unpaired', pairing_available: true };
      this.state.error = 'Your local session ended. Pair this browser again to continue.';
    } else if (error?.code === 'offline') {
      this.#forget(); this.state.connection = 'offline'; this.state.error = 'Connection lost. Reconnect to check what was saved; no change is retried automatically.';
    } else { this.state.error = errorMessage(error?.code); if (error?.code === 'cas_conflict') this.state.needsReload = true; }
    this.#emit();
  }
  async connect() {
    clearTimeout(this.#timer); this.#invalidate(); const ticket = this.#ticket(); this.state.connection = 'connecting'; this.state.error = null; this.state.notice = null; this.#emit();
    try {
      const session = await this.#request('/v1/setup/session'); if (!this.#current(ticket)) return;
      this.state.session = session; this.state.connection = 'online'; this.state.error = null;
      if (session.state === 'paired') await this.#loadProjects(ticket);
      else { this.#forget(); this.#poll(); }
    } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    this.#emit();
  }
  #poll() {
    clearTimeout(this.#timer);
    if (this.state.session.state === 'pending' && this.state.connection === 'online' && !this.#disposed) {
      this.#timer = setTimeout(() => this.connect(), 1000);
    }
  }
  async pair() {
    if (this.#disposed || this.state.busy || this.state.connection !== 'online' || this.state.session.state !== 'unpaired' || !this.state.session.pairing_available) return;
    this.state.busy = true; this.state.error = null; const ticket = this.#ticket(); this.#emit();
    try {
      const session = await this.#request('/v1/setup/pair', {}); if (!this.#current(ticket)) return;
      this.state.session = session; this.#poll();
    } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    finally { if (this.#current(ticket)) { this.state.busy = false; this.#emit(); } }
  }
  async #loadProjects(ticket, selectId) {
    const data = await this.#action('projects.list'); if (!this.#current(ticket)) return;
    this.state.projects = data.projects; this.state.capabilities = data.capabilities;
    const chosen = selectId ?? this.state.selectedProjectId ?? data.projects[0]?.project_id;
    if (chosen && data.projects.some(p => p.project_id === chosen)) await this.selectProject(chosen);
    else { this.state.adding = true; this.state.project = null; this.#emit(); }
  }
  async reloadProjects() {
    if (!this.#ready() || this.state.busy) return; const ticket = this.#ticket();
    try { await this.#loadProjects(ticket); } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    this.#emit();
  }
  async #readProject(ticket, keepDraft = false) {
    const data = await this.#action('project.read', { project_id: ticket.project_id }); if (!this.#current(ticket)) return;
    this.state.project = data; this.state.capabilities = data.capabilities;
    this.state.projects = this.state.projects.map(p => p.project_id === ticket.project_id ? data.project : p);
    if (!keepDraft) {
      const config = data.providers.config; this.state.provider = config?.primary.provider ?? 'typesafe';
      this.state.draft = { timeout_ms: config?.timeout_ms ?? 10000, max_attempts: config?.max_attempts ?? 1,
        fallbacks: config?.fallbacks.map(item => item.provider) ?? [] };
    }
  }
  async selectProject(project_id) {
    if (!this.#ready() || !this.state.projects.some(p => p.project_id === project_id)) return;
    this.#invalidate(); this.state.selectedProjectId = project_id; this.state.project = null; this.state.adding = false;
    this.state.preview = null; this.state.error = null; this.state.notice = null; this.state.loading = true;
    const ticket = this.#ticket(); this.#emit();
    try { await this.#readProject(ticket); } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    finally { if (this.#current(ticket)) { this.state.loading = false; this.#emit(); } }
  }
  async reloadProject() {
    if (!this.#ready() || this.state.busy || this.state.loading || !this.state.selectedProjectId) return;
    this.#clearSecret(); const ticket = this.#ticket(); this.state.loading = true; this.state.error = null; this.#emit();
    try { await this.#readProject(ticket); if (this.#current(ticket)) this.state.needsReload = false; }
    catch (error) { if (this.#current(ticket)) this.#failure(error); }
    finally { if (this.#current(ticket)) { this.state.loading = false; this.#emit(); } }
  }
  addProject() {
    if (!this.#ready()) return;
    this.#invalidate(); this.state.selectedProjectId = null; this.state.project = null; this.state.adding = true;
    this.state.folder = ''; this.state.name = ''; this.state.preview = null; this.state.error = null; this.state.notice = null; this.#emit();
  }
  editFolder(folder) { if (this.state.busy) return; this.state.folder = folder; if (this.state.preview) { this.state.preview = null; this.#emit(); } }
  editName(name) { this.state.name = name; }
  async #folderAction(action, input) {
    if (!this.#ready() || this.state.busy || !this.state.adding) return; const ticket = this.#ticket(); this.state.busy = true; this.state.error = null; this.state.notice = null; this.#emit();
    try {
      const data = await this.#action(action, input); if (!this.#current(ticket)) return;
      if (action === 'projects.enroll') { this.state.preview = null; await this.#loadProjects(ticket, data.project_id); }
      else { this.state.preview = data; if (!this.state.name) this.state.name = this.state.folder.split('/').filter(Boolean).at(-1)?.slice(0, 80) ?? 'New project'; }
    } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    finally { if (this.#current(ticket)) { this.state.busy = false; this.#emit(); } }
  }
  inspect(folder) { this.state.folder = folder; this.state.preview = null; return this.#folderAction('folder.inspect', { folder }); }
  initialize() { if (this.state.preview?.inspection.status === 'not_git') return this.#folderAction('folder.initialize', { preview_id: this.state.preview.preview_id }); }
  enroll(name) { if (this.state.preview?.inspection.status === 'git') { this.state.name = name; return this.#folderAction('projects.enroll', { preview_id: this.state.preview.preview_id, name }); } }
  chooseProvider(provider) {
    if (!this.#ready() || this.state.busy || this.state.loading || !Object.hasOwn(ROUTES, provider)) return;
    this.#clearSecret(); this.state.provider = provider; this.state.draft.fallbacks = this.state.draft.fallbacks.filter(p => p !== provider);
    this.state.error = null; this.state.notice = null; this.#emit();
  }
  editDraft(values) { this.state.draft = { ...this.state.draft, ...values }; }
  async #projectAction(action, input, notice) {
    if (!this.#ready() || this.state.busy || this.state.loading || this.state.needsReload || !this.state.project) return;
    const ticket = this.#ticket(); this.state.busy = true; this.state.error = null; this.state.notice = null; this.#emit();
    try {
      await this.#action(action, { project_id: ticket.project_id, ...input }); if (!this.#current(ticket)) return;
      await this.#readProject(ticket, true); if (this.#current(ticket)) this.state.notice = notice;
    } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    finally { if (this.#current(ticket)) { this.state.busy = false; this.#emit(); } }
  }
  retry() { return this.#projectAction('projects.retry', {}, 'Project enrollment checked.'); }
  refresh(checkout_id) { return this.#projectAction('project.refresh', { checkout_id, expectedVersion: this.state.project?.git?.version }, 'Git inventory refreshed.'); }
  setEnabled() {
    const activation = this.state.project?.activation; if (!activation) return;
    return this.#projectAction('project.activation', { enabled: !activation.state.enabled, expectedVersion: activation.version }, 'Project switch updated. No connected collector or Worker is started by this setup page.');
  }
  saveConfig(values) {
    try { const config = providerConfig(this.state.provider, values); this.state.draft = { ...values }; return this.#projectAction('provider.configure', { config }, 'Provider configuration saved. No model call was made.'); }
    catch (error) { this.#failure(error); this.#emit(); }
  }
  replaceSecret(secret) {
    this.#clearSecret();
    if (this.state.capabilities?.secure_store === 'unsupported') return;
    if (!secret) { this.#failure({ code: 'invalid_credential' }); this.#emit(); return; }
    return this.#projectAction('provider.replace', { provider: this.state.provider, secret }, 'API key saved to the secure store. It has not been verified with the provider.');
  }
  removeSecret() { this.#clearSecret(); if (this.state.capabilities?.secure_store === 'unsupported') return; return this.#projectAction('provider.remove', { provider: this.state.provider }, 'API key removed from this project’s secure store.'); }
  async stop() {
    if (!this.#ready()) return;
    this.#invalidate(); const ticket = this.#ticket(); this.state.busy = true; this.#emit();
    try {
      await this.#request('/v1/setup/stop', {}); if (!this.#current(ticket)) return;
      this.#forget(); this.state.connection = 'stopped'; this.state.error = null;
    } catch (error) { if (this.#current(ticket)) this.#failure(error); }
    finally { if (this.#current(ticket)) this.state.busy = false; this.#emit(); }
  }
  dispose() { this.#disposed = true; clearTimeout(this.#timer); this.#clearSecret(); }
}

const esc = escapeHtml;
const disabled = value => value ? ' disabled' : '';
const badge = (label, tone = '') => `<span class="badge ${tone}">${esc(label)}</span>`;
const button = (label, action, options = {}) => `<button data-action="${action}"${options.id ? ` id="${esc(options.id)}"` : ''}${options.value ? ` data-value="${esc(options.value)}"` : ''} class="${options.class ?? ''}"${disabled(options.disabled)}>${esc(label)}</button>`;
const date = value => Number.isFinite(value) ? new Date(value).toLocaleString() : 'Not recorded';
const branch = worktree => worktree.unborn ? 'No commits yet' : worktree.detached ? 'Detached HEAD' : (worktree.branch?.replace(/^refs\/heads\//, '') ?? 'Branch unavailable');
function worktreeRows(worktrees = []) {
  return `<div class="worktree-list">${worktrees.map(w => `<div class="worktree-row"><span class="branch-icon" aria-hidden="true">⑂</span><div><strong>${esc(branch(w))}</strong><p class="path">${esc(w.path)}</p></div><div class="tree-state">${badge(w.state ?? w.status ?? 'observed', w.state === 'removed' || w.state === 'unavailable' ? 'muted-badge' : '')}${w.locked ? badge('locked', 'muted-badge') : ''}${w.prunable ? badge('prunable', 'muted-badge') : ''}${w.head ? `<small class="mono">${esc(w.head.slice(0, 12))}</small>` : ''}</div></div>`).join('') || '<p class="muted">No worktree is available.</p>'}</div>`;
}
function addView(state) {
  const p = state.preview?.inspection;
  return `<div class="page-heading"><div><span class="eyebrow">PROJECT SETUP</span><h1>Bring a project into view.</h1><p>Start with a folder on this computer. GitHub is optional.</p></div>${badge('LOCAL FILESYSTEM', 'muted-badge')}</div>
  <section class="card add-card"><div class="section-title"><span class="step-number">01</span><div><h2>Choose your project folder</h2><p>Paste its full absolute path. Only this selection is inspected.</p></div></div>
  <form id="inspect-form"><label for="folder">Folder path</label><div class="input-action"><input id="folder" name="folder" value="${esc(state.folder)}" placeholder="/Users/you/projects/my-project" required maxlength="4096" autocomplete="off" spellcheck="false"${disabled(state.busy)}><button class="primary"${disabled(state.busy)}>${state.busy ? 'Working…' : 'Inspect folder'}</button></div></form>
  ${p ? `<div class="inspection"><div class="section-heading"><h3>${p.status === 'git' ? 'Git folder found' : p.status === 'bare' ? 'Bare repository' : 'This folder is not a Git repository'}</h3>${badge(p.status === 'git' ? 'Inspected' : 'Action needed', p.status === 'git' ? '' : 'amber')}</div><p class="path">${esc(p.selected_path ?? state.folder)}</p>
    ${p.status === 'not_git' ? `<p>Initialize Git here to continue. Existing files stay intact; no commit, remote or activation is created.</p>${button('Initialize Git in this folder', 'initialize', { disabled: state.busy })}` : p.status === 'bare' ? '<p>Select a regular working folder or linked worktree to use this project.</p>' : `<p>${(p.worktrees ?? []).length} registered worktree(s), including locations outside the selected folder.</p>${worktreeRows(p.worktrees)}<form id="enroll-form"><label for="project-name">Project name</label><div class="input-action"><input id="project-name" name="name" value="${esc(state.name)}" required maxlength="80"${disabled(state.busy)}><button class="primary"${disabled(state.busy)}>Enroll project</button></div><small>Enrollment saves this Git identity. The project starts disabled.</small></form>`}</div>` : '<div class="selection-note"><span aria-hidden="true">⌁</span><p>One project can include worktrees in different folders. VibeHub discovers them through Git.</p></div>'}</section>`;
}
function providerView(state) {
  const project = state.project, provider = state.provider, info = ROUTES[provider], blocked = state.busy || state.loading || state.needsReload;
  const status = project.providers.statuses[provider]?.state ?? 'missing', unsupported = state.capabilities?.secure_store === 'unsupported';
  return `<section class="card provider-card"><div class="section-title"><span class="step-number">02</span><div><h2>Semantic-judgment provider</h2><p>Configure the API route for small JEV decisions.</p></div></div>
  <form id="provider-form"><label for="provider">Provider</label><select id="provider" name="provider"${disabled(blocked)}>${Object.entries(ROUTES).map(([id, r]) => `<option value="${id}"${provider === id ? ' selected' : ''}>${r.name}</option>`).join('')}</select><div class="model-row"><div><span class="field-caption">MODEL</span><p class="mono">${info.model}</p></div>${badge('Unverified', 'amber')}</div>
  <div class="budget-fields"><div><label for="timeout">Timeout <span class="muted">(ms)</span></label><input id="timeout" name="timeout" type="number" min="100" max="120000" step="1" required value="${esc(state.draft.timeout_ms)}"${disabled(blocked)}></div><div><label for="attempts">Maximum attempts</label><input id="attempts" name="attempts" type="number" min="1" max="3" step="1" required value="${esc(state.draft.max_attempts)}"${disabled(blocked)}></div></div>
  <fieldset class="fallbacks"><legend>Allowed fallback routes <span class="muted">· optional</span></legend>${Object.entries(ROUTES).filter(([id]) => id !== provider).map(([id, r]) => `<label class="check"><input type="checkbox" name="fallback" value="${id}"${state.draft.fallbacks.includes(id) ? ' checked' : ''}${disabled(blocked)}> ${r.name}</label>`).join('')}</fieldset>
  <button${disabled(blocked)}>Save provider settings</button></form>
  <div class="credential-box"><div class="section-heading"><h3>API key</h3>${badge(credentialLabel(status), status === 'error' ? 'amber' : 'muted-badge')}</div><p>${unsupported ? 'Secure credential storage is not supported on this platform yet. Project setup remains available.' : 'Stored in macOS Keychain for this project and provider. Existing keys are never displayed.'}</p>
  ${status === 'error' ? '<p class="inline-error">Check Keychain access and macOS Command Line Tools. You can continue setting up the project.</p>' : ''}
  <form id="credential-form"><label class="sr-only" for="api-key">New ${esc(info.name)} API key</label><input id="api-key" name="api-key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" maxlength="8192" placeholder="Paste a new API key" required${disabled(blocked || unsupported)}><div class="actions"><button class="primary"${disabled(blocked || unsupported)}>${status === 'configured' ? 'Replace API key' : 'Save API key'}</button>${button('Remove key', 'remove-key', { class: 'quiet', disabled: blocked || unsupported || status === 'missing' })}</div></form><small>Saving a key makes no model call. Configured does not mean verified.</small></div></section>`;
}
function projectView(state) {
  const { project, git, activation } = state.project, a = activation.state, blocked = state.busy || state.loading || state.needsReload;
  const checkouts = git?.value.checkouts ?? [], worktrees = checkouts.flatMap(c => c.worktrees);
  return `<div class="page-heading"><div><span class="eyebrow">PROJECT SETUP</span><h1>${esc(project.name)}</h1><p class="path">${esc(project.folder)}</p></div>${button('Reload status', 'reload-project', { class: 'quiet', disabled: state.busy || state.loading })}</div>
  ${project.state !== 'ready' ? `<section class="repair"><h2>Finish project enrollment</h2><p>The saved setup attempt is ${esc(project.state)}. Retry keeps this project’s identity and selected folder.</p>${button('Retry saved enrollment', 'retry', { disabled: blocked })}</section>` : ''}
  <section class="activation-card ${a.enabled ? 'is-enabled' : ''}"><div><div class="eyebrow">PROJECT SWITCH</div><h2>VibeHub is ${a.enabled ? 'enabled' : 'disabled'} for this project.</h2><p>${a.enabled ? 'This switch applies to every enrolled worktree.' : 'Enable when you want this project to use VibeHub.'} Collectors, plugins and Workers are not connected yet.</p><div class="activation-meta">${badge(`Epoch ${a.epoch}`, 'muted-badge')}<span>${a.enabled ? 'Project setting saved' : 'Your coding tools keep working'}</span></div></div>${button(a.enabled ? 'Disable project' : 'Enable project', 'activation', { class: a.enabled ? 'quiet' : 'primary', disabled: blocked || (!a.enabled && (project.state !== 'ready' || !worktrees.some(w => w.state === 'active'))) })}</section>
  <div class="setup-columns"><div class="main-column"><section class="card git-card"><div class="section-title"><span class="step-number">01</span><div><h2>Git & worktrees</h2><p>Registered locations for this project. Refresh to discover changes.</p></div></div>
  ${checkouts.map(c => `<div class="checkout"><div class="section-heading"><div><span class="field-caption">REPOSITORY · ${esc(c.state)}</span><p class="path">${esc(c.selected_path)}</p></div>${button('Refresh Git', 'refresh', { value: c.checkout_id, class: 'small', disabled: blocked })}</div>${worktreeRows(c.worktrees)}<details><summary>Branches <span>${c.refs.length}</span></summary><div class="ref-list">${c.refs.map(ref => `<div><span class="mono">${esc(ref.name.replace(/^refs\/heads\//, ''))}</span>${badge(ref.state === 'deleted' ? 'deleted' : c.worktrees.some(w => w.state === 'active' && w.branch === ref.name) ? 'checked out' : 'no checkout', 'muted-badge')}</div>`).join('') || '<p class="muted">No branch refs yet.</p>'}</div></details><small>Git metadata is an observation of this computer, not proof of uninterrupted history.</small></div>`).join('') || '<p class="muted">No repository is enrolled yet.</p>'}</section>
  <section class="card connection-card"><div class="section-title"><span class="step-number">03</span><div><h2>Coding agents & Workers</h2><p>API billing and CLI subscriptions are separate.</p></div></div><div class="integration-row"><span class="integration-mark" aria-hidden="true">C</span><div><strong>Codex</strong><small>Plugin & subscription Worker</small></div>${badge('Not connected', 'muted-badge')}</div><div class="integration-row"><span class="integration-mark claude" aria-hidden="true">✳</span><div><strong>Claude Code</strong><small>Plugin & subscription Worker</small></div>${badge('Not connected', 'muted-badge')}</div><p class="subtle-note">Live connections will be added separately. This setup page does not inspect logins, install plugins or collect conversations.</p></section></div>${providerView(state)}</div>
  <section class="history-note"><span aria-hidden="true">◷</span><div><strong>History stays. Gaps stay visible.</strong><p>${a.disabled_since ? `Disabled since ${esc(date(a.disabled_since.at_ms))}. ` : ''}${a.last_gap ? `Last disabled interval: ${esc(date(a.last_gap.from_ms))} – ${esc(date(a.last_gap.to_ms))}. ` : ''}Re-enabling never imports missed conversations automatically. An app outage has unknown coverage.</p></div></section>`;
}
export function mainMarkup(state) {
  if (['offline', 'stopped'].includes(state.connection)) return `<section class="welcome"><span class="eyebrow">LOCAL APP</span><h1>${state.connection === 'stopped' ? 'Paused here.<br>Your work continues.' : 'The local app is offline.'}</h1><p>Your saved data stays on this computer. Reuse your original launch command, including the same --data-dir and --port options if supplied. The default command is:</p><div class="command">npm run app</div><p>Use the URL printed by that launch, then pair this browser again if asked.</p>${button('Reconnect', 'reconnect', { class: 'primary' })}</section>`;
  if (state.session.state !== 'paired') {
    const pending = state.session.state === 'pending';
    return `<section class="welcome"><span class="eyebrow">VIBEHUB / LOCAL SETUP</span><h1>A home for your<br>project context.</h1><p>Connect this browser to the app running on your computer.</p><div class="pair-card"><div class="pair-icon" aria-hidden="true">⌘</div><h2>${pending ? 'Approve in your launch terminal' : 'Pair this browser'}</h2><p>${pending ? 'Match this code with the one in the terminal where you started VibeHub.' : 'The local app asks for approval in its launch terminal before showing any projects.'}</p>${pending ? `<div class="pair-code" aria-label="Pairing comparison code">${esc(state.session.code)}</div><p>Type <code>approve ${esc(state.session.code)}</code> in that terminal. This request expires after two minutes.</p><span class="waiting">Waiting for local approval…</span>` : state.connection === 'connecting' ? '<p>Checking the local connection…</p>' : state.session.pairing_available ? button('Request local approval', 'pair', { class: 'primary', disabled: state.busy }) : '<div class="inline-error">Pairing needs an interactive terminal. Start with <code>npm run app</code> in a terminal, then reconnect.</div>'}</div><p class="welcome-footnote">Your provider API key is never used to sign in to this app.</p>${!pending ? button('Check connection', 'reconnect', { class: 'quiet', disabled: state.busy }) : ''}</section>`;
  }
  if (state.loading || state.connection === 'connecting') return '<section class="loading-card"><span class="eyebrow">PROJECT SETUP</span><h1>Loading your project…</h1><p>Checking saved Git, provider and activation state.</p></section>';
  if (state.adding || !state.project) return addView(state);
  return projectView(state);
}

function mount() {
  const main = document.querySelector('#main'), dialog = document.querySelector('#stop-dialog'); let opener;
  const clearSecret = () => { const field = document.querySelector('#api-key'); if (field) field.value = ''; };
  function render(state) {
    const active = document.activeElement, focusId = active?.id, wasInMain = main.contains(active), selection = active?.type === 'text' ? active.selectionStart : null;
    const paired = state.session.state === 'paired' && state.connection === 'online';
    document.querySelector('#project-count').textContent = paired ? state.projects.length : '—';
    document.querySelector('#project-list').innerHTML = paired ? state.projects.map(p => `<button id="project-${esc(p.project_id)}" data-project="${esc(p.project_id)}" class="project-link${p.project_id === state.selectedProjectId ? ' selected' : ''}"${p.project_id === state.selectedProjectId ? ' aria-current="page"' : ''}><span class="project-monogram" aria-hidden="true">${esc(p.name.slice(0, 1).toUpperCase())}</span><span>${esc(p.name)}${p.state !== 'ready' ? '<small>Setup needs attention</small>' : ''}</span></button>`).join('') : '<p class="nav-empty">Pair to see your projects.</p>';
    document.querySelector('#add-project').hidden = !paired; document.querySelector('#reload-projects').hidden = !paired; document.querySelector('#stop-app').hidden = !paired;
    document.querySelector('#breadcrumb').textContent = paired && state.project ? state.project.project.name : 'Local setup';
    document.querySelector('#connection-status').textContent = state.connection === 'online' ? paired ? '● Local app · paired' : '○ Local app · unpaired' : state.connection === 'connecting' ? 'Connecting…' : '○ Local app · offline';
    const message = document.querySelector('#message'); message.hidden = !(state.error || state.notice); message.className = `message ${state.error ? 'error-message' : ''}`;
    message.textContent = state.error ?? state.notice ?? ''; message.setAttribute('role', state.error ? 'alert' : 'status');
    main.innerHTML = mainMarkup(state); main.setAttribute('aria-busy', String(state.busy || state.loading));
    document.querySelector('#announcement').textContent = state.error ?? state.notice ?? '';
    const surviving = focusId && document.getElementById(focusId);
    if (surviving && !surviving.disabled) { surviving.focus({ preventScroll: true }); if (selection !== null && surviving.setSelectionRange) surviving.setSelectionRange(selection, selection); }
    else if (wasInMain && !dialog.open) main.focus({ preventScroll: true });
  }
  const client = new SetupClient({ onChange: render, clearSecret });
  document.addEventListener('click', event => {
    const project = event.target.closest('[data-project]'); if (project) { client.selectProject(project.dataset.project); return; }
    const element = event.target.closest('[data-action]'); if (!element || element.disabled) return;
    const action = element.dataset.action;
    const handlers = { reconnect: () => client.connect(), pair: () => client.pair(), add: () => client.addProject(),
      initialize: () => client.initialize(), 'reload-project': () => client.reloadProject(), 'reload-projects': () => client.reloadProjects(), refresh: () => client.refresh(element.dataset.value),
      activation: () => client.setEnabled(), retry: () => client.retry(), 'remove-key': () => client.removeSecret(),
      stop: () => { clearSecret(); opener = element; dialog.showModal(); }, 'cancel-stop': () => dialog.close(),
      'confirm-stop': () => { dialog.close(); client.stop(); } };
    handlers[action]?.();
  });
  document.addEventListener('submit', event => {
    event.preventDefault(); const form = event.target;
    if (form.id === 'inspect-form') client.inspect(form.elements.folder.value);
    else if (form.id === 'enroll-form') client.enroll(form.elements.name.value);
    else if (form.id === 'provider-form') client.saveConfig({ timeout_ms: Number(form.elements.timeout.value), max_attempts: Number(form.elements.attempts.value),
      fallbacks: [...form.querySelectorAll('[name=fallback]:checked')].map(input => input.value) });
    else if (form.id === 'credential-form') client.replaceSecret(form.elements['api-key'].value);
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'folder') client.editFolder(event.target.value);
    if (event.target.id === 'project-name') client.editName(event.target.value);
    if (event.target.id === 'timeout') client.editDraft({ timeout_ms: Number(event.target.value) });
    if (event.target.id === 'attempts') client.editDraft({ max_attempts: Number(event.target.value) });
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'provider') client.chooseProvider(event.target.value);
    if (event.target.name === 'fallback') client.editDraft({ fallbacks: [...document.querySelectorAll('[name=fallback]:checked')].map(input => input.value) });
  });
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); else main.focus(); });
  window.addEventListener('pagehide', () => client.dispose()); client.connect();
}
if (typeof document !== 'undefined') mount();
