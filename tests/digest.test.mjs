import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAudit,buildDigest} from '../dist/index.js';
const path=sampleFile('br-kite.json');
test('provider digest is bounded and excludes source text and contact data',async()=>{
 const n=await loadAudit(path); const d=buildDigest(n); const serialized=JSON.stringify(d);
 assert.equal(d.bytes,Buffer.byteLength(serialized)); assert.ok(d.bytes<=16000); assert.ok(d.issues.some(i=>i.code==='missing_meta_description'));
 assert.ok(!serialized.includes('No meta description was found')); assert.ok(!serialized.includes('contacts')); assert.equal(d.readiness,'REVIEW_REQUIRED');
});
test('large duplicate sets are bounded and stable under reordering',async()=>{
 const n=await loadAudit(path); const g=n.groups.find(x=>x.code==='missing_meta_description');
 n.groups=Array.from({length:5000},()=>({...g}));
 const a=buildDigest(n); n.groups.reverse(); const b=buildDigest(n);
 assert.deepEqual(a,b); assert.ok(a.bytes<=16000); assert.equal(a.issues[0].affectedDistinctPages,1);
});
test('query URLs are omitted and non-generic paths are redacted',async()=>{
 const n=await loadAudit(path);const g=n.groups[0];n.groups=[{...g,code:'noindex',referenceRedacted:true},{...g,code:'missing_title',page:'https://escola.brkite.com.br/people/alice'}];
 const d=buildDigest(n); assert.equal(d.issues.length,1); assert.ok(JSON.stringify(d).includes('[path-redacted]')); assert.ok(!JSON.stringify(d).includes('alice'));
});

test('duplicated evidence does not invalidate material identity',async()=>{
 const n=await loadAudit(path); const a=buildDigest(n); n.groups.push({...n.groups[0]}); const b=buildDigest(n); assert.equal(a.materialFingerprint,b.materialFingerprint);
});
test('issue selection IDs are scoped to the target company',async()=>{
 const n=await loadAudit(path);const a=buildDigest(n);n.targetIdentity='f'.repeat(64);const b=buildDigest(n);assert.notEqual(a.issues[0].id,b.issues[0].id);
});
test('provider sees checker gaps and unknown export coverage without fabricated zeros',async()=>{
 const n=await loadAudit(path),d=buildDigest(n);assert.equal(d.version,'digest-v2');
 assert.equal(d.limits.exportStatus,'UNKNOWN');assert.equal(d.limits.exported,null);
 assert.equal(d.limits.checks.checks.imageSizes.status,'partial');assert.equal(d.limits.checks.checks.imageSizes.omittedTargets,3);
 const changed=structuredClone(n);changed.checkCoverage.checks.imageSizes.omittedTargets++;
 assert.notEqual(buildDigest(changed).materialFingerprint,d.materialFingerprint);
});
test('export omissions and field truncation invalidate material identity and remain bounded',async()=>{
 const {loadEvidenceArchive,qualifiedDigest}=await import('../dist/index.js');
 const x=await loadEvidenceArchive(sampleFile('site-05.zip'));
 const a=qualifiedDigest(x.evidence,x.pages);assert.equal(a.limits.truncatedPages,1);assert.equal(a.limits.truncatedFields.images,1);assert.ok(a.limits.corroboratedGroups>0);assert.ok(a.bytes<=16000);assert.equal(a.bytes,Buffer.byteLength(JSON.stringify(a)));
 x.evidence.exportCoverage.truncationCounts.images=0;
 const b=qualifiedDigest(x.evidence,x.pages);assert.notEqual(a.materialFingerprint,b.materialFingerprint);
 const c=qualifiedDigest(x.evidence,[]);assert.equal(c.readiness,'INSUFFICIENT_EVIDENCE');assert.notEqual(a.materialFingerprint,c.materialFingerprint);
});
test('thousands of distinct records retain service examples with a truthful bounded overflow',async()=>{
 const {createHash}=await import('node:crypto');const n=await loadAudit(path),base=n.groups.find(x=>x.code==='missing_meta_description');
 const codes=['noindex','invalid_canonical','missing_title','duplicate_title_across_pages','missing_meta_description','duplicate_meta_description_across_pages','missing_h1','broken_internal_link','broken_image_asset','image_alt_missing_or_empty','images_missing_alt','images_missing_dimensions','missing_canonical'];
 const locales=['en','es','de','pt','fr','it','nl'];const hash=x=>createHash('sha256').update(x).digest('hex');
 n.groups=Array.from({length:5000},(_,i)=>({...base,id:hash(String(i)).slice(0,24),page:`https://${n.hostname}/${locales[Math.floor(i/13)%7]}/archive-${i}`,pageIdentity:hash('page'+i),code:codes[i%13],source:Math.floor(i/91)%2?'rendered-dom':'http'}));
 const special={...base,id:'f'.repeat(24),page:`https://${n.hostname}/en/courses`,pageIdentity:hash('service')};n.groups.push(special);
 n.crawl={...n.crawl,discovered:5001,attempted:5001,captured:5001,skipped:0};
 const a=buildDigest(n);n.groups.reverse();const b=buildDigest(n);assert.deepEqual(a,b);assert.ok(a.bytes<=16000);assert.ok(a.issues.length<=40);assert.ok(a.issues.every(x=>x.pages.length<=3));
 assert.equal(a.overflow.omittedGroups,a.overflow.omittedByByteCap+a.overflow.omittedByGroupCap);assert.ok(a.overflow.omittedGroups>0);assert.ok(a.issues.some(x=>x.pages.some(p=>p.id===special.id)));
});
