import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {loadEvidenceArchive,corroborateArchive} from '../dist/index.js';
const path=sampleFile('site-05.zip');
let archivePromise;
async function freshArchive(){archivePromise??=loadEvidenceArchive(path);return structuredClone(await archivePromise);}
function provenCase(x,check){
 const proof=corroborateArchive(x.evidence,x.pages).find(item=>item.check===check);
 assert.ok(proof,`real archive should have a ${check} corroboration`);
 const group=x.evidence.groups.find(item=>item.id===proof.groupId);
 const page=x.pages.find(item=>item.id===proof.pageId);
 assert.ok(group&&page);
 return {proof,group,page};
}
test('real dive archive page projections corroborate findings without promoting them to publication',async()=>{
 const x=await freshArchive();const proof=corroborateArchive(x.evidence,x.pages);
 assert.ok(proof.some(p=>p.check==='missing_meta_description'));assert.ok(proof.some(p=>p.check==='image_alt_missing_or_empty'));
 assert.equal(x.verification,'STRUCTURAL_ONLY');
 const target=proof[0];const page=x.pages.find(p=>p.id===target.pageId);page.statusCode=403;
 assert.ok(!corroborateArchive(x.evidence,x.pages).some(p=>p.groupId===target.groupId));
});
test('page identity cannot be substituted',async()=>{
 const x=await freshArchive();const proof=corroborateArchive(x.evidence,x.pages);const target=proof[0];const page=x.pages.find(p=>p.id===target.pageId);page.finalUrl='https://evil.example/';
 assert.ok(!corroborateArchive(x.evidence,x.pages).some(p=>p.groupId===target.groupId));
});

test('non-HTML page data cannot corroborate a missing description',async()=>{
 const x=await freshArchive();const {proof,page}=provenCase(x,'missing_meta_description');page.contentType='application/pdf';
 assert.ok(!corroborateArchive(x.evidence,x.pages).some(item=>item.groupId===proof.groupId));
});

test('technical finding timestamp must match the exact page capture even inside the scan window',async()=>{
 const x=await freshArchive();const {proof,group,page}=provenCase(x,'missing_meta_description');
 const shifted=new Date(Date.parse(page.fetchedAt)+1_000).toISOString();
 assert.ok(Date.parse(shifted)>=Date.parse(x.evidence.startedAt)-600_000&&Date.parse(shifted)<=Date.parse(x.evidence.completedAt)+600_000);
 assert.notEqual(group.representative.observedAt,shifted);page.fetchedAt=shifted;
 assert.ok(!corroborateArchive(x.evidence,x.pages).some(item=>item.groupId===proof.groupId));
});

test('raw description and canonical values contradicting missing statuses cannot corroborate',async()=>{
 const descriptionData=await freshArchive();const description=provenCase(descriptionData,'missing_meta_description');description.page.descriptionRaw='A present description';
 assert.ok(!corroborateArchive(descriptionData.evidence,descriptionData.pages).some(item=>item.groupId===description.proof.groupId));
 const canonicalData=await freshArchive();const canonical=provenCase(canonicalData,'missing_canonical');canonical.page.canonical='https://www.belizedivingadventures.net/';
 assert.ok(!corroborateArchive(canonicalData.evidence,canonicalData.pages).some(item=>item.groupId===canonical.proof.groupId));
});

test('a viewport declaration containing noindex does not corroborate robots noindex',async()=>{
 const x=await freshArchive();const {proof,page}=provenCase(x,'noindex');
 const declaration=page.metaRobotsDeclarations.find(item=>item.status==='observed'&&/\bnoindex\b/i.test(item.content??''));
 assert.ok(declaration);declaration.name='viewport';
 assert.ok(!corroborateArchive(x.evidence,x.pages).some(item=>item.groupId===proof.groupId));
});
