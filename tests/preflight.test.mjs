import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyze, batch } from '../dist/pipeline.js';
import { loadEvidenceArchive } from '../dist/archive.js';
import { qualifiedDigest } from '../dist/decision.js';
import { mergeProspects } from '../dist/crm.js';
import { buildCrmSnapshotFromState } from '../dist/crm-session.js';
import { readPublishedArtifact } from '../dist/files.js';

const site05=sampleFile('site-05.zip');
const site04=sampleFile('site-04.zip');
const pricingSource='https://developers.openai.com/api/docs/pricing';

async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-preflight-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
function config(){return {model:'gpt-test-configured',timeoutMs:5000,maxInputTokens:32000,maxOutputTokens:1500,inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:2,companyRequestCap:3,companyTokenCap:50000,companyUsdCap:1,batchRequestCap:3,batchTokenCap:50000,batchUsdCap:2,pricingConfirmedAt:new Date().toISOString(),pricingSource,maxAttempts:1,overallDeadlineMs:15000,maxRetryAfterMs:0};}
function live(configPath,statePath,batchId='preflight-test'){return {paidCallOptIn:true,configPath,statePath,batchId};}
async function assertNoDispatch(statePath,calls){assert.equal(calls(),0,'provider fetch must not happen before local validation');assert.equal(existsSync(statePath),false,'preflight rejection must not create provider state/reservation');}
function crmSnapshotNearLimit(target=8*1024*1024-64){
 const state=mergeProspects(undefined,Array.from({length:5},(_,i)=>({companyKey:`padding-${i}.example`,branchKey:'main',companyName:`Padding ${i}`,website:`https://padding-${i}.example/`,status:'HOLD',evidenceFingerprint:String(i+1).repeat(64),issueCount:0,issueCodes:[]})));
 for(const prospect of state.prospects)prospect.operator={padding:Array.from({length:9},()=>Array(100).fill(''))};
 const limit=8*1024*1024;
 const size=()=>Buffer.byteLength(`${JSON.stringify(state,null,2)}\n`);
 let gap=target-size();assert.ok(gap>0&&gap<=5*9*100*2000,'padding skeleton leaves enough bounded room to reach target size');
 for(const prospect of state.prospects){for(const row of prospect.operator.padding){for(let i=0;i<row.length&&gap>0;i++){const take=Math.min(2000,gap);row[i]='x'.repeat(take);gap-=take;}}}
 assert.equal(gap,0);assert.equal(size(),target);
 return {state,limit,baseBytes:size()};
}
function crmProspectFor(loaded){
 const digest=qualifiedDigest(loaded.evidence,loaded.pages);
 const codes=[...new Set(digest.issues.map(issue=>issue.code))].filter(code=>['missing_meta_description','missing_title','missing_h1','missing_canonical','noindex','image_alt_missing_or_empty','images_missing_dimensions','malformed_json_ld'].includes(code)).slice(0,6);
 return {companyKey:loaded.evidence.hostname,branchKey:loaded.evidence.targetIdentity,companyName:loaded.evidence.hostname,website:new URL(loaded.evidence.target).origin+'/',status:'HOLD',evidenceFingerprint:digest.materialFingerprint,issueCount:codes.length,issueCodes:codes};
}

test('analyze validates seller fields before paid-call state or provider fetch', {}, async()=>fixture(async dir=>{
 const oldKey=process.env.OPENAI_API_KEY,oldFetch=globalThis.fetch;let fetches=0;
 try{
  process.env.OPENAI_API_KEY='sk-test-only-not-a-real-key';
  globalThis.fetch=async()=>{fetches++;throw new Error('test_fetch_must_not_run');};
  const configPath=join(dir,'provider.json');await writeFile(configPath,JSON.stringify(config()));
  const cases=[
   {field:'sellerName',value:''},
   {field:'sellerName',value:'   '},
   {field:'sellerName',value:'<b>Belize Dive School</b>'},
   {field:'sellerName',value:'x'.repeat(601)},
   {field:'sellerLocation',value:''},
   {field:'sellerLocation',value:' \t '},
   {field:'sellerLocation',value:'<script>Belize</script>'},
   {field:'sellerLocation',value:'x'.repeat(601)},
  ];
  for(let i=0;i<cases.length;i++){
   const item=cases[i],statePath=join(dir,`seller-${i}.state`),args={input:site05,out:join(dir,`seller-${i}-out`),locale:'en',sellerName:'Belize Dive School',sellerLocation:'Belize',live:live(configPath,statePath,`seller-${i}`),dryRun:false};
   args[item.field]=item.value;
   await assert.rejects(()=>analyze(args),/seller|invalid|unsafe/i,`${item.field}=${JSON.stringify(item.value)}`);
   await assertNoDispatch(statePath,()=>fetches);
  }
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
}));

test('analyze rejects missing, malformed, or corrupt explicit CRM snapshots before dispatch', {}, async()=>fixture(async dir=>{
 const oldKey=process.env.OPENAI_API_KEY,oldFetch=globalThis.fetch;let fetches=0;
 try{
  process.env.OPENAI_API_KEY='sk-test-only-not-a-real-key';globalThis.fetch=async()=>{fetches++;throw new Error('test_fetch_must_not_run');};
  const configPath=join(dir,'provider.json');await writeFile(configPath,JSON.stringify(config()));
  const cases=[
   {name:'missing',path:join(dir,'missing-prospects.json')},
   {name:'malformed',path:join(dir,'malformed-prospects.json'),contents:'{"schema":'},
   {name:'wrong-schema',path:join(dir,'wrong-schema-prospects.json'),contents:JSON.stringify({schema:'wrong',prospects:[]})},
   {name:'corrupt-row',path:join(dir,'corrupt-row-prospects.json'),contents:JSON.stringify({schema:'seo-outreach-crm-v1',prospects:[{id:'bad'}]})},
  ];
  for(let i=0;i<cases.length;i++){
   const item=cases[i];if(item.contents!==undefined)await writeFile(item.path,item.contents);
   const statePath=join(dir,`crm-${i}.state`);
   await assert.rejects(()=>analyze({input:site05,out:join(dir,`crm-${i}-out`),locale:'en',crmExisting:item.path,live:live(configPath,statePath,`crm-${i}`),dryRun:false}),/crm|prospect|state|json|snapshot/i,item.name);
   await assertNoDispatch(statePath,()=>fetches);
  }
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
}));

test('batch validates explicit CRM snapshot before dispatching its first prospect', {}, async()=>fixture(async dir=>{
 const oldKey=process.env.OPENAI_API_KEY,oldFetch=globalThis.fetch;let fetches=0;
 try{
  process.env.OPENAI_API_KEY='sk-test-only-not-a-real-key';globalThis.fetch=async()=>{fetches++;throw new Error('test_fetch_must_not_run');};
  const configPath=join(dir,'provider.json'),statePath=join(dir,'batch.state'),crmPath=join(dir,'corrupt-prospects.json'),manifestPath=join(dir,'batch.json');
  await writeFile(configPath,JSON.stringify(config()));await writeFile(crmPath,'not json');await writeFile(manifestPath,JSON.stringify({inputs:[site05]}));
  await assert.rejects(()=>batch({manifest:manifestPath,out:join(dir,'batch-out'),locale:'en',crmExisting:crmPath,live:live(configPath,statePath,'batch-preflight'),dryRun:false}),/crm|prospect|state|json|snapshot/i);
  await assertNoDispatch(statePath,()=>fetches);
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
}));

test('analyze publishes from the validated preflight CRM snapshot without reparsing after the provider call', {}, async()=>fixture(async dir=>{
 const oldKey=process.env.OPENAI_API_KEY,oldFetch=globalThis.fetch;let fetches=0;
 try{
  process.env.OPENAI_API_KEY='sk-test-only-not-a-real-key';
  const loaded=await loadEvidenceArchive(site05),digest=qualifiedDigest(loaded.evidence,loaded.pages);
  const issue=digest.issues.find(x=>['missing_title','missing_meta_description','missing_h1','missing_canonical','noindex','image_alt_missing_or_empty','images_missing_dimensions','malformed_json_ld'].includes(x.code));
  assert.ok(issue,'fixture has a supported corroborated issue');
  const configPath=join(dir,'provider.json'),statePath=join(dir,'provider.state'),crmPath=join(dir,'existing-prospects.json');
  await writeFile(configPath,JSON.stringify(config()));
  const prior=mergeProspects(undefined,[{companyKey:'retained.example',branchKey:'main',companyName:'Retained Company',website:'https://retained.example/',status:'HOLD',evidenceFingerprint:'a'.repeat(64),issueCount:1,issueCodes:['missing_title']}]);
  prior.prospects[0].operator={owner:'Operator-owned',stage:'review'};
  await writeFile(crmPath,JSON.stringify(prior));
  const output={selectedIssueIds:[issue.id],opportunities:[{title:'Review one page',issueIds:[issue.id],rationale:'The captured page supports a focused review.'}],salesAngle:{text:'A specific captured page may be clearer for visitors.',issueIds:[issue.id]},businessContext:[],buyerRoleHypothesis:'School manager (hypothesis)',locale:'en',findings:[{issueId:issue.id,implication:'Visitors may have less context.',proposedFix:'Review the page and make its information clearer.'}],whatsappOpener:'Hello, I noticed one specific detail on a captured page. Would it be useful if I sent the notes?',afterInterestReply:'Thanks for your interest. I can share the page detail and a small implementation option.',salesBrief:'One captured page has a reviewable issue. Evidence is partial and outcomes are uncertain.',uncertainties:['The crawl does not establish site-wide coverage.']};
  globalThis.fetch=async()=>{fetches++;await writeFile(crmPath,'not json after provider dispatch');return new Response(JSON.stringify({id:'resp_preflight_crm',status:'completed',output_text:JSON.stringify(output),usage:{input_tokens:1200,output_tokens:120}}),{status:200,headers:{'content-type':'application/json'}});};
  const out=join(dir,'published');
  const result=await analyze({input:site05,out,locale:'en',crmExisting:crmPath,live:live(configPath,statePath),dryRun:false});
  assert.equal(result.provider.status,'COMPLETED');assert.equal(fetches,1);
  const published=JSON.parse((await readPublishedArtifact(out,'prospects.json')).toString());
  const retained=published.prospects.find(p=>p.companyKey==='retained.example');
  assert.ok(retained,'preflight prospect is preserved after source file changes');
  assert.deepEqual(retained.operator,{owner:'Operator-owned',stage:'review'});
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
}));

test('analyze and batch preflight prospective CRM capacity before any paid dispatch', {}, async()=>fixture(async dir=>{
 const oldKey=process.env.OPENAI_API_KEY,oldFetch=globalThis.fetch;let fetches=0;
 try{
  process.env.OPENAI_API_KEY='sk-test-only-not-a-real-key';globalThis.fetch=async()=>{fetches++;throw new Error('test_fetch_must_not_run');};
  const {state,limit,baseBytes}=crmSnapshotNearLimit();
  const candidate={companyKey:'new-company.example',branchKey:'new-branch',companyName:'New Company',website:'https://new-company.example/',status:'HOLD',evidenceFingerprint:'f'.repeat(64),issueCount:6,issueCodes:['missing_title','missing_h1']};
  const existingSnapshot=buildCrmSnapshotFromState(state,[]),projectedBytes=Buffer.byteLength(`${JSON.stringify(mergeProspects(state,[candidate]),null,2)}\n`);
  assert.equal(existingSnapshot.json.byteLength,baseBytes);assert.ok(baseBytes<limit);assert.ok(projectedBytes>limit,`base=${baseBytes}, prospective_growth=${projectedBytes-baseBytes}, limit=${limit}`);
  const configPath=join(dir,'provider.json'),crmPath=join(dir,'near-limit-prospects.json');await writeFile(configPath,JSON.stringify(config()));await writeFile(crmPath,JSON.stringify(state));
  const analyzeState=join(dir,'analyze.state');
  await assert.rejects(()=>analyze({input:site05,out:join(dir,'near-limit-analyze'),locale:'en',crmExisting:crmPath,live:live(configPath,analyzeState,'near-limit-analyze'),dryRun:false}),/crm|prospect|capacity/i);
  await assertNoDispatch(analyzeState,()=>fetches);
  const batchState=join(dir,'batch.state'),manifestPath=join(dir,'near-limit-batch.json');await writeFile(manifestPath,JSON.stringify({inputs:[site05]}));
  await assert.rejects(()=>batch({manifest:manifestPath,out:join(dir,'near-limit-batch'),locale:'en',crmExisting:crmPath,live:live(configPath,batchState,'near-limit-batch'),dryRun:false}),/crm|prospect|capacity/i);
  await assertNoDispatch(batchState,()=>fetches);

  const [loaded05,loaded04]=await Promise.all([loadEvidenceArchive(site05),loadEvidenceArchive(site04)]);
  const [prospect05,prospect04]=[crmProspectFor(loaded05),crmProspectFor(loaded04)];
  const smallState=mergeProspects(undefined,Array.from({length:5},(_,i)=>({companyKey:`padding-${i}.example`,branchKey:'main',companyName:`Padding ${i}`,website:`https://padding-${i}.example/`,status:'HOLD',evidenceFingerprint:String(i+1).repeat(64),issueCount:0,issueCodes:[]})));
  const smallBytes=Buffer.byteLength(`${JSON.stringify(smallState,null,2)}\n`);
  const one05=Buffer.byteLength(`${JSON.stringify(mergeProspects(smallState,[prospect05]),null,2)}\n`)-smallBytes;
  const one04=Buffer.byteLength(`${JSON.stringify(mergeProspects(smallState,[prospect04]),null,2)}\n`)-smallBytes;
  const both=Buffer.byteLength(`${JSON.stringify(mergeProspects(smallState,[prospect05,prospect04]),null,2)}\n`)-smallBytes;
  const headroom=Math.max(one05,one04)+32,target=limit-headroom;
  assert.ok(both>headroom,`aggregate_growth=${both}, remaining_capacity=${headroom}; each prospect fits alone`);
  const aggregate=crmSnapshotNearLimit(target),aggregateCrmPath=join(dir,'aggregate-near-limit-prospects.json');
  assert.ok(buildCrmSnapshotFromState(aggregate.state,[prospect05]).json.byteLength<=limit);
  assert.ok(buildCrmSnapshotFromState(aggregate.state,[prospect04]).json.byteLength<=limit);
  assert.ok(Buffer.byteLength(`${JSON.stringify(mergeProspects(aggregate.state,[prospect05,prospect04]),null,2)}\n`)>limit);
  await writeFile(aggregateCrmPath,JSON.stringify(aggregate.state));
  const aggregateState=join(dir,'aggregate.state'),aggregateManifest=join(dir,'aggregate-batch.json');
  await writeFile(aggregateManifest,JSON.stringify({inputs:[site05,site04]}));
  await assert.rejects(()=>batch({manifest:aggregateManifest,out:join(dir,'aggregate-batch'),locale:'en',crmExisting:aggregateCrmPath,live:live(configPath,aggregateState,'aggregate-preflight'),dryRun:false}),/crm|prospect|capacity/i);
  await assertNoDispatch(aggregateState,()=>fetches);
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
}));
