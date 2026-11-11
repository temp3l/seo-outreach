import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { customerPriorityObservation, customerPriorityProjection } from '../dist/reports/customer.js';

const at = '2026-10-29T00:00:00.000Z';
const page = path => `https://fixture.example${path}`;
const evidence = (path, extra = {}) => ({ pageUrl: page(path), source: 'http', observedAt: at, ...extra });

function legacyOrderedFindings(findings) {
  return findings.map(finding => ({
    ...finding,
    evidence: finding.code === 'image_file_too_large' && finding.evidence.length
      ? [finding.evidence[0], ...finding.evidence.slice(1).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
      : [...finding.evidence].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function makeAudit() {
  const { audit } = createEvidenceFixture(1);
  const paths = ['/courses/a/', '/courses/b/', '/assets/a.png'];
  audit.coverage.urls = [
    { url: audit.target, outcome: 'captured', statusCode: 200 },
    ...paths.map(path => ({ url: page(path), outcome: 'captured', statusCode: 200 })),
  ];
  return audit;
}

test('projection preserves the legacy JSON ordering and image asset evidence stays first', () => {
  const audit = makeAudit();
  const image = {
    code: 'image_file_too_large', category: 'performance', observed: 'Large image',
    evidence: [
      evidence('/assets/a.png', { value: 500_000 }),
      evidence('/courses/b/', { value: 500_000, excerpt: page('/assets/a.png') }),
      evidence('/courses/a/', { value: 500_000, excerpt: page('/assets/a.png') }),
    ],
  };
  const findings = [
    { code: 'missing_meta_description', category: 'metadata', observed: 'zeta', evidence: [evidence('/courses/b/'), evidence('/courses/a/')] },
    image,
    { code: 'missing_meta_description', category: 'metadata', observed: 'alpha', evidence: [evidence('/courses/a/'), evidence('/courses/b/')] },
  ];
  audit.findings = structuredClone(findings);
  const original = structuredClone(audit);

  const projection = customerPriorityProjection(audit);

  assert.deepEqual(projection.customerFindings, legacyOrderedFindings(findings));
  assert.deepEqual(audit, original, 'projection leaves the saved audit unchanged');
  assert.equal(projection.deduplicatedIssues, 3);
});

test('priority observation preserves timestamp direction, stable JSON ties, and leaves findings unchanged', () => {
  const audit = makeAudit();
  const findings = [
    { code: 'missing_meta_description', category: 'metadata', observed: 'zeta', evidence: [evidence('/courses/a/', { value: 2 })] },
    { code: 'missing_meta_description', category: 'metadata', observed: 'alpha', evidence: [evidence('/courses/a/', { value: 1 })] },
    { code: 'missing_meta_description', category: 'metadata', observed: 'same-key', evidence: [evidence('/courses/a/', { value: 4 })] },
  ];
  const original = structuredClone(findings);
  const candidates = findings.flatMap(finding => finding.evidence.map(item => ({ finding, evidence: item })));
  const expected = [...candidates].sort((a, b) => Date.parse(a.evidence.observedAt) - Date.parse(b.evidence.observedAt)
    || JSON.stringify(a).localeCompare(JSON.stringify(b)))[0];
  const topic = { code: 'missing_meta_description', urls: [{ identity: page('/courses/a/') }] };

  const selected = customerPriorityObservation(findings, topic);
  assert.deepEqual(selected, expected);
  assert.strictEqual(selected.finding, expected.finding);
  assert.deepEqual(findings, original, 'observation selection leaves findings unchanged');

  const duplicate = findings[0];
  const duplicateCopy = structuredClone(duplicate);
  const tied = customerPriorityObservation([duplicate, duplicateCopy], topic);
  assert.strictEqual(tied.finding, duplicate, 'equal JSON keys retain original stable order');

  const performanceFindings = [
    { code: 'pagespeed_category_score', category: 'performance', observed: 'performance score: 40/100', evidence: [evidence('/courses/a/', { observedAt: '2026-10-29T00:00:00.000Z', value: 40, source: 'pagespeed' })] },
    { code: 'pagespeed_category_score', category: 'performance', observed: 'performance score: 80/100', evidence: [evidence('/courses/a/', { observedAt: '2026-10-30T00:00:00.000Z', value: 80, source: 'pagespeed' })] },
  ];
  const measurementTopic = { code: 'pagespeed_category_score', measurement: 'performance', urls: [{ identity: page('/courses/a/') }] };
  assert.strictEqual(customerPriorityObservation(performanceFindings, measurementTopic).finding, performanceFindings[1]);
});

test('observation selection avoids JSON serialization when candidate timestamps differ', () => {
  const findings = [
    { code: 'missing_meta_description', category: 'metadata', observed: 'newer', evidence: [evidence('/courses/a/', { observedAt: '2026-10-30T00:00:00.000Z' })] },
    { code: 'missing_meta_description', category: 'metadata', observed: 'older', evidence: [evidence('/courses/a/', { observedAt: '2026-10-29T00:00:00.000Z' })] },
  ];
  const topic = { code: 'missing_meta_description', urls: [{ identity: page('/courses/a/') }] };
  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = function (...args) {
    stringifyCalls++;
    return originalStringify.apply(this, args);
  };
  let selected;
  try {
    selected = customerPriorityObservation(findings, topic);
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.strictEqual(selected.finding, findings[1]);
  assert.equal(stringifyCalls, 0);
});

test('projection serializes sort keys linearly rather than inside comparison calls', () => {
  const audit = makeAudit();
  const paths = ['/courses/a/', '/courses/b/'];
  audit.findings = Array.from({ length: 100 }, (_, index) => ({
    code: 'missing_meta_description', category: 'metadata', observed: `finding-${String(index).padStart(3, '0')}`,
    evidence: paths.map(path => evidence(path, { value: index })).reverse(),
  }));

  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = function (...args) {
    stringifyCalls++;
    return originalStringify.apply(this, args);
  };
  try {
    customerPriorityProjection(audit);
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.ok(stringifyCalls < 900, `expected precomputed sort keys; observed ${stringifyCalls} JSON serializations`);
});
