import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDrafts } from '../dist/drafts.js';

const sample = (overrides = {}) => ({
  company: 'Blue Bay Kite School', locale: 'en', seller: {name:'Alex',location:'Tarifa'}, reportAvailable:false,
  finding: {code:'missing_title',observed:'The lesson page has no page title.',reference:'/lessons',implication:'People comparing lesson options may have less context.',fix:'write a descriptive page title'},
  ...overrides
});

test('creates unsent, permission-based drafts and fixed status/length metadata', () => {
  const d = buildDrafts(sample());
  assert.equal(d.status, 'READY_FOR_REVIEW'); assert.deepEqual(d.holdReasons, []);
  assert.ok(d.opener.includes('Alex, and I’m based in Tarifa')); assert.ok(d.opener.includes('no page title'));
  assert.match(d.opener, /May I share the notes\?/);
  assert.ok(d.opener.length <= 450); assert.ok(d.afterInterest.length <= 700);
  assert.match(d.afterInterest, /small, fixed-scope implementation/);
  assert.equal(d.limits.openerMaxChars, 450);
});

test('missing seller identity uses natural placeholders and HOLD outside message text in every locale', () => {
  const identityText={en:'[YOUR NAME]',es:'[YOUR NAME]',de:'[YOUR NAME]','pt-BR':'[YOUR NAME]'};
  for(const [locale,phrase] of Object.entries(identityText)) {
    const d = buildDrafts(sample({seller:null,locale}));
    assert.equal(d.status, 'HOLD'); assert.equal(d.holdReasons.length, 1);
    assert.ok(d.opener.includes(phrase),`${locale} placeholder identity missing`);
    assert.ok(!d.opener.includes('HOLD'));
  }
});

test('report availability controls whether copy offers a PDF or only observations', () => {
  const unavailable=buildDrafts(sample());
  assert.ok(unavailable.opener.includes('May I share the notes?'));
  assert.ok(unavailable.afterInterest.includes('I can share the observed details and source page references here'));
  assert.ok(!unavailable.afterInterest.includes('Here is the reviewed report'));
  const available=buildDrafts(sample({reportAvailable:true}));
  assert.ok(available.opener.includes('send the reviewed report'));
  assert.ok(available.afterInterest.includes('Here is the reviewed report'));
});

test('uses compact hostname fallback for hashed references without truncating Decision copy', () => {
  const x=sample({company:'blue.example',finding:{...sample().finding,observed:'The captured page had no meta description.',reference:`blue.example — page_${'a'.repeat(64)}`,implication:'Search engines may choose their own snippet, which can make the page less clear in search results.'}});
  const d=buildDrafts(x);
  assert.equal(d.status,'READY_FOR_REVIEW'); assert.ok(d.opener.length<=450);
  assert.ok(d.opener.includes('blue.example')); assert.ok(!d.opener.includes('page_'));
  assert.equal(d.reviewNotes.reference,x.finding.reference);
  assert.ok(d.opener.includes('The captured page had no meta description. Search engines may choose their own snippet'));
  assert.ok(!/\.\s*\./.test(d.opener));
});

test('uses localized fixed templates in all supported locales', () => {
  const expected={es:['¿Le comparto las notas?','Alex y estoy en Tarifa'],de:['Soll ich die Notizen teilen?','Mein Standort ist Tarifa'],'pt-BR':['Posso compartilhar as notas?','Alex e estou em Tarifa']};
  for (const [locale,[ask,locationPhrase]] of Object.entries(expected)) {
    const d = buildDrafts(sample({locale})); assert.ok(d.opener.includes(ask)); assert.ok(d.opener.includes(locationPhrase)); assert.ok(d.afterInterest.length <= 700);
    assert.ok(!d.opener.includes('aus Tarifa')); assert.ok(!d.opener.includes('de Tarifa'));
  }
});

test('rejects unsafe, oversized, contact-bearing, or unknown fields', () => {
  assert.throws(() => buildDrafts(sample({company:'<script>x</script>'})), /markup/);
  assert.throws(() => buildDrafts(sample({company:'owner@example.com'})), /contact/);
  assert.throws(() => buildDrafts(sample({locale:'fr'})), /locale/);
  assert.throws(() => buildDrafts({...sample(), extra:true}), /unexpected/);
  assert.throws(() => buildDrafts(sample({finding:{...sample().finding, observed:'x'.repeat(601)}})), /600 characters/);
});


test('seller name and email work without a location or invented location placeholder',()=>{
 for(const locale of ['en','es','de','pt-BR']){
  const d=buildDrafts(sample({locale,seller:{name:'Alex',email:'alex@example.com'}}));
  assert.equal(d.status,'READY_FOR_REVIEW');assert.match(d.opener,/Alex/);
  assert.doesNotMatch(d.opener,/YOUR LOCATION|based in|estoy en|Standort|estou em/);
 }
});
