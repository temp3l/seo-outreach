import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportPdfInput, buildCustomerReportPdfInput } from '../dist/report.js';
import { renderCustomerPdf } from '../dist/pdf.js';
import { verifyRenderedPdf } from '../dist/pdf-verification.js';
import { buildDrafts } from '../dist/drafts.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const codes = ['missing_meta_description','missing_title','missing_h1','noindex','image_alt_missing_or_empty','malformed_json_ld'];
const fixture = (locale='en') => ({version:'decision-v1',locale,company:'kite.example',materialFingerprint:'a'.repeat(64),coverage:{captured:10,failed:1,skipped:2,unattempted:3,exported:8,omitted:2,robots:'available'},customerStatus:'HOLD',reasons:['artifact_and_source_semantics_not_yet_verified'],findings:codes.map((code,i)=>({id:(i+1).toString(16).padStart(24,'0'),code,observed:`Supported observation ${i+1}.`,reference:`https://kite.example/page-${i+1}`,implication:`This may affect how visitors understand page ${i+1}.`,fix:`Review page ${i+1} and make its information clearer.`}))});

test('builds an INTERNAL/HOLD mobile PDF input with exact supported count and honest coverage limits',()=>{
  const x=buildReportPdfInput(fixture());
  assert.equal(x.company,'kite.example'); assert.equal(x.findings.length,6); assert.ok(x.opportunities.length>=1&&x.opportunities.length<=3);
  assert.match(x.opening,/INTERNAL \/ HOLD/); assert.match(x.coverage,/6 distinct selected findings/); assert.match(x.coverage,/Captured: 10/); assert.match(x.coverage,/exported: 8/); assert.match(x.coverage,/omitted: 2/); assert.match(x.coverage,/failed: 1/); assert.match(x.coverage,/unattempted: 3/); assert.match(x.coverage,/skipped: 2/); assert.match(x.coverage,/do not establish site-wide coverage/);
  assert.ok(x.findings.every(f=>f.reference.startsWith('https://kite.example/')));
  const pdf=renderCustomerPdf(x); assert.equal(pdf.subarray(0,8).toString('latin1'),'%PDF-1.4');
});

test('builds English, Spanish and German customer copy from the same six safe findings and verifies each rendered artifact',()=>{
  for(const locale of ['en','es','de']) {
    const decision=fixture(locale);decision.coverage.truncatedPages=2;
    const internal=buildReportPdfInput(decision);const customer=buildCustomerReportPdfInput(decision);
    assert.equal(customer.findings.length,6);assert.deepEqual(customer.findings,internal.findings);
    assert.deepEqual(customer.opportunities,internal.opportunities);assert.equal(customer.coverage,internal.coverage);
    assert.doesNotMatch(customer.opening,/INTERNAL|INTERNO|INTERN|HOLD|EN ESPERA|EM ESPERA/);
    assert.doesNotMatch(customer.nextStep,/Internal|Interno|Interner|HOLD/);
    assert.match(customer.coverage,/site-wide coverage|cobertura completa|vollständige Abdeckung|cobertura de todo/i);
    const verified=verifyRenderedPdf(customer,renderCustomerPdf(customer));
    assert.equal(verified.status,'ARTIFACT_VERIFIED_ONLY');assert.equal(verified.findings,6);
  }
});

test('customer copy rejects opaque page IDs while the internal review builder remains available',()=>{
  const decision=fixture();decision.findings[0].reference=`kite.example — page_${'a'.repeat(64)}`;
  assert.doesNotThrow(()=>buildReportPdfInput(decision));
  assert.throws(()=>buildCustomerReportPdfInput(decision),/usable same-company page URL/);
});

test('rejects empty findings, duplicate IDs/root causes, unsupported issues, and cross-host references',()=>{
  const a=fixture(); a.findings=[]; assert.throws(()=>buildReportPdfInput(a),/One to six/);
  const b=fixture(); b.findings[5].id=b.findings[0].id; assert.throws(()=>buildReportPdfInput(b),/distinct/);
  const c=fixture(); c.findings[5].code=c.findings[0].code; assert.throws(()=>buildReportPdfInput(c),/distinct supported/);
  const d=fixture(); d.findings[0].reference='https://other.example/'; assert.throws(()=>buildReportPdfInput(d),/same-company/);
  const e=fixture(); e.findings[0].code='made_up'; assert.throws(()=>buildReportPdfInput(e),/distinct supported/);
  const f=fixture(); f.coverage.exported=7; assert.throws(()=>buildReportPdfInput(f),/equal captured/);
  const g=fixture(); delete g.coverage; assert.throws(()=>buildReportPdfInput(g),/Unexpected or missing decision fields/);
});

test('multilingual generated copy is extractable and retains INTERNAL/HOLD',()=>{
  const phrases={es:['INTERNO / EN ESPERA','no demuestran una cobertura completa'],de:['INTERN / ZURÜCKGEHALTEN','keine vollständige Abdeckung'], 'pt-BR':['INTERNO / EM ESPERA','não comprovam a cobertura de todo']};
  for(const [locale,expected] of Object.entries(phrases)) {
    const pdf=renderCustomerPdf(buildReportPdfInput(fixture(locale))); const dir=mkdtempSync(join(tmpdir(),'report-pdf-'));
    try { const path=join(dir,'x.pdf'); writeFileSync(path,pdf); const text=execFileSync('pdftotext',[path,'-'],{encoding:'utf8'}).replace(/\s+/g,' '); for(const s of expected) assert.ok(text.includes(s),`${locale} missing ${s}`); assert.ok(text.includes('INTERNAL')||text.includes('INTERN')||text.includes('INTERNO')); assert.ok(!text.includes('?'),'unexpected replacement glyph'); }
    finally { rmSync(dir,{recursive:true,force:true}); }
  }
});

test('wraps a long hostname and keeps every rendered line inside the 304pt content width',()=>{
  const decision=fixture(); const longHost=`${'kite'.repeat(15)}.school.example`; decision.company=longHost;
  decision.findings.forEach((f,i)=>f.reference=`https://${longHost}/page-${i+1}`);
  const dir=mkdtempSync(join(tmpdir(),'long-host-pdf-'));
  try {
    const path=join(dir,'long.pdf'); writeFileSync(path,renderCustomerPdf(buildReportPdfInput(decision)));
    const extracted=execFileSync('pdftotext',[path,'-'],{encoding:'utf8'}).replace(/\s+/g,''); assert.ok(extracted.includes(longHost));
    const bbox=execFileSync('pdftotext',['-bbox-layout',path,'-'],{encoding:'utf8'});
    const lines=[...bbox.matchAll(/<line xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)"/g)];
    assert.ok(lines.length>0); for(const [,min,max] of lines) { assert.ok(Number(min)>=28-0.1); assert.ok(Number(max)<=332+0.1); assert.ok(Number(max)-Number(min)<=304+0.2); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('decision finding maps into natural evidence-based opener without claiming report is ready',()=>{
  const decision=fixture(); const d=buildReportPdfInput(decision); const {id,...finding}=decision.findings[0];
  finding.observed='The captured page had no meta description.';
  finding.implication='Search engines may choose their own snippet, which can make the page less clear in search results.';
  const draft=buildDrafts({company:decision.company,locale:decision.locale,seller:{name:'Alex',location:'Tarifa'},finding,reportAvailable:false});
  assert.ok(draft.opener.includes(`${finding.reference}: ${finding.observed}`));
  assert.ok(draft.opener.includes(`${finding.observed} ${finding.implication}`));
  assert.ok(!draft.opener.includes('results..'));
  assert.ok(draft.opener.length<=450);
  assert.ok(draft.afterInterest.includes('I can share the observed details and source page references here'));
  assert.ok(!draft.afterInterest.includes('customer-ready PDF'));
  assert.ok(!draft.afterInterest.includes('Here is the reviewed report'));
  assert.ok(!draft.afterInterest.includes('HOLD'));
});
test('coverage discloses known truncation and never invents a zero for unknown export coverage',()=>{
 const d=fixture();assert.match(buildReportPdfInput(d).coverage,/truncated export fields: unknown/);
 d.coverage.truncatedPages=7;assert.match(buildReportPdfInput(d).coverage,/truncated export fields: 7/);
 d.coverage.truncatedPages=11;assert.throws(()=>buildReportPdfInput(d),/Invalid truncated-page count/);
});


test('coverage counts and closing next step stay on the same page when they fit',()=>{
 const d=fixture();d.coverage={captured:500,exported:500,omitted:0,failed:0,unattempted:1223,skipped:29,robots:'available',truncatedPages:499};
 const bytes=renderCustomerPdf(buildCustomerReportPdfInput(d));
 const streams=[...bytes.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m=>m[1]);
 const coverage=streams.findIndex(s=>s.includes('(Coverage)'));assert.ok(coverage>=0);
 assert.ok(streams[coverage].includes('(Next step)'));
 assert.ok(streams[coverage].includes('unattempted: 1223'));
 assert.ok(streams[coverage].includes('499.'));
});

test('one to five supported findings render without padding and retain coverage disclosures',()=>{
 for(const count of [1,2,3,4,5])for(const locale of ['en','es','de']){
  const d=fixture(locale);d.findings=d.findings.slice(0,count);
  const internal=buildReportPdfInput(d),customer=buildCustomerReportPdfInput(d);
  assert.equal(internal.findings.length,count);assert.equal(customer.findings.length,count);
  assert.doesNotMatch(customer.opening,/\bsix\b|\bseis\b|\bsechs\b/i);
  const result=verifyRenderedPdf(customer,renderCustomerPdf(customer));assert.equal(result.findings,count);
  assert.match(customer.coverage,/unattempted: 3|no intentadas: 3|nicht versucht: 3|não tentadas: 3/);
  assert.throws(()=>verifyRenderedPdf({...customer,findings:[]},renderCustomerPdf(customer)),/verification failed/);
 }
 const tooMany=fixture();tooMany.findings.push({...tooMany.findings[0],id:'f'.repeat(24)});
 assert.throws(()=>buildReportPdfInput(tooMany),/One to six/);
});


test('four through six distinct findings render and verify in English, Spanish and German, without padding',()=>{
  for(const locale of ['en','es','de']) for(const count of [4,5,6]) {
    const decision=fixture(locale); decision.findings=decision.findings.slice(0,count);
    for(const build of [buildReportPdfInput,buildCustomerReportPdfInput]) {
      const input=build(decision), bytes=renderCustomerPdf(input);
      assert.equal(input.findings.length,count);
      assert.equal(verifyRenderedPdf(input,bytes).findings,count);
      assert.doesNotMatch(input.nextStep,/quote|pricing|fixed.price|precio|preço|Festpreis/i);
    }
  }
  const seven=fixture();seven.findings.push({...seven.findings[0],id:'f'.repeat(24)});
  assert.throws(()=>buildReportPdfInput(seven),/One to six/);
});
