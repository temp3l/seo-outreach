import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {loadEvidenceArchive,qualifiedDigest,validateSelection} from '../dist/index.js';
const path=sampleFile('site-05.zip');
const wanted=['missing_meta_description','missing_h1','missing_canonical','noindex','image_alt_missing_or_empty','images_missing_dimensions'];
test('six distinct synthetic dive-school observations yield safe structured review text',async()=>{
 const x=await loadEvidenceArchive(path);const d=qualifiedDigest(x.evidence,x.pages);
 const ids=wanted.map(code=>d.issues.find(i=>i.code===code)?.id);assert.ok(ids.every(Boolean));
 const v=validateSelection(x.evidence,x.pages,ids,'en');assert.equal(v.findings.length,6);assert.equal(v.customerStatus,'HOLD');assert.ok(v.findings.every(f=>f.reference&&f.implication&&f.fix));
 assert.throws(()=>validateSelection(x.evidence,x.pages,['0'.repeat(24)],'en'),/unknown_issue_id/);
 assert.throws(()=>validateSelection(x.evidence,x.pages,[ids[0],ids[0]],'en'),/invalid_selection/);
});
test('forged or mismatched page evidence cannot be selected',async()=>{
 const x=await loadEvidenceArchive(path);const d=qualifiedDigest(x.evidence,x.pages);const id=d.issues.find(i=>i.code==='missing_meta_description').id;
 for(const p of x.pages)if(p.descriptionStatus==='ABSENT')p.descriptionStatus='OBSERVED';
 assert.throws(()=>validateSelection(x.evidence,x.pages,[id],'en'),/unknown_issue_id/);
});
test('safe captured date archive references remain useful without exposing private paths',async()=>{
 const x=await loadEvidenceArchive(path);const d=qualifiedDigest(x.evidence,x.pages);const id=d.issues.find(i=>i.code==='noindex').id;const v=validateSelection(x.evidence,x.pages,[id],'en');
 assert.match(v.findings[0].reference,/^https:\/\/www\.belizedivingadventures\.net\/2016\//);
});
