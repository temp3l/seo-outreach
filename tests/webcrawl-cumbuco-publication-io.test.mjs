import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, stat, rename, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { publishNewFile, replaceVerifiedFile, publishCumbucoReplacements } from '../scripts/compat/cumbuco-publication-io.mjs';

test('publication creates one private file, refuses collisions and leaves prior evidence recoverable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-publish-test-'));try{
  const path=join(dir,'report.pdf');await publishNewFile(path,Buffer.from('new'));
  assert.equal(await readFile(path,'utf8'),'new');await assert.rejects(publishNewFile(path,Buffer.from('replacement')),{code:'EEXIST'});assert.equal(await readFile(path,'utf8'),'new');
  const old=join(dir,'old');await writeFile(old,'original');const alias=join(dir,'alias');await symlink(old,alias);await assert.rejects(publishNewFile(alias,Buffer.from('bad')),{code:'EEXIST'});assert.equal(await readFile(old,'utf8'),'original');
  await assert.rejects(publishNewFile(join(dir,'missing','out'),Buffer.from('bad')),{code:'ENOENT'});assert.deepEqual((await readdir(dir)).sort(),['alias','old','report.pdf']);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('verified replacement keeps a collision-safe original backup and identical repeat is a no-op',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-replace-test-'));try{
  const path=join(dir,'current');await writeFile(path,'original');const sha=x=>createHash('sha256').update(x).digest('hex');
  await assert.rejects(replaceVerifiedFile(path,Buffer.from('new'),'0'.repeat(64)),/original_changed/);assert.deepEqual(await readdir(dir),['current']);
  const result=await replaceVerifiedFile(path,Buffer.from('new'),sha('original'));assert.equal(result.changed,true);assert.equal(await readFile(result.backup,'utf8'),'original');assert.equal(await readFile(path,'utf8'),'new');
  const before=(await readdir(dir)).sort();assert.deepEqual(await replaceVerifiedFile(path,Buffer.from('new'),sha('new')),{changed:false});assert.deepEqual((await readdir(dir)).sort(),before);
  const alias=join(dir,'alias');await symlink(path,alias);await assert.rejects(replaceVerifiedFile(alias,Buffer.from('bad'),sha('new')));assert.equal(await readFile(path,'utf8'),'new');
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('a failed final publication leaves earlier review evidence and the prior manifest intact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-publish-fail-'));try{
  const prior=join(dir,'qualification.current.json');const review=join(dir,'report.pt-review.pdf');
  await writeFile(prior,'prior');await publishNewFile(review,Buffer.from('HOLD'));
  await assert.rejects(publishNewFile(prior,Buffer.from('new manifest')),{code:'EEXIST'});
  assert.equal(await readFile(prior,'utf8'),'prior');assert.equal(await readFile(review,'utf8'),'HOLD');
  assert.deepEqual((await readdir(dir)).sort(),['qualification.current.json','report.pt-review.pdf']);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('a failed final replacement leaves the prior manifest and a recoverable report backup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-recover-test-'));try{
  const manifest=join(dir,'qualification.current.json'),report=join(dir,'report.pdf');const sha=x=>createHash('sha256').update(x).digest('hex');
  await writeFile(manifest,'prior HOLD manifest');await writeFile(report,'prior HOLD report');
  const saved=await replaceVerifiedFile(report,Buffer.from('new HOLD report'),sha('prior HOLD report'));
  await assert.rejects(replaceVerifiedFile(manifest,Buffer.from('new manifest'),'0'.repeat(64)),/original_changed/);
  assert.equal(await readFile(manifest,'utf8'),'prior HOLD manifest');assert.equal(await readFile(saved.backup,'utf8'),'prior HOLD report');assert.equal(await readFile(report,'utf8'),'new HOLD report');
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('the shared Cumbuco promotion seam rejects escapes, symlinks, collisions and tampered prior bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-seam-reject-'));try{
  const sha=x=>createHash('sha256').update(x).digest('hex');const target=join(dir,'protected');await writeFile(target,'protected');
  await symlink(target,join(dir,'linked-output'));await writeFile(join(dir,'collision'),'occupied');
  await assert.rejects(publishCumbucoReplacements(dir,[['../escape',Buffer.from('bad')]],new Map(),join(dir,'qualification.current.json')),/unsafe_output_path/);
  await assert.rejects(publishCumbucoReplacements(dir,[['linked-output',Buffer.from('bad')]],new Map(),join(dir,'qualification.current.json')),/output_already_exists/);
  await assert.rejects(publishCumbucoReplacements(dir,[['collision',Buffer.from('bad')]],new Map(),join(dir,'qualification.current.json')),/output_already_exists/);
  await assert.rejects(publishCumbucoReplacements(dir,[['protected',Buffer.from('replacement')]],new Map([['protected',sha('stale')]]),join(dir,'qualification.current.json')),/original_changed/);
  assert.equal(await readFile(target,'utf8'),'protected');assert.equal(await readFile(join(dir,'collision'),'utf8'),'occupied');assert.equal((await readdir(dir)).sort().join(','),'collision,linked-output,protected');
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('the shared promotion seam backs up changed owned files and preserves a true identical no-op',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-seam-noop-'));try{
  const sha=x=>createHash('sha256').update(x).digest('hex');const path=join(dir,'report.pt-review.pdf');await writeFile(path,'old HOLD bytes');
  const originalStat=await stat(path);const oldHashes=new Map([['report.pt-review.pdf',sha('old HOLD bytes')]]);
  const backups=await publishCumbucoReplacements(dir,[['report.pt-review.pdf',Buffer.from('new HOLD bytes')]],oldHashes,join(dir,'qualification.current.json'));
  assert.equal(backups.length,1);assert.equal(await readFile(backups[0],'utf8'),'old HOLD bytes');assert.equal(await readFile(path,'utf8'),'new HOLD bytes');
  const replacedStat=await stat(path);const listing=(await readdir(dir)).sort();const repeat=await publishCumbucoReplacements(dir,[['report.pt-review.pdf',Buffer.from('new HOLD bytes')]],new Map([['report.pt-review.pdf',sha('new HOLD bytes')]]),join(dir,'qualification.current.json'));
  assert.deepEqual(repeat,[]);assert.deepEqual((await readdir(dir)).sort(),listing);assert.equal((await stat(path)).mtimeMs,replacedStat.mtimeMs);assert.ok(replacedStat.mtimeMs>=originalStat.mtimeMs);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('the shared promotion seam requires qualification JSON last and leaves prior evidence recoverable on final-write failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-seam-final-'));try{
  const sha=x=>createHash('sha256').update(x).digest('hex');const report=join(dir,'report.pt-review.pdf'),manifest=join(dir,'qualification.current.json');
  await writeFile(report,'prior HOLD report');await writeFile(manifest,'prior HOLD manifest');
  const prior=new Map([['report.pt-review.pdf',sha('prior HOLD report')],['qualification.current.json',sha('prior HOLD manifest')]]);
  await assert.rejects(publishCumbucoReplacements(dir,[['qualification.current.json',Buffer.from('new manifest')],['report.pt-review.pdf',Buffer.from('new HOLD report')]],prior,manifest),/manifest_must_be_last/);
  let failed=false;const operations={rename:async(a,b)=>{if(b===manifest&&!failed){failed=true;throw Error('injected');}return rename(a,b);}};
  await assert.rejects(publishCumbucoReplacements(dir,[['report.pt-review.pdf',Buffer.from('new HOLD report')],['qualification.current.json',Buffer.from('new HOLD manifest')]],prior,manifest,{operations}),/injected/u);
  assert.equal(await readFile(report,'utf8'),'prior HOLD report');assert.equal(await readFile(manifest,'utf8'),'prior HOLD manifest');
  const backup=(await readdir(dir)).find(name=>name.startsWith('report.pt-review.pdf.cumbuco-backup-'));assert.ok(backup);assert.equal(await readFile(join(dir,backup),'utf8'),'prior HOLD report');
 }finally{await rm(dir,{recursive:true,force:true})}
});


test('promotion rolls back prior changes on final manifest failure and preserves verified backup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-transaction-'));try{const sha=x=>createHash('sha256').update(x).digest('hex');const report=join(dir,'report'),csv=join(dir,'qualification.csv'),manifest=join(dir,'qualification.current.json');await writeFile(report,'old report');await writeFile(csv,'old csv');await writeFile(manifest,'old manifest');const prior=new Map([['report',sha('old report')],['qualification.csv',sha('old csv')],['qualification.current.json',sha('old manifest')]]);let failed=false;const operations={rename:async(a,b)=>{if(b===manifest&&!failed){failed=true;throw Error('injected_manifest_rename');}return rename(a,b);}};await assert.rejects(publishCumbucoReplacements(dir,[['report',Buffer.from('new report')],['qualification.csv',Buffer.from('new csv')],['qualification.current.json',Buffer.from('new manifest')]],prior,manifest,{operations}),/injected_manifest_rename/u);assert.equal(await readFile(report,'utf8'),'old report');assert.equal(await readFile(csv,'utf8'),'old csv');assert.equal(await readFile(manifest,'utf8'),'old manifest');assert.ok((await readdir(dir)).some(n=>n.startsWith('report.cumbuco-backup-')));assert.equal((await readdir(dir)).some(n=>n.endsWith('.tmp')),false);}finally{await rm(dir,{recursive:true,force:true})}
});

test('promotion prevalidates retirement and rolls a removed owned file back on manifest failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-retirement-'));try{const sha=x=>createHash('sha256').update(x).digest('hex');const businessDir=join(dir,'scraped/synthetic-CB-0123456789');await (await import('node:fs/promises')).mkdir(businessDir,{recursive:true});const rel='scraped/synthetic-CB-0123456789/report.pt-review.pdf',report=join(dir,rel),manifest=join(dir,'qualification.current.json');await writeFile(report,'old');await writeFile(manifest,'old manifest');const prior=new Map([[rel,sha('old')],['qualification.current.json',sha('old manifest')]]);let failed=false;const operations={rename:async(a,b)=>{if(b===manifest&&!failed){failed=true;throw Error('injected_manifest_rename');}return rename(a,b);}};await assert.rejects(publishCumbucoReplacements(dir,[['qualification.current.json',Buffer.from('new')]],prior,manifest,{retirePaths:[rel],operations}),/injected_manifest_rename/u);assert.equal(await readFile(report,'utf8'),'old');assert.equal(await readFile(manifest,'utf8'),'old manifest');assert.ok((await readdir(businessDir)).some(n=>n.startsWith('report.pt-review.pdf.cumbuco-backup-')));}finally{await rm(dir,{recursive:true,force:true})}
});

test('rollback failure reports both errors and retains the verified original backup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-rollback-failure-'));try{const sha=x=>createHash('sha256').update(x).digest('hex');const report=join(dir,'report'),manifest=join(dir,'qualification.current.json');await writeFile(report,'old report');await writeFile(manifest,'old manifest');const prior=new Map([['report',sha('old report')],['qualification.current.json',sha('old manifest')]]);let manifestFailed=false,restoreFailed=false;const operations={rename:async(a,b)=>{if(b===manifest&&!manifestFailed){manifestFailed=true;throw Error('primary_manifest_failure');}if(b===report&&manifestFailed&&!restoreFailed){restoreFailed=true;throw Error('rollback_restore_failure');}return rename(a,b);}};await assert.rejects(publishCumbucoReplacements(dir,[['report',Buffer.from('new report')],['qualification.current.json',Buffer.from('new manifest')]],prior,manifest,{operations}),e=>{assert.match(e.message,/primary_manifest_failure/u);assert.match(e.message,/rollback_restore_failure/u);return true;});const backup=(await readdir(dir)).find(n=>n.startsWith('report.cumbuco-backup-'));assert.ok(backup);assert.equal(await readFile(join(dir,backup),'utf8'),'old report');assert.equal(await readFile(manifest,'utf8'),'old manifest');}finally{await rm(dir,{recursive:true,force:true});}
});

test('rollback leaves an unexpected destination untouched and rejects unsafe retirement paths before mutation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-unsafe-retirement-'));try{const sha=x=>createHash('sha256').update(x).digest('hex');const report=join(dir,'report'),manifest=join(dir,'qualification.current.json');await writeFile(report,'old report');await writeFile(manifest,'old manifest');const prior=new Map([['report',sha('old report')],['qualification.current.json',sha('old manifest')]]);await assert.rejects(publishCumbucoReplacements(dir,[['qualification.current.json',Buffer.from('new')]],prior,manifest,{retirePaths:['../protected']}),/unsafe_output_path/u);assert.equal(await readFile(report,'utf8'),'old report');let manifestFailed=false;const operations={rename:async(a,b)=>{if(b===manifest&&!manifestFailed){manifestFailed=true;await writeFile(report,'unexpected destination');throw Error('primary_manifest_failure');}return rename(a,b);}};await assert.rejects(publishCumbucoReplacements(dir,[['report',Buffer.from('new report')],['qualification.current.json',Buffer.from('new manifest')]],prior,manifest,{operations}),/rollback_unexpected_destination/u);assert.equal(await readFile(report,'utf8'),'unexpected destination');const backup=(await readdir(dir)).find(n=>n.startsWith('report.cumbuco-backup-'));assert.equal(await readFile(join(dir,backup),'utf8'),'old report');}finally{await rm(dir,{recursive:true,force:true});}
});

test('promotion detects an intervening edit and rolls back earlier replacements without overwriting it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-intervening-edit-'));
 try {
  const sha=x=>createHash('sha256').update(x).digest('hex');
  const first=join(dir,'first'),second=join(dir,'second'),manifest=join(dir,'qualification.current.json');
  await writeFile(first,'old first');await writeFile(second,'old second');await writeFile(manifest,'old manifest');
  const prior=new Map([['first',sha('old first')],['second',sha('old second')],['qualification.current.json',sha('old manifest')]]);
  let edited=false;
  const operations={rename:async(a,b)=>{
   await rename(a,b);
   if(b===first&&!edited){edited=true;await writeFile(second,'intervening edit');}
  }};
  await assert.rejects(publishCumbucoReplacements(dir,[['first',Buffer.from('new first')],['second',Buffer.from('new second')],['qualification.current.json',Buffer.from('new manifest')]],prior,manifest,{operations}),/original_changed:second/u);
  assert.equal(await readFile(first,'utf8'),'old first');
  assert.equal(await readFile(second,'utf8'),'intervening edit');
  assert.equal(await readFile(manifest,'utf8'),'old manifest');
  assert.equal((await readdir(dir)).some(name=>name.endsWith('.tmp')),false);
  const backup=(await readdir(dir)).find(name=>name.startsWith('second.cumbuco-backup-'));
  assert.equal(await readFile(join(dir,backup),'utf8'),'old second');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('rollback never removes a substituted staging inode during cleanup retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cumbuco-stage-identity-'));
 try {
  const protectedPath=join(dir,'protected'),manifest=join(dir,'qualification.current.json');
  await writeFile(protectedPath,'protected bytes');
  let substitutedStage;
  const operations={unlink:async path=>{
   if(!substitutedStage&&path.endsWith('.tmp')){
    substitutedStage=path;
    await unlink(path);await link(protectedPath,path);
    throw Error('injected_stage_cleanup_failure');
   }
   return unlink(path);
  }};
  await assert.rejects(publishCumbucoReplacements(dir,[['new-report',Buffer.from('new report')],['qualification.current.json',Buffer.from('manifest')]],new Map(),manifest,{operations}),error=>{
   assert.match(error.message,/injected_stage_cleanup_failure/u);
   assert.match(error.message,/stage_identity_changed/u);
   return true;
  });
  assert.equal(await readFile(protectedPath,'utf8'),'protected bytes');
  assert.equal((await stat(substitutedStage)).ino,(await stat(protectedPath)).ino);
  await assert.rejects(readFile(join(dir,'new-report')),{code:'ENOENT'});
  await assert.rejects(readFile(manifest),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
