import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchAuthorized, liveSettingsFingerprint, LIVE_PROMPT_VERSION, LIVE_SCHEMA_VERSION, retryAfterDelayMs } from '../dist/live.js';
import { estimateRequest } from '../dist/provider.js';
import { openLocalState } from '../dist/state.js';

const digest={version:'digest-v2',targetHost:'school.example',issues:[{id:'issue-a',code:'missing_title',language:'en',pages:[{id:'evidence-a',url:'https://school.example/courses'}],affectedDistinctPages:1}],coverage:{captured:1,failed:0,skipped:0,unattempted:0,robots:'FETCHED'},overflow:{sourceGroups:1,eligibleGroups:1,selectedGroups:1,omittedGroups:0,omittedExamples:0,excluded:{}},materialFingerprint:'a'.repeat(64),bytes:700,readiness:'REVIEW_REQUIRED'};
const config=(over={})=>({apiKey:'test-secret',model:'configured-model',endpoint:'https://api.openai.com/v1/responses',timeoutMs:1000,maxInputTokens:12000,maxOutputTokens:1200,inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:4,companyRequestCap:2,companyTokenCap:20000,companyUsdCap:1,batchRequestCap:5,batchTokenCap:60000,batchUsdCap:5,...over});
const caps=(c)=>({currency:'USD',company:{requests:c.companyRequestCap,tokens:c.companyTokenCap,money:c.companyUsdCap},batch:{requests:c.batchRequestCap,tokens:c.batchTokenCap,money:c.batchUsdCap}});
const identity=(c,over={})=>({company:digest.targetHost,branch:'branch-tarifa',evidenceFingerprint:digest.materialFingerprint,locale:'en',model:c.model,settingsFingerprint:liveSettingsFingerprint(c),promptVersion:LIVE_PROMPT_VERSION,schemaVersion:LIVE_SCHEMA_VERSION,...over});
const input=(statePath,c=config(),over={})=>({digest,locale:'en',config:c,identity:identity(c),batchId:'batch-1',caps:caps(c),statePath,paidCallOptIn:true,retry:{maxAttempts:1,deadlineAtMs:Date.now()+60_000,maxRetryAfterMs:1000},...over});
const generated={selectedIssueIds:['issue-a'],opportunities:[{title:'Improve course page clarity',issueIds:['issue-a'],rationale:'The page has no title.'}],salesAngle:{text:'A course page title is missing.',issueIds:['issue-a']},businessContext:[],buyerRoleHypothesis:'School manager',locale:'en',findings:[{issueId:'issue-a',implication:'Visitors may have less context in search results.',proposedFix:'Add a distinct page title.'}],whatsappOpener:'I noticed a missing page title. May I send a short report?',afterInterestReply:'Thanks. Here is the report; would you be open to a small implementation discussion?',salesBrief:'One verified observation; impact is not measured.',uncertainties:['No traffic or booking data was supplied.']};
const apiResponse=(usage={input_tokens:500,output_tokens:300})=>new Response(JSON.stringify({id:'resp_mock',status:'completed',output_text:JSON.stringify(generated),usage}),{status:200,headers:{'content-type':'application/json'}});
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-live-'));try{await fn(join(dir,'state.json'));}finally{await rm(dir,{recursive:true,force:true});}}

test('dispatches once, persists completed output, and returns validated cache with zero second calls',async()=>fixture(async statePath=>{
  let calls=0;const opts=input(statePath);
  const first=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});
  const second=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(first.status,'COMPLETED');assert.equal(second.status,'CACHED');assert.equal(calls,1);
  assert.deepEqual(second.output,generated);assert.deepEqual(second.cost,{amount:0.0017,currency:'USD'});
  assert.deepEqual(first.usage,{inputTokens:500,outputTokens:300});assert.deepEqual(second.usage,{inputTokens:500,outputTokens:300});
  const lock=await openLocalState(statePath).acquire();try{assert.deepEqual((await lock.getCache(opts.identity)).usage,{inputTokens:500,outputTokens:300});}finally{await lock.release();}
  const reservations=await openLocalState(statePath).inspectReservations();assert.equal(reservations.length,1);assert.equal(reservations[0].status,'COMPLETED');
}));

test('accepts a valid pre-usage cache entry without dispatching again',async()=>fixture(async statePath=>{
  let calls=0;const opts=input(statePath);
  const first=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});assert.equal(first.status,'COMPLETED');
  const lock=await openLocalState(statePath).acquire();try{
    const current=await lock.getCache(opts.identity);const {usage,...oldEntry}=current;
    await lock.putCache(opts.identity,oldEntry);
  }finally{await lock.release();}
  const cached=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(cached.status,'CACHED');assert.equal(cached.usage,undefined);assert.equal(calls,1);
}));

test('unknown reported usage stays UNKNOWN while successful result is still cached',async()=>fixture(async statePath=>{
  const result=await dispatchAuthorized({...input(statePath),fetchImpl:async()=>apiResponse({})});
  assert.equal(result.status,'COMPLETED');assert.deepEqual(result.cost,{status:'UNKNOWN'});
  assert.equal(result.usage,undefined);
  const cached=await dispatchAuthorized({...input(statePath),fetchImpl:async()=>{throw new Error('must not call');}});
  assert.equal(cached.status,'CACHED');assert.deepEqual(cached.cost,{status:'UNKNOWN'});assert.equal(cached.usage,undefined);
}));

test('requires explicit opt-in and valid configuration before dispatch',async()=>fixture(async statePath=>{
  let calls=0;const opts=input(statePath);
  const noOpt=await dispatchAuthorized({...opts,paidCallOptIn:false,fetchImpl:async()=>{calls++;return apiResponse();}});
  const noConfig=await dispatchAuthorized({...opts,config:undefined,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(noOpt.status,'NOT_SENT');assert.equal(noConfig.status,'NOT_SENT');assert.equal(calls,0);
  assert.equal((await openLocalState(statePath).inspectReservations()).length,0);
}));

test('identity and configured cap mismatches fail before state reservation or provider call',async()=>fixture(async statePath=>{
  let calls=0;const opts=input(statePath);
  const wrongHost=await dispatchAuthorized({...opts,identity:identity(opts.config,{company:'other.example'}),fetchImpl:async()=>{calls++;return apiResponse();}});
  const wrongPriceSettings=await dispatchAuthorized({...opts,identity:identity(opts.config,{settingsFingerprint:'b'.repeat(64)}),fetchImpl:async()=>{calls++;return apiResponse();}});
  const oldPromptIdentity=identity(opts.config,{promptVersion:'seo-outreach-sales-prompt-v2'});
  const oldPrompt=await dispatchAuthorized({...opts,identity:oldPromptIdentity,fetchImpl:async()=>{calls++;return apiResponse();}});
  const wrongCaps=await dispatchAuthorized({...opts,caps:{...opts.caps,company:{...opts.caps.company,money:2}},fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(wrongHost.status,'NOT_SENT');assert.equal(wrongPriceSettings.status,'NOT_SENT');assert.equal(oldPrompt.status,'NOT_SENT');assert.equal(wrongCaps.status,'NOT_SENT');assert.equal(calls,0);
  assert.equal((await openLocalState(statePath).inspectReservations()).length,0);
}));

test('prior prompt cache identity remains historical and is rejected before cache replay',async()=>fixture(async statePath=>{
  const opts=input(statePath),priorIdentity=identity(opts.config,{promptVersion:'seo-outreach-sales-prompt-v2'});
  const estimate=estimateRequest(digest,opts.config,'en');const store=openLocalState(statePath),lock=await store.acquire();
  try{
    const reservation=await lock.reserve(priorIdentity,'historic-batch',{requests:1,tokens:estimate.requestTokens,money:estimate.maxCostUsd},opts.caps);
    await lock.markDispatched(reservation.id);
    const cache={schema:'seo-outreach-provider-cache-v1',reservationId:reservation.id,output:generated,responseId:'resp_historical',cost:{status:'UNKNOWN'}};
    await lock.completeWithCache(reservation.id,priorIdentity,'resp_historical',cache,{status:'UNKNOWN'});
  }finally{await lock.release();}
  let calls=0;const result=await dispatchAuthorized({...opts,identity:priorIdentity,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(result.status,'NOT_SENT');assert.equal(result.reason,'prompt_or_schema_identity_mismatch');assert.equal(calls,0);
  const check=await store.acquire();try{assert.equal((await check.getCache(priorIdentity)).responseId,'resp_historical');}finally{await check.release();}
}));

test('timeout is persisted ambiguous and same identity is never automatically replayed',async()=>fixture(async statePath=>{
  const c=config({timeoutMs:10});let calls=0;
  const fetchImpl=async(_url,init)=>{calls++;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));};
  const first=await dispatchAuthorized(input(statePath,c,{identity:identity(c),fetchImpl}));
  const second=await dispatchAuthorized(input(statePath,c,{identity:identity(c),fetchImpl}));
  assert.equal(first.status,'AMBIGUOUS');assert.equal(second.status,'NOT_SENT');assert.equal(calls,1);
  assert.equal((await openLocalState(statePath).inspectReservations())[0].status,'AMBIGUOUS');
}));

test('concurrent duplicate execution is excluded by the lock while the first request is pending',async()=>fixture(async statePath=>{
  let calls=0,release,startedResolve;
  const gate=new Promise(r=>{release=r;});
  const started=new Promise(r=>{startedResolve=r;});
  const firstPromise=dispatchAuthorized({...input(statePath),fetchImpl:async()=>{calls++;startedResolve();await gate;return apiResponse();}});
  await started;
  const second=await dispatchAuthorized({...input(statePath),fetchImpl:async()=>{calls++;return apiResponse();}});
  release();const first=await firstPromise;
  assert.equal(second.status,'NOT_SENT');assert.equal(first.status,'COMPLETED');assert.equal(calls,1);
}));

test('invalid cached output fails closed without dispatch',async()=>fixture(async statePath=>{
  const opts=input(statePath),store=openLocalState(statePath),lock=await store.acquire();
  await lock.putCache(opts.identity,{schema:'seo-outreach-provider-cache-v1',reservationId:'orphan-reservation',output:{selectedIssueIds:['invented']},responseId:'resp_old',cost:{status:'UNKNOWN'}});await lock.release();
  let calls=0;const result=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(result.status,'NOT_SENT');assert.equal(result.reason,'cached_output_invalid');assert.equal(calls,0);
}));

test('orphan or ambiguous reservation cache entries cannot be replayed as completed output',async()=>fixture(async statePath=>{
  const opts=input(statePath),ambiguous=await dispatchAuthorized({...opts,fetchImpl:async()=>{throw new Error('timeout');}});
  assert.equal(ambiguous.status,'AMBIGUOUS');
  const store=openLocalState(statePath),lock=await store.acquire();
  await lock.putCache(opts.identity,{schema:'seo-outreach-provider-cache-v1',reservationId:ambiguous.reservationId,output:generated,responseId:'resp_uncommitted',cost:{status:'UNKNOWN'}});await lock.release();
  let calls=0;const resumed=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(resumed.status,'NOT_SENT');assert.equal(resumed.reason,'cached_output_invalid');assert.equal(calls,0);
}));

test('cap exhaustion reserves nothing and makes no provider call',async()=>fixture(async statePath=>{
  const c=config({companyUsdCap:0.000001}),opts=input(statePath,c);let calls=0;
  const result=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(result.status,'NOT_SENT');assert.equal(result.reason,'budget_cap_exceeded');assert.equal(calls,0);
  assert.equal((await openLocalState(statePath).inspectReservations()).length,0);
}));

test('definitive 429 records safe rejection and never retries within the invocation',async()=>fixture(async statePath=>{
  let calls=0;
  const result=await dispatchAuthorized({...input(statePath),fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'4'}});}});
  assert.equal(result.status,'DEFINITELY_REJECTED');assert.equal(result.retryAfter,'4');assert.equal(calls,1);
  assert.equal((await openLocalState(statePath).inspectReservations())[0].status,'DEFINITELY_REJECTED');
}));

test('retries only definite 429 with bounded Retry-After and a fresh reservation per attempt',async()=>fixture(async statePath=>{
  let calls=0;const opts=input(statePath,config(),{retry:{maxAttempts:3,deadlineAtMs:Date.now()+5000,maxRetryAfterMs:1000}});
  const result=await dispatchAuthorized({...opts,fetchImpl:async()=>{calls++;return calls===1?new Response('{}',{status:429,headers:{'retry-after':'0'}}):apiResponse();}});
  assert.equal(result.status,'COMPLETED');assert.equal(result.attempts,2);assert.equal(calls,2);
  const rows=await openLocalState(statePath).inspectReservations();assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.status),['DEFINITELY_REJECTED','COMPLETED']);
  assert.equal(rows[0].estimate.tokens,rows[1].estimate.tokens);assert.equal(rows[0].estimate.money,rows[1].estimate.money);
}));

test('does not retry missing, invalid, or over-bound Retry-After values',async()=>fixture(async statePath=>{
  for(const [label,header] of [['missing',undefined],['invalid','not-a-date'],['over-bound','5']]){
    let calls=0;const headers=header===undefined?{}:{'retry-after':header};
    const result=await dispatchAuthorized({...input(`${statePath}-${label}`,config(),{retry:{maxAttempts:3,deadlineAtMs:Date.now()+5000,maxRetryAfterMs:100}}),fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers});}});
    assert.equal(result.status,'DEFINITELY_REJECTED');assert.equal(result.attempts,1);assert.equal(calls,1);
  }
  assert.equal(retryAfterDelayMs('3',1_000),3_000);assert.equal(retryAfterDelayMs('Wed, 21 Oct 2015 07:28:00 GMT',Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')),60_000);assert.equal(retryAfterDelayMs('not-a-date',0),undefined);
}));

test('stops retry when Retry-After would reach or pass the overall deadline',async()=>fixture(async statePath=>{
  let calls=0;
  const result=await dispatchAuthorized({...input(statePath,config(),{retry:{maxAttempts:3,deadlineAtMs:Date.now()+50_000,maxRetryAfterMs:60_000}}),fetchImpl:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'60'}});}});
  assert.equal(result.status,'DEFINITELY_REJECTED');assert.equal(result.reason,'overall_deadline_prevents_retry');assert.equal(calls,1);
}));

test('already elapsed deadline makes zero calls and ambiguous failures are never retried',async()=>fixture(async statePath=>{
  let calls=0;
  const elapsed=await dispatchAuthorized({...input(statePath,config(),{retry:{maxAttempts:3,deadlineAtMs:Date.now()-1,maxRetryAfterMs:1000}}),fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(elapsed.status,'NOT_SENT');assert.equal(calls,0);
  const ambiguous=await dispatchAuthorized({...input(statePath,config(),{retry:{maxAttempts:3,deadlineAtMs:Date.now()+5000,maxRetryAfterMs:1000}}),fetchImpl:async()=>{calls++;throw new Error('timeout');}});
  assert.equal(ambiguous.status,'AMBIGUOUS');assert.equal(calls,1);
}));

test('company exposure and request caps include prior reservations across batch IDs',async()=>fixture(async statePath=>{
  const base=config();const estimate=estimateRequest(digest,base,'en');const c=config({companyTokenCap:estimate.requestTokens+10});
  const first=await dispatchAuthorized({...input(statePath,c),fetchImpl:async()=>apiResponse()});assert.equal(first.status,'COMPLETED');
  const otherDigest={...digest,materialFingerprint:'b'.repeat(64)};
  const secondIdentity={...identity(c,{branch:'branch-dakhla',evidenceFingerprint:otherDigest.materialFingerprint})};
  let calls=0;
  const second=await dispatchAuthorized({...input(statePath,c,{digest:otherDigest,identity:secondIdentity,batchId:'batch-2'}),fetchImpl:async()=>{calls++;return apiResponse();}});
  assert.equal(second.status,'NOT_SENT');assert.equal(second.reason,'budget_cap_exceeded');assert.equal(calls,0);
  assert.equal((await openLocalState(statePath).inspectReservations()).length,1);
}));
