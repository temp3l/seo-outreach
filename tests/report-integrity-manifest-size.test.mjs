import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {auditResultSha256} from '../dist/reports/qualification.js';
import {createCustomerReviewManifest} from '../dist/reports/review.js';
import {checkEntry,digest,readBounded} from '../scripts/compat/data-integrity-core.mjs';

test('integrity readback accepts a large traced review and retains a bounded private read',async()=>{
 const dir=await mkdtemp('/tmp/review-manifest-bound-'),{audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;
 const pdf=Buffer.from('%PDF-fixture'),artifacts=[{role:'a4',path:dir+'/a4.pdf',content:pdf},{role:'mobile',path:dir+'/mobile.pdf',content:pdf}];
 const review={...createCustomerReviewManifest(audit,'en',artifacts),admittedEvidenceReferences:Array.from({length:1000},(_,i)=>({findingIndex:i,evidenceIndex:0}))};
 const auditPath=dir+'/audit.json',reviewPath=dir+'/review.json',qPath=dir+'/qualification.json';
 const bytes=Buffer.from(JSON.stringify(review));assert.ok(bytes.length>16384);await writeFile(reviewPath,bytes,{mode:0o600});await writeFile(auditPath,JSON.stringify(audit),{mode:0o600});
 const q={decision:'RELEASE',target:audit.target,auditSha256:auditResultSha256(audit),qualifiedAt:new Date().toISOString(),qualifiedBy:'Synthetic reviewer',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED',reviewedManifestSha256:digest(bytes)};await writeFile(qPath,JSON.stringify(q),{mode:0o600});
 const result=await checkEntry({id:'bounded',audit:auditPath,qualification:qPath,reviewManifest:reviewPath});
 assert.ok(result.checks.some(c=>c.code==='review_manifest_binding'&&c.status==='PASS'),JSON.stringify(result));assert.equal(result.decision,'HOLD');
 await writeFile(reviewPath,Buffer.alloc(16_000_001),{mode:0o600});await assert.rejects(readBounded(reviewPath,16_000_000,true),/unsafe_or_oversized_file/);
 assert.equal((await readFile(auditPath,'utf8')),JSON.stringify(audit));
});
