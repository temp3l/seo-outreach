import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeProspects, prospectsCsv, upsertProspectFiles } from '../dist/crm.js';

const candidate=(over={})=>({companyKey:'school.example',branchKey:'tarifa',companyName:'Kite School',branchLabel:'Tarifa',website:'https://school.example/?tracking=secret',status:'INTERNAL',evidenceFingerprint:'a'.repeat(64),issueCount:2,issueCodes:['missing_title','missing_h1'],...over});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-crm-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('identity is deterministic, branch-scoped and duplicate input is deduplicated',()=>{
  const first=mergeProspects(undefined,[candidate(),candidate({companyKey:' SCHOOL.EXAMPLE ',branchKey:' TARIFA ',issueCodes:['missing_h1','missing_title','missing_h1']})]);
  const second=mergeProspects(undefined,[candidate()]);
  assert.equal(first.prospects.length,1); assert.equal(first.prospects[0].id,second.prospects[0].id);
  assert.notEqual(mergeProspects(first,[candidate({branchKey:'dakhla'})]).prospects.length,first.prospects.length);
  assert.throws(()=>mergeProspects(undefined,[candidate(),candidate({companyName:'Conflicting name'})]),/conflicting_duplicate/);
});

test('refresh updates generated fields while preserving prior operator funnel state and old prospects',()=>{
  const old=mergeProspects(undefined,[candidate()]);
  old.prospects[0].operator={stage:'contacted',owner:'Sam',notes:'Call after season',nextAction:'follow_up'};
  old.prospects.push(mergeProspects(undefined,[candidate({companyKey:'other.example',branchKey:'main',companyName:'Other',website:'https://other.example'})]).prospects[0]);
  const next=mergeProspects(old,[candidate({status:'HOLD',evidenceFingerprint:'b'.repeat(64),issueCount:1})]);
  const updated=next.prospects.find(p=>p.companyKey==='school.example');
  assert.equal(updated.status,'HOLD'); assert.equal(updated.evidenceFingerprint,'b'.repeat(64));
  assert.deepEqual(updated.operator,{stage:'contacted',owner:'Sam',notes:'Call after season',nextAction:'follow_up'});
  assert.equal(next.prospects.length,2);
});

test('CSV escapes formula injection and excludes operator and private contact fields',()=>{
  const state=mergeProspects(undefined,[candidate({companyName:'=HYPERLINK("https://bad")'})]);
  state.prospects[0].operator={notes:'private note',owner:'=Alice'};
  const csv=prospectsCsv(state);
  assert.match(csv,/'=HYPERLINK/); assert.ok(!csv.includes('private note')); assert.ok(!csv.includes('=Alice'));
  assert.ok(!csv.includes('tracking=secret')); assert.ok(!csv.includes('phone'));
});

test('local upsert writes deduplicated JSON and CSV and never accepts private contact properties',async()=>fixture(async dir=>{
  const jsonPath=join(dir,'out','prospects.json'),csvPath=join(dir,'out','prospects.csv');
  const result=await upsertProspectFiles({jsonPath,csvPath,prospects:[candidate()]});
  assert.equal(result.state.prospects.length,1);
  const stored=JSON.parse(await readFile(jsonPath,'utf8')); assert.equal(stored.schema,'seo-outreach-crm-v1');
  assert.equal((await readFile(csvPath,'utf8')).split('\r\n').length,3);
  await assert.rejects(()=>upsertProspectFiles({jsonPath,csvPath,prospects:[candidate({phone:'+123'})]}),/unsupported_prospect_field/);
}));

test('malformed existing state and symlink destinations fail closed',async()=>fixture(async dir=>{
  const jsonPath=join(dir,'prospects.json'),csvPath=join(dir,'prospects.csv');
  await writeFile(jsonPath,'{"schema":"wrong","prospects":[]}');
  await assert.rejects(()=>upsertProspectFiles({jsonPath,csvPath,prospects:[candidate()]}),/corrupt_crm_state/);
  const real=join(dir,'real.json'); await writeFile(real,JSON.stringify(mergeProspects(undefined,[candidate()])));
  await rm(jsonPath); await symlink(real,jsonPath);
  await assert.rejects(()=>upsertProspectFiles({jsonPath,csvPath,prospects:[candidate()]}));
}));

test('an abandoned exclusive publication lock blocks a second writer',async()=>fixture(async dir=>{
  const jsonPath=join(dir,'prospects.json'),csvPath=join(dir,'prospects.csv');
  await writeFile(`${jsonPath}.lock`,'held');
  await assert.rejects(()=>upsertProspectFiles({jsonPath,csvPath,prospects:[candidate()]}),/crm_state_locked/);
}));
