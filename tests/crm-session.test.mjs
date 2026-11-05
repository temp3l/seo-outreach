import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishArtifacts} from '../dist/files.js';
import {mergeProspects} from '../dist/crm.js';
import {buildCrmSnapshot} from '../dist/crm-session.js';

async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-crm-session-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const row=(over={})=>({companyKey:'dive.example',branchKey:'branch-a',companyName:'Dive Example',branchLabel:'Branch A',website:'https://dive.example/branch-a/',status:'HOLD',evidenceFingerprint:'a'.repeat(64),issueCount:2,issueCodes:['missing_title','missing_h1'],...over});
async function publishPrior(dir,state,name='prior'){const directory=join(dir,name);await publishArtifacts(directory,{'prospects.json':Buffer.from(`${JSON.stringify(state)}\n`)},{allowedNames:['prospects.json']});return directory;}

test('merges incoming rows, deduplicates, and preserves every prior operator field without modifying source',async()=>fixture(async dir=>{
 const priorState=mergeProspects(undefined,[row()]);priorState.prospects[0].operator={stage:'contacted',owner:'Sam',notes:['called','follow up'],custom:{priority:3}};
 const previous=await publishPrior(dir,priorState);const original=await readFile(join(previous,'prospects.json'));
 const changed=row({evidenceFingerprint:'b'.repeat(64),issueCount:3,issueCodes:['missing_h1','noindex']});
 const result=await buildCrmSnapshot(previous,[changed,changed,row({branchKey:'branch-b',branchLabel:'Second branch'})]);
 const parsed=JSON.parse(result.json.toString('utf8'));
 assert.equal(result.count,2);assert.equal(parsed.prospects.length,2);
 const kept=parsed.prospects.find(p=>p.branchKey==='branch-a');assert.equal(kept.evidenceFingerprint,'b'.repeat(64));
 assert.deepEqual(kept.operator,priorState.prospects[0].operator);
 assert.ok(!result.csv.toString('utf8').includes('called'));
 assert.deepEqual(await readFile(join(previous,'prospects.json')),original);
}));

test('starts a fresh bounded snapshot when no prior directory is supplied',async()=>{
 const result=await buildCrmSnapshot(undefined,[row(),row()]);
 const parsed=JSON.parse(result.json.toString());assert.equal(result.count,1);assert.deepEqual(parsed.prospects[0].operator,{});
 assert.ok(result.csv.toString('utf8').includes('dive.example'));
});

test('accepts an explicit operator-edited JSON snapshot without modifying it',async()=>fixture(async dir=>{
 const state=mergeProspects(undefined,[row()]);state.prospects[0].operator={stage:'proposal',optOut:true,note:'operator-owned'};
 const path=join(dir,'operator-crm.json');await writeFile(path,JSON.stringify(state));const before=await readFile(path);
 const result=await buildCrmSnapshot(undefined,[row({evidenceFingerprint:'c'.repeat(64)})],{existingJsonPath:path});
 assert.deepEqual(JSON.parse(result.json.toString()).prospects[0].operator,state.prospects[0].operator);
 assert.deepEqual(await readFile(path),before);
 await assert.rejects(()=>buildCrmSnapshot(join(dir,'unused'),[],{existingJsonPath:path}),/ambiguous_crm_source/);
}));

test('rejects unpublished, corrupted, and semantically invalid prior states',async()=>fixture(async dir=>{
 const unpublished=join(dir,'unpublished');await mkdir(unpublished);await writeFile(join(unpublished,'prospects.json'),JSON.stringify({schema:'seo-outreach-crm-v1',prospects:[]}));
 await assert.rejects(()=>buildCrmSnapshot(unpublished,[row()]));
 const corrupted=await publishPrior(dir,mergeProspects(undefined,[row()]));await writeFile(join(corrupted,'prospects.json'),'x'.repeat((await readFile(join(corrupted,'prospects.json'))).length));
 await assert.rejects(()=>buildCrmSnapshot(corrupted,[row()]));
 const invalid=await publishPrior(dir,{schema:'wrong',prospects:[]},'invalid');
 await assert.rejects(()=>buildCrmSnapshot(invalid,[row()]),/corrupt_crm_state/);
 const unsafe=join(dir,'unsafe.json');await writeFile(unsafe,JSON.stringify(mergeProspects(undefined,[row()])));
 const link=join(dir,'unsafe-link.json');await (await import('node:fs/promises')).symlink(unsafe,link);
 await assert.rejects(()=>buildCrmSnapshot(undefined,[row()],{existingJsonPath:link}));
}));


test('reads the bounded prospect snapshot from a bundle with a larger retained source',async()=>fixture(async dir=>{
 const state=mergeProspects(undefined,[row()]);
 const source=Buffer.alloc(8*1024*1024+1,32),directory=join(dir,'large-source-bundle');
 await publishArtifacts(directory,{'prospects.json':Buffer.from(JSON.stringify(state)),'source.json':source},{allowedNames:['prospects.json','source.json'],maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
 const result=await buildCrmSnapshot(directory,[row({issueCount:3})]);assert.equal(result.count,1);assert.equal(JSON.parse(result.json).prospects[0].issueCount,3);
}));
