import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {customerPriorityProjection} from '../dist/reports/customer.js';
import {countDeduplicatedIssues} from '../dist/reports/issue-counts.js';
import {renderCustomerSummaryHtml} from '../dist/reports/summary.js';

test('pre-limit reportable checks omitted from cards remain described in customer output',()=>{
 const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;const page=audit.target;
 audit.findings=['invalid_canonical','meta_description_length','missing_meta_description','images_missing_dimensions','missing_h1','heading_hierarchy_skip','missing_canonical','image_file_too_large'].map(code=>({code,category:'metadata',severity:'low',observed:code,evidence:[{pageUrl:page,observedAt:audit.startedAt,source:'http'}]}));
 const p=customerPriorityProjection(audit),shown=new Set(p.selected.map(t=>t.code)),hidden=p.countedFindings.filter(f=>!shown.has(f.code));
 assert.ok(hidden.length);assert.equal(p.deduplicatedIssues,countDeduplicatedIssues(p.countedFindings));
 assert.ok(p.selected.some(t=>t.observed.includes('Also counted in overall SEO findings:')));
 const html=renderCustomerSummaryHtml(audit,'en');assert.match(html,/Also counted in overall SEO findings:/);assert.match(html,/check observations?/);
 const german=renderCustomerSummaryHtml(audit,'de');assert.match(german,/Ebenfalls in SEO-Befunden gezählt:/);
});


test('real repeated image-link aliases do not create an additional count disclosure',async()=>{
 const {readFile}=await import('node:fs/promises');const {gunzipSync}=await import('node:zlib');
 const {withCustomerEvidence}=await import('../dist/reports/customer-evidence.js');
 const root='/home/box/spora-worktrees/capetown-schools-5/WC-017-high-five-kitesurf-school';
 const audit=JSON.parse(await readFile(root+'/crawl.json'));const data=JSON.parse(gunzipSync(await readFile(root+'/crawl.page-data.json.gz'),{maxOutputLength:200000000}));
 const p=customerPriorityProjection(withCustomerEvidence(audit,data));
 assert.ok(p.selected.some(t=>t.code.includes('alt')));
 assert.ok(!p.selected.some(t=>/Also counted in overall SEO findings: Some image-only links/u.test(t.observed)));
});

async function duplicateMetadataFixture(extra) {
 const {createPageDataExport}=await import('@spora/webcrawl/analysis/page-data');
 const {auditResultSha256}=await import('../dist/reports/qualification.js');
 const {withCustomerEvidence}=await import('../dist/reports/customer-evidence.js');
 const {audit}=createEvidenceFixture(2),urls=['https://fixture.example/products/a','https://fixture.example/products/b'];
 audit.target=urls[0];audit.coverage.urls=urls.map(url=>({url,finalUrl:url,outcome:'captured',statusCode:200}));
 const evidence=urls.map(pageUrl=>({pageUrl,source:'http',observedAt:audit.startedAt}));
 audit.findings=['duplicate_title_across_pages','duplicate_meta_description_across_pages'].map(code=>({code,category:'metadata',severity:'low',observed:'same',evidence}));
 if(extra)audit.findings.push(...['invalid_canonical','missing_canonical','missing_meta_description','meta_description_length','missing_h1','images_missing_dimensions','image_file_too_large'].map(code=>({code,category:'metadata',severity:'high',observed:code,evidence:[evidence[0]]})));
 const pages=urls.map(url=>({requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:200,xRobotsTag:'index',xRobotsTagCaptured:true,html:`<title>Same</title><meta name="description" content="Same"><link rel="canonical" href="${url}">`}));
 const data={...createPageDataExport(pages),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 return withCustomerEvidence(audit,data);
}
test('merged title and description checks both remain explicit on the selected card',async()=>{
 const result=await duplicateMetadataFixture(false),p=customerPriorityProjection(result),html=renderCustomerSummaryHtml(result,'en');
 assert.equal(p.deduplicatedIssues,4);assert.equal(p.selected.length,1);assert.match(html,/Review repeated page titles and descriptions/);assert.match(html,/share both page titles and search descriptions/);assert.match(html,/distinct titles or descriptions/);
 assert.equal(p.countedFindings.filter(f=>f.code.startsWith('duplicate_')).length,2);
});
test('an omitted merged metadata topic discloses all title and description observations',async()=>{
 const result=await duplicateMetadataFixture(true),p=customerPriorityProjection(result),html=renderCustomerSummaryHtml(result,'en');
 assert.equal(p.selected.length,6);assert.ok(!p.selected.some(t=>t.code==='duplicate_title_across_pages'));
 assert.match(html,/Review repeated page titles and descriptions \(4 check observations\)/);
});

test('distinct trailing-slash page identities do not merge metadata topics',async()=>{
 const {createPageDataExport}=await import('@spora/webcrawl/analysis/page-data');
 const {auditResultSha256}=await import('../dist/reports/qualification.js');
 const {withCustomerEvidence,prepareCustomerEvidenceTriage}=await import('../dist/reports/customer-evidence.js');
 const {audit}=createEvidenceFixture(4),urls=['https://fixture.example/products/a','https://fixture.example/products/b','https://fixture.example/products/a/','https://fixture.example/products/b/'];
 audit.target=urls[0];audit.coverage.urls=urls.map(url=>({url,finalUrl:url,outcome:'captured',statusCode:200}));
 audit.findings=['duplicate_title_across_pages','duplicate_meta_description_across_pages'].map((code,i)=>({code,category:'metadata',severity:'low',observed:'same',evidence:urls.slice(i*2,i*2+2).map(pageUrl=>({pageUrl,source:'http',observedAt:audit.startedAt}))}));
 const pages=urls.map(url=>({requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:200,xRobotsTag:'index',xRobotsTagCaptured:true,html:`<title>Same</title><meta name="description" content="Same"><link rel="canonical" href="${url}">`}));
 const data={...createPageDataExport(pages),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 assert.deepEqual(audit.findings.map(prepareCustomerEvidenceTriage(audit,data)),['admitted','admitted']);
 const p=customerPriorityProjection(withCustomerEvidence(audit,data));assert.deepEqual(new Set(p.selected.map(t=>t.code)),new Set(['duplicate_title_across_pages','duplicate_meta_description_across_pages']));
 assert.ok(!p.selected.some(t=>t.titleOverride));assert.equal(p.deduplicatedIssues,4);
});
