import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadEvidenceArchive,unpackEvidenceArchive} from '../dist/index.js';
const sample=sampleFile('site-01.zip');
test('portable Webcrawl evidence archive is read with structural-only status',async()=>{
 const result=await loadEvidenceArchive(sample);
 assert.equal(result.evidence.target,'https://theplacencia.com/adventures');
 assert.equal(result.verification,'STRUCTURAL_ONLY');
 assert.equal(result.evidence.format,'webcrawl-evidence-zip-1');
 assert.equal(result.manifest.status,'PARTIAL');
 assert.equal(result.evidence.status,'INTERNAL_UNVERIFIED');
});
test('empty and corrupt archives are rejected',async()=>{
 assert.throws(()=>unpackEvidenceArchive(Buffer.alloc(0)));
 const bytes=await readFile(sample); bytes[90]^=0xff;
 assert.throws(()=>unpackEvidenceArchive(bytes));
});
test('traversal member is rejected before decompression',async()=>{
 const bytes=await readFile(sample); bytes.write('../evil!!',30,'utf8');
 assert.throws(()=>unpackEvidenceArchive(bytes));
});
test('preserves real export omissions and rejects contradictory crawl metadata',async()=>{
 const x=await loadEvidenceArchive(sample);
 assert.equal(x.evidence.exportCoverage.status,'PARTIAL');
 assert.equal(x.evidence.exportCoverage.exported,x.pages.length);
 assert.ok(x.evidence.exportCoverage.truncationCounts.pages>=0);
 const {attachArchiveCoverage}=await import('../dist/archive.js');
 const altered=structuredClone(x.manifest);altered.coverage.failed++;
 assert.throws(()=>attachArchiveCoverage(x.evidence,altered,x.pages.length),/archive_audit_coverage_mismatch/);
 const missing=structuredClone(x.manifest);delete missing.truncationCounts;
 assert.throws(()=>attachArchiveCoverage(x.evidence,missing,x.pages.length),/archive_coverage_metadata_invalid/);
});
