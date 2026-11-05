import assert from 'node:assert/strict';
import test from 'node:test';
import { findBrokenInternalLinks } from '@spora/webcrawl/analysis/link-health';
import { renderWhatsAppDraft } from '../dist/reports/whatsapp-draft.js';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { auditWebsite } from '@spora/webcrawl/core/audit';

function auditWithCoverage() {
  const { audit } = createEvidenceFixture(1);
  audit.startedAt = new Date(Date.now() - 120_000).toISOString();
  audit.completedAt = new Date(Date.now() - 30_000).toISOString();
  return audit;
}

test('a crawler-produced homepage alias cannot suppress the captured homepage observation', async () => {
  const target = 'https://fixture.test/';
  const audit = await auditWebsite({
    startUrl: target, pagespeed: false, contacts: false, technology: false, renderBrowser: false,
    policy: { allowedHosts: ['fixture.test'], maxPages: 10, maxRequests: 30, maxRuntimeMs: 10000, maxResponseBytes: 100000, maxTotalResponseBytes: 1000000, minRequestIntervalMs: 0, maxConcurrency: 1, maxRetries: 0, maxImageChecks: 0 },
    resolveAddresses: async () => ['93.184.216.34'],
    request: async url => url.pathname === '/robots.txt'
      ? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') }
      : url.pathname === '/alias'
        ? { status: 302, headers: { location: target }, body: Buffer.from('') }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><title>Site</title></head><body><h1>Site</h1><a href="/alias">Home alias</a></body></html>') },
  });
  assert.ok(audit.coverage.urls.some(row => row.url === target && row.outcome === 'captured'));
  assert.ok(audit.coverage.urls.some(row => row.reason === 'duplicate_final_url'));
  const draft = renderWhatsAppDraft(audit);
  assert.doesNotMatch(draft, /REVIEW_REQUIRED/u);
  assert.match(draft, /no meta description was recorded/u);
  assert.match(draft, /Outbound approval:\*\* false/u);
});

test('draft from findBrokenInternalLinks names captured source and confirmed relative destination, with no query values', () => {
  const audit = auditWithCoverage();
  const source = 'https://fixture.example/courses?campaign=PRIVATE_SOURCE';
  const destination = 'https://fixture.example/missing?token=PRIVATE_DESTINATION';
  audit.coverage.urls = [
    ...audit.coverage.urls,
    { url: source, outcome: 'captured', statusCode: 200 },
    { url: destination, outcome: 'captured', statusCode: 404 },
  ];
  const finding = findBrokenInternalLinks(new Map([[destination, new Set([source])]]), new Map([[destination, 404]]), audit.completedAt,
    new Map([[destination, [{ pageUrl: source, href: '../missing?token=PRIVATE_DESTINATION', anchorText: 'Course details' }]]]),
    new Map([[destination, { url: destination, outcome: 'captured', statusCode: 404, finalUrl: destination }]]))[0];
  assert.equal(finding.evidence[0].pageUrl, destination, 'producer stores destination evidence first');
  audit.findings = [finding];
  const draft = renderWhatsAppDraft(audit);
  assert.match(draft, /exact destination is withheld for query privacy/u);
  assert.doesNotMatch(draft, /linked to https:\/\/fixture\.example\/missing/u);
  assert.doesNotMatch(draft, /your team|team to review/iu);
  assert.match(draft, new RegExp(`recorded ${audit.completedAt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.doesNotMatch(draft, /PRIVATE_SOURCE|PRIVATE_DESTINATION|campaign=|token=/u);
  assert.match(draft, /recipient_review_required:\*\* true/u); assert.match(draft, /selected_send_target:\*\* null/u); assert.match(draft, /Outbound approval:\*\* false/u);
});

test('unconfirmed, stale or out-of-scope broken links produce REVIEW_REQUIRED, never invented copy', () => {
  const audit = auditWithCoverage();
  const source = 'https://fixture.example/courses'; const destination = 'https://fixture.example/missing';
  audit.coverage.urls.push({ url: source, outcome: 'captured', statusCode: 200 });
  const finding = findBrokenInternalLinks(new Map([[destination, new Set([source])]]), new Map([[destination, 404]]), audit.completedAt,
    new Map([[destination, [{ pageUrl: source, href: '/missing', anchorText: 'Missing course' }]]]),
    new Map([[destination, { url: destination, outcome: 'captured', statusCode: 404 }]]))[0];
  audit.findings = [{ ...finding, evidence: finding.evidence.filter(item => item.anchorHref) }];
  assert.match(renderWhatsAppDraft(audit), /REVIEW_REQUIRED/u);
  audit.findings = [{ ...finding, evidence: finding.evidence.map(item => ({ ...item, observedAt: '2020-01-01T00:00:00.000Z' })) }];
  assert.match(renderWhatsAppDraft(audit), /REVIEW_REQUIRED/u);
  audit.findings = [{ ...finding, evidence: finding.evidence.map(item => item.anchorHref ? { ...item, anchorHref: 'https://other-business.example/missing' } : item) }];
  assert.match(renderWhatsAppDraft(audit), /REVIEW_REQUIRED/u);
});
