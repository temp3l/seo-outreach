import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyze} from '../dist/pipeline.js';
import {loadEvidenceArchive} from '../dist/archive.js';
import {qualifiedDigest} from '../dist/decision.js';
import {isArtifactDirectoryPublished,readPublishedArtifact} from '../dist/files.js';

const archive=sampleFile('site-05.zip');
const pricingSource='https://developers.openai.com/api/docs/pricing';
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-live-pipeline-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
function providerOutput(issueId){return {selectedIssueIds:[issueId],opportunities:[{title:'Review one page',issueIds:[issueId],rationale:'The captured page supports a focused review.'}],salesAngle:{text:'A specific captured page may be clearer for visitors.',issueIds:[issueId]},businessContext:[],buyerRoleHypothesis:'School manager (hypothesis)',locale:'en',findings:[{issueId,implication:'Visitors may have less context.',proposedFix:'Review the page and make its information clearer.'}],whatsappOpener:'Hello, I noticed one specific detail on a captured page. Would it be useful if I sent the notes?',afterInterestReply:'Thanks for your interest. I can share the page detail and a small implementation option.',salesBrief:'One captured page has a reviewable issue. Evidence is partial and outcomes are uncertain.',uncertainties:['The crawl does not establish site-wide coverage.']};}
function config(over={}){return {model:'gpt-test-configured',timeoutMs:5000,maxInputTokens:32000,maxOutputTokens:1500,inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2,companyRequestCap:3,companyTokenCap:50000,companyUsdCap:1,batchRequestCap:3,batchTokenCap:50000,batchUsdCap:2,pricingConfirmedAt:new Date().toISOString(),pricingSource,maxAttempts:1,overallDeadlineMs:15000,maxRetryAfterMs:0,...over};}
function live(configPath,statePath,batchId='test-batch'){return {paidCallOptIn:true,configPath,statePath,batchId};}

test('live pipeline completion/cache/failsafe paths are bounded and never access the network', {skip:!existsSync(archive)&&'synthetic Belize-shaped ZIP fixture unavailable'}, async()=>fixture(async dir=>{
 const oldKey=process.env.OPENAI_API_KEY;const oldFetch=globalThis.fetch;let calls=0;
 try{
  process.env.OPENAI_API_KEY='sk-test-only-not-a-real-key';
  const loaded=await loadEvidenceArchive(archive);const digest=qualifiedDigest(loaded.evidence,loaded.pages);
  const issue=digest.issues.find(x=>['missing_title','missing_meta_description','missing_h1','missing_canonical','noindex','image_alt_missing_or_empty','images_missing_dimensions','malformed_json_ld'].includes(x.code));
  assert.ok(issue,'fixture has a supported corroborated finding');
  globalThis.fetch=async(url,init)=>{
   calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.headers.authorization,'Bearer sk-test-only-not-a-real-key');
   return new Response(JSON.stringify({id:'resp_test_001',status:'completed',output_text:JSON.stringify(providerOutput(issue.id)),usage:{input_tokens:1200,output_tokens:120}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const configPath=join(dir,'provider-config.json'),statePath=join(dir,'provider-state.json');await writeFile(configPath,JSON.stringify(config()));
  const firstOut=join(dir,'live-first');const first=await analyze({input:archive,out:firstOut,locale:'en',live:live(configPath,statePath),dryRun:false});
  assert.equal(first.provider.status,'COMPLETED');assert.equal(first.gates.LIVE.status,'READY');assert.equal(first.gates.CUSTOMER_READY.status,'HOLD');assert.equal(first.gates.OUTREACH_READY.status,'HOLD');assert.equal(first.provider.dispatches,1);assert.equal(calls,1);assert.equal(await isArtifactDirectoryPublished(firstOut),true);
  const firstManifest=JSON.parse((await readPublishedArtifact(firstOut,'manifest.json')).toString());assert.equal(firstManifest.spend.dispatches,1);

  const secondOut=join(dir,'live-cached');const second=await analyze({input:archive,out:secondOut,locale:'en',live:live(configPath,statePath),dryRun:false});
  assert.equal(second.provider.status,'CACHED');assert.equal(second.gates.LIVE.reason,'validated_completed_receipt_zero_new_dispatches');assert.equal(second.gates.CUSTOMER_READY.status,'HOLD');assert.equal(second.provider.dispatches,0);assert.equal(calls,1);assert.equal(await isArtifactDirectoryPublished(secondOut),true);

  const previewOut=join(dir,'preview-output'),before=await readdir(dir);
  const preview=await analyze({input:archive,out:previewOut,locale:'en',providerPreview:configPath,dryRun:true});
  assert.equal(preview.provider.dispatches,0);assert.equal(preview.provider.status,'NOT_SENT');assert.ok(preview.provider.predicted.requestTokens>0);assert.equal(calls,1);assert.deepEqual(await readdir(dir),before);

  const malformedPath=join(dir,'malformed.json');await writeFile(malformedPath,'{}');
  const malformed=await analyze({input:archive,out:join(dir,'invalid-config-output'),locale:'en',live:live(malformedPath,join(dir,'bad-state.json')),dryRun:false});
  assert.equal(malformed.provider.status,'NOT_SENT');assert.equal(malformed.provider.dispatches,0);assert.equal(malformed.gates.LIVE.status,'HOLD');assert.equal(calls,1);

  const savedKey=process.env.OPENAI_API_KEY;delete process.env.OPENAI_API_KEY;
  try{const missing=await analyze({input:archive,out:join(dir,'missing-key-output'),locale:'en',live:live(configPath,join(dir,'missing-key-state.json')),dryRun:false});assert.equal(missing.provider.status,'NOT_SENT');assert.equal(missing.provider.dispatches,0);assert.equal(calls,1);}finally{process.env.OPENAI_API_KEY=savedKey;}

  const capPath=join(dir,'zero-cap.json');await writeFile(capPath,JSON.stringify(config({companyRequestCap:0,batchRequestCap:0})));
  const capped=await analyze({input:archive,out:join(dir,'capped-output'),locale:'en',live:live(capPath,join(dir,'capped-state.json')),dryRun:false});
  assert.equal(capped.provider.status,'NOT_SENT');assert.equal(capped.provider.dispatches,0);assert.equal(calls,1);

  const timeoutPath=join(dir,'timeout-config.json');await writeFile(timeoutPath,JSON.stringify(config({timeoutMs:25,companyRequestCap:3,batchRequestCap:3})));
  const timeoutState=join(dir,'timeout-state.json'),timeoutOut=join(dir,'timeout-first');
  globalThis.fetch=async(_url,init)=>{calls++;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('timed out')),{once:true}));};
  const timed=await analyze({input:archive,out:timeoutOut,locale:'en',live:live(timeoutPath,timeoutState,'timeout-batch'),dryRun:false});
  assert.equal(timed.provider.status,'AMBIGUOUS');assert.equal(timed.provider.dispatches,1);const afterTimeout=calls;
  globalThis.fetch=async()=>{calls++;return new Response('{}',{status:200});};
  const restarted=await analyze({input:archive,out:join(dir,'timeout-restart'),locale:'en',live:live(timeoutPath,timeoutState,'timeout-batch'),dryRun:false});
  assert.equal(restarted.provider.status,'NOT_SENT');assert.equal(restarted.provider.dispatches,0);assert.equal(calls,afterTimeout);
  assert.equal(await isArtifactDirectoryPublished(timeoutOut),true);
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
}));
