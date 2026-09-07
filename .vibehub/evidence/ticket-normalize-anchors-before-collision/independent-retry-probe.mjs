import {mkdirSync,writeFileSync,statSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const {run,room,tempRepo,writeRoom}=await import(`${process.argv[2]}/test/helpers.mjs`);
const repo=tempRepo('independent-retry');
assert.equal(run(repo,'project','init').status,0);
mkdirSync(join(repo,'.vibehub/evidence/probe'),{recursive:true});
writeFileSync(join(repo,'.vibehub/evidence/probe/notes.md'),'# Internal\nnot source\n');
assert.equal(statSync(join(repo,'.vibehub/evidence/probe/notes.md')).ino,statSync(join(repo,'.VIBEHUB/evidence/probe/notes.md')).ino);
console.log('Verified identical inode for real macOS .VIBEHUB alias');
for(const anchor of ['.VIBEHUB/evidence/probe','.VIBEHUB/evidence/probe/notes.md','.VIBEHUB/evidence/probe/notes.md#internal']){
 const put=run(repo,'room','put',room('case',{anchors:[anchor]}),['--room','case']);
 assert.notEqual(put.status,0);assert.match(put.stdout,/internal documents/);
 writeRoom(repo,'case',room('case',{anchors:[anchor]}));
 for(const [d,o] of [['project','validate'],['context','coverage'],['room','drift']]){
  const result=run(repo,d,o);assert.notEqual(result.status,0);assert.match(result.stdout,/internal documents/);
 }
 rmSync(join(repo,'.vibehub/rooms/case'),{recursive:true});
 console.log('Rejected write, validation, coverage and drift:',anchor);
}
for(const dir of ['deep/.ViBeHuB','deep/.gIt','deep/.VIBEHUB-notes']){
 mkdirSync(join(repo,'docs',dir),{recursive:true});writeFileSync(join(repo,'docs',dir,'notes.md'),'# One\nsource\n');
}
assert.equal(run(repo,'room','put',room('docs',{anchors:['./docs//.']}),['--room','docs']).status,0);
const coverage=run(repo,'context','coverage');
assert.equal(coverage.status,0);assert.deepEqual(coverage.envelope.data.rooms[0].files.map(x=>x.path),['docs/deep/.VIBEHUB-notes/notes.md']);
console.log('Nested mixed-case walk excludes internals and retains similarly named source:',JSON.stringify(coverage.envelope));
symlinkSync(join(repo,'.vibehub/evidence'),join(repo,'alias'));
for(const anchor of ['alias/probe','alias/probe/notes.md','alias/probe/notes.md#internal']){
 assert.equal(run(repo,'room','put',room('alias',{anchors:[anchor]}),['--room','alias']).status,0);
 const r=run(repo,'context','coverage').envelope.data.rooms.find(x=>x.room==='alias');
 assert.deepEqual(r.files,[]);console.log('Symlink remains excluded:',anchor);
}
console.log('All independent retry probes passed.');
