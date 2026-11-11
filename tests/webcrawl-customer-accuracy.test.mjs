import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {renderCustomerSummaryHtml,renderOperatorStatusHtml} from '../dist/reports/summary.js';
import {safeGet} from '@spora/webcrawl/crawler/safe-transport';
import {CrawlRequestBudget} from '@spora/webcrawl/crawler/request-control';
const base={allowedHosts:['fixture.example'],timeoutMs:1000,maxResponseBytes:100,maxRedirects:1,maxRetries:2,retryBaseDelayMs:0,retryMaxDelayMs:0,resolveAddresses:async()=>['93.184.216.34']};
test('429 recovery, exhaustion, zero, long Retry-After and budget boundaries',async()=>{
 for(const [statuses,retries,headers,expected] of [[[429,200],2,{},2],[[429,429,429],2,{},3],[[429],0,{},1],[[429],2,{'retry-after':'3600'},1]]){
  let calls=0;const budget=new CrawlRequestBudget(5,100);
  const response=await safeGet('https://fixture.example/',{...base,maxRetries:retries,budget,request:async()=>({status:statuses[Math.min(calls++,statuses.length-1)],headers,body:Buffer.from('x')})});
  assert.equal(calls,expected);assert.equal(response.requestCount,expected);assert.equal(budget.requestCount,expected);assert.equal(response.responseBytes,expected);
 }
 let calls=0;
 await assert.rejects(safeGet('https://fixture.example/',{...base,budget:new CrawlRequestBudget(1,100),request:async()=>{calls++;return {status:429,headers:{},body:Buffer.alloc(0)};}}));assert.equal(calls,1);
 const controller=new AbortController();controller.abort();
 await assert.rejects(safeGet('https://fixture.example/',{...base,signal:controller.signal,request:async()=>{throw Error('must not dispatch');}}));
});
test('customer summaries preserve up to six supported topics but booleans never authorize release',()=>{
 const {audit}=createEvidenceFixture(3);const e=value=>({pageUrl:audit.target,source:'http',observedAt:audit.startedAt,value});
 audit.findings=[{code:'http_status_error',category:'indexability',observed:'HTTP 429 and missing pages',evidence:[e(429),e(404),e(410)]},{code:'multiple_h1',category:'content',observed:'document H1',evidence:[e(3)]}];
 const before=JSON.stringify(audit);
 let html=renderCustomerSummaryHtml(audit);assert.doesNotMatch(html,/error status codes/);assert.doesNotMatch(html,/multiple main headings|429/);assert.equal(JSON.stringify(audit),before);assert.match(renderOperatorStatusHtml(audit),/429/);
 audit.findings[0].evidence=[e(429),e(undefined)];html=renderCustomerSummaryHtml(audit);assert.doesNotMatch(html,/error status codes/);assert.match(html,/<strong>0<\/strong>topics<\/div>/);
 const issuer={name:'Reviewer',email:'reviewer@example.test'};
 assert.match(renderCustomerSummaryHtml(audit,'en',{issuer,clientReady:true}),/data-publication-status="HOLD"/u);
 audit.findings=['missing_canonical','missing_meta_description','title_long','images_missing_alt','missing_h1','heading_hierarchy_skip','images_missing_dimensions'].map(code=>({code,category:'content',observed:code,evidence:[e(undefined)]}));
 audit.coverage.urls.push({url:audit.target,outcome:'captured',statusCode:200});
 const eligible=audit.findings.filter(f=>f.code!=='title_long');
 for(const count of [0,1,2,3,4,5,6,7]) for(const locale of ['en','de']) {
  audit.findings=eligible.slice(0,count);
  const html=renderCustomerSummaryHtml(audit,locale,{issuer,clientReady:true});
  assert.equal((html.match(/<article class="card">/g)??[]).length,[0,1,2,3,4,4,5,5][count]);
  assert.match(html,/data-publication-status="HOLD"/u);
  assert.doesNotMatch(html,/data-publication-status="CLIENT_READY"/u);
 }
});
test('H1 producer scopes differ for navigation, empty headings and body fallback',async()=>{
 const {inspectPage}=await import('@spora/webcrawl/analysis/technical');
 const {createPageDataExport}=await import('@spora/webcrawl/analysis/page-data');
 for(const [html,scope,count] of [['<nav><h1>Brand</h1></nav><main><h1>Offer</h1><h1></h1></main>','main',1],['<article><h1>Offer</h1></article><footer><h1>Brand</h1></footer>','article',1],['<h1>Offer</h1><h1></h1>','body',1],['<main><h1>Offer','main',1]]){
  const page={requestedUrl:'https://fixture.example/',finalUrl:'https://fixture.example/',statusCode:200,contentType:'text/html',fetchedAt:'2026-10-30T00:00:00Z',responseBytes:html.length,html};
  const record=createPageDataExport([page]).pages[0];assert.equal(record.contentScope,scope);assert.equal(record.headings.filter(h=>h.level===1).length,count);
  if(html.includes('Brand'))assert.ok(inspectPage(page).findings.some(f=>f.code==='multiple_h1'));
 }
});

test('long-title recommendations review the relevance of flagged non-offer pages in EN and DE',()=>{
 const {audit}=createEvidenceFixture(1);
 const article='https://fixture.example/behavioural-economics-and-behavioural-finance-manifesto/';
 audit.coverage.urls=[{url:article,finalUrl:article,statusCode:200,outcome:'captured'}];
 audit.findings=[{code:'title_long',category:'metadata',observed:'Title contains 66 characters.',evidence:[{pageUrl:article,source:'http',observedAt:audit.startedAt,value:66}]}];
 const before=JSON.stringify(audit);
 for(const locale of ['en','de']){
  const html=renderCustomerSummaryHtml(audit,locale);
  const card=html.match(/<article class="card">[\s\S]*?<\/article>/u)?.[0];
  assert.equal(card,undefined);
  assert.match(html,/HOLD/u);
  assert.match(renderOperatorStatusHtml(audit,locale),/66/u);
 }
 assert.equal(JSON.stringify(audit),before);
});

test('long-title recommendations retain offer-page advice only when flagged evidence includes an offer',()=>{
 for(const paths of [['/'],['/kitesurfing-lessons/'],['/blog/old-post/','/kitesurfing-lessons/']]){
  const {audit}=createEvidenceFixture(paths.length);
  audit.coverage.urls=paths.map(path=>({url:`https://fixture.example${path}`,finalUrl:`https://fixture.example${path}`,statusCode:200,outcome:'captured'}));
  audit.findings=[{code:'title_long',category:'metadata',observed:'Long titles',evidence:paths.map(path=>({pageUrl:`https://fixture.example${path}`,source:'http',observedAt:audit.startedAt,value:66}))}];
  for(const locale of ['en','de']){
   const html=renderCustomerSummaryHtml(audit,locale);
   assert.doesNotMatch(html,/data-issue-code="title_long"/u);
   assert.doesNotMatch(html,/before editing their titles|vor Titeländerungen/u);

  }
 }
});
