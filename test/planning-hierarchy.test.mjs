import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { helper, run, tempRepo, ticket } from './helpers.mjs';
import { buildUiSnapshot, ticketContextPackage } from '../skills/vibehub-core/scripts/vh-ui.mjs';

const goal = (id = 'team-adoption') => ({ schema_version: 1, kind: 'goal', goal_id: id, title: 'Make the product usable by teams', description: 'Enable teammates to collaborate.', success_criteria: ['Invited teammates can join and collaborate.'], context_refs: [], provenance_refs: ['prd:team-adoption'] });
const epic = (id = 'invitations', goalId = 'team-adoption') => ({ schema_version: 1, kind: 'epic', epic_id: id, goal_id: goalId, title: 'Team invitations', outcome: 'Teams can securely invite members.', context_refs: [], provenance_refs: ['prd:team-adoption'] });
const validation = { independent: false, note: 'Test fixture' };
const member = (id, epicId = 'invitations', deps = []) => ({ ...ticket(id, deps), epic_id: epicId });
const ok = (result) => { assert.equal(result.status, 0, result.stdout || result.stderr); return result.envelope.data; };
const rejected = (result, pattern) => { assert.notEqual(result.status, 0, result.stdout); assert.equal(result.envelope.error.code, 'validation_error', result.stdout); if (pattern) assert.match(JSON.stringify(result.envelope.error.details), pattern); };
const create = () => { const repo = tempRepo('hierarchy'); ok(run(repo, 'project', 'init')); return repo; };
const path = (repo, kind, id) => join(repo, '.vibehub', kind, `${id}.yaml`);

function close(repo, id) {
  ok(run(repo, 'ticket', 'evidence', {schema_version: 1, kind: 'ticket_evidence', evidence_id: `${id}-proof`, ticket_id: id, acceptance_ids: ['works'], summary: 'Behavior passed.', refs: ['test:behavior'], recorded_at: '2026-09-08T12:00:00Z'}));
  ok(run(repo, 'ticket', 'closeout', {schema_version: 1, kind: 'ticket_outcome', ticket_id: id, status: 'successful', independence: { source: 'subagent', note: 'Fixture adjudication' }, accepted_acceptance_ids: ['works'], unresolved_acceptance_ids: [], evidence_ids: [`${id}-proof`], summary: 'Behavior verified.', closed_at: '2026-09-08T12:01:00Z'}));
}

test('a PRD plan persists real ownership while readiness follows only dependencies', () => {
  const repo = create();
  const input = { validation, goals: [goal()], epics: [epic(), epic('roles')], tickets: [member('persist'), member('email', 'invitations', ['persist']), member('accept'), member('permissions', 'roles', ['email']), ticket('standalone')] };
  ok(run(repo, 'ticket', 'apply', input));
  const graph = ok(run(repo, 'ticket', 'graph'));
  assert.deepEqual(graph.tickets.map(x => [x.ticket.ticket_id, x.status]), [['accept','READY'],['email','BLOCKED'],['permissions','BLOCKED'],['persist','READY'],['standalone','READY']]);
  assert.equal(graph.relations.length, 2);
  assert.equal(graph.hierarchy.goals[0].progress.total_tickets, 4);
  assert.deepEqual(graph.hierarchy.standalone_ticket_ids, ['standalone']);
  assert.deepEqual(ok(run(repo, 'goal', 'get', {goal_id: 'team-adoption'})).epic_ids, ['invitations', 'roles']);
  assert.deepEqual(ok(run(repo, 'epic', 'get', {epic_id: 'invitations'})).ticket_ids, ['accept', 'email', 'persist']);
  const detail = ok(run(repo, 'ticket', 'get', {ticket_id: 'email'}));
  assert.equal(detail.hierarchy.goal.goal_id, 'team-adoption');
  assert.equal(detail.hierarchy.epic.epic_id, 'invitations');
  assert.deepEqual(JSON.parse(readFileSync(path(repo, 'goals', 'team-adoption'), 'utf8')), goal());
  assert.equal(ok(run(repo, 'goal', 'list')).length, 1);
  assert.equal(ok(run(repo, 'epic', 'list')).length, 2);
  assert.equal(ok(run(repo, 'project', 'validate')).goals, 1);
  close(repo, 'persist');
  assert.equal(ok(run(repo, 'ticket', 'get', {ticket_id: 'email'})).status, 'READY');
});

test('invalid plans reject without writing any new parents or Tickets', () => {
  const repo = create();
  const attempts = [
    {goals: [goal()], epics: [epic('invitations', 'missing')], tickets: [member('work')]},
    {goals: [goal()], epics: [epic()], tickets: [member('work', 'missing')]},
    {goals: [goal(), goal()], epics: [epic()], tickets: [member('work')]},
    {goals: [goal()], epics: [epic(), epic()], tickets: [member('work')]},
    {goals: [goal()], epics: [epic()], tickets: [{...member('work'), goal_id: 'team-adoption'}]},
    {goals: [goal()], epics: [epic()], tickets: [{...member('work'), epic_id: null}]},
    {goals: [goal()], epics: [epic()], tickets: [member('work', 'invitations', ['work'])]},
    {goals: 'bad', epics: [], tickets: [ticket('work')]},
    {goals: null, epics: [], tickets: [ticket('work')]},
    {goals: [null], epics: [], tickets: [ticket('work')]},
    {goals: [{...goal(), context_refs: [{ref: 'missing-prd.md', purpose: 'PRD'}]}], epics: [epic()], tickets: [member('work')]},
  ];
  for (const attempt of attempts) {
    rejected(run(repo, 'ticket', 'apply', {validation, ...attempt}));
    for (const kind of ['goals', 'epics', 'tickets']) assert.deepEqual(readdirSync(join(repo, '.vibehub', kind)), []);
  }
});

test('parent put validates schema, references and typed ownership', () => {
  const repo = create();
  rejected(run(repo, 'epic', 'put', epic()), /dangling Epic Goal/);
  for (const bad of [{...goal(), success_criteria: []}, {...goal(), success_criteria: ['same','same']}, {...goal(), goal_id: '../escape'}, {...goal(), ticket_ids: []}, {...goal(), schema_version: 2}, {...goal(), context_refs: [null]}]) rejected(run(repo, 'goal', 'put', bad));
  writeFileSync(join(repo,'prd.md'), '# Team PRD');
  ok(run(repo, 'goal', 'put', {...goal(), context_refs: [{ref:'prd.md',purpose:'Requirements'}]}));
  ok(run(repo, 'epic', 'put', epic()));
  rejected(run(repo, 'epic', 'put', {...epic(), epic_id:'other', goal_id:'invitations'}), /dangling Epic Goal/);
  rejected(run(repo, 'epic', 'put', {...epic(), parent_epic_id:'invitations'}), /not allowed/);
  assert.equal(run(repo, 'goal', 'get', {goal_id:'missing'}).envelope.error.code, 'not_found');
  assert.equal(run(repo, 'epic', 'get', {epic_id:'../bad'}).envelope.error.code, 'invalid_input');
});

test('a late write failure restores parent bytes and removes newly written members', () => {
  const repo = create();
  ok(run(repo, 'goal', 'put', goal()));
  const original = readFileSync(path(repo, 'goals', 'team-adoption'), 'utf8');
  const inputPath = join(repo, 'plan.json');
  writeFileSync(inputPath, JSON.stringify({validation, goals:[{...goal(), title:'Changed title'}], epics:[epic()], tickets:[member('work')]}));
  const injection = join(repo, 'fail-rename.mjs');
  writeFileSync(injection, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
let failed = false;
fs.renameSync = (source, target) => {
  if (!failed && target.endsWith('/tickets/work.yaml')) {
    failed = true;
    throw new Error('injected late write failure');
  }
  return rename(source, target);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--import',injection,helper,'ticket','apply','--repo',repo,'--input',inputPath], {encoding:'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /injected late write failure/);
  assert.equal(readFileSync(path(repo,'goals','team-adoption'),'utf8'),original);
  for (const kind of ['epics','tickets']) assert.deepEqual(readdirSync(join(repo,'.vibehub',kind)),[]);
  ok(run(repo,'project','validate'));
});

test('reparenting preserves proof identities and Outcomes; completed history stays in full-scope progress', () => {
  const repo = create();
  ok(run(repo, 'ticket', 'apply', {validation, goals:[goal(), goal('second-goal')], epics:[epic(),epic('second-epic','second-goal'),epic('empty-epic')], tickets:[member('work')]}));
  close(repo,'work');
  const before = ok(run(repo, 'ticket', 'get', {ticket_id:'work'}));
  const evidenceBefore = readFileSync(path(repo,'evidence/work','work-proof'),'utf8');
  const outcomeBefore = readFileSync(path(repo,'outcomes/work','contract-v1'),'utf8');
  ok(run(repo, 'ticket', 'apply', {validation,tickets:[{...before.ticket,epic_id:'second-epic'}]}));
  const after = ok(run(repo, 'ticket', 'get', {ticket_id:'work'}));
  assert.equal(after.hierarchy.goal.goal_id,'second-goal');
  assert.deepEqual(after.ticket.contract_revisions,before.ticket.contract_revisions);
  assert.deepEqual(after.ticket.acceptance,before.ticket.acceptance);
  assert.equal(after.status,'DONE');
  assert.equal(readFileSync(path(repo,'evidence/work','work-proof'),'utf8'),evidenceBefore);
  assert.equal(readFileSync(path(repo,'outcomes/work','contract-v1'),'utf8'),outcomeBefore);
  const graph = ok(run(repo,'ticket','graph'));
  assert.equal(graph.count,0);
  assert.equal(graph.hierarchy.scope,'all');
  assert.equal(graph.hierarchy.goals.find(x=>x.goal.goal_id==='second-goal').progress.completed_tickets,1);
  for (const row of [...graph.hierarchy.goals,...graph.hierarchy.epics]) {
    assert.equal(row.status,undefined); assert.equal(row.achieved,undefined);
  }
  assert.deepEqual(graph.hierarchy.epics.find(x=>x.epic.epic_id==='empty-epic').progress,{total_tickets:0,completed_tickets:0,by_status:{}});
  ok(run(repo, 'epic', 'put', epic('second-epic')));
  assert.equal(ok(run(repo,'ticket','get',{ticket_id:'work'})).hierarchy.goal.goal_id,'team-adoption');
  const {epic_id,...standalone} = after.ticket;
  ok(run(repo,'ticket','apply',{validation,tickets:[standalone]}));
  assert.deepEqual(ok(run(repo,'project','hierarchy')).standalone_ticket_ids,['work']);
});

test('format 4 migration changes only the marker; missing optional parents leave legacy Tickets standalone', () => {
  const repo = create();
  ok(run(repo,'ticket','apply',{validation,tickets:[ticket('legacy')]}));
  close(repo,'legacy');
  const files = [path(repo,'tickets','legacy'),path(repo,'evidence/legacy','legacy-proof'),path(repo,'outcomes/legacy','contract-v1')];
  const originals = files.map(p=>readFileSync(p,'utf8'));
  const version = path(repo,'','version');
  writeFileSync(version,JSON.stringify({schema_version:1,kind:'vibehub_project',format_version:4}));
  assert.equal(run(repo,'goal','put',goal()).envelope.error.code,'format_mismatch');
  const migration = ok(run(repo,'project','migrate-mechanical'));
  assert.deepEqual(migration.changed_paths,['.vibehub/version.yaml']);
  assert.deepEqual(migration.applied_migrations,['format-4-to-format-5']);
  assert.deepEqual(files.map(p=>readFileSync(p,'utf8')),originals);
  assert.deepEqual(ok(run(repo,'project','hierarchy')).standalone_ticket_ids,['legacy']);
  assert.deepEqual(ok(run(repo,'project','migrate-mechanical')).changed_paths,[]);
});

test('Workbench snapshot and handoff carry parent context and invalidate when parents change', () => {
  const repo = create();
  assert.equal(spawnSync('git',['init','-q',repo]).status,0);
  ok(run(repo,'ticket','apply',{validation,goals:[goal()],epics:[epic()],tickets:[member('work')]}));
  const before = buildUiSnapshot(repo);
  assert.equal(before.graph.hierarchy.goals[0].goal.goal_id,'team-adoption');
  assert.equal(before.state.graph.hierarchy.goals[0].goal.goal_id,'team-adoption');
  const source = before.state.graph.source;
  const handoff = ticketContextPackage(before.repository.tickets.documents.get('work').document, before.graph.relations, before.repository, source);
  assert.equal(handoff.agentPayload.hierarchy.goal.goal_id,'team-adoption');
  assert.equal(handoff.agentPayload.hierarchy.epic.epic_id,'invitations');
  const node = before.graph.tickets.find(x=>x.ticketId==='work');
  assert.equal(node.hierarchy.epic.epic_id,'invitations');
  ok(run(repo,'goal','put',{...goal(),description:'Enable secure collaboration across distributed teams.'}));
  const after = buildUiSnapshot(repo);
  assert.notEqual(after.state.graph.snapshotId,before.state.graph.snapshotId);
  assert.equal(after.graph.tickets[0].hierarchy.goal.description,'Enable secure collaboration across distributed teams.');
});
