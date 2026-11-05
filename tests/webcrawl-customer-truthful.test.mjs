import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {customerPriorityProjection} from '../dist/reports/customer.js';
import {renderWhatsAppDraft} from '../dist/reports/whatsapp-draft.js';
import {renderCustomerSummaryHtml} from '../dist/reports/summary.js';

test('audit-shaped trip destinations retain identity without attributing their 404 to homepage',()=>{
 const a=createEvidenceFixture(1).audit;const at=a.completedAt;const home=a.target;
 a.findings=[1,2].map(n=>{const target=`${home}?post_type=trip&p=${n}`;return {code:'broken_internal_link',category:'links',observed:'Internal destination returned HTTP 404.',evidence:[{pageUrl:target,requestedUrl:target,finalUrl:target,observedAt:at,source:'http',value:404},{pageUrl:home,anchorHref:target,requestedUrl:target,observedAt:at,source:'http',value:404}]};});
 a.coverage.urls=a.findings.flatMap(f=>f.evidence.map(e=>({url:e.pageUrl,finalUrl:e.pageUrl,outcome:'captured',statusCode:e.anchorHref?200:404})));
 const text=renderWhatsAppDraft(a);assert.doesNotMatch(text,/post_type|p=|linked to .*which returned HTTP/);assert.match(text,/destination is withheld/);
 const html=renderCustomerSummaryHtml(a);assert.match(html,/2 distinct broken destinations/);assert.match(html,/1 referring pages/);
});
test('transactional noindex stays private while commercial noindex remains reviewable',()=>{
 const a=createEvidenceFixture(1).audit;const at=a.completedAt;
 a.findings=['payment-form','checkout','order-confirmation','courses'].map(path=>({code:'noindex',category:'indexability',observed:'noindex',evidence:[{pageUrl:new URL(`/${path}/`,a.target).href,observedAt:at,source:'http'}]}));
 a.coverage.urls=a.findings.flatMap(f=>f.evidence.map(e=>({url:e.pageUrl,finalUrl:e.pageUrl,outcome:'captured',statusCode:200})));
 const p=customerPriorityProjection(a);assert.ok(p.customerFindings.some(f=>f.evidence.some(e=>e.pageUrl.includes('/courses/'))));assert.ok(!p.customerFindings.some(f=>f.evidence.some(e=>/payment-form|checkout|order-confirmation/.test(e.pageUrl))));assert.equal(a.findings.length,4);
});

test('all exact/query source and destination combinations retain truthful public identity', async () => {
 const {findBrokenInternalLinks}=await import('@spora/webcrawl/analysis/link-health');
 for (const sourceQuery of [false,true]) for (const destinationQuery of [false,true]) {
  const {audit}=createEvidenceFixture(1);
  const source=`https://fixture.example/courses${sourceQuery?'?campaign=PRIVATE_SOURCE':''}`;
  const destination=`https://fixture.example/missing${destinationQuery?'?token=PRIVATE_DESTINATION':''}`;
  audit.coverage.urls=[{url:source,finalUrl:source,outcome:'captured',statusCode:200},{url:destination,finalUrl:destination,outcome:'captured',statusCode:404}];
  audit.findings=findBrokenInternalLinks(new Map([[destination,new Set([source])]]),new Map([[destination,404]]),audit.completedAt,new Map([[destination,[{pageUrl:source,href:destination,anchorText:'Details'}]]]),new Map([[destination,{url:destination,finalUrl:destination,outcome:'captured',statusCode:404}]]));
  const draft=renderWhatsAppDraft(audit);
  assert.match(draft,/returned HTTP 404/);
  assert.doesNotMatch(draft,/PRIVATE_SOURCE|PRIVATE_DESTINATION|campaign=|token=/);
  if(sourceQuery) assert.doesNotMatch(draft,/https:\/\/fixture\.example\/courses/, 'never claim the projected source contained this link');
  else assert.match(draft,/https:\/\/fixture\.example\/courses/);
  if(destinationQuery) assert.doesNotMatch(draft,/https:\/\/fixture\.example\/missing/);
  else assert.match(draft,/https:\/\/fixture\.example\/missing, which returned HTTP 404/);
 }
});

test('transactional endpoint classification overrides commercial parents without suppressing offers',()=>{
 const {audit}=createEvidenceFixture(1);
 const transactional=['/payment-form/','/courses/payment-form/','/booking/checkout/','/shop/cart/','/en/payment/','/courses/order-confirmation/','/booking/thank-you/'];
 const offers=['/courses/','/courses/payment-form-design/','/courses/cartography/','/shop/payment-products/'];
 audit.findings=[...transactional,...offers].map(path=>({code:'noindex',category:'indexability',observed:'noindex',evidence:[{pageUrl:new URL(path,audit.target).href,observedAt:audit.completedAt,source:'http'}]}));
 audit.coverage.urls=audit.findings.flatMap(f=>f.evidence.map(e=>({url:e.pageUrl,finalUrl:e.pageUrl,outcome:'captured',statusCode:200})));
 const urls=customerPriorityProjection(audit).customerFindings.flatMap(f=>f.evidence.map(e=>new URL(e.pageUrl).pathname));
 assert.deepEqual(urls.sort(),offers.sort());
 assert.equal(audit.findings.length,transactional.length+offers.length);
});

test('an exact homepage 404 remains a status-bearing destination', async()=>{
 const {findBrokenInternalLinks}=await import('@spora/webcrawl/analysis/link-health');
 const {audit}=createEvidenceFixture(1), source=new URL('/courses',audit.target).href, destination=audit.target;
 audit.coverage.urls=[{url:source,finalUrl:source,outcome:'captured',statusCode:200},{url:destination,finalUrl:destination,outcome:'captured',statusCode:404}];
 audit.findings=findBrokenInternalLinks(new Map([[destination,new Set([source])]]),new Map([[destination,404]]),audit.completedAt,new Map([[destination,[{pageUrl:source,href:'/',anchorText:'Home'}]]]),new Map([[destination,{url:destination,finalUrl:destination,outcome:'captured',statusCode:404}]]));
 assert.match(renderWhatsAppDraft(audit),/linked to https:\/\/fixture\.example\/, which returned HTTP 404/);
});
