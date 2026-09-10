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
