import {mkdirSync,writeFileSync,statSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const repoRoot=process.argv[2];
const {run,room,tempRepo}=await import(`${repoRoot}/test/helpers.mjs`);
const repo=tempRepo('independent-case');
assert.equal(run(repo,'project','init').status,0);
mkdirSync(join(repo,'.vibehub/evidence/probe'),{recursive:true});
writeFileSync(join(repo,'.vibehub/evidence/probe/notes.md'),'# Internal\nnot source\n');
console.log('scratch',repo);
console.log('same inode',statSync(join(repo,'.vibehub/evidence/probe/notes.md')).ino===statSync(join(repo,'.VIBEHUB/evidence/probe/notes.md')).ino);
for(const anchor of ['.VIBEHUB/evidence/probe','.VIBEHUB/evidence/probe/notes.md','.VIBEHUB/evidence/probe/notes.md#internal']){
 const put=run(repo,'room','put',room('case',{anchors:[anchor]}),['--room','case']);
 const validate=run(repo,'project','validate');
 const coverage=run(repo,'context','coverage');
 console.log(JSON.stringify({anchor,put:put.envelope,validate:validate.envelope,coverage:coverage.envelope}));
 assert.equal(put.status,0);assert.equal(validate.status,0);assert.equal(coverage.envelope.data.segments_total,1);
}
symlinkSync(join(repo,'.vibehub/evidence'),join(repo,'alias'));
for(const anchor of ['alias/probe','alias/probe/notes.md','alias/probe/notes.md#internal']){
 assert.equal(run(repo,'room','put',room('case',{anchors:[anchor]}),['--room','case']).status,0);
 const coverage=run(repo,'context','coverage');
 assert.equal(coverage.envelope.data.segments_total,0);
 console.log(JSON.stringify({symlinkAnchor:anchor,coverage:coverage.envelope}));
}
