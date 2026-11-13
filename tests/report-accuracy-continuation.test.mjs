import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createPageDataExport} from '@spora/webcrawl/analysis/page-data';
import {imageNamingEvidence} from '@spora/webcrawl/analysis/image-naming';
import {prepareCustomerEvidenceTriage,withCustomerEvidence} from '../dist/reports/customer-evidence.js';
import {customerPriorityProjection} from '../dist/reports/customer.js';
import {auditResultSha256} from '../dist/reports/qualification.js';
import {renderOperatorStatusHtml} from '../dist/reports/summary.js';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
const archive='/home/box/spora-worktrees/capetown-schools-5';
async function saved(name){const path=archive+'/'+name;const audit=JSON.parse(await readFile(path+'/crawl.json'));const data=JSON.parse(gunzipSync(await readFile(path+'/crawl.page-data.json.gz'),{maxOutputLength:200000000}));return {audit,data};}
test('saved WC-011 metadata is provisionally consolidated and named gift navigation does not become a defect',async()=>{
 const {audit,data}=await saved('WC-011-constantly-kiting'),before=JSON.stringify({audit,data});const triage=prepareCustomerEvidenceTriage(audit,data);const duplicates=audit.findings.filter(f=>['duplicate_title_across_pages','duplicate_meta_description_across_pages'].includes(f.code));assert.equal(duplicates.length,38);assert.ok(duplicates.every(f=>triage(f)==='consolidated'));
 const homepage=data.pages.find(p=>p.finalUrl===audit.target);const images=imageNamingEvidence(homepage);assert.equal(images.filter(i=>i.altStatus==='empty'&&i.controlContext?.nameEvidence==='text').length,4);assert.equal(images.filter(i=>i.altStatus==='empty'&&i.controlContext?.nameEvidence==='none').length,3);
 const projection=customerPriorityProjection(withCustomerEvidence(audit,data));assert.ok(projection.selected.some(t=>t.code==='image_alt_missing_or_empty'));assert.ok(!projection.countedFindings.some(f=>f.code.startsWith('duplicate_')));assert.equal(JSON.stringify({audit,data}),before);
});
test('High Five missing-alt functional link is admitted; Fruitloops informative assets stay traceable without inferred naming failures',async()=>{
 const {audit,data}=await saved('WC-017-high-five-kitesurf-school');const triage=prepareCustomerEvidenceTriage(audit,data);const missing=audit.findings.find(f=>f.code==='images_missing_alt'&&f.evidence[0].pageUrl===audit.target);assert.equal(triage(missing),'admitted');
 const projection=customerPriorityProjection(withCustomerEvidence(audit,data));assert.ok(projection.selected.some(t=>['images_missing_alt','image_alt_missing_or_empty'].includes(t.code)));assert.ok(projection.selected.findIndex(t=>t.code.includes('alt'))<projection.selected.findIndex(t=>t.code==='images_missing_dimensions'));
 const fruit=await saved('WC-013-fruitloops-kitesurfing-school');const informative=fruit.audit.findings.find(f=>f.code==='images_missing_alt'&&f.evidence[0].pageUrl===fruit.audit.target);assert.equal(prepareCustomerEvidenceTriage(fruit.audit,fruit.data)(informative),'review');assert.ok(informative.evidence[0].imageObservations.length>0);
});
test('missing-alt aliases cannot borrow an unrelated empty-alt failure and limited context stays review-only',()=>{
 const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;const html='<a href="/go"><img src="/empty.png" alt=""></a><a href="/go" aria-labelledby="unknown"><img src="/missing.png"></a>';
 const data={...createPageDataExport([{requestedUrl:audit.target,finalUrl:audit.target,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:html.length,html}]),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 const base={category:'accessibility',observed:'Inventory',evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.startedAt}]};const triage=prepareCustomerEvidenceTriage(audit,data);assert.equal(triage({...base,code:'images_missing_alt'}),'review');assert.equal(triage({...base,code:'image_alt_missing_or_empty'}),'admitted');
 data.pages[0].documentImages[0].controlContext.nameEvidence='unknown';assert.equal(prepareCustomerEvidenceTriage(audit,data)({...base,code:'image_alt_missing_or_empty'}),'review');
});
test('operator evidence coverage label survives settled execution and content PARTIAL',()=>{
 const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;audit.crawl.limitations=['content_inspection_incomplete'];const html=renderOperatorStatusHtml(audit,'en');assert.match(html,/Crawl complete/u);assert.match(html,/some page content was not analyzed/u);
});

// Customer copy describes image links, so an image-only button cannot substantiate it.
test('image button evidence is not mislabeled as an image link',()=>{
 const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;
 const html='<a href="/go"><img src="/link.png" alt=""></a><button><img src="/button.png" alt=""></button>';
 const data={...createPageDataExport([{requestedUrl:audit.target,finalUrl:audit.target,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:html.length,html}]),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 const finding={code:'image_alt_missing_or_empty',category:'accessibility',observed:'Inventory',evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.startedAt}]};
 assert.equal(prepareCustomerEvidenceTriage(audit,data)(finding),'admitted');
 data.pages[0].documentImages=data.pages[0].documentImages.filter(i=>i.controlContext?.kind==='button');
 assert.equal(data.pages[0].documentImages.length,1);
 assert.equal(prepareCustomerEvidenceTriage(audit,data)(finding),'review');
});
