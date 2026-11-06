import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { customerPriorityProjection } from '../dist/reports/customer.js';
import { renderWhatsAppDraft } from '../dist/reports/whatsapp-draft.js';
test('priority admission is stable under finding/evidence permutations; invalid URLs never create claims', () => {
  const {audit}=createEvidenceFixture(3);
  for(const row of audit.coverage.urls) {row.url=row.url.replace('/page-','/courses/page-');row.finalUrl=row.url;}
  audit.findings=['missing_canonical','missing_meta_description','missing_h1','heading_hierarchy_skip'].map(code=>({code,category:'content',severity:'low',observed:code,evidence:audit.coverage.urls.map(r=>({pageUrl:r.url,observedAt:audit.startedAt,source:'http'}))}));
  const first=customerPriorityProjection(audit).selected, draft=renderWhatsAppDraft(audit);
  assert.equal(first.length,3);
  const reversed=structuredClone(audit);reversed.findings.reverse();reversed.findings.forEach(f=>f.evidence.reverse());
  assert.deepEqual(customerPriorityProjection(reversed).selected,first);
  assert.equal(renderWhatsAppDraft(reversed),draft);
  assert.ok(draft.includes(first[0].urls[0].url));
  audit.findings[0].evidence.push({pageUrl:'javascript:bad',observedAt:audit.startedAt,source:'http'});
  assert.ok(customerPriorityProjection(audit).selected.every(t=>t.urls.every(ref=>ref.url.startsWith('https://fixture.example/'))));
  audit.findings=[{...audit.findings[0],evidence:[{pageUrl:'javascript:bad',observedAt:audit.startedAt,source:'http'}]}];
  assert.equal(customerPriorityProjection(audit).selected.length,0);
  audit.findings=[];assert.match(renderWhatsAppDraft(audit),/REVIEW_REQUIRED/);
});

test('performance priority uses its own category timestamp in report and draft', async () => {
  const {renderCustomerSummaryHtml}=await import('../dist/reports/summary.js');
  const {audit}=createEvidenceFixture(1);audit.completedAt='2026-10-29T00:01:00.000Z';
  const performanceTime='2026-10-29T00:00:40.000Z', otherTime='2026-10-29T00:00:10.000Z';
  audit.findings=['accessibility','performance'].map(name=>({code:'pagespeed_category_score',category:'performance',observed:`${name} score: ${name==='performance'?39:90}/100.`,evidence:[{pageUrl:audit.target,source:'pagespeed',observedAt:name==='performance'?performanceTime:otherTime,value:name==='performance'?39:90}]}));
  const html=renderCustomerSummaryHtml(audit,'en'),draft=renderWhatsAppDraft(audit);
  assert.match(draft,new RegExp(`recorded ${performanceTime}`));
  assert.match(html,/data-example-finding="1" data-example-evidence="0"/);
});


test('archive noindex and policy errors stay out of customer priorities while offer and enquiry evidence remains', () => {
  const {audit}=createEvidenceFixture(1);
  const page=path=>new URL(path,audit.target).href;
  const ev=(path,extra={})=>({pageUrl:page(path),observedAt:audit.startedAt,source:'http',...extra});
  const paths=['/kite-lessons/','/contact/','/enquiry-missing/','/affiliate-disclaimer/','/privacy-policy/','/2016/06/','/2016/06/page/2/','/category/lessons/'];
  audit.coverage.urls=[{url:audit.target,outcome:'captured',statusCode:200},...paths.map(path=>({url:page(path),outcome:'captured',statusCode:path==='/enquiry-missing/'?404:['/affiliate-disclaimer/','/privacy-policy/'].includes(path)?500:200}))];
  audit.findings=[
    {code:'http_status_error',category:'indexability',severity:'high',observed:'Observed HTTP 500',evidence:[ev('/affiliate-disclaimer/',{value:500}),ev('/privacy-policy/',{value:500})]},
    {code:'noindex',category:'indexability',severity:'high',observed:'Recorded noindex directive',evidence:[ev('/2016/06/'),ev('/2016/06/page/2/'),ev('/category/lessons/')]},
    {code:'missing_h1',category:'content',severity:'low',observed:'Missing offer heading',evidence:[ev('/kite-lessons/')]},
    {code:'missing_meta_description',category:'metadata',severity:'low',observed:'Missing offer description',evidence:[ev('/kite-lessons/')]},
    {code:'broken_internal_link',category:'indexability',severity:'high',observed:'Observed missing enquiry destination',evidence:[ev('/enquiry-missing/',{value:404,requestedUrl:page('/enquiry-missing/')}),ev('/contact/',{value:404,anchorHref:'/enquiry-missing/',requestedUrl:page('/enquiry-missing/')})]},
  ];
  const original=structuredClone(audit);
  const projection=customerPriorityProjection(audit);
  assert.deepEqual(new Set(projection.selected.map(t=>t.code)),new Set(['broken_internal_link','missing_h1','missing_meta_description']));
  assert.ok(projection.selected.find(t=>t.code==='broken_internal_link').urls.some(ref=>ref.url===page('/contact/')||ref.url===page('/enquiry-missing/')));
  assert.ok(projection.customerFindings.every(f=>f.code!=='noindex'&&f.code!=='http_status_error'));
  assert.deepEqual(audit,original,'operator/audit observations remain intact');
});

test('offer-page noindex remains a request directive rather than a claim of actual index exclusion', async()=>{
 const {renderCustomerSummaryHtml}=await import('../dist/reports/summary.js');
 const {audit}=createEvidenceFixture(1);const offer=new URL('/kite-lessons/',audit.target).href;
 audit.coverage.urls.push({url:offer,outcome:'captured',statusCode:200});
 audit.findings=[{code:'noindex',category:'indexability',observed:'Recorded noindex directive',evidence:[{pageUrl:offer,source:'http',observedAt:audit.startedAt}]}];
 const html=renderCustomerSummaryHtml(audit,'en');
 assert.match(html,/Pages requesting exclusion from search/);
 assert.doesNotMatch(html,/Pages excluded from indexing/);
 assert.equal(customerPriorityProjection(audit).selected[0].code,'noindex');
});


test('routine metadata/headings use main site routes and do not pad reports with policy, archive or template posts',()=>{
 const {audit}=createEvidenceFixture(1);const page=p=>new URL(p,audit.target).href;
 const offer='/kite-lessons/',about='/about/',contact='/contact-us/';
 const excluded=['/policies/refund-policy','/policies/terms-of-service','/category/senza-categoria/','/blog/a-news-post/','/demo/offer/','/new-corporate-style-website/','/behavioural-economics-and-behavioural-finance-manifesto/'];
 const paths=[offer,about,contact,...excluded];audit.coverage.urls=paths.map(p=>({url:page(p),outcome:'captured',statusCode:200}));
 const ev=p=>({pageUrl:page(p),source:'http',observedAt:audit.startedAt});
 audit.findings=[
  {code:'missing_meta_description',category:'metadata',observed:'Missing description',evidence:[ev(offer),ev(about),...excluded.map(ev)]},
  {code:'missing_h1',category:'content',observed:'Missing main heading',evidence:[ev(offer)]},
  {code:'heading_hierarchy_skip',category:'content',observed:'Heading hierarchy',evidence:[ev(offer),ev(contact)]},
 ];
 const original=structuredClone(audit),projection=customerPriorityProjection(audit);
 assert.deepEqual(new Set(projection.selected.map(t=>t.code)),new Set(['missing_h1','missing_meta_description']));
 assert.equal(projection.selected.find(t=>t.code==='missing_meta_description').urls.length,2);
 assert.ok(projection.customerFindings.every(f=>f.evidence.every(e=>!excluded.includes(new URL(e.pageUrl).pathname))));
 audit.findings=[{...audit.findings[0],evidence:excluded.map(ev)}];
 assert.equal(customerPriorityProjection(audit).selected.length,0,'non-offer observations do not fill a report');
 assert.equal(original.findings[0].evidence.length,9,'all observations remain in the original audit');
});
