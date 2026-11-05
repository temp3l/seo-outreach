import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { auditResultSha256, isCustomerReleaseQualified, isReportableEvidenceAdmissible } from '../dist/reports/qualification.js';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { auditWebsite } from '@spora/webcrawl/core/audit';
import { renderCustomerSummaryHtml } from '../dist/reports/summary.js';
import { renderCustomerPdfPair } from '../dist/reports/publication.js';
import { renderMobileCustomerPdf } from '../dist/reports/mobile.js';
import { renderWhatsAppDraft } from '../dist/reports/whatsapp-draft.js';
import { findBrokenInternalLinks } from '@spora/webcrawl/analysis/link-health';
import { analyzeImageProbe } from '@spora/webcrawl/analysis/image-health';
import { findDuplicateMetadata } from '@spora/webcrawl/analysis/technical';

const issuer = { name: 'Synthetic Reviewer', email: 'reviewer@example.test' };
function fixture() {
  const { audit } = createEvidenceFixture(1);
  audit.startedAt = new Date(Date.now() - 60_000).toISOString();
  audit.completedAt = new Date(Date.now() - 30_000).toISOString();
  audit.coverage.urls[0].url = audit.target;
  audit.coverage.urls[0].finalUrl = audit.target;
  audit.findings = [{ code: 'missing_meta_description', category: 'metadata', observed: 'Missing meta description', evidence: [{ pageUrl: audit.target, source: 'http', observedAt: audit.completedAt }] }];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_meta_description', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  return audit;
}
function qualification(audit, extra = {}) {
  return { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 10_000).toISOString(), qualifiedBy: 'Synthetic responsible reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED', ...extra };
}
function recount(audit) {
  const codes = new Map();
  for (const finding of audit.findings) { const row = codes.get(finding.code) ?? { records: 0, pages: new Set(), evidenceOccurrences: 0 }; row.records++; row.evidenceOccurrences += finding.evidence.length; finding.evidence.forEach(e => row.pages.add(e.pageUrl)); codes.set(finding.code, row); }
  audit.coverage.findings = { records: audit.findings.length, checkCodes: codes.size, affectedPages: new Set(audit.findings.flatMap(f => f.evidence.map(e => e.pageUrl))).size, evidenceOccurrences: audit.findings.reduce((n, f) => n + f.evidence.length, 0), byCheck: [...codes].map(([code, row]) => ({ code, records: row.records, affectedPages: row.pages.size, evidenceOccurrences: row.evidenceOccurrences })) };
}
function updatePageChecks(audit) {
  const rows = audit.coverage.urls;
  const checked = rows.filter(row => row.outcome === 'captured' && row.statusCode < 400).length;
  const failed = rows.filter(row => row.outcome === 'failed').length;
  const skipped = rows.filter(row => row.outcome === 'skipped' || row.outcome === 'captured' && row.statusCode >= 400).length;
  const unattempted = rows.filter(row => row.outcome === 'unattempted').length;
  for (const name of ['securityHeaders', 'mixedContent', 'sensitiveForms', 'cookieAttributes']) {
    Object.assign(audit.coverage.checks[name], { discovered: rows.length, checked, failed, skipped, unattempted, status: checked === rows.length ? 'complete' : 'partial' });
  }
  audit.capabilities.technicalSeo = rows.some(row => row.outcome === 'captured' && row.statusCode >= 400 || row.outcome === 'failed' || row.outcome === 'unattempted') ? 'partial' : 'complete';
}
const decode = bytes => Buffer.from(bytes).toString();

function brokenLinkFixture() {
  const audit = fixture();
  const requested = new URL('/missing?token=ORIGINAL', audit.target).href;
  const final = new URL('/missing-final?token=FINAL', audit.target).href;
  const row = { url: requested, finalUrl: final, redirectChain: [final], outcome: 'captured', statusCode: 404 };
  audit.coverage.urls.push(row);
  audit.crawl.discovered++; audit.crawl.attempted++; audit.crawl.captured++;
  const link = findBrokenInternalLinks(new Map([[requested, new Set([audit.target])]]), new Map([[requested, 404]]), audit.completedAt,
    new Map([[requested, [{ pageUrl: audit.target, href: '/missing?token=ORIGINAL', anchorText: 'Missing' }]]]), new Map([[requested, row]]))[0];
  audit.findings.unshift(link);
  recount(audit);
  updatePageChecks(audit);
  return { audit, link };
}

test('broken-link evidence binds page, final URL, redirect chain and source href to the requested outcome', async () => {
  const valid = brokenLinkFixture();
  assert.ok(isAuditResultRecord(valid.audit));
  assert.equal(isReportableEvidenceAdmissible(valid.audit, valid.link), true);
  assert.match(renderWhatsAppDraft(valid.audit), /returned HTTP 404; its exact destination is withheld/u);
  assert.doesNotMatch(renderWhatsAppDraft(valid.audit), /token=|ORIGINAL|FINAL/u);
  for (const mutate of [
    link => { link.evidence[0].pageUrl = 'https://fixture.example/courses'; link.evidence[0].finalUrl = 'https://fixture.example/courses'; link.evidence[1].anchorHref = '/courses'; },
    link => { link.evidence[0].pageUrl = 'https://fixture.example/uncaptured'; },
    link => { link.evidence[0].finalUrl = 'https://fixture.example/uncaptured'; },
    link => { link.evidence[0].redirectChain = ['https://fixture.example/unrecorded-hop']; },
    link => { link.evidence[1].requestedUrl = 'https://fixture.example/another-request'; },
    link => { link.evidence[0].pageUrl = 'https://fixture.example/missing-final?token=DIFFERENT'; },
  ]) {
    const { audit, link } = brokenLinkFixture(); mutate(link); recount(audit);
    assert.ok(isAuditResultRecord(audit));
    const before = structuredClone(audit);
    assert.equal(isReportableEvidenceAdmissible(audit, link), false);
    const q = qualification(audit);
    assert.equal(isCustomerReleaseQualified(audit, q), false);
    for (const locale of ['en', 'de', 'pt-BR']) {
      const sender = { ...issuer, phone: '+31 20 123 4567' };
      assert.match(renderCustomerSummaryHtml(audit, locale, { issuer: sender, qualification: q }), /data-publication-status="HOLD"/u);
      const mobile = await renderMobileCustomerPdf(audit, async html => Buffer.from(html), sender, locale, 'CLIENT_READY', q);
      assert.match(decode(mobile), /data-publication-status="HOLD"/u);
    }
    assert.doesNotMatch(renderWhatsAppDraft(audit), /returned HTTP 404/u, 'use the valid metadata observation instead');
    audit.findings = [link]; recount(audit);
    assert.match(renderWhatsAppDraft(audit), /REVIEW_REQUIRED/u);
    audit.findings = before.findings; recount(audit);
    assert.deepEqual(audit, before);
  }
});

test('a recorded allowed seed redirect establishes child-page scope without admitting arbitrary subdomains', async () => {
  for (const robotsAvailable of [true, false]) {
    const audit = await auditWebsite({
      startUrl: 'https://fixture.test/', pagespeed: false, contacts: false, technology: false, renderBrowser: false,
      policy: { allowedHosts: ['fixture.test', 'www.fixture.test'], maxPages: 10, maxRequests: 30, maxRuntimeMs: 10000, maxResponseBytes: 100000, maxTotalResponseBytes: 1000000, minRequestIntervalMs: 0, maxConcurrency: 1, maxRetries: 0, maxImageChecks: 0 },
      resolveAddresses: async () => ['93.184.216.34'],
      request: async url => {
        if (url.pathname === '/robots.txt') return { status: robotsAvailable ? 200 : 503, headers: { 'content-type': 'text/plain' }, body: Buffer.from(robotsAvailable ? 'User-agent: *\nAllow: /' : 'Unavailable') };
        if (url.hostname === 'fixture.test') return { status: 301, headers: { location: 'https://www.fixture.test/' }, body: Buffer.alloc(0) };
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html lang="en"><head><title>${url.pathname === '/' ? 'Home' : 'Course'}</title><meta name="description" content="${'A synthetic description for this page. '.repeat(4)}"><link rel="canonical" href="${url.href}"></head><body><main>${url.pathname === '/' ? '<h1>Home</h1><a href="/courses">Courses</a>' : '<p>Course details</p>'}</main></body></html>`) };
      },
    });
    assert.ok(isAuditResultRecord(audit));
    assert.equal(audit.capabilities.technicalSeo, 'complete');
    assert.equal(audit.coverage.checks.sensitiveForms.checked, 2);
    assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), true);
    const original = structuredClone(audit);
    for (const locale of ['en', 'de']) assert.match(renderCustomerSummaryHtml(audit, locale, { issuer, qualification: qualification(audit) }), /data-publication-status="CLIENT_READY"/u);
    for (const mutate of [
      a => { a.crawlSettings.policy.allowedHosts = ['fixture.test']; },
      a => { a.coverage.urls[0].finalUrl = a.target; a.coverage.urls[0].redirectChain = []; },
      a => { a.coverage.urls.push({ url: 'https://other.fixture.test/courses', outcome: 'captured', statusCode: 200 }); a.crawlSettings.policy.allowedHosts.push('other.fixture.test'); a.crawl.discovered++; a.crawl.attempted++; a.crawl.captured++; a.findings.find(f => f.code === 'missing_h1').evidence[0].pageUrl = 'https://other.fixture.test/courses'; recount(a); updatePageChecks(a); },
    ]) {
      const candidate = structuredClone(audit); mutate(candidate);
      assert.ok(isAuditResultRecord(candidate));
      assert.equal(isCustomerReleaseQualified(candidate, qualification(candidate)), false);
    }
    assert.deepEqual(audit, original);
  }
});

test('duplicate-final aliases preserve captured evidence regardless of outcome order', () => {
  for (const reverse of [false, true]) {
    const audit = fixture();
    audit.coverage.urls.push({ url: new URL('/alias', audit.target).href, finalUrl: audit.target, outcome: 'skipped', statusCode: 200, reason: 'duplicate_final_url' });
    audit.crawl.discovered++; audit.crawl.attempted++; audit.crawl.skipped++;
    updatePageChecks(audit);
    if (reverse) audit.coverage.urls.reverse();
    assert.equal(isReportableEvidenceAdmissible(audit, audit.findings[0]), true);
    assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), false, 'duplicate skips retain the existing partial security coverage HOLD');
    assert.doesNotMatch(renderWhatsAppDraft(audit), /REVIEW_REQUIRED/u);

    // The first capture can itself be a redirect; its final URL may later
    // appear as a requested duplicate, without a second HTML inspection.
    const canonical = new URL('/canonical', audit.target).href;
    const redirected = fixture();
    redirected.coverage.urls[0].finalUrl = canonical;
    redirected.coverage.urls.push({ url: canonical, finalUrl: canonical, outcome: 'skipped', statusCode: 200, reason: 'duplicate_final_url' });
    redirected.findings[0].evidence[0].pageUrl = canonical;
    redirected.crawl.discovered++; redirected.crawl.attempted++; redirected.crawl.skipped++;
    updatePageChecks(redirected);
    if (reverse) redirected.coverage.urls.reverse();
    assert.equal(isReportableEvidenceAdmissible(redirected, redirected.findings[0]), true);
    assert.doesNotMatch(renderWhatsAppDraft(redirected), /REVIEW_REQUIRED/u);
  }
  const audit = fixture();
  audit.coverage.urls[0].outcome = 'skipped';
  audit.coverage.urls[0].reason = 'duplicate_final_url';
  audit.crawl.captured = 0; audit.crawl.skipped = 1;
  assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), false, 'a duplicate skip without a captured representation is not evidence');
});

test('one to three supported findings release only through the matching explicit qualification', async () => {
  for (const count of [1, 2, 3]) {
    const audit = fixture();
    audit.findings = [audit.findings[0], ...Array.from({ length: count - 1 }, (_, i) => ({ code: ['missing_canonical', 'missing_h1'][i], category: 'metadata', observed: 'Recorded finding', evidence: [{ pageUrl: audit.target, source: 'http', observedAt: audit.startedAt }] }))];
    recount(audit);
    const approved = qualification(audit);
    assert.equal(isCustomerReleaseQualified(audit, approved), true);
    const direct = renderCustomerSummaryHtml(audit, 'en', { issuer, clientReady: true });
    assert.match(direct, /data-publication-status="HOLD"/u);
    assert.doesNotMatch(direct, /data-publication-status="CLIENT_READY"/u);
    const pair = await renderCustomerPdfPair(audit, async html => Buffer.from(html), issuer, approved);
    assert.equal(pair.status, 'CLIENT_READY');
    assert.equal((decode(pair.en).match(/<article class="card">/gu) ?? []).length, count);
    assert.match(decode(pair.en), /data-publication-status="CLIENT_READY"/u);
    assert.match(decode(pair.de), /data-publication-status="CLIENT_READY"/u);
    let mobileHtml = '';
    await renderMobileCustomerPdf(audit, async html => { mobileHtml = html; return Buffer.from(html); }, issuer, 'en', pair.status, approved);
    assert.match(mobileHtml, /data-publication-status="CLIENT_READY"/u);
  }
});

test('missing, mismatched, stale, partial, identity, and private-security qualifications fail closed', () => {
  const audit = fixture();
  const good = qualification(audit);
  const negatives = [
    undefined,
    { ...good, auditSha256: '0'.repeat(64) },
    { ...good, target: 'https://other.example/' },
    { ...good, businessIdentity: 'UNRESOLVED' },
    { ...good, qualifiedAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString() },
  ];
  for (const value of negatives) assert.equal(isCustomerReleaseQualified(audit, value), false);
  const partial = structuredClone(audit); partial.crawl.unattempted = 1;
  assert.equal(isCustomerReleaseQualified(partial, qualification(partial)), false);
  const privateReview = structuredClone(audit);
  privateReview.findings.push({ code: 'sensitive_form_over_http', category: 'security', observed: 'private', evidence: [{ pageUrl: audit.target, source: 'http', observedAt: audit.startedAt }] });
  assert.equal(isCustomerReleaseQualified(privateReview, qualification(privateReview)), false);
  const stale = structuredClone(audit); stale.startedAt = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  assert.equal(isCustomerReleaseQualified(stale, qualification(stale)), false);
});

test('a valid current finding cannot authorize stale, foreign, uncaptured, or failed-page evidence in EN/DE/PT/mobile', async () => {
  for (const mutate of [
    finding => finding.evidence.push({ pageUrl: 'https://fixture.example/old', source: 'http', observedAt: '2020-01-01T00:00:00.000Z' }),
    finding => finding.evidence.push({ pageUrl: 'https://other-business.example/courses', source: 'http', observedAt: new Date().toISOString() }),
    finding => finding.evidence.push({ pageUrl: 'https://fixture.example/not-captured', source: 'http', observedAt: new Date().toISOString() }),
    finding => { finding.evidence[0].pageUrl = 'https://fixture.example/?secret=private'; },
    finding => { finding.evidence[0].source = 'pagespeed'; },
  ]) {
    const audit = fixture(); mutate(audit.findings[0]); audit.coverage.findings.evidenceOccurrences = audit.findings[0].evidence.length;
    audit.coverage.findings.affectedPages = audit.findings[0].evidence.length;
    audit.coverage.findings.byCheck[0].evidenceOccurrences = audit.findings[0].evidence.length;
    audit.coverage.findings.byCheck[0].affectedPages = audit.findings[0].evidence.length;
    const original = structuredClone(audit);
    const q = qualification(audit);
    assert.equal(isCustomerReleaseQualified(audit, q), false);
    for (const locale of ['en', 'de', 'pt-BR']) {
      assert.match(renderCustomerSummaryHtml(audit, locale, { issuer: { name: 'Synthetic Reviewer', email: 'reviewer@example.test', phone: '+31 20 123 4567' }, qualification: q }), /data-publication-status="HOLD"/u);
      let mobile = '';
      await renderMobileCustomerPdf(audit, async html => { mobile = html; return Buffer.from(html); }, { name: 'Synthetic Reviewer', email: 'reviewer@example.test', phone: '+31 20 123 4567' }, locale, 'CLIENT_READY', q);
      assert.match(mobile, /data-publication-status="HOLD"/u);
    }
    assert.deepEqual(audit, original);
  }
  const audit = fixture();
  audit.coverage.urls[0].outcome = 'failed'; audit.coverage.urls[0].statusCode = 503;
  audit.crawl.captured = 0; audit.crawl.failed = 1;
  assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), false);
});

test('completion ordering and future completion are rejected', () => {
  const audit = fixture();
  audit.completedAt = new Date(Date.now() + 10 * 60_000).toISOString();
  assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), false);
  const reversed = fixture(); reversed.completedAt = new Date(Date.parse(reversed.startedAt) - 1).toISOString();
  assert.equal(isCustomerReleaseQualified(reversed, qualification(reversed)), false);
});

test('producer-shaped broken-link, image, duplicate metadata, robots and healthy PSI evidence remain admissible', () => {
  const audit = fixture();
  const firstPage = audit.coverage.urls[0].url;
  audit.coverage.urls.push({ url: 'https://fixture.example/page-001', outcome: 'captured', statusCode: 200 });
  const missing = 'https://fixture.example/missing';
  audit.coverage.urls.push({ url: missing, outcome: 'captured', statusCode: 404 });
  const link = findBrokenInternalLinks(new Map([[missing, new Set([firstPage])]]), new Map([[missing, 404]]), audit.completedAt,
    new Map([[missing, [{ pageUrl: firstPage, href: '/missing', anchorText: 'Unavailable page' }]]]),
    new Map([[missing, { url: missing, outcome: 'captured', statusCode: 404, finalUrl: missing }]]))[0];
  const imageUrl = 'https://fixture.example/assets/large.jpg';
  const image = analyzeImageProbe({ url: imageUrl, sourcePages: [firstPage], observedAt: audit.completedAt }, 200, 'image/jpeg', 900_000, 500_000);
  const duplicate = findDuplicateMetadata([
    { pageUrl: firstPage, observedAt: audit.completedAt, source: 'http', title: 'Repeated title', description: 'Shared description' },
    { pageUrl: 'https://fixture.example/page-001', observedAt: audit.completedAt, source: 'rendered-dom', title: 'Repeated title', description: 'Shared description' },
  ]);
  const robots = { code: 'robots_policy_unavailable', category: 'indexability', observed: 'Robots unavailable', evidence: [{ pageUrl: 'https://fixture.example/', observedAt: audit.completedAt, source: 'robots', value: 'unavailable' }] };
  const healthyPsi = { code: 'pagespeed_category_score', category: 'performance', observed: 'performance score: 88/100.', evidence: [{ pageUrl: audit.target, observedAt: audit.completedAt, source: 'pagespeed', value: 88 }] };
  audit.crawl.discovered = 3; audit.crawl.attempted = 3; audit.crawl.captured = 3;
  audit.findings = [audit.findings[0], link, image, ...duplicate, robots, healthyPsi];
  recount(audit);
  updatePageChecks(audit);
  assert.ok(isAuditResultRecord(audit));
  for (const finding of audit.findings) assert.equal(isReportableEvidenceAdmissible(audit, finding), true, finding.code);
  assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), false, 'the observed 404 still leaves security inspection partial');
  audit.coverage.urls.pop();
  audit.crawl.discovered--; audit.crawl.attempted--; audit.crawl.captured--;
  audit.findings = audit.findings.filter(finding => finding !== link);
  recount(audit); updatePageChecks(audit);
  assert.ok(isAuditResultRecord(audit));
  assert.equal(isCustomerReleaseQualified(audit, qualification(audit)), true);
  assert.equal(image.evidence[0].pageUrl, imageUrl, 'asset is not an ordinary captured HTML requirement');
});

test('successful rendering and caller supplied readiness booleans cannot change HOLD', async () => {
  const audit = fixture();
  const pair = await renderCustomerPdfPair(audit, async html => Buffer.from(html), issuer);
  assert.equal(pair.status, 'HOLD');
  assert.match(decode(pair.en), /data-publication-status="HOLD"/u);
  assert.match(decode(pair.de), /data-publication-status="HOLD"/u);
  let html = '';
  await renderMobileCustomerPdf(audit, async value => { html = value; return Buffer.from(value); }, issuer, 'en', 'CLIENT_READY');
  assert.match(html, /data-publication-status="HOLD"/u);
  assert.match(renderWhatsAppDraft(audit, 'customer.pdf', 'CLIENT_READY'), /Report release:\*\* HOLD/u);
  assert.match(renderWhatsAppDraft(audit, 'customer.pdf', 'CLIENT_READY', qualification(audit)), /Report release:\*\* CLIENT_READY/u);
});
