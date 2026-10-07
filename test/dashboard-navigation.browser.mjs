import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startVibeHubUi } from '../skills/vibehub-core/scripts/vh-ui.mjs';
import { run, ticket } from './helpers.mjs';

const { chromium } = await import(process.env.VIBEHUB_PLAYWRIGHT_MODULE || 'playwright');

async function dashboard(t, { holdDiscovery = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'vh-dashboard-navigation-'));
  let host, browser;
  t.after(async () => {
    await browser?.close();
    await host?.close();
    rmSync(repo, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q', repo]);
  const apply = (domain, operation, input) => {
    const result = run(repo, domain, operation, input);
    assert.equal(result.status, 0, result.stdout || result.stderr);
  };
  apply('project', 'init');
  apply('ticket', 'apply', {
    validation: { independent: false, note: 'Browser navigation fixture' },
    goals: [
      {
        schema_version: 1,
        kind: 'goal',
        goal_id: 'reader',
        title: 'Reader goal',
        description: 'A readable workspace',
        success_criteria: ['People can read tasks'],
        context_refs: [],
        provenance_refs: [],
      },
    ],
    epics: [
      {
        schema_version: 1,
        kind: 'epic',
        epic_id: 'views',
        goal_id: 'reader',
        title: 'Views',
        outcome: 'Show work',
        context_refs: [],
        provenance_refs: [],
      },
    ],
    tickets: [{ ...ticket('current'), epic_id: 'views' }, ticket('finished')],
  });
  apply('ticket', 'update', {
    ticket_id: 'finished',
    update_id: 'complete',
    summary: 'Completed work',
    status: 'done',
    recorded_at: '2026-10-01T12:00:00Z',
  });
  host = startVibeHubUi({ repoRoot: repo, dashboardRoots: [repo] });
  const ready = await host.ready;
  const response = await fetch(`${ready.origin}/api/dashboard`, {
    headers: { Authorization: `Bearer ${host.token}` },
  });
  const workspace = (await response.json()).data.projects[0].worktrees[0].id;
  browser = await chromium.launch({
    channel: process.env.VIBEHUB_BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const initialRead = holdDiscovery ? await delayedRead(page, '**/api/dashboard') : null;
  await page.goto(
    `${ready.origin}/dashboard?workspace=${workspace}&surface=${holdDiscovery ? 'goals' : 'tickets'}&view=board#${host.token}`,
  );
  if (holdDiscovery) return { page, read: initialRead };
  await page.waitForFunction(() => document.querySelectorAll('.board-card').length === 2);
  return page;
}

async function delayedRead(page, pattern) {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const arrived = new Promise((resolve) => {
    entered = resolve;
  });
  let first = true;
  await page.route(pattern, async (route) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    await route.continue();
  });
  return { arrived, release };
}

async function finishRefresh(page, read) {
  read.release();
  await page.waitForFunction(() => !document.querySelector('#refresh-dashboard').disabled);
}

for (const destination of ['all-projects', 'contexts', 'goal', 'ticket']) {
  test(`delayed Refresh keeps newer ${destination} navigation`, async (t) => {
    const page = await dashboard(t);
    const read = await delayedRead(
      page,
      ['goal', 'ticket'].includes(destination) ? '**/api/dashboard' : '**/api/state?**',
    );
    try {
      await page.getByRole('button', { name: 'Refresh dashboard', exact: true }).click();
      await read.arrived;
      if (destination === 'all-projects') {
        await page.locator('#project-trigger').click();
        await page.getByRole('option', { name: /All projects/ }).click();
        await page.waitForFunction(() => document.querySelector('#heading').textContent === 'Goals');
      } else if (destination === 'contexts') {
        await page.locator('[data-surface=contexts]').click();
        await page.waitForFunction(() => document.querySelector('#heading').textContent === 'Context');
      } else if (destination === 'ticket') {
        await page.locator('.board-card').filter({ hasText: 'current' }).click();
        await page.locator('#inspector[open]').waitFor();
      } else {
        await page.locator('.goal-link').filter({ hasText: 'Reader goal' }).click();
        await page.waitForFunction(() => document.querySelector('#heading').textContent === 'Reader goal');
      }
      const selectedTicket =
        destination === 'ticket' ? await page.locator('#detail-title').innerText() : null;
      const expected = { heading: await page.locator('#heading').innerText(), url: page.url() };
      await finishRefresh(page, read);
      assert.deepEqual({ heading: await page.locator('#heading').innerText(), url: page.url() }, expected);
      if (destination === 'ticket') {
        assert.equal(await page.locator('#inspector').getAttribute('open'), '');
        assert.equal(await page.locator('#detail-title').innerText(), selectedTicket);
      }
      if (destination === 'all-projects') {
        assert.equal(new URL(page.url()).searchParams.has('workspace'), false);
        assert.equal(await page.locator('.board-card').count(), 0);
      }
    } finally {
      read.release();
    }
  });
}

test('leaving a filtered Ticket view clears its URL filter and reload preserves the visible board', async (t) => {
  const page = await dashboard(t);
  await page.locator('#status-filters .stage-completed').click();
  assert.equal(await page.locator('.board-card').count(), 1);
  assert.equal(new URL(page.url()).searchParams.get('filters'), 'completed');
  await page.locator('[data-surface=contexts]').click();
  await page.locator('[data-surface=tickets]').click();
  const current = async () => ({
    count: await page.locator('.board-card').count(),
    all: await page.getByRole('button', { name: 'All statuses', exact: true }).getAttribute('aria-pressed'),
    filter: new URL(page.url()).searchParams.get('filters'),
  });
  assert.deepEqual(await current(), { count: 2, all: 'true', filter: null });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#refresh-dashboard').disabled);
  assert.deepEqual(await current(), { count: 2, all: 'true', filter: null });
});

for (const surface of ['tickets', 'contexts']) {
  test(`navigation to ${surface} during first discovery still loads the workspace`, async (t) => {
    const { page, read } = await dashboard(t, { holdDiscovery: true });
    try {
      await read.arrived;
      await page.locator(`[data-surface=${surface}]`).click();
      await finishRefresh(page, read);
      assert.equal(new URL(page.url()).searchParams.get('surface'), surface);
      assert.equal(await page.locator('#project-trigger').isEnabled(), true);
      if (surface === 'tickets') assert.equal(await page.locator('.board-card').count(), 2);
      else assert.equal(await page.locator('#heading').innerText(), 'Context');
    } finally {
      read.release();
    }
  });
}
