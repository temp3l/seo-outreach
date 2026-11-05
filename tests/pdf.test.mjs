import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCustomerPdf } from '../dist/pdf.js';
import { pdfFontTextWidth } from '../dist/pdf-font-metrics.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sample = () => ({
  company: 'Kite School', locale: 'en', opening: 'A short note based on the pages reviewed.',
  opportunities: ['Make lesson information easier to find.'],
  findings: Array.from({length: 6}, (_, i) => ({ id: `f${i+1}`, observed: `Observed issue number ${i+1}`, reference: `Page /lesson-${i+1}`, implication: 'This may make it harder for lesson seekers to understand the offering.', fix: 'Add a clear, specific page description.' })),
  coverage: 'Review covered the supplied pages; other pages may not be represented.', nextStep: 'If useful, we can discuss a small implementation scope.'
});

test('renders six distinct findings to a readable, sequential PDF with extractable text', () => {
  const b = renderCustomerPdf(sample());
  assert.equal(b.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  const d = mkdtempSync(join(tmpdir(), 'seo-pdf-'));
  try {
    const p = join(d, 'report.pdf'); writeFileSync(p, b);
    const info = execFileSync('pdfinfo', [p], {encoding:'utf8'});
    assert.match(info, /Pages:\s+\d+/);
    const text = execFileSync('pdftotext', ['-layout', p, '-'], {encoding:'utf8'});
    assert.ok(text.indexOf('Observed issue number 1') < text.indexOf('Observed issue number 2'));
    for (let i=1;i<=6;i++) assert.ok(text.includes(`Observed issue number ${i}`));
    assert.ok(text.includes('Coverage')); assert.ok(text.includes('Next step'));
  } finally { rmSync(d, {recursive:true, force:true}); }
});

test('rejects missing, repeated, or malformed findings and unknown fields', () => {
  const x = sample(); x.findings.pop(); assert.throws(() => renderCustomerPdf(x), /Exactly six/);
  const y = sample(); y.findings[5].id = y.findings[0].id; assert.throws(() => renderCustomerPdf(y), /distinct/);
  const z = sample(); z.extra = 'unexpected'; assert.throws(() => renderCustomerPdf(z), /Unexpected/);
  assert.throws(() => renderCustomerPdf({...sample(), locale:'fr'}), /locale/);
});

test('escapes PDF syntax and removes contact strings and markup from extracted copy', () => {
  const x = sample(); x.locale = 'es'; x.company = 'ACME (West) \\ <script>alert(1)</script>'; x.opening = 'Email owner@example.com or call +1 (555) 123-4567'; x.findings[0].reference = '/page/202411';
  const b = renderCustomerPdf(x); const d = mkdtempSync(join(tmpdir(), 'seo-pdf-'));
  try {
    const p = join(d, 'report.pdf'); writeFileSync(p, b);
    const text = execFileSync('pdftotext', [p, '-'], {encoding:'utf8'});
    assert.ok(text.includes('ACME (West)'));
    assert.ok(!text.includes('owner@example.com')); assert.ok(!text.includes('555'));
    assert.ok(text.includes('202411')); assert.ok(text.includes('Oportunidades'));
    assert.ok(!text.includes('<script>'));
    assert.ok(readFileSync(p).includes(Buffer.from('%%EOF')));
  } finally { rmSync(d, {recursive:true, force:true}); }
});

test('uses actual WinAnsi Helvetica advances for distinguishing glyphs',()=>{
  assert.equal(pdfFontTextWidth('F',10,false),6.11);
  assert.equal(pdfFontTextWidth('R',10,false),7.22);
  assert.equal(pdfFontTextWidth('T',10,false),6.11);
  assert.equal(pdfFontTextWidth('L',10,false),5.56);
  assert.equal(pdfFontTextWidth('L',10,true),6.11);
  assert.equal(pdfFontTextWidth('é',10,false),5.56);
  assert.equal(pdfFontTextWidth('🪁',10,false),pdfFontTextWidth('?',10,false));
  assert.equal(pdfFontTextWidth('a—b',10,false),pdfFontTextWidth('a-b',10,false));
});

test('wraps upper-case, accented and long source URL text within the phone page width',()=>{
  const x=sample();x.company='FULL FLIGHT KITE SCHOOL';
  x.findings[0].observed='The FULL FLEET took the FAST ROUTE past the cliff.';
  x.findings[0].reference='https://kite.example/FULL-FLEET-TRAINING-FOR-RENTALS-AND-TRIPS/ação-eólica/FLIGHT-ROUTE-REFERENCE-TESTING-2026';
  x.findings[1].observed='A página de TREINAMENTO foi atualizada em português.';
  const b=renderCustomerPdf(x);const d=mkdtempSync(join(tmpdir(),'seo-pdf-metrics-'));
  try {
    const p=join(d,'report.pdf');writeFileSync(p,b);
    const extracted=execFileSync('pdftotext',[p,'-'],{encoding:'utf8'});
    assert.ok(extracted.includes('FULL FLEET'));assert.ok(extracted.includes('ação-eólica'));
    const bbox=execFileSync('pdftotext',['-bbox-layout',p,'-'],{encoding:'utf8'});
    const lines=[...bbox.matchAll(/<line xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)"/g)];
    assert.ok(lines.length>0);for(const [,min,max] of lines){assert.ok(Number(min)>=28-0.1);assert.ok(Number(max)<=332+0.1);}
  } finally {rmSync(d,{recursive:true,force:true});}
});
