import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { customerReviewTemplate, validateCustomerReview } from '../dist/customer-review.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const context = () => ({
  company: 'example.test',
  analysisSha256: hash('analysis'),
  reportPdfSha256: hash('report'),
  findings: [
    'missing_meta_description', 'missing_title', 'missing_h1', 'missing_canonical',
    'noindex', 'image_alt_missing_or_empty',
  ].map((code, i) => ({
    id: (i + 1).toString(16).padStart(24, '0'), code,
    reference: `https://example.test/page-${i + 1}`,
    observed: 'bounded finding', implication: 'bounded impact', fix: 'bounded fix',
  })),
});
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const approved = ctx => {
  const value = structuredClone(customerReviewTemplate(ctx));
  value.coverageReviewed = true;
  value.findings = value.findings.map(item => ({ ...item, approved: true,
    indexingIntended: ctx.findings.find(f => f.id === item.issueId).code === 'noindex' ? true : null,
  }));
  return value;
};

test('template is bounded, explicit, and non-authoritative', () => {
  const ctx = context();
  const value = customerReviewTemplate(ctx);
  assert.equal(value.schema, 'seo-outreach-customer-review-v1');
  assert.equal(value.analysisSha256, ctx.analysisSha256);
  assert.equal(value.reportPdfSha256, ctx.reportPdfSha256);
  assert.equal(value.coverageReviewed, false);
  assert.equal(value.findings.length, 6);
  assert.ok(value.findings.every(f => f.approved === false && f.indexingIntended === null));
  assert.equal(value.findings[0].code, ctx.findings[0].code);
  assert.equal(value.findings[0].observed, ctx.findings[0].observed);
  assert.deepEqual(Object.keys(value.findings[0]), ['issueId', 'code', 'observed', 'reference', 'approved', 'indexingIntended']);
  assert.deepEqual(Object.keys(value), ['schema', 'analysisSha256', 'reportPdfSha256', 'coverageReviewed', 'findings']);
});

test('accepts exact six per-finding approvals and returns hash-only receipt', () => {
  const ctx = context();
  const bytes = encode(approved(ctx));
  const receipt = validateCustomerReview(bytes, ctx);
  assert.deepEqual(receipt, { sha256: hash(bytes), approvedFindings: 6 });
  assert.deepEqual(Object.keys(receipt), ['sha256', 'approvedFindings']);
});

test('rejects mismatched artifact hashes, IDs, references, and duplicate selections', () => {
  const ctx = context();
  for (const mutate of [
    v => { v.analysisSha256 = hash('different'); },
    v => { v.reportPdfSha256 = hash('different'); },
    v => { v.findings[0].issueId = 'f'.repeat(24); },
    v => { v.findings[0].code = 'missing_h1'; },
    v => { v.findings[0].observed = 'operator supplied new text'; },
    v => { v.findings[0].reference = 'https://example.test/other'; },
    v => { v.findings[1].issueId = v.findings[0].issueId; },
  ]) {
    const v = approved(ctx); mutate(v);
    assert.throws(() => validateCustomerReview(encode(v), ctx), /customer_review_(?:invalid|mismatch)/);
  }
});

test('requires coverage review and explicit approved disposition for every finding', () => {
  const ctx = context();
  for (const mutate of [
    v => { v.coverageReviewed = false; },
    v => { v.findings.pop(); },
    v => { v.findings[2].approved = false; },
    v => { v.findings.push({ ...v.findings[0] }); },
    v => { v.reviewer = 'invented identity'; },
  ]) {
    const v = approved(ctx); mutate(v);
    assert.throws(() => validateCustomerReview(encode(v), ctx), /customer_review_(?:invalid|mismatch)/);
  }
});

test('noindex requires affirmative indexing intent; other findings require null', () => {
  const ctx = context();
  for (const value of [null, false]) {
    const v = approved(ctx); v.findings.find(f => ctx.findings.find(g => g.id === f.issueId).code === 'noindex').indexingIntended = value;
    assert.throws(() => validateCustomerReview(encode(v), ctx), /customer_review_mismatch/);
  }
  const wrong = approved(ctx); wrong.findings[0].indexingIntended = true;
  assert.throws(() => validateCustomerReview(encode(wrong), ctx), /customer_review_mismatch/);
});

test('rejects oversized input, unsafe context references, duplicate roots, and malformed JSON', () => {
  const ctx = context();
  assert.throws(() => validateCustomerReview(new Uint8Array(16 * 1024 + 1), ctx), /customer_review_invalid/);
  assert.throws(() => validateCustomerReview(encode(approved(ctx)).subarray(0, 4), ctx), /customer_review_invalid/);
  const unsafe = context(); unsafe.findings[0].reference = 'https://other.test/page';
  assert.throws(() => customerReviewTemplate(unsafe), /customer_review_invalid/);
  const duplicateRoot = context(); duplicateRoot.findings[1].code = duplicateRoot.findings[0].code;
  assert.throws(() => customerReviewTemplate(duplicateRoot), /customer_review_invalid/);
});

test('short reports require exactly their selected findings and exact hashes',()=>{
 for(const count of [1,2,3,4,5]){
  const ctx=context();ctx.findings=ctx.findings.slice(0,count);
  const review=approved(ctx),bytes=encode(review);
  assert.equal(validateCustomerReview(bytes,ctx).approvedFindings,count);
  const omitted=structuredClone(review);omitted.findings.pop();
  assert.throws(()=>validateCustomerReview(encode(omitted),ctx),/customer_review_(?:invalid|mismatch)/);
  const stale=structuredClone(review);stale.reportPdfSha256=hash('other-report');
  assert.throws(()=>validateCustomerReview(encode(stale),ctx),/customer_review_mismatch/);
 }
 const empty=context();empty.findings=[];assert.throws(()=>customerReviewTemplate(empty),/customer_review_invalid/);
 const long=context();long.findings.push({...long.findings[0],id:'f'.repeat(24)});assert.throws(()=>customerReviewTemplate(long),/customer_review_invalid/);
});
