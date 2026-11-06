import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextForCompany, validateOutreachContext, reviewGeneratedDrafts, BUYER_ROLES, BUSINESS_TYPES } from '../dist/outreach.js';
import { buildDrafts } from '../dist/drafts.js';
import { loadEvidenceArchive } from '../dist/archive.js';
import { findingWording, qualifiedDigest, validateSelection } from '../dist/decision.js';
import { analyze, render, batch } from '../dist/pipeline.js';
import { liveSettingsFingerprint } from '../dist/live.js';
import { parseArgs } from '../dist/cli.js';
import { sampleFile } from './fixtures/data.mjs';

const seller = { name: 'Alex', location: 'Tarifa' };
const archive = sampleFile('site-05.zip');
const fixture = async (count = 6, locale = 'en') => {
  const { evidence, pages } = await loadEvidenceArchive(archive);
  const digest = qualifiedDigest(evidence, pages), seen = new Set();
  const ids = [...digest.issues].sort((a,b) => Number(a.code === 'noindex') - Number(b.code === 'noindex')).filter(i => {
    if (!findingWording(i.code, locale) || seen.has(i.code)) return false;
    seen.add(i.code); return true;
  }).slice(0, count).map(i => i.id);
  assert.equal(ids.length, count);
  const decision = validateSelection(evidence, pages, ids, locale);
  const first = decision.findings.find(f => f.code !== 'noindex' && /^https?:/.test(f.reference));
  assert.ok(first);
  const output = {
    selectedIssueIds: ids,
    opportunities: [{ title: 'Page clarity', issueIds: [first.id], rationale: 'Review the recorded observation.' }],
    salesAngle: { text: 'Discuss the selected findings.', issueIds: [first.id] },
    businessContext: [], buyerRoleHypothesis: 'Unknown', locale,
    findings: decision.findings.map(f => ({ issueId: f.id, implication: f.implication, proposedFix: f.fix })),
    whatsappOpener: `Hello, I’m Alex. On ${first.reference}: ${first.observed} Would discussing this be helpful?`,
    afterInterestReply: 'Thanks for your interest. Would discussing implementation of the first two findings be useful?',
    salesBrief: 'Discuss the recorded page observations and practical next steps.',
    uncertainties: ['Business outcomes and recipient role are unknown.'],
  };
  return { evidence, digest, decision, first, output };
};
const temporary = async fn => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-outreach-enhanced-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('business and buying-role context is explicit, bounded, and selected by exact hostname', () => {
  for (const buyerRole of BUYER_ROLES) for (const businessType of BUSINESS_TYPES) {
    assert.deepEqual(validateOutreachContext({ buyerRole, businessType }), { buyerRole, businessType });
  }
  const contexts = { 'one.example': { buyerRole: 'owner', businessType: 'booking_business', businessName: 'One', services: ['Lessons'] } };
  assert.equal(contextForCompany(contexts, 'one.example').businessName, 'One');
  assert.deepEqual(contextForCompany(contexts, 'other.example'), { buyerRole: 'unknown', businessType: 'unknown' });
  for (const value of [{ buyerRole: 'invented' }, { businessType: 'invented' }, { businessName: 'x'.repeat(121) }, { businessName: 'person@example.com' }, { services: Array(6).fill('service') }, { secret: 'hidden' }]) {
    assert.throws(() => validateOutreachContext(value), /invalid_outreach_context/);
  }
  assert.throws(() => contextForCompany({ 'https://one.example': {} }, 'one.example'), /invalid_outreach_context/);
});

test('CLI passes context and seller identity for individual and batch runs, while render stays offline', () => {
  for (const argv of [['analyze', '--input', 'site.zip'], ['batch', '--manifest', 'sites.json']]) {
    const parsed = parseArgs([...argv, '--out', 'out', '--outreach-context', 'context.json', '--seller-name', 'Alex', '--seller-location', 'Tarifa']);
    assert.equal(parsed.outreachContext, 'context.json'); assert.equal(parsed.sellerName, 'Alex');
    assert.equal(parseArgs([...argv,'--out','out','--seller-name','Alex']).sellerName,'Alex');
  }
  assert.throws(() => parseArgs(['render', '--analysis', 'analysis.json', '--out', 'out', '--outreach-context', 'context.json']), /unknown_or_inapplicable_flag/);
});

test('generated copy uses a traced observation and falls back for unsafe, unsupported, quoted or oversized copy', async () => {
  const { output, decision, first } = await fixture();
  const { id, ...finding } = first;
  const fallback = buildDrafts({ company: decision.company, seller, locale: 'en', finding, reportAvailable: false });
  const review = value => reviewGeneratedDrafts(value, decision.findings, seller, fallback, 'en');
  assert.equal(review(output).source, 'LLM');
  assert.equal(review(output).status, 'REQUIRES_HUMAN_REVIEW');
  assert.equal(review(output).drafts.opener, output.whatsappOpener);
  for (const change of [
    { whatsappOpener: 'A generic note from Alex.' },
    { whatsappOpener: output.whatsappOpener.replace(first.observed, 'You are losing traffic.') },
    { afterInterestReply: 'See https://other.example/ for help.' },
    { afterInterestReply: 'I guarantee first place.' },
    { afterInterestReply: 'The report is attached.' },
    { afterInterestReply: 'Would you like a fixed-price quote?' },
    { afterInterestReply: 'Would you like pricing?' },
    { afterInterestReply: 'Posso enviar um orçamento?' },
    { afterInterestReply: '¿Quieres un presupuesto?' },
    { afterInterestReply: 'Möchten Sie ein Angebot?' },
    { afterInterestReply: 'Call person@example.com.' },
    { afterInterestReply: '<script>bad()</script>' },
    { whatsappOpener: output.whatsappOpener + 'x'.repeat(451) },
  ]) {
    const result = review({ ...output, ...change });
    assert.equal(result.source, 'TEMPLATE', JSON.stringify(change));
    assert.equal(result.drafts.opener, fallback.opener);
    assert.ok(result.reasons.length);
  }
  assert.equal(reviewGeneratedDrafts(output, decision.findings, null, fallback, 'en').source, 'TEMPLATE');
});

test('internal reports permit one to six findings and retain generated drafts without a customer-design bypass', async () => temporary(async dir => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected_network'); };
  try {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const { output, evidence } = await fixture(count);
      const recorded = join(dir, `recorded-${count}.json`), context = join(dir, `context-${count}.json`);
      await writeFile(recorded, JSON.stringify(output));
      await writeFile(context, JSON.stringify({ [evidence.hostname]: { buyerRole: 'owner', businessType: 'booking_business' } }));
      const out = join(dir, `analyze-${count}`);
      await analyze({ input: archive, out, locale: 'en', recorded, outreachContext: context, sellerName: seller.name, sellerLocation: seller.location, dryRun: false });
      const saved = JSON.parse(await readFile(join(out, 'outreach-review.json'), 'utf8'));
      assert.equal(saved.source, 'LLM'); assert.equal(saved.status, 'INTERNAL_HOLD'); assert.equal(saved.attachment, null); assert.equal(saved.attachmentDetails, null); assert.equal(saved.attachmentMode, 'AUTOMATIC_ON_APPROVED_DOCUMENT_SEND');
      assert.equal(saved.context.buyerRole, 'owner');
      const template = JSON.parse(await readFile(join(out, 'customer-review.json'), 'utf8'));
      assert.equal(template.findings.length, count);
      template.coverageReviewed = true;
      for (const f of template.findings) { f.approved = true; f.indexingIntended = f.code === 'noindex' ? true : null; }
      const approval = join(dir, `approval-${count}.json`); await writeFile(approval, JSON.stringify(template));
      const released = join(dir, `released-${count}`);
      await assert.rejects(render({analysis:join(out,'analysis.json'),out:released,customerReview:approval,dryRun:false}),/customer_pdf_requires_frozen_design/);
      const result = await render({ analysis: join(out, 'analysis.json'), out: released, dryRun: false });
      assert.equal(result.gates.CUSTOMER_READY.status, 'HOLD'); assert.equal(result.gates.OUTREACH_READY.status, 'HOLD');
      const manifest = JSON.parse(await readFile(join(released, 'manifest.json'), 'utf8'));
      assert.equal(manifest.pdfVerification.findings,count);assert.equal(manifest.customerReview,null);assert.equal(manifest.customerPdfVerification,null);
      const rerendered = JSON.parse(await readFile(join(released, 'outreach-review.json'), 'utf8'));
      assert.equal(rerendered.source, 'LLM'); assert.equal(rerendered.attachment,null);
      await assert.rejects(access(join(released,'customer-report.pdf')));assert.equal(rerendered.attachmentDetails,null);
      assert.equal(rerendered.attachmentMode,'AUTOMATIC_ON_APPROVED_DOCUMENT_SEND');
      assert.equal(rerendered.manualAttachmentRequired,undefined);
      assert.equal(await readFile(join(out, 'whatsapp-opener.txt'), 'utf8'), await readFile(join(released, 'whatsapp-opener.txt'), 'utf8'));
      const unapproved = join(dir, `unapproved-${count}`);
      await render({ analysis: join(released, 'analysis.json'), out: unapproved, dryRun: false });
      await assert.rejects(access(join(unapproved, 'customer-report.pdf')));
      const held=JSON.parse(await readFile(join(unapproved,'outreach-review.json'),'utf8'));assert.equal(held.attachment,null);assert.equal(held.attachmentDetails,null);
    }
  } finally { globalThis.fetch = original; }
}));

test('one live request produces drafts; identical context is cached, changed role changes cache identity', async () => temporary(async dir => {
  const { output, evidence } = await fixture(4);
  const contextFile = join(dir, 'context.json'), configFile = join(dir, 'config.json');
  const config = { model: 'test-model', timeoutMs: 5000, maxInputTokens: 32000, maxOutputTokens: 3000, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, companyRequestCap: 3, companyTokenCap: 100000, companyUsdCap: 1, batchRequestCap: 3, batchTokenCap: 100000, batchUsdCap: 1, pricingConfirmedAt: new Date().toISOString(), pricingSource: 'https://developers.openai.com/api/docs/pricing', maxAttempts: 1, overallDeadlineMs: 15000, maxRetryAfterMs: 0 };
  await writeFile(configFile, JSON.stringify(config));
  const context = { buyerRole: 'owner', businessType: 'booking_business', businessName: 'Example School', services: ['Lessons'] };
  await writeFile(contextFile, JSON.stringify({ [evidence.hostname]: context }));
  const oldFetch = globalThis.fetch, oldKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  process.env.OPENAI_API_KEY = 'test-only';
  globalThis.fetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(JSON.parse(init.body).input[0].content[0].text);
    assert.equal(prompt.context.business.businessName, 'Example School');
    assert.equal(prompt.context.seller.name, 'Alex');
    assert.match(prompt.instruction, /Do not propose prices, quotes/);
    assert.match(prompt.instruction, /sender automatically attaches the approved PDF/);
    assert.doesNotMatch(prompt.instruction, /manual attachment/i);
    assert.match(prompt.instruction, /marketing managers/);
    assert.match(prompt.instruction, /general inboxes/);
    return new Response(JSON.stringify({ id: `resp_${calls}`, status: 'completed', output_text: JSON.stringify(output), usage: { input_tokens: 2000, output_tokens: 900 } }), { status: 200 });
  };
  try {
    const live = { paidCallOptIn: true, configPath: configFile, statePath: join(dir, 'state.json'), batchId: 'test' };
    const options = { input: archive, locale: 'en', outreachContext: contextFile, sellerName: seller.name, sellerLocation: seller.location, dryRun: false, live };
    const first = await analyze({ ...options, out: join(dir, 'first') });
    assert.equal(first.provider.status, 'COMPLETED'); assert.equal(calls, 1);
    const second = await analyze({ ...options, out: join(dir, 'second') });
    assert.equal(second.provider.status, 'CACHED'); assert.equal(calls, 1);
    const fingerprint = salesContext => liveSettingsFingerprint({ ...config, endpoint: 'https://api.openai.com/v1/responses', salesContext });
    const one = { business: context, seller };
    assert.notEqual(fingerprint(one), fingerprint({ ...one, business: { ...context, buyerRole: 'marketing_manager' } }));
    assert.notEqual(fingerprint(one), fingerprint({ ...one, seller: { ...seller, name: 'Other' } }));
    await render({ analysis: join(dir, 'first', 'analysis.json'), out: join(dir, 'render'), dryRun: false });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
}));

test('batch keeps hostname-specific context and seller in its published analysis', async () => temporary(async dir => {
  const { evidence } = await fixture(4);
  const manifest = join(dir, 'batch.json'), contextFile = join(dir, 'contexts.json');
  await writeFile(manifest, JSON.stringify({ inputs: [archive] }));
  await writeFile(contextFile, JSON.stringify({ [evidence.hostname]: { buyerRole: 'general_inbox', businessType: 'local_service' } }));
  const result = await batch({ manifest, out: join(dir, 'batch'), locale: 'en', outreachContext: contextFile, sellerName: seller.name, sellerLocation: seller.location, dryRun: false });
  const analysis = JSON.parse(await readFile(join(result.results[0].directory, 'analysis.json'), 'utf8'));
  assert.equal(analysis.seller.name, seller.name); assert.equal(analysis.outreach.context.buyerRole, 'general_inbox');
}));

test('unknown context remains portable and keeps its exact analysis hash during internal replay', async () => temporary(async dir => {
  const contexts = join(dir, 'contexts.json');
  await writeFile(contexts, '{}');
  const out = join(dir, 'first');
  await analyze({ input: archive, out, locale: 'en', outreachContext: contexts, dryRun: false });
  const analysis = await readFile(join(out, 'analysis.json'), 'utf8');
  assert.deepEqual(JSON.parse(analysis).outreach.context, { buyerRole: 'unknown', businessType: 'unknown' });
  await rm(contexts);
  const review = JSON.parse(await readFile(join(out, 'customer-review.json'), 'utf8'));
  review.coverageReviewed = true;
  for (const f of review.findings) { f.approved = true; f.indexingIntended = f.code === 'noindex' ? true : null; }
  const approval = join(dir, 'review.json'); await writeFile(approval, JSON.stringify(review));
  const released = join(dir, 'released');
  await assert.rejects(render({analysis:join(out,'analysis.json'),out:released,customerReview:approval,dryRun:false}),/customer_pdf_requires_frozen_design/);
      const result = await render({ analysis: join(out, 'analysis.json'), out: released, dryRun: false });
  assert.equal(result.gates.CUSTOMER_READY.status, 'HOLD');
  assert.equal(await readFile(join(released, 'analysis.json'), 'utf8'), analysis);
}));
