import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState,ticketProjection,changePreference,tickets,contexts,blockedAction,changeNoticeState } from './fixtures.mjs';

test('one Ticket spans A creation, B execution and C independent acceptance without collapsing attempts',()=>{
  const s=initialState();s.filter='created';assert(ticketProjection(s).some(t=>t.id==='T-21'));
  s.workspace='B';s.filter='finished';assert(ticketProjection(s).some(t=>t.id==='T-21'));
  s.filter='accepted';assert(!ticketProjection(s).some(t=>t.id==='T-21'));
  s.workspace='C';assert(ticketProjection(s).some(t=>t.id==='T-21'));
  assert.equal(tickets.find(t=>t.id==='T-21').attempts.length,3);
  s.filter='relevant';s.workspace='A';assert(ticketProjection(s).some(t=>t.id==='T-24'));
  s.workspace='B';assert(ticketProjection(s).some(t=>t.id==='T-24'));
});
test('hidden preference is view/viewer/workspace scoped and cannot erase an authorized blocker',()=>{
  let s=initialState();s.workspace='B';s.filter='project';
  const baseline=JSON.stringify(tickets);
  s=changePreference(s,'T-18','hide');
  assert(!ticketProjection(s).some(t=>t.id==='T-18'));
  assert.equal(ticketProjection(s).find(t=>t.id==='T-24').blockerReference.id,'T-18');
  s.viewer='Noah';assert(ticketProjection(s).some(t=>t.id==='T-18'));
  s.viewer='Mira';s.workspace='A';assert(ticketProjection(s).some(t=>t.id==='T-18'));
  s.workspace='B';s.filter='participated';assert(ticketProjection(s).some(t=>t.id==='T-18'));
  s.filter='project';s=changePreference(s,'T-18','restore-hidden');assert(ticketProjection(s).some(t=>t.id==='T-18'));
  assert.equal(JSON.stringify(tickets),baseline);
});
test('archive/restore is a workspace preference, not shared status or deletion',()=>{
  let s=initialState();s.filter='project';s=changePreference(s,'T-21','archive');
  assert(!ticketProjection(s).some(t=>t.id==='T-21'));
  s.filter='archived';assert(ticketProjection(s).some(t=>t.id==='T-21'));
  s=changePreference(s,'T-21','restore-archive');assert.equal(ticketProjection(s).length,0);
  s.filter='project';assert.equal(ticketProjection(s).find(t=>t.id==='T-21').status,'Accepted');
});
test('A supersession preserves current B variant; deleted-origin constraint remains applicable',()=>{
  assert.equal(contexts.find(c=>c.id==='ctx-local@1').state,'Superseded');
  assert.equal(contexts.find(c=>c.id==='ctx-queue@1').state,'Current');
  assert.equal(contexts.find(c=>c.id==='ctx-source@3').state,'Current');
  assert(contexts.find(c=>c.id==='ctx-source@3').origin.includes('(deleted)'));
  assert(contexts.some(c=>c.state==='Invalidated'));
  assert(contexts.some(c=>c.state==='Unresolved conflict'));
});
test('synthetic action gates do not treat offline/stale/denied fixtures as successful adoption',()=>{
  const s=initialState();assert.equal(blockedAction(s),false);
  for(const scenario of ['offline','stale','denied','unavailable','auth','quota','failure']){s.scenario=scenario;assert.equal(blockedAction(s),true);}
  s.scenario='ready';s.enabled.atlas=false;assert.equal(blockedAction(s),true);
  s.enabled.atlas=true;s.runtime=false;assert.equal(blockedAction(s),true);
});
test('notice preferences cannot erase an adopted receipt or duplicate its lineage',()=>{
  let s=changeNoticeState(initialState(),'n-ba','seen');assert.equal(s.adoptions.length,0);
  s=changeNoticeState(s,'n-ba','adopted');
  for(const attempted of ['deferred','continued own path','seen','adopted'])s=changeNoticeState(s,'n-ba',attempted);
  assert.equal(s.noticeStates['n-ba'],'adopted');assert.equal(s.adoptions.length,1);
  assert.equal(s.adoptions[0].ref,'ctx-queue@1');assert.equal(s.adoptions[0].to,'A');
});
