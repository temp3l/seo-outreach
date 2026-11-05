import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCustomerPdf } from '../dist/pdf.js';
import { verifyRenderedPdf } from '../dist/pdf-verification.js';
import { loadEvidenceArchive } from '../dist/archive.js';
import { validateSelection } from '../dist/decision.js';
import { buildReportPdfInput } from '../dist/report.js';

const input={company:'kite.example',locale:'en',opening:'A concise review of captured pages.',opportunities:['Clarify search snippets','Improve page context'],findings:Array.from({length:6},(_,i)=>({id:String(i+1).padStart(24,'0'),observed:`Observation ${i+1}.`,reference:`https://kite.example/page-${i+1}`,implication:`Potential impact ${i+1}.`,fix:`Suggested fix ${i+1}.`})),coverage:'Captured 8; exported 6; omitted 2; failed 0; unattempted 1. Site-wide coverage is not established.',nextStep:'If useful, we can discuss a small fixed-scope review. Would you like to explore that?'};
const rendered=()=>renderCustomerPdf(input);
const text=(bytes)=>Buffer.from(bytes).toString('latin1');

test('verifies valid renderer output and reports artifact-only status',()=>{
  const pdf=rendered(); const result=verifyRenderedPdf(input,pdf);
  assert.deepEqual(result,{status:'ARTIFACT_VERIFIED_ONLY',sha256:createHash('sha256').update(pdf).digest('hex'),pageCount:2,findings:6});
});

test('verifies multi-page output and all localized fixed labels in reading order',()=>{
  for(const locale of ['es','de','pt-BR']) {
    const localized={...input,locale,opening:'Revisión de páginas capturadas. '.repeat(180)};
    const result=verifyRenderedPdf(localized,renderCustomerPdf(localized));
    assert.ok(result.pageCount>1,`${locale} should exercise page-tree traversal`); assert.equal(result.findings,6);
  }
});

test('rejects malformed structure, changed text, reordered lines, and active-content tokens',()=>{
  const pdf=rendered();
  assert.throws(()=>verifyRenderedPdf(input,Buffer.from('not a pdf')));
  const width=text(pdf).replace('/MediaBox [0 0 360 640]','/MediaBox [0 0 612 792]'); assert.throws(()=>verifyRenderedPdf(input,Buffer.from(width,'latin1')));
  const changed=text(pdf).replace('Observation 1.','Observation X.'); assert.notEqual(changed,text(pdf)); assert.throws(()=>verifyRenderedPdf(input,Buffer.from(changed,'latin1')));
  const swapped=text(pdf).replace(/stream\n([^\n]+)\n([^\n]+)\n/, 'stream\n$2\n$1\n'); assert.throws(()=>verifyRenderedPdf(input,Buffer.from(swapped,'latin1')));
  const open=text(pdf).replace('%%EOF','/OpenAction'); assert.throws(()=>verifyRenderedPdf(input,Buffer.from(open,'latin1')));
  const badLength=text(pdf).replace(/\/Length (\d+)/,(_,n)=>`/Length ${Number(n)+1}`); assert.throws(()=>verifyRenderedPdf(input,Buffer.from(badLength,'latin1')));
  const badXref=text(pdf).replace(/startxref\n\d+\n/,'startxref\n0\n'); assert.throws(()=>verifyRenderedPdf(input,Buffer.from(badXref,'latin1')));
});

const analysisPath=resolve('.workproof/artifact-verified-belize/analysis.json');
const analysis=existsSync(analysisPath)?JSON.parse(readFileSync(analysisPath,'utf8')):null;
const heldPdfPath=resolve('.workproof/artifact-verified-belize/report.pdf');
const sourceAvailable=!!analysis&&typeof analysis.inputPath==='string'&&existsSync(analysis.inputPath)&&existsSync(heldPdfPath);
test('verifies the current recorded held PDF against an archive-coverage-aware Decision when available',{skip:!sourceAvailable},async()=>{
  const zip=readFileSync(analysis.inputPath);assert.equal(createHash('sha256').update(zip).digest('hex'),analysis.inputSha256);
  const archive=await loadEvidenceArchive(analysis.inputPath);
  const decision=validateSelection(archive.evidence,archive.pages,analysis.selectedIssueIds,analysis.locale);
  const expected=buildReportPdfInput(decision);const verified=verifyRenderedPdf(expected,readFileSync(heldPdfPath));
  assert.equal(verified.status,'ARTIFACT_VERIFIED_ONLY');assert.equal(verified.findings,6);
});



test('rejects same-length style changes and clipped final text despite intact PDF structure',()=>{
 const pdf=rendered(),original=text(pdf);
 const missingBold=Buffer.from(original.replaceAll('/F2','/F1'),'latin1');
 assert.equal(missingBold.length,pdf.length);assert.throws(()=>verifyRenderedPdf(input,missingBold));
 const largeFinal={...input,nextStep:'M'.repeat(20)};
 const good=renderCustomerPdf(largeFinal),doc=text(good),at=doc.lastIndexOf('BT /F1 11 ');
 assert.ok(at>=0);const clipped=Buffer.from(doc.slice(0,at)+doc.slice(at).replace('BT /F1 11 ','BT /F1 21 '),'latin1');
 assert.equal(clipped.length,good.length);assert.throws(()=>verifyRenderedPdf(largeFinal,clipped));
});
