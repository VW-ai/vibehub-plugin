import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const main = '5846c3f44ede79a4e260befe67105a7102caf377';
const branch = 'c3515c4635cc293fdde49a2cbcdf794fd5cdb305';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const old = (ref, path) => JSON.parse(git('show', `${ref}:${path}`));
const paths = ref => git('ls-tree', '-r', '--name-only', ref, '.vibehub').trim().split('\n').filter(p => p.endsWith('.yaml'));
let tickets = 0, proofs = 0;
for (const path of paths(main)) {
  if (!/^\.vibehub\/(tickets|evidence|outcomes)\//.test(path)) continue;
  const before = old(main, path), after = read(path);
  if (before.kind === 'ticket') {
    for (const key of ['acceptance', 'contract_revisions', 'active_contract_revision', 'revision_state']) assert.deepEqual(after[key], before[key], `${path}:${key}`);
    tickets++;
  } else if (['ticket_evidence', 'ticket_outcome'].includes(before.kind)) {
    assert.deepEqual(after, before, path); proofs++;
  }
}
console.log(`main ${main}: ${tickets} Ticket revision records and ${proofs} Evidence/Outcome documents preserved`);
const mainPaths = new Set(paths(main));
let importedTickets = 0, importedProofs = 0;
for (const path of paths(branch)) {
  if (mainPaths.has(path) || !/^\.vibehub\/(tickets|evidence|outcomes)\//.test(path)) continue;
  const before = old(branch, path);
  if (before.kind === 'ticket') {
    const after = read(path);
    const current = after.acceptance.filter(a => a.state === 'active');
    assert.deepEqual(current.map(({ acceptance_id, criterion, authority = 'agent' }) => ({ acceptance_id, criterion, authority })).sort((a,b)=>a.acceptance_id.localeCompare(b.acceptance_id)), before.acceptance.map(({ acceptance_id, criterion, authority = 'agent' }) => ({ acceptance_id, criterion, authority })).sort((a,b)=>a.acceptance_id.localeCompare(b.acceptance_id)), path);
    assert.deepEqual(after.constraints, before.constraints, path); importedTickets++;
  } else if (before.kind === 'ticket_evidence') {
    const after = read(path);
    for (const key of Object.keys(before).filter(k => k !== 'schema_version')) assert.deepEqual(after[key], before[key], `${path}:${key}`);
    importedProofs++;
  } else if (before.kind === 'ticket_outcome') {
    const dir = `.vibehub/outcomes/${before.ticket_id}`;
    const candidates = readdirSync(dir).filter(p=>p.endsWith('.yaml')).map(p=>read(`${dir}/${p}`));
    assert.ok(candidates.some(after => Object.keys(before).filter(k=>k!=='schema_version').every(key=>JSON.stringify(after[key])===JSON.stringify(before[key]))), `original Outcome payload preserved: ${path}`);
    importedProofs++;
  }
}
console.log(`branch ${branch}: ${importedTickets} current Acceptance sets/constraints and ${importedProofs} original proof payloads preserved`);
const peel = read('.vibehub/outcomes/ticket-verify-absorption-against-peel/contract-v1.yaml');
assert.equal(peel.status, 'partial'); assert.deepEqual(peel.unresolved_acceptance_ids, ['no-prompted-recovery']);
console.log('Peel remains partial with no-prompted-recovery unresolved');
