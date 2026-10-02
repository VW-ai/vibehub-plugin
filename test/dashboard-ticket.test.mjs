import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const sandbox = {};
vm.runInNewContext(readFileSync(new URL('../skills/vibehub-review/assets/dashboard-ticket.js', import.meta.url), 'utf8'), sandbox);
const { contentFor } = sandbox.VibeHubTicket;

test('ticket requirements preserve human authority and constraints without reviving retired criteria', () => {
  const saved = { outcome:'Choose an editor', context:'Users need accessible editing.', constraints:['Local only'], acceptance:[
    { criterion:'Choose an editor', state:'active', authority:'human' },
    { criterion:'Keyboard navigation works', state:'active', authority:'agent' },
    { criterion:'Approve the prototype', state:'active', authority:'human' },
    { criterion:'Use the previous layout', state:'retired', authority:'agent' },
  ] };
  const content = contentFor({title:'Editor', outcome:'Old description'}, saved);
  assert.equal(content.description, saved.outcome);
  assert.equal(content.background, saved.context);
  assert.deepEqual(Array.from(content.criteria, c => [c.criterion,c.authority]), [
    ['Keyboard navigation works','agent'], ['Approve the prototype','human'],
  ]);
  assert.deepEqual(Array.from(content.constraints), ['Local only']);
  assert.equal(saved.acceptance.length, 4);
});

test('a ticket keeps its available description while requirements are unavailable', () => {
  const content = contentFor({title:'Describe the task',outcome:'Describe the task'}, null);
  assert.equal(content.description,'Describe the task');
  assert.equal(content.criteria.length,0);
  assert.equal(content.constraints.length,0);
  assert.equal(contentFor({},null).description,'');
});

test('rendered task details show progress and history and copy a personal-workflow brief', async () => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.text = ''; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
    get childElementCount() { return this.children.length; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.text = ''; this.append(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  }
  const container = new Element('div'), actions = new Element('div');
  sandbox.document = { createElement: tag => new Element(tag), getElementById: id => id === 'detail-actions' ? actions : null };
  let copied = null;
  sandbox.VibeHubTicket.mount({
    container,
    item: { id: 'search', title: 'Search settings', outcome: 'Find settings.', path: '/demo/.vibehub/tickets/search.yaml', ticket: true },
    workflow: { lane: 'ready', detail: 'Task reopened.' },
    dependencies: [{ id: 'data', title: 'Settings data' }], dependents: [], goals: [], navigate() {},
    loadDetails: async () => ({
      outcome: 'Find settings by their translated name.', context: 'People could not find translated settings.',
      contextRefs: [{ ref: 'docs/settings.md', purpose: 'Settings behavior' }],
      updates: [
        { update_id: 'done', status: 'done', summary: 'Search was added.', recorded_at: '2026-10-01T12:00:00Z', refs: [] },
        { update_id: 'reopen', status: 'open', summary: 'Reopened for translated names.', recorded_at: '2026-10-02T12:00:00Z', refs: ['issue:settings'] },
      ],
      evidence: [{ summary: 'Earlier keyboard checks passed.' }],
      outcomeHistory: [{ status: 'successful', summary: 'Earlier review accepted the first version.' }],
    }),
    copy: value => { copied = value; }, contractUrl: '/?ticket=search&view=contract',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(container.textContent, /Progress and results/u);
  assert.match(container.textContent, /Search was added/u);
  assert.match(container.textContent, /Reopened for translated names/u);
  assert.match(container.textContent, /Historical proof/u);
  assert.match(container.textContent, /Earlier review accepted/u);
  const copyButton = actions.children.find(node => node.tagName === 'button');
  assert.equal(copyButton.textContent, 'Copy task brief');
  copyButton.events.click();
  assert.match(copied, /my chosen skills and working methods/u);
  assert.match(copied, /Depends on: data/u);
  assert.match(copied, /Context: docs\/settings.md/u);
  assert.match(copied, /Reopened for translated names/u);
  assert.doesNotMatch(copied, /independent closeout|CLOSE_OUT|vibehub-ticket-(run|plan|closeout)/u);
});
