import assert from 'node:assert/strict';
import test from 'node:test';
import {ContactCollector,inspectContactPage} from '@spora/webcrawl/enrichments/contacts';
import {inspectPage} from '@spora/webcrawl/analysis/technical';
import {renderWhatsAppDraft} from '../dist/reports/whatsapp-draft.js';
import {reportEvidenceCounts} from '../dist/reports/references.js';
import {renderAuditHtml} from '../dist/reports/html.js';
import {renderCustomerSummaryHtml} from '../dist/reports/summary.js';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
const at='2026-10-30T00:00:00Z';
const page=(html,url='https://fixture.co.za/contact')=>({requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:at,responseBytes:html.length,html});
const collect=(html,url)=>{const c=new ContactCollector();c.observe(page(html,url));return c.result(1);};
const e=(pageUrl,value)=>({pageUrl,source:'http',observedAt:at,...(value===undefined?{}:{value})});
test('narrow phone negatives, first-party positives, ZA context, and immutable source capture',()=>{
 for(const raw of ['+27000000000','2019 1993','2020 1997','2026/2027','+270607794535']) {
  const html=`<main><a href="tel:${raw}">${raw}</a></main><footer>${raw}</footer>`;
  const p=page(html);const c=new ContactCollector();c.observe(p);const inventory=c.result(1);
  assert.ok(inspectContactPage(p).some(o=>o.raw.trim()===raw),raw);
  assert.equal(inventory.candidates.length,0,raw);assert.ok(inventory.coverage.rejectedValues>0);assert.equal(p.html,html);
 }
 for(const raw of ['+27764981218','+27227721114','+493012345678','+12125551212']) {
  const inventory=collect(`<main><a href="tel:${raw}">General contact</a></main>`);
  assert.equal(inventory.candidates.length,1,raw);assert.equal(inventory.candidates[0].validation,'FORMAT_VALID');assert.equal(inventory.candidates[0].ownership,'UNVERIFIED');assert.ok(!inventory.candidates[0].channels.includes('whatsapp'));
 }
 const za=collect('<main><a href="tel:+27764981218">Contact</a><button data-phone="27764981218">WhatsApp</button></main>');
 assert.equal(za.candidates.length,1);assert.equal(za.candidates[0].normalizedValue,'+27764981218');assert.ok(za.candidates[0].channels.includes('whatsapp'));assert.ok(za.candidates[0].rawValue.includes('27764981218'));
 const elsewhere=collect('<a href="tel:27764981218">Phone</a>','https://fixture.test/contact');assert.equal(elsewhere.candidates[0].validation,'NEEDS_REVIEW');assert.equal(elsewhere.candidates[0].normalizedValue,'27764981218');
 const product=collect('<footer><table><tr><td>24 26 46 51 88 435</td></tr></table></footer><a href="tel:+27764981218">Phone</a>','https://fixture.co.za/products/foil');assert.deepEqual(product.candidates.map(c=>c.normalizedValue),['+27764981218']);assert.ok(product.coverage.rejectedValues>0);
 const general=collect('<footer>022 772 1114</footer>','https://fixture.co.za/products/foil');assert.ok(general.candidates.some(c=>c.normalizedValue==='0227721114'));
 const rejected=inspectContactPage(page('<footer><table><tr><td>24 26 46 51 88 435</td></tr></table></footer>','https://fixture.co.za/products/foil')).find(o=>o.valid===false);assert.ok(rejected);assert.match(rejected.raw,/24 26/);assert.equal(rejected.source.pageUrl,'https://fixture.co.za/products/foil');
});
test('partner instructor and explicit WhatsApp remain evidence with no selected send target',()=>{
 const {audit}=createEvidenceFixture(1);
 for(const html of ['<main><h1>Partner school</h1><p>AfriKite instructor: WhatsApp +27731206658</p></main>','<footer><a href="https://wa.me/27764981218">WhatsApp shop</a></footer>','<main><a href="tel:+27764981218">General shop contact</a></main>']) {
  audit.contacts=collect(html);const before=JSON.stringify(audit.contacts);const draft=renderWhatsAppDraft(audit);
  assert.match(draft,/recipient_review_required:\*\* true/);assert.match(draft,/selected_send_target:\*\* null/);assert.match(draft,/company context and WhatsApp/);assert.doesNotMatch(draft,/Phone \(verify|wa\.me\/|\+277/);assert.equal(JSON.stringify(audit.contacts),before);
 }
});
test('SVG title never counts as HTML head title; two head titles remain a defect',()=>{
 assert.ok(!inspectPage(page('<head><title>Offer</title></head><body><svg><title>Icon</title></svg>')).findings.some(f=>f.code==='multiple_title_tags'));
 assert.ok(inspectPage(page('<head><title>One</title><title>Two</title></head>')).findings.some(f=>f.code==='multiple_title_tags'));
});
test('derived accounting separates captured HTML, image assets, records, occurrences and incomplete analysis',()=>{
 const {audit}=createEvidenceFixture(1);audit.coverage.urls[0]={url:audit.target,finalUrl:audit.target,outcome:'captured',statusCode:200};const asset='https://fixture.example/image.jpg';
 audit.findings=[{code:'image_file_too_large',category:'performance',observed:'Large',evidence:[e(asset,500000),e(audit.target),e(audit.target)]}];
 const before=JSON.stringify(audit);let counts=reportEvidenceCounts(audit);
 assert.equal(counts.affectedCapturedUrls,1);assert.equal(counts.affectedAssets,1);assert.equal(counts.records,1);assert.equal(counts.occurrences,3);assert.equal(counts.analyzedHtmlPages,null);assert.equal(JSON.stringify(audit),before);
 audit.coverage.urls.push({url:'https://fixture.example/limited',outcome:'captured',statusCode:429},{url:'https://fixture.example/fail',outcome:'failed'},{url:asset,outcome:'skipped',reason:'non_html'},{url:'https://fixture.example/alias',outcome:'skipped',finalUrl:audit.target,reason:'duplicate_final_url'},{url:'https://fixture.example/later',outcome:'unattempted'});
 audit.crawl.limitations.push('content_inspection_incomplete');counts=reportEvidenceCounts(audit);
 assert.equal(counts.analyzedHtmlPages,null);assert.equal(counts.successfulResponses,1);assert.equal(counts.rateLimitedResponses,1);assert.equal(counts.nonHtmlSkips,1);assert.equal(counts.duplicateFinalUrls,1);
 assert.match(renderAuditHtml(audit),/1 captured URLs and 1 image\/assets/);
});
test('archive noindex and non-offer descriptions stay internal, score 50 is URL-scoped mobile lab evidence',()=>{
 const {audit}=createEvidenceFixture(1);audit.findings=[{code:'noindex',category:'indexability',observed:'noindex',evidence:[e('https://fixture.example/category/stories/')]},{code:'missing_meta_description',category:'metadata',observed:'Missing',evidence:[e('https://fixture.example/article/')]},{code:'pagespeed_category_score',category:'performance',observed:'performance score: 50/100.',evidence:[{...e(audit.target,50),source:'pagespeed'}]}];
 audit.startedAt=at; audit.completedAt=at; audit.coverage.urls.push({url:'https://fixture.example/article/',outcome:'captured',statusCode:200});
 let html=renderCustomerSummaryHtml(audit);assert.doesNotMatch(html,/Some pages declare/);assert.doesNotMatch(html,/Review whether these pages belong/);assert.match(html,/Mobile loading performance/);assert.match(html,/Homepage · Mobile lab page/);assert.match(html,/The tested page scored 50\/100 in the mobile PageSpeed lab measurement recorded/);assert.match(html,/This laboratory score.*not a measurement of lost enquiries or bookings/);assert.doesNotMatch(html,/Measured:|site-wide field Core Web Vitals|HOLD \/ NOT FOR CUSTOMER DISTRIBUTION/);assert.match(renderAuditHtml(audit),/<time>2026-10-30T00:00:00Z<\/time>/);assert.equal(audit.findings[2].evidence[0].observedAt,at);assert.match(html,/data-publication-status="HOLD"/);
 audit.findings[2].evidence[0].pageUrl='https://fixture.example/other';html=renderCustomerSummaryHtml(audit);assert.doesNotMatch(html,/Investigate mobile loading/);assert.match(html,/do not match the audited target/);
});

test('product paths never turn a general footer phone into a numeric specification',()=>{
 for(const path of ['/contact/','/products/foil','/collections/gear','/contact/?return=/products/foil']) for(const number of ['022 772 1114','022 7 72 11 14']) {
  const inventory=collect(`<footer>General contact: ${number}</footer>`,'https://fixture.co.za'+path);assert.ok(inventory.candidates.some(c=>c.normalizedValue==='0227721114'),path+' '+number);
 }
 const mixed=collect('<footer><table><tr><td>24 26 46 51 88 435</td></tr></table><p>General contact: 022 7 72 11 14</p></footer>','https://fixture.co.za/products/foil');assert.ok(mixed.candidates.some(c=>c.normalizedValue==='0227721114'));assert.ok(mixed.coverage.rejectedValues>0);
 const tableContact=collect('<footer><table><tr><td>General contact:</td><td>022 7 72 11 14</td></tr></table></footer>','https://fixture.co.za/products/foil');assert.ok(tableContact.candidates.some(c=>c.normalizedValue==='0227721114'));
});
test('recovered 429 display describes final outcomes and never invents retry totals',async()=>{
 const {auditWebsite}=await import('@spora/webcrawl/core/audit');const {DEFAULT_CRAWL_LIMITS}=await import('@spora/webcrawl/core/defaults');let calls=0;const events=[];
 const audit=await auditWebsite({startUrl:'https://fixture.test/',pagespeed:false,contacts:false,technology:false,policy:{...DEFAULT_CRAWL_LIMITS,allowedHosts:['fixture.test'],maxPages:1,maxRequests:8,minRequestIntervalMs:0,maxRetries:1,retryBaseDelayMs:0,retryMaxDelayMs:0},resolveAddresses:async()=>['93.184.216.34'],onRequestEvent:e=>events.push(e),request:async u=>u.pathname==='/robots.txt'?{status:404,headers:{'content-type':'text/plain'},body:Buffer.from('missing')}:{status:++calls===1?429:200,headers:{'content-type':'text/html'},body:Buffer.from('<title>Offer</title><h1>Offer</h1>')}});
 assert.equal(events.filter(e=>e.kind==='response'&&e.status===429).length,1);assert.equal(reportEvidenceCounts(audit).rateLimitedResponses,0);const html=renderAuditHtml(audit);assert.match(html,/Final URL outcomes with HTTP 429: 0 \(total retry responses: UNKNOWN\)/);assert.doesNotMatch(html,/HTTP 429 responses: 0/);
});

test('missing legacy coverage stays UNKNOWN rather than displaying measured zero outcomes',()=>{
 const {audit}=createEvidenceFixture(1);delete audit.coverage;const counts=reportEvidenceCounts(audit);assert.equal(counts.rateLimitedResponses,null);assert.equal(counts.nonHtmlSkips,null);assert.equal(counts.duplicateFinalUrls,null);const html=renderAuditHtml(audit);assert.match(html,/Final URL outcomes with HTTP 429: UNKNOWN/);assert.match(html,/non-HTML skips: UNKNOWN/);assert.match(html,/duplicate final URLs: UNKNOWN/);
});

test('table provenance tracking preserves the existing pre-normalization text cap',()=>{
 const inventory=collect('<footer>'+ ' '.repeat(6000)+'<p>General contact: 022 7 72 11 14</p></footer>','https://fixture.co.za/products/foil');assert.equal(inventory.candidates.length,0);assert.ok(inventory.coverage.omittedVisibleText>0);assert.equal(inventory.status,'partial');
});

test('table contact labels protect equivalent phones before/after the value and in captions',()=>{
 for(const [number,normalized,validation] of [['022 7 72 11 14','0227721114','NEEDS_REVIEW'],['27 22 77 211 14','+27227721114','FORMAT_VALID']]) for(const path of ['/products/foil','/collections/gear']) for(const label of ['General contact','Telephone','Telefon','WhatsApp']) {
  for(const table of [
   `<table><tr><th>${label}</th><td>${number}</td></tr></table>`,
   `<table><tr><td>${number}</td><td>${label}</td></tr></table>`,
   `<table><caption>${label}</caption><tr><td>${number}</td></tr></table>`,
   `<table><tr><td>${number}</td></tr><caption>${label}</caption></table>`,
   `<table aria-label="${label}"><tr><td>${number}</td></tr></table>`,
   `<table><tr aria-label="${label}"><td>${number}</td></tr></table>`,
   `<table><caption aria-label="${label}"></caption><tr><td>${number}</td></tr></table>`,
   `<table><thead><tr><th scope="col">${label}</th></tr></thead><tbody><tr><td>${number}</td></tr></tbody></table>`,
   `<table><tbody><tr><td>${number}</td></tr></tbody><thead><tr><th scope="col">${label}</th></tr></thead></table>`,
   `<table><thead><tr><th scope="col" aria-label="${label}"></th></tr></thead><tbody><tr><td>${number}</td></tr></tbody></table>`,
   `<table><tbody><tr><td>${number}</td></tr></tbody><thead><tr><th scope="col" aria-label="${label}"></th></tr></thead></table>`,
  ]) {
   const inventory=collect(`<footer>${table}</footer>`,'https://fixture.co.za'+path);
   const candidate=inventory.candidates.find(c=>c.normalizedValue===normalized);assert.ok(candidate,path+' '+table);assert.equal(candidate.ownership,'UNVERIFIED');assert.equal(candidate.validation,validation);
   // A specification-filter exemption must not verify ownership or infer a channel.
   if(label!=='WhatsApp'||table.includes('aria-label')||table.indexOf(number)<table.indexOf(label))assert.deepEqual(candidate.channels,['phone']);
  }
 }
});
test('table labels stay scoped: sibling rows/tables and hidden labels cannot legitimize specification values',()=>{
 const spec='24 26 46 51 88 435';const phone='022 7 72 11 14';
 for(const html of [
  `<footer><table><tr><td>${spec}</td><td>Dimensions</td></tr><tr><td>${phone}</td><td>General contact</td></tr></table></footer>`,
  `<footer><table><tr><td>${spec}</td></tr></table><table><caption>General contact</caption><tr><td>${phone}</td></tr></table></footer>`,
  `<footer><table><tr><td>${spec}</td><td><span hidden>General contact</span></td></tr></table></footer>`,
  `<footer><table><caption hidden>General contact</caption><tr><td>${spec}</td></tr></table></footer>`,
 ]) {
  const inventory=collect(html,'https://fixture.co.za/products/foil');assert.ok(!inventory.candidates.some(c=>c.normalizedValue==='2426465188435'));assert.ok(inventory.coverage.rejectedValues>0);
  if(html.includes(phone))assert.ok(inventory.candidates.some(c=>c.normalizedValue==='0227721114'));
 }
});
test('labels beyond the existing source-text cap do not change rejected-value classification',()=>{
 const html='<footer><table><tr><td>24 26 46 51 88 435</td><td>'+ ' '.repeat(6000)+'</td><td>General contact</td></tr></table></footer>';
 const inventory=collect(html,'https://fixture.co.za/products/foil');assert.equal(inventory.candidates.length,0);assert.ok(inventory.coverage.rejectedValues>0);assert.ok(inventory.coverage.omittedVisibleText>0);
});
