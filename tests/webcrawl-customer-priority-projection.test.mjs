import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { customerPriorityProjection } from '../dist/reports/customer.js';
import { renderWhatsAppDraft } from '../dist/reports/whatsapp-draft.js';
test('priority admission is stable under finding/evidence permutations; invalid URLs never create claims', () => {
  const {audit}=createEvidenceFixture(3);
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
