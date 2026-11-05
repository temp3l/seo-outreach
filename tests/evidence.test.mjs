import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAudit, normalizeAudit} from '../dist/index.js';
const sample=sampleFile('br-kite.json');
test('portable schema-1 report preserves source and partial crawl', async () => {
 const n=await loadAudit(sample);
 assert.equal(n.target,'https://escola.brkite.com.br/');
 assert.equal(n.crawl.captured,1);
 assert.equal(n.crawl.skipped,12);
 assert.ok(n.groups.some(g=>g.code==='missing_meta_description' && g.page===n.target));
 assert.equal(n.status,'INTERNAL_UNVERIFIED');
});
test('unsupported input is rejected',()=>assert.throws(()=>normalizeAudit({schemaVersion:'2'},'a'.repeat(64))));
test('invalid time is rejected',()=>assert.throws(()=>normalizeAudit({schemaVersion:'1',crawl:{},coverage:{},capabilities:{},crawlSettings:{},findings:[],target:'https://example.com',startedAt:'x',completedAt:'x'},'a'.repeat(64))));

test('query-bearing evidence retains identity and redaction', async () => {
 const n=await loadAudit(sampleFile('kitepoeira.json'));
 const q=n.groups.find(g=>g.code==='noindex');
 assert.equal(q.page,'https://kitepoeira.com/hello-world/');
 assert.equal(q.referenceRedacted,true);
 assert.ok(!JSON.stringify(q).includes('replytocom'));
});
test('contact candidates retain attribution but are never eligible by default',async()=>{
 const n=await loadAudit(sampleFile('kitepoeira.json'));
 assert.equal(n.contacts.eligibility,'HOLD');
 assert.ok(n.contacts.candidates.some(c=>c.kind==='phone' && c.sources.some(s=>s.type==='whatsapp-link')));
 assert.equal(n.contacts.coverage.omittedCandidates,0);
});
test('failed or uncaptured URLs cannot qualify from an HTTP status alone',()=>{
 const base={schemaVersion:'1',target:'https://example.com/',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T01:00:00Z',crawlSettings:{},capabilities:{},crawl:{discovered:1,attempted:1,captured:0,failed:1,skipped:0,unattempted:0,limitations:[]},coverage:{urls:[{url:'https://example.com/',outcome:'failed',statusCode:200}]},findings:[{code:'missing_title',category:'metadata',observed:'Missing title',evidence:[{pageUrl:'https://example.com/',source:'http'}]}]};
 const n=normalizeAudit(base,'a'.repeat(64));assert.equal(n.groups[0].capture,'UNKNOWN_OR_UNSUCCESSFUL');
 base.crawl.captured=1; base.crawl.failed=0; base.coverage.urls[0]={url:'https://example.com/',outcome:'captured',statusCode:403};
 assert.equal(normalizeAudit(base,'a'.repeat(64)).groups[0].capture,'UNKNOWN_OR_UNSUCCESSFUL');
});
test('tracking parameters do not split branch identity; material query parameters do',()=>{
 const base={schemaVersion:'1',target:'https://example.com/?utm_source=one',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T01:00:00Z',crawlSettings:{},capabilities:{},crawl:{discovered:0,attempted:0,captured:0,failed:0,skipped:0,unattempted:0,limitations:[]},coverage:{urls:[]},findings:[]};
 const a=normalizeAudit(base,'a'.repeat(64));base.target='https://example.com/?utm_source=two';const b=normalizeAudit(base,'b'.repeat(64));assert.equal(a.targetIdentity,b.targetIdentity);
 base.target='https://example.com/?branch=two';const c=normalizeAudit(base,'c'.repeat(64));assert.notEqual(a.targetIdentity,c.targetIdentity);
});
test('robots-blocked URLs count as skipped but not attempted',()=>{
 const a={schemaVersion:'1',target:'https://example.com/',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T01:00:00Z',crawlSettings:{policy:{robots:'respect'}},capabilities:{},crawl:{discovered:2,attempted:1,captured:1,failed:0,skipped:1,unattempted:0,limitations:[]},coverage:{urls:[{url:'https://example.com/',outcome:'captured',statusCode:200},{url:'https://example.com/private',outcome:'robots_blocked',reason:'robots_disallowed'}]},findings:[]};
 assert.equal(normalizeAudit(a,'a'.repeat(64)).crawl.skipped,1);
 a.crawlSettings.policy.robots='observation-only';assert.throws(()=>normalizeAudit(a,'a'.repeat(64)),/invalid_robots_blocked_outcome/);a.crawlSettings.policy.robots='respect';
 a.crawl.attempted=2;assert.throws(()=>normalizeAudit(a,'a'.repeat(64)),/inconsistent_url_outcomes/);
});
test('normalization retains upstream contact confidence and unresolved provenance without granting eligibility',async()=>{
 const {readFile}=await import('node:fs/promises');const p=sampleFile('ckc.json');const raw=JSON.parse(await readFile(p,'utf8'));const n=await loadAudit(p);
 assert.equal(n.contract,'seo-outreach-evidence-v2');assert.equal(n.contacts.profile,raw.contacts.profile);assert.equal(n.contacts.eligibility,'HOLD');
 assert.equal(n.contacts.candidates[0].rank.tier,raw.contacts.candidates[0].rank.tier);assert.deepEqual(n.contacts.candidates[0].rank.reasons,raw.contacts.candidates[0].rank.reasons);
 assert.ok(n.contacts.unresolvedWhatsApp.length>0);assert.equal(n.contacts.coverage.unresolvedWhatsAppLinks,raw.contacts.coverage.unresolvedWhatsAppLinks);
 assert.equal(n.contacts.suggestedPrimary.phone.known,true);assert.equal(n.contacts.suggestedPrimary.phone.value,null);
});
test('malformed declared checker metadata is rejected at the ingestion boundary',async()=>{
 const {readFile}=await import('node:fs/promises');const raw=JSON.parse(await readFile(sampleFile('br-kite.json'),'utf8'));raw.coverage.checks.imageSizes.status='secret@example.test';assert.throws(()=>normalizeAudit(raw,'a'.repeat(64)),/invalid_checker_coverage/);
});


test('producer unknown-origin robots exclusions are skipped without establishing a capture',()=>{
 const blocked='https://example.com:8443/private';
 const a={schemaVersion:'1',target:'https://example.com/',startedAt:'2026-01-01T00:00:00Z',completedAt:'2026-01-01T01:00:00Z',crawlSettings:{policy:{robots:'respect'}},capabilities:{},robotsObservation:{policy:'respect',retrieval:'available',capturedDisallowedCount:0},crawl:{discovered:2,attempted:1,captured:1,failed:0,skipped:1,unattempted:0,limitations:['robots_admission_exclusions']},coverage:{urls:[{url:'https://example.com/',outcome:'captured',statusCode:200},{url:blocked,outcome:'robots_blocked',reason:'robots_policy_unknown_origin'}]},findings:[{code:'missing_title',category:'metadata',observed:'No title element was found.',evidence:[{pageUrl:blocked,source:'http'}]}]};
 const n=normalizeAudit(a,'a'.repeat(64));assert.equal(n.crawl.attempted,1);assert.equal(n.crawl.skipped,1);assert.equal(n.groups[0].capture,'UNKNOWN_OR_UNSUCCESSFUL');assert.ok(n.crawl.limitations.includes('robots_admission_exclusions'));
 a.coverage.urls[1].statusCode=200;assert.throws(()=>normalizeAudit(a,'a'.repeat(64)),/invalid_robots_blocked_outcome/);delete a.coverage.urls[1].statusCode;
 a.coverage.urls[1].reason='unrecognized_future_reason';assert.throws(()=>normalizeAudit(a,'a'.repeat(64)),/invalid_robots_blocked_outcome/);
});
