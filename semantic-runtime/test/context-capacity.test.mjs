import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, publish, head, rows, git, bind } from './helpers/context-fixture.mjs';
import { records } from './helpers/canonical-reader-fixture.mjs';

function largeShared(t, bytes, large = true) {
  const template = records().authority, values = {};
  for (let index = 0; index < 4; index++) values[`authority-${index}`] = {
    ...structuredClone(template), context_id: `authority-large-${index}`, detail: 'x'.repeat(bytes)
  };
  const f = fixture(t, { canonical: true, values });
  const pin = { at: f.canonical.graph_revision, address: f.canonical.address, record_keys: Object.keys(values) };
  f.explorations.setProjectSelection(f.context, { epoch: f.epoch, idempotency_key: 'large-project', expected_version: null, pin });
  git(f.folder, 'switch', '-c', 'large-contexts'); f.refresh();
  f.a = bind(f, { key: 'large-origin', shared_base: pin });
  for (let index = 0; index < 16; index++) publish(f, `large-context-${index}`, { typed: {
    summary: large ? '\u0000'.repeat(512) : 'Small synthetic Context', detail: large ? '\u0000'.repeat(8192) : '', reason: large ? '\u0000'.repeat(2048) : 'Synthetic size control'
  } });
  return f;
}

test('aggregate Context response bound includes shared Authority material and refuses without truncation or effects', t => {
  const small = largeShared(t, 2000, false), request = f => ({ exploration_id: f.a.exploration_id, at: head(f), mode: 'current',
    collection: { kind: 'heads' }, cursor: null, limit: 16 });
  const control = small.contexts.page(small.context, request(small));
  assert.equal(control.local.items.length, 16); assert.equal(control.shared.governing.length, 8);
  assert(Buffer.byteLength(JSON.stringify(control)) < 1048576);
  const large = largeShared(t, 12000), before = rows(large);
  // Each configured record/selection and individual context is within its own
  // accepted limit; their combined response must still respect the outer bound.
  assert.throws(() => large.contexts.page(large.context, request(large)), error =>
    ['graph_capacity', 'context_capacity'].includes(error.code));
  assert.deepEqual(rows(large), before);
});
