import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture, judgeTransport, judgeResponse } from '../support/judge-runtime-fixture.mjs';
import { git, pin } from '../support/exploration-fixture.mjs';

// Independent verification of the public evaluate boundaries, supplementing
// the internal selected-proof tests with actual awaited credential/SDK paths.
for (const timing of ['credential', 'response']) {
  for (const change of ['grant', 'catalog', 'selection', 'head']) {
    test(`${timing}: changed ${change} refuses public evaluation and cannot publish or cache output`, async t => {
      const f = await runtimeFixture(t, { canonical: true });
      const request = f.request();
      const mutate = () => {
        if (change === 'grant') f.authority.revoke(f.issued.credential_id);
        if (change === 'catalog') { git(f.folder, 'branch', 'review-probe-ref'); f.refresh(); }
        if (change === 'selection') f.explorations.setProjectSelection(f.context, {
          epoch: f.epoch, idempotency_key: 'review-project-pointer', expected_version: null, pin: pin(f.canonical),
        });
        if (change === 'head') f.addTarget({ name: 'review-head-change' });
      };
      if (timing === 'credential') f.secrets.beforeUse = mutate;
      const calls = judgeTransport(t, ({ provider, body }) => {
        if (timing === 'response') mutate();
        return judgeResponse(provider, body);
      });
      const result = await f.runtime.evaluate(f.context, request);
      assert.equal(result.status, 'refused', result.reason_code);
      assert.equal(result.decision, null);
      assert.deepEqual(result.target_refs, []);
      assert.equal(result.branch, null);
      assert.equal(result.cache, 'miss');
      assert.equal(calls.length, timing === 'credential' ? 0 : 1);
      if (timing === 'response') assert.equal(result.attempts[0].status, 'completed');

      const retry = await f.runtime.evaluate(f.context, request);
      assert.equal(retry.status, 'refused', retry.reason_code);
      assert.equal(retry.decision, null);
      assert.equal(retry.cache, 'miss');
      assert.equal(calls.length, timing === 'credential' ? 0 : 1);
    });
  }
}
