import test from 'node:test';
import assert from 'node:assert/strict';
import {countDeduplicatedIssues} from '../dist/reports/issue-counts.js';
import {customerPriorityProjection} from '../dist/reports/customer.js';
import {renderCustomerSummaryHtml} from '../dist/reports/summary.js';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
const at='2026-10-29T00:00:00.000Z';
const e=(path,extra={})=>({pageUrl:'https://fixture.example'+path,source:'http',observedAt:at,...extra});
const f=(code,evidence)=>({code,category:'content',observed:code,evidence});
test('individual page issues deduplicate aliases, repeat records and sources without collapsing different pages',()=>{
 const findings=[f('missing_meta_description',[e('/'),e('/courses/')]),f('missing_meta_description',[e('/',{source:'rendered-dom',observedAt:'2026-11-05T01:00:00Z'})]),f('images_missing_alt',[e('/')]),f('image_alt_missing_or_empty',[e('/')])];
 assert.equal(countDeduplicatedIssues(findings),3);
 assert.equal(countDeduplicatedIssues([...findings].reverse()),3);
 assert.equal(countDeduplicatedIssues([f('missing_meta_description',[e('/?page=1'),e('/?page=2'),e('/?page=1#fragment')])]),2);
});
test('asset observations count assets once and broken-link confirmation does not add a second issue',()=>{
 assert.equal(countDeduplicatedIssues([f('image_file_too_large',[e('/large.jpg'),e('/courses/')]),f('image_file_too_large',[e('/large.jpg'),e('/booking/')])]),1);
 assert.equal(countDeduplicatedIssues([f('broken_internal_link',[e('/missing',{value:404})]),f('broken_internal_link',[e('/courses/',{anchorHref:'/missing',value:404})])]),1);
 assert.equal(countDeduplicatedIssues([f('broken_internal_link',[e('/courses/',{anchorHref:'/missing',value:404}),e('/missing',{value:404}),e('/courses/',{anchorHref:'/missing#again',value:404}),e('/booking/',{anchorHref:'/missing',value:404})])]),2);
});
test('customer badge counts admitted individual issues and excludes internal and unsupported material',()=>{
 const {audit}=createEvidenceFixture(1);const urls=['/','/courses/','/booking/'];
 audit.coverage.urls=urls.map(path=>({url:'https://fixture.example'+path,outcome:'captured',statusCode:200}));
 audit.findings=[f('missing_meta_description',urls.map(path=>e(path))),f('missing_meta_description',[e('/')]),f('missing_nosniff_header',[e('/')]),f('not_supported',[e('/')]),f('missing_meta_description',[e('/privacy/')])];
 for(const locale of ['en','de']){
  const projection=customerPriorityProjection(audit,locale);assert.equal(projection.selected.length,1);assert.equal(projection.deduplicatedIssues,3);
  const html=renderCustomerSummaryHtml(audit,locale);
  assert.match(html,/data-summary="deduplicated-issues"><strong>3<\/strong>/);
  assert.match(html,locale==='en'?/SEO findings/:/SEO-Befunde/);assert.doesNotMatch(html,/deduplicated issues|bereinigte Befunde/);
 }
});
