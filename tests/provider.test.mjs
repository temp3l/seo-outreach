import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRequest, generateSalesOutput, validateRecordedOutput } from '../dist/provider.js';

const digest = { version:'digest-v2', targetHost:'example.test', issues:[{id:'issue-a',code:'missing_title',language:'en',pages:[{id:'evidence-a',url:'https://example.test/courses'}],affectedDistinctPages:1}], coverage:{captured:1,failed:0,skipped:0,unattempted:0,robots:'FETCHED'}, overflow:{sourceGroups:1,eligibleGroups:1,selectedGroups:1,omittedGroups:0,omittedExamples:0,excluded:{}}, materialFingerprint:'abc',bytes:500,readiness:'REVIEW_REQUIRED' };
const config = { apiKey:'test-secret', model:'configured-model', endpoint:'https://api.openai.com/v1/responses', timeoutMs:5000, maxInputTokens:8000, maxOutputTokens:1500, inputUsdPerMillionTokens:1, outputUsdPerMillionTokens:4, companyRequestCap:1, companyTokenCap:10000, companyUsdCap:1, batchRequestCap:10, batchTokenCap:100000, batchUsdCap:10 };
const spend = { paidCallOptIn:true, companyRequestsReserved:1, companyTokensReserved:10000, companyUsdReserved:1, batchRequestsReserved:1, batchTokensReserved:10000, batchUsdReserved:1 };
const generated = { selectedIssueIds:['issue-a'], opportunities:[{title:'Improve course-page clarity',issueIds:['issue-a'],rationale:'The title is absent on the course page.'}], salesAngle:{text:'Observed issue',issueIds:['issue-a']}, businessContext:[], buyerRoleHypothesis:'School manager', locale:'en', findings:[{issueId:'issue-a',implication:'May make the page less clear in search results.',proposedFix:'Write a distinct title.'}], whatsappOpener:'A specific note. May I send a short report?', afterInterestReply:'Thanks. Here is the report; would a small implementation discussion help?', salesBrief:'One observed title issue.', uncertainties:['Business impact is not measured.'] };
const response = (body, status=200) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json'}});

test('requires explicit spend opt-in before dispatch', async () => {
  let calls = 0;
  const result = await generateSalesOutput(digest,'en', { config, spend:{...spend,paidCallOptIn:false}, fetchImpl:async()=>{ calls++; return response({}); } });
  assert.equal(result.status,'NOT_SENT'); assert.equal(calls,0);
});

test('rejects digest-v1 before estimating, validating recorded output, or dispatching',async()=>{
  let calls=0;const old={...digest,version:'digest-v1'};
  const result=await generateSalesOutput(old,'en',{config,spend,fetchImpl:async()=>{calls++;return response({});}});
  assert.equal(result.status,'NOT_SENT');assert.equal(result.reason,'digest_not_bounded_or_eligible');assert.equal(calls,0);
  assert.throws(()=>estimateRequest(old,config,'en'),/digest_not_bounded_or_eligible/);
  assert.equal(validateRecordedOutput(generated,old,'en').ok,false);
});

test('sends one bounded strict-schema Responses API request and returns only known issue references', async () => {
  let calls = 0; let sent;
  const result = await generateSalesOutput(digest,'en', { config, spend, fetchImpl:async(url,init)=>{ calls++; sent={url,init,body:JSON.parse(init.body)}; return response({id:'resp_test',status:'completed',output_text:JSON.stringify(generated),usage:{input_tokens:100,output_tokens:200}}); } });
  assert.equal(calls,1); assert.equal(sent.url,config.endpoint); assert.equal(sent.body.model,config.model); assert.deepEqual(sent.body.reasoning,{effort:'medium'}); assert.equal(sent.body.max_output_tokens,config.maxOutputTokens); assert.equal(sent.body.store,false); assert.deepEqual(sent.body.tools,[]); assert.equal(sent.body.text.format.type,'json_schema'); assert.equal(sent.init.headers.authorization,'Bearer test-secret');
  assert.match(sent.body.input[0].content[0].text,/"requestedLocale":"en"/);
  assert.equal(result.status,'COMPLETED'); assert.equal(result.output.findings[0].issueId,'issue-a'); assert.equal(result.usage.inputTokens,100);
});

test('does not retry or classify a transport timeout as a definite rejection', async () => {
  let calls=0;
  const result=await generateSalesOutput(digest,'en',{config,spend,fetchImpl:async()=>{calls++;throw new Error('socket closed');}});
  assert.equal(calls,1); assert.equal(result.status,'AMBIGUOUS');
});

test('classifies a definitive rate-limit response as rejected without retry', async () => {
  let calls=0;
  const result=await generateSalesOutput(digest,'en',{config,spend,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{message:'rate limited'}}),{status:429,headers:{'retry-after':'3'}});}});
  assert.equal(calls,1); assert.equal(result.status,'DEFINITELY_REJECTED'); assert.equal(result.httpStatus,429); assert.equal(result.retryAfter,'3');
});

test('treats non-429 HTTP errors as ambiguous unless pre-accept rejection is proven', async () => {
  const result=await generateSalesOutput(digest,'en',{config,spend,fetchImpl:async()=>response({error:{message:'bad request'}},400)});
  assert.equal(result.status,'AMBIGUOUS');
});

test('fails closed when pricing or exposure reservation is missing', async () => {
  let calls=0;
  const noPrice={...config,inputUsdPerMillionTokens:undefined};
  const a=await generateSalesOutput(digest,'en',{config:noPrice,spend,fetchImpl:async()=>{calls++;return response({});}});
  const b=await generateSalesOutput(digest,'en',{config,spend:{...spend,batchUsdReserved:0},fetchImpl:async()=>{calls++;return response({});}});
  assert.equal(a.status,'NOT_SENT'); assert.equal(b.status,'NOT_SENT'); assert.equal(calls,0);
});

test('marks successful API output with fabricated issue IDs ambiguous', async () => {
  const bad={...generated,selectedIssueIds:['fabricated']};
  const result=await generateSalesOutput(digest,'en',{config,spend,fetchImpl:async()=>response({id:'resp_test',status:'completed',output_text:JSON.stringify(bad)})});
  assert.equal(result.status,'AMBIGUOUS'); assert.equal(result.reason,'recorded_output_schema_or_evidence_validation_failed');
});

test('recorded validator requires locale match, selected references, and nonempty opportunity/finding sets',()=>{
  assert.equal(validateRecordedOutput(generated,digest,'en').ok,true);
  assert.equal(validateRecordedOutput({...generated,locale:'pt-BR'},digest,'pt-BR').ok,true);
  assert.equal(validateRecordedOutput(generated,digest,'pt-BR').ok,false);
  assert.equal(validateRecordedOutput({...generated,opportunities:[]},digest,'en').ok,false);
  assert.equal(validateRecordedOutput({...generated,findings:[]},digest,'en').ok,false);
  assert.equal(validateRecordedOutput({...generated,salesAngle:{text:'x',issueIds:['not-selected']}},digest,'en').ok,false);
});

test('validator rejects duplicate root causes and issue codes without decision templates',()=>{
  const duplicateDigest={...digest,issues:[...digest.issues,{...digest.issues[0],id:'issue-b',pages:[{id:'evidence-b',url:'https://example.test/lessons'}]}]};
  const duplicateOutput={...generated,selectedIssueIds:['issue-a','issue-b'],opportunities:[{...generated.opportunities[0],issueIds:['issue-a','issue-b']}],salesAngle:{...generated.salesAngle,issueIds:['issue-a','issue-b']},findings:[...generated.findings,{...generated.findings[0],issueId:'issue-b'}]};
  assert.equal(validateRecordedOutput(duplicateOutput,duplicateDigest,'en').ok,false);
  const unsupportedDigest={...digest,issues:[{...digest.issues[0],code:'images_missing_alt'}]};
  assert.equal(validateRecordedOutput(generated,unsupportedDigest,'en').ok,false);
});

test('estimate uses full serialized request including schema and locale, and gates by that exposure',async()=>{
  const estimate=estimateRequest(digest,config,'pt-BR');
  assert.ok(estimate.requestBytes>Buffer.byteLength(JSON.stringify(digest)));
  assert.equal(estimate.inputTokens,estimate.requestBytes);
  assert.equal(estimate.requestTokens,estimate.inputTokens+config.maxOutputTokens);
  let calls=0;
  const result=await generateSalesOutput(digest,'pt-BR',{config:{...config,maxInputTokens:100},spend,fetchImpl:async()=>{calls++;return response({});}});
  assert.equal(result.status,'NOT_SENT'); assert.equal(calls,0);
});

test('oversized response body is bounded and remains ambiguous',async()=>{
  const big=JSON.stringify({id:'resp_test',status:'completed',output_text:JSON.stringify(generated)})+' '.repeat(1_100_000);
  const result=await generateSalesOutput(digest,'en',{config,spend,fetchImpl:async()=>new Response(big)});
  assert.equal(result.status,'AMBIGUOUS');
});


test('one opportunity per selected finding is valid through six and matches request schema limits',async()=>{
 const issues=Array.from({length:4},(_,i)=>({...digest.issues[0],id:`issue-${i}`,code:['missing_title','missing_h1','missing_meta_description','images_missing_dimensions'][i]}));
 const d={...digest,issues};
 const output={...generated,selectedIssueIds:issues.map(i=>i.id),opportunities:issues.map(i=>({title:'Review page',issueIds:[i.id],rationale:'Review the supported finding.'})),salesAngle:{text:'Review findings',issueIds:issues.map(i=>i.id)},findings:issues.map(i=>({issueId:i.id,implication:'Review the page.',proposedFix:'Check the supported observation.'}))};
 assert.equal(validateRecordedOutput(output,d,'en').ok,true);
 let sent;
 const result=await generateSalesOutput(d,'en',{config:{...config,maxInputTokens:32000,companyTokenCap:40000},spend:{...spend,companyTokensReserved:40000,batchTokensReserved:40000},fetchImpl:async(_url,init)=>{sent=JSON.parse(init.body);return response({id:'resp_four',status:'completed',output_text:JSON.stringify(output)});}});
 assert.ok(sent);assert.equal(sent.text.format.schema.properties.opportunities.maxItems,6);assert.equal(sent.text.format.schema.properties.findings.maxItems,6);
 assert.equal(result.status,'COMPLETED');
});
