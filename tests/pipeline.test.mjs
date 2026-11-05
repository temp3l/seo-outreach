import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {analyze,batch,render} from '../dist/pipeline.js';
import {isArtifactDirectoryPublished,readPublishedArtifact} from '../dist/files.js';
import {loadAudit} from '../dist/evidence.js';
import {mergeProspects} from '../dist/crm.js';

const cumbuco=sampleFile('br-kite.json');
const belize=sampleFile('site-05.zip');
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-pipeline-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function withoutNetwork(fn){
 let calls=0;const oldFetch=globalThis.fetch,oldHttp=http.request,oldHttpGet=http.get,oldHttps=https.request,oldHttpsGet=https.get;
 const blocked=()=>{calls++;throw new Error('unexpected_network_request');};
 globalThis.fetch=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;
 try{await fn(()=>calls);}finally{globalThis.fetch=oldFetch;http.request=oldHttp;http.get=oldHttpGet;https.request=oldHttps;https.get=oldHttpsGet;}
}

test('pipeline E2E: real sources, gates, replay, corruption, batches, and explicit CRM snapshot',async t=>{
 await withoutNetwork(async networkCalls=>fixture(async dir=>{
  if(existsSync(cumbuco))await t.test('synthetic Cumbuco-shaped JSON dry-run is read-only and network-free',async()=>{
   const before=await readdir(dir);const result=await analyze({input:cumbuco,out:join(dir,'dry-json'),locale:'en',dryRun:true});
   assert.equal(result.inputFormat,'JSON');assert.equal(result.provider.dispatches,0);assert.equal(result.provider.cost,'UNKNOWN');
   assert.deepEqual(await readdir(dir),before);assert.equal(networkCalls(),0);
  });
  else await t.test('synthetic Cumbuco-shaped JSON dry-run is read-only and network-free',{skip:'synthetic Cumbuco-shaped fixture unavailable'},()=>{});

  if(existsSync(belize)){
   await t.test('synthetic Belize-shaped ZIP dry-run is read-only and network-free',async()=>{
    const before=await readdir(dir);const result=await analyze({input:belize,out:join(dir,'dry-zip'),locale:'en',dryRun:true});
    assert.equal(result.inputFormat,'ZIP');assert.equal(result.provider.dispatches,0);assert.deepEqual(await readdir(dir),before);assert.equal(networkCalls(),0);
   });
   await t.test('six findings produce an explicitly internal HOLD PDF and successful replay',async()=>{
    const out=join(dir,'belize-output');const result=await analyze({input:belize,out,locale:'en',dryRun:false});
    assert.equal(result.status,'INTERNAL_HOLD');assert.equal(result.gates.CUSTOMER_READY.status,'HOLD');assert.equal(result.gates.OUTREACH_READY.status,'HOLD');
    assert.equal(await isArtifactDirectoryPublished(out),true);const files=await readdir(out);assert.ok(files.includes('report.pdf'));
    const manifest=JSON.parse((await readPublishedArtifact(out,'manifest.json')).toString());assert.equal(manifest.pdfVerification.status,'ARTIFACT_VERIFIED_ONLY');assert.equal(manifest.pdfVerification.findings,6);assert.equal(manifest.readiness.CUSTOMER_READY.status,'HOLD');
    const pdf=await readFile(join(out,'report.pdf'));assert.ok(pdf.subarray(0,8).toString('latin1').startsWith('%PDF-'));assert.ok(pdf.toString('latin1').includes('INTERNAL / HOLD'));
    const analysis=await readPublishedArtifact(out,'analysis.json');assert.equal(JSON.parse(analysis.toString()).status,'INTERNAL_HOLD');
    const replayOut=join(dir,'belize-replay');const replay=await render({analysis:join(out,'analysis.json'),out:replayOut,dryRun:false});
    assert.equal(replay.status,'INTERNAL_HOLD');assert.equal(await isArtifactDirectoryPublished(replayOut),true);
    await assert.rejects(()=>analyze({input:belize,out,locale:'en',dryRun:false}),/destination_exists/);
    const analysisPath=join(out,'analysis.json'),bytes=await readFile(analysisPath);const marker=bytes.indexOf(Buffer.from('OFFLINE_TEMPLATE'));
    assert.ok(marker>=0);bytes[marker+Buffer.byteLength('OFFLINE_TEMPLATE')-1]^=1;await writeFile(analysisPath,bytes);
    assert.equal(await isArtifactDirectoryPublished(out),false);
    await assert.rejects(()=>render({analysis:analysisPath,out:join(dir,'corrupt-replay'),dryRun:false}));
    assert.equal(networkCalls(),0);
   });
  }else await t.test('synthetic Belize-shaped ZIP pipeline and six-finding PDF',{skip:'synthetic Belize-shaped ZIP fixture unavailable'},()=>{});

  if(existsSync(cumbuco))await t.test('immutable source snapshots survive source changes and reject snapshot corruption',async()=>{
   const source=join(dir,'mutable.json');await copyFile(cumbuco,source);const out=join(dir,'source-output');
   await analyze({input:source,out,locale:'en',dryRun:false});const brief=(await readPublishedArtifact(out,'sales-brief.md')).toString();assert.match(brief,/robots retrieval: missing/);assert.match(brief,/hsts_missing_or_inactive/);assert.match(brief,/ownership and outreach eligibility remain unverified/i);await writeFile(source,`${await readFile(source,'utf8')} `);
   await rm(source);const moved=join(dir,'moved-analysis');await (await import('node:fs/promises')).rename(out,moved);
   const replay=await render({analysis:join(moved,'analysis.json'),out:join(dir,'portable-replay'),dryRun:false});assert.equal(replay.status,'INTERNAL_HOLD');
   await writeFile(join(moved,'source.json'),'corrupt source snapshot');await assert.rejects(()=>render({analysis:join(moved,'analysis.json'),out:join(dir,'corrupt-source-replay'),dryRun:false}));
  });
  else await t.test('immutable source snapshots survive source changes and reject snapshot corruption',{skip:'synthetic Cumbuco-shaped fixture unavailable'},()=>{});

  if(existsSync(cumbuco))await t.test('batch deduplicates unchanged branch, rejects changed evidence, and preserves explicit CRM operator state',async()=>{
   const source=join(dir,'batch-input.json');await copyFile(cumbuco,source);const evidence=await loadAudit(source);
   const crm=mergeProspects(undefined,[{companyKey:evidence.hostname,branchKey:evidence.targetIdentity,companyName:evidence.hostname,website:new URL(evidence.target).origin+'/',status:'HOLD',evidenceFingerprint:'a'.repeat(64),issueCount:0,issueCodes:[]}]);
   crm.prospects[0].operator={stage:'contacted',owner:'operator',notes:['preserve me']};const prior=join(dir,'prior-crm.json');await writeFile(prior,JSON.stringify(crm));
   const manifest=join(dir,'batch.json');await writeFile(manifest,JSON.stringify({inputs:['batch-input.json','batch-input.json']}));
   const dry=await batch({manifest,out:join(dir,'batch-dry'),locale:'en',dryRun:true});assert.equal(dry.count,1);assert.equal(dry.duplicates,1);assert.equal(await networkCalls(),0);assert.ok(!(await readdir(dir)).includes('batch-dry'));
   const out=join(dir,'batch-output');const done=await batch({manifest,out,locale:'en',crmExisting:prior,dryRun:false});assert.equal(done.count,1);assert.equal(done.duplicates,1);
   const companyDir=join(out,evidence.targetIdentity.slice(0,24));assert.equal(await isArtifactDirectoryPublished(companyDir),true);
   const outputCrm=JSON.parse((await readPublishedArtifact(companyDir,'prospects.json')).toString());
   assert.deepEqual(outputCrm.prospects[0].operator,crm.prospects[0].operator);assert.deepEqual(JSON.parse(await readFile(prior,'utf8')),crm);
   const changed=JSON.parse(await readFile(source,'utf8'));changed.completedAt=new Date(Date.parse(changed.completedAt)+1000).toISOString();const modified=join(dir,'changed.json');await writeFile(modified,JSON.stringify(changed));
   const conflict=join(dir,'conflict.json');await writeFile(conflict,JSON.stringify({inputs:['batch-input.json','changed.json']}));
   await assert.rejects(()=>batch({manifest:conflict,out:join(dir,'conflict-output'),locale:'en',dryRun:true}),/conflicting_inputs_for_company/);
   assert.equal(networkCalls(),0);
  });
  else await t.test('batch deduplication and CRM preservation',{skip:'synthetic Cumbuco-shaped fixture unavailable'},()=>{});
 }));
});
test('private drafts avoid opaque page references and uncertain noindex claims',async()=>{
 if(!existsSync(belize))return;
 await withoutNetwork(()=>fixture(async dir=>{const out=join(dir,'draft');await analyze({input:belize,out,locale:'en',dryRun:false});const draft=(await readPublishedArtifact(out,'whatsapp-opener.txt')).toString();assert.ok(!draft.includes('noindex'));assert.ok(!draft.includes('page_'));assert.match(draft,/https:\/\//);}));
});


test('retained valid source over 8MiB supports analyze and portable render',async()=>{
 await withoutNetwork(()=>fixture(async dir=>{
  const source=join(dir,'large.json');await writeFile(source,Buffer.concat([await readFile(cumbuco),Buffer.alloc(8*1024*1024,32)]));
  const out=join(dir,'large-source'),again=join(dir,'large-replay');await analyze({input:source,out,locale:'en',dryRun:false});
  const result=await render({analysis:join(out,'analysis.json'),out:again,dryRun:false});assert.equal(result.status,'INTERNAL_HOLD');assert.equal(await isArtifactDirectoryPublished(again,{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024}),true);
 }));
});
