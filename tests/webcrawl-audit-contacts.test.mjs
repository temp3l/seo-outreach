import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditWebsite, auditWebsiteWithPageData } from '@spora/webcrawl/core/audit';
import { DEFAULT_CRAWL_LIMITS } from '@spora/webcrawl/core/defaults';
import { contactEnrichment } from '@spora/webcrawl/enrichments/contacts';
import { runCli } from '../dist/compat/cli.js';
import { verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { createEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { renderAuditHtml } from '../dist/reports/html.js';
import { crawlSite, stripCapturedHtml } from '@spora/webcrawl/crawler/crawl';

function fixtureTransport() {
  const html = '<html><head><title>Fixture</title></head><body><main><h1>School</h1><address><a href="mailto:office@fixture.test">Email</a><a href="tel:+34603518875">Phone</a><a href="https://wa.me/34603518875?text=private">WhatsApp</a></address></main></body></html>';
  return {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => ({ status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/plain' }, body: Buffer.from(url.pathname === '/' ? html : 'not found') }),
  };
}

function config(contacts = undefined) {
  return {
    startUrl: 'https://fixture.test/',
    pagespeed: false,
    policy: { ...DEFAULT_CRAWL_LIMITS, allowedHosts: ['fixture.test'], maxPages: 1, maxRequests: 6, maxRuntimeMs: 10_000, maxResponseBytes: 100_000, maxTotalResponseBytes: 500_000, maxRetries: 0, minRequestIntervalMs: 0, maxConcurrency: 1, robots: 'ignore' },
    renderBrowser: false,
    ...(contacts === undefined ? {} : { contacts }),
    ...fixtureTransport(),
  };
}

test('audit APIs default to contacts, opt out cleanly, and do not retain HTML solely for contacts', async () => {
  const audit = await auditWebsite(config());
  assert.equal(audit.capabilities.contacts, 'complete');
  assert.equal(audit.contacts.candidates.length, 2);
  assert.equal(audit.contacts.candidates.find((candidate) => candidate.kind === 'phone').channels.includes('whatsapp'), true);
  assert.equal(audit.crawlSettings.retainHtml, false);
  assert.equal(audit.crawlSettings.policy.robots, 'observation-only');
  assert.equal(audit.findings.some((finding) => finding.code === 'missing_title'), false);
  assert.deepEqual(audit.robotsObservation, { policy: 'observation-only', revision: 'robots-observation-only-v1', retrieval: 'missing', crawlerUserAgent: 'webcrawl/0.1', googlebotEvaluation: 'NOT_VERIFIED', knownDiscoveredUrls: 1, advisoryAllowed: 1, advisoryDisallowed: 0, advisoryUnknown: 0, capturedDisallowedCount: 0, capturedDisallowedSamples: [], omittedCapturedDisallowedSamples: 0 });
  assert.match(renderAuditHtml(audit), /Robots rules do not prevent otherwise permitted requests/u);

  const disabled = await auditWebsite(config(false));
  assert.equal(disabled.capabilities.contacts, 'disabled');
  assert.equal('contacts' in disabled, false);
  assert.equal(disabled.crawlSettings.retainHtml, false);
  const normalizeFindingTimes = (findings) => findings.filter((finding) => finding.category !== 'contacts').map((finding) => ({ ...finding, evidence: finding.evidence.map((evidence) => ({ ...evidence, observedAt: '<time>' })) }));
  assert.deepEqual(normalizeFindingTimes(audit.findings), normalizeFindingTimes(disabled.findings));
  assert.deepEqual(['discovered', 'attempted', 'captured', 'failed', 'skipped', 'unattempted'].map((key) => audit.crawl[key]), ['discovered', 'attempted', 'captured', 'failed', 'skipped', 'unattempted'].map((key) => disabled.crawl[key]));

  const withData = await auditWebsiteWithPageData(config(), { maxPages: 1 });
  assert.equal(withData.audit.contacts.candidates.length, 2);
  assert.equal(withData.audit.crawlSettings.retainHtml, false);
  assert.equal(withData.pageData.pages.length, 1);
});

test('date-like visible numbers stay ineligible as primary phones while explicit tel links remain eligible', async () => {
  const audit = await auditWebsite({
    ...config(),
    request: async (url) => ({
      status: url.pathname === '/' ? 200 : 404,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from(url.pathname === '/' ? '<main><footer><p>Next course date 2016-11-27 01. Call us.</p><p>Phone: +5016001234</p><p>Tel: +5016005678</p><p>Call +5016009999</p><a href="tel:+5016004321">Phone</a><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","telephone":"+5016007654"}</script></footer></main>' : ''),
    }),
  });
  const dateCandidate = audit.contacts.candidates.find((candidate) => candidate.rawValue.some((value) => value.includes('2016')));
  const phoneCandidate = audit.contacts.candidates.find((candidate) => candidate.rawValue.includes('+5016004321'));
  assert.ok(dateCandidate, 'the footer date occurrence should be extracted as a candidate');
  assert.equal(dateCandidate.eligibleForPrimary, false);
  assert.notEqual(audit.contacts.suggestedPrimary.phone, dateCandidate.normalizedValue);
  assert.ok(phoneCandidate);
  assert.equal(phoneCandidate.eligibleForPrimary, true);
  for (const digits of ['5016001234', '5016005678']) {
    const candidate = audit.contacts.candidates.find((item) => item.kind === 'phone' && item.rawValue.some((raw) => raw.replace(/\D/gu, '') === digits));
    assert.ok(candidate);
    assert.equal(candidate.eligibleForPrimary, true);
  }
  for (const digits of ['5016009999', '5016004321', '5016007654']) {
    const candidate = audit.contacts.candidates.find((item) => item.kind === 'phone' && item.rawValue.some((raw) => raw.replace(/\D/gu, '') === digits));
    assert.ok(candidate);
    assert.equal(candidate.eligibleForPrimary, true);
  }
});

test('visible phone eligibility belongs to the adjacent label and preserves localized national numbers', async () => {
  const cases = [
    ['<footer>Reference 1234567890. Phone service available.</footer>', '1234567890', false],
    ['<div class="contact"><table><thead><tr><th>Phone</th><th>Reference</th></tr></thead><tbody><tr><td>Unassigned</td><td>1234567890</td></tr></tbody></table></div>', '1234567890', false],
    ['<div class="contact">Next course date 2016-11-27 01. Call us.</div>', '2016112701', false],
    ...['Phone:', 'Tel:', 'Telefon:', 'Kontakt:', 'Telephone —', 'Call us at', 'Mobile ('].map(label => [`<footer>${label} +5016001234</footer>`, '5016001234', true]),
    ['<div class="contact">Telefon: 020 7946 0958</div>', '02079460958', true],
    ['<footer>Phone: 2016-11-27 01. Call us.</footer>', '2016112701', false],
    ['<footer>Reference: +5016001234. Phone: +5016001234. End.</footer>', '5016001234', true],
    ['<footer>Reference: +5016001234. Phone: +5016001234 End.</footer>', '5016001234', true],
    ['<footer>Phone: +5016001234. Reference: +5016001234. End.</footer>', '5016001234', true],
  ];
  for (const [html, digits, eligible] of cases) {
    const audit = await auditWebsite({ ...config(), request: async url => ({ status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from(url.pathname === '/' ? html : '') }) });
    const candidate = audit.contacts.candidates.find(item => item.kind === 'phone' && item.normalizedValue.replace(/\D/gu, '') === digits);
    assert.ok(candidate, html);
    assert.equal(candidate.eligibleForPrimary, eligible, html);
    assert.equal(audit.contacts.suggestedPrimary.phone, eligible ? candidate.normalizedValue : null, html);
  }
  const audit = await auditWebsite({ ...config(), request: async url => ({ status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from(url.pathname === '/' ? '<footer>Phone: +5016001234. Reference 1234567890.</footer>' : '') }) });
  const reference = audit.contacts.candidates.find(item => item.normalizedValue === '1234567890');
  assert.ok(reference);
  assert.equal(reference.eligibleForPrimary, false);
  assert.equal(audit.contacts.suggestedPrimary.phone, '+5016001234');
});

test('base-relative destinations flow unchanged through crawl discovery, checking, and page evidence', async () => {
  const requested = [];
  const html = '<html><head><template><base href="/wrong/"></template><base href="/docs/"></head><body><main><a href="guide.html#intro">Guide</a></main></body></html>';
  const result = await auditWebsiteWithPageData({
    ...config(false),
    policy: { ...config(false).policy, maxPages: 2, maxRequests: 8 },
    request: async (url) => {
      requested.push(url.href);
      if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(0) };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
      return { status: url.pathname === '/docs/guide.html' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Guide</main>') };
    },
  }, { maxPages: 2 });
  assert.ok(requested.includes('https://fixture.test/docs/guide.html'));
  assert.ok(!requested.includes('https://fixture.test/guide.html'));
  assert.deepEqual(result.pageData.pages[0].links.map((link) => link.href), ['https://fixture.test/docs/guide.html']);
  assert.deepEqual(result.pageData.pages[0].responseHeaderTiming, { status: 'NOT_MEASURED' });
  assert.equal(result.audit.findings.some((finding) => finding.code === 'slow_response_headers' || finding.code === 'very_slow_response_headers'), false);
  assert.equal(result.audit.coverage.checks.internalLinks.discovered, 1);
  assert.equal(result.audit.coverage.checks.internalLinks.checked, 1);
  assert.equal(result.audit.findings.some((finding) => finding.code === 'broken_internal_link'), false);
  const defaultBase = await auditWebsite({
    ...config(false), policy: { ...config(false).policy, maxPages: 2, maxRequests: 8 },
    request: async (url) => {
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<a href="guide.html">Guide</a>') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>Guide</p>') };
    },
  });
  assert.ok(defaultBase.coverage.urls.some((item) => item.url === 'https://fixture.test/guide.html'));
  const redirectedBase = await auditWebsite({
    ...config(false), startUrl: 'https://fixture.test/alias', policy: { ...config(false).policy, maxPages: 2, maxRequests: 8 },
    request: async (url) => {
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url.pathname === '/alias') return { status: 302, headers: { location: '/current/page' }, body: Buffer.alloc(0) };
      if (url.pathname === '/current/page') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<base href="../docs/"><a href="guide.html">Guide</a>') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Guide</main>') };
    },
  });
  assert.ok(redirectedBase.coverage.urls.some((item) => item.url === 'https://fixture.test/docs/guide.html'));
});

test('distinct-link cap follows duplicate anchors and bounded omitted URLs affect contact completeness', async () => {
  const requested = [];
  const duplicateAnchors = `${'<a href="/">Home</a>'.repeat(10_000)}<a href="/contact">Contact</a>`;
  const audit = await auditWebsite({
    ...config(), policy: { ...config().policy, maxPages: 2, maxRequests: 8, maxResponseBytes: 2_000_000, maxTotalResponseBytes: 5_000_000 },
    request: async (url) => {
      requested.push(url.pathname);
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      return { status: url.pathname === '/contact' ? 404 : 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(url.pathname === '/' ? duplicateAnchors : '<main>Missing contact page</main>') };
    },
  });
  assert.ok(requested.includes('/contact'));
  assert.equal(audit.coverage.checks.internalLinks.discovered, 2);
  assert.equal(audit.coverage.checks.internalLinks.findings, 1);
  assert.equal(audit.findings.find((finding) => finding.code === 'broken_internal_link')?.evidence[0]?.requestedUrl, 'https://fixture.test/contact');
});

test('distinct URL producer cap records the known late target and suppresses unsupported contact primary', async () => {
  const links = Array.from({ length: 10_001 }, (_, index) => `<a href="/page-${index}"></a>`).join('');
  const audit = await auditWebsite({
    ...config(), policy: { ...config().policy, maxPages: 1, maxRequests: 8, maxResponseBytes: 2_000_000, maxTotalResponseBytes: 5_000_000 },
    request: async (url) => {
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<main><a href="mailto:hello@fixture.test">Email</a>${links}</main>`) };
    },
  });
  const coverage = audit.coverage.checks.internalLinks;
  assert.equal(coverage.discovered, 10_001);
  assert.equal(coverage.omittedTargets, 1);
  assert.equal(coverage.unattempted, 10_001);
  assert.equal(coverage.status, 'partial');
  assert.equal(audit.contacts.coverage.incompleteDiscoveryPages, 1);
  assert.equal(audit.contacts.suggestedPrimary.email, null);
});

test('link coverage counts denied and budget-unattempted URLs exactly once', async () => {
  const requested = [];
  const audit = await auditWebsite({
    ...config(false), policy: { ...config(false).policy, maxPages: 4, maxRequests: 3 },
    request: async (url) => {
      requested.push(url.pathname);
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<a href="/denied">Denied</a><a href="/later">Later</a>') };
      if (url.pathname === '/denied') return { status: 403, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>Access denied</p>') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<p>Later</p>') };
    },
  });
  const coverage = audit.coverage.checks.internalLinks;
  assert.equal(requested.includes('/later'), false);
  assert.deepEqual([coverage.discovered, coverage.checked, coverage.failed, coverage.skipped, coverage.unattempted], [2, 0, 1, 0, 1]);
  assert.equal(coverage.checked + coverage.failed + coverage.skipped + coverage.unattempted, coverage.discovered);
  assert.equal(audit.findings.some((finding) => finding.code === 'broken_internal_link'), false);
});

test('integrated link evidence distinguishes only confirmed 404/410 from denied and unavailable targets', async () => {
  const request = async (url) => {
    if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
    if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from([
      '<a href="/missing">Missing</a><a href="/gone">Gone</a><a href="/denied">Denied</a>',
      '<a href="/throttled">Throttled</a><a href="/unavailable">Unavailable</a><a href="/reset">Reset</a>',
      '<a href="/redirected#section">Redirected</a>',
    ].join('')) };
    if (url.pathname === '/missing') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
    if (url.pathname === '/gone') return { status: 410, headers: { 'content-type': 'text/plain' }, body: Buffer.from('gone') };
    if (url.pathname === '/denied') return { status: 403, headers: { 'content-type': 'text/plain' }, body: Buffer.from('denied') };
    if (url.pathname === '/throttled') return { status: 429, headers: { 'content-type': 'text/plain' }, body: Buffer.from('throttled') };
    if (url.pathname === '/unavailable') return { status: 503, headers: { 'content-type': 'text/plain' }, body: Buffer.from('unavailable') };
    if (url.pathname === '/reset') throw new Error('synthetic_transport_failure');
    if (url.pathname === '/redirected') return { status: 302, headers: { location: '/gone-final' }, body: Buffer.alloc(0) };
    if (url.pathname === '/gone-final') return { status: 410, headers: { 'content-type': 'text/plain' }, body: Buffer.from('gone') };
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
  };
  const audit = await auditWebsite({
    ...config(false), policy: { ...config(false).policy, maxPages: 8, maxRequests: 16 }, request,
  });
  const broken = audit.findings.filter((finding) => finding.code === 'broken_internal_link');
  assert.deepEqual(broken.map((finding) => finding.evidence[0].requestedUrl).sort(), [
    'https://fixture.test/gone', 'https://fixture.test/missing', 'https://fixture.test/redirected',
  ]);
  const redirected = broken.find((finding) => finding.evidence[0].requestedUrl.endsWith('/redirected'));
  assert.equal(redirected.evidence[0].pageUrl, 'https://fixture.test/gone-final');
  assert.deepEqual(redirected.evidence[0].redirectChain, ['https://fixture.test/gone-final']);
  assert.equal(redirected.evidence[1].pageUrl, 'https://fixture.test/');
  assert.equal(redirected.evidence[1].anchorHref, '/redirected');
  assert.equal(redirected.evidence[1].anchorText, 'Redirected');
  assert.equal(redirected.evidence[1].fragmentStatus, 'unchecked');
  const coverage = audit.coverage.checks.internalLinks;
  assert.deepEqual([coverage.discovered, coverage.checked, coverage.failed, coverage.unattempted], [7, 3, 4, 0]);
});

test('external and unsafe base targets cannot bypass allowed-host or scheme checks', async () => {
  for (const [html, expected] of [
    ['<base href="https://outside.test/docs/"><a href="guide.html">External</a>', ['https://fixture.test/']],
    ['<base href="javascript:alert(1)"><a href="guide.html">Unsafe</a>', ['https://fixture.test/', 'https://fixture.test/guide.html']],
  ]) {
    const requested = [];
    await auditWebsite({
      ...config(false), policy: { ...config(false).policy, maxPages: 3 },
      request: async (url) => {
        requested.push(url.href);
        if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(url.pathname === '/' ? html : '<title>Safe fallback target</title>') };
      },
    });
    assert.deepEqual(requested.filter((value) => !value.endsWith('/robots.txt')), expected);
    assert.equal(requested.some((value) => value.includes('outside.test') || value.startsWith('javascript:')), false);
  }
});

test('deep static HTML is analyzed iteratively and preserves successful HTTP capture', async () => {
  const deep = `${'<div>'.repeat(6_000)}<h1>Deep</h1><a href="/next">Next</a>${'</div>'.repeat(6_000)}`;
  const audit = await auditWebsite({
    ...config(false), policy: { ...config(false).policy, maxPages: 1 },
    request: async (url) => url.pathname === '/robots.txt'
      ? { status: 404, headers: {}, body: Buffer.alloc(0) }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(deep) },
  });
  assert.equal(audit.crawl.captured, 1);
  assert.equal(audit.crawl.failed, 0);
  assert.equal(audit.coverage.urls.find((item) => item.url === 'https://fixture.test/').statusCode, 200);
  assert.equal(audit.findings.some((finding) => finding.code === 'analysis_failed'), false);
  assert.equal(audit.findings.some((finding) => finding.code === 'http_status_error'), false);
});

test('same-final-URL redirect aliases choose a stable representative regardless of response timing', async () => {
  async function capture(delayA, delayB) {
    const request = async (url) => {
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<a href="/a">A</a><a href="/b">B</a>') };
      if (url.pathname === '/a' || url.pathname === '/b') {
        await new Promise((resolve) => setTimeout(resolve, url.pathname === '/a' ? delayA : delayB));
        return { status: 302, headers: { location: '/common' }, body: Buffer.alloc(0) };
      }
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Common content</main>') };
    };
    const result = await auditWebsiteWithPageData({
      ...config(false), policy: { ...config(false).policy, maxPages: 3, maxRequests: 12, maxConcurrency: 2 }, request,
    }, { maxPages: 3 });
    const pack = verifyEvidencePack(createEvidencePack(result.audit, result.pageData));
    const packedAudit = JSON.parse(pack.members.find((member) => member.name === 'audit.json').content.toString('utf8'));
    const packedPages = pack.members.find((member) => member.name === 'pages.jsonl').content.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    const graph = JSON.parse(pack.members.find((member) => member.name === 'site-graph.json').content.toString('utf8'));
    const manifest = JSON.parse(pack.members.find((member) => member.name === 'manifest.json').content.toString('utf8'));
    return { result, packedAudit, packedPages, graph, manifest };
  }
  const fastA = await capture(1, 30);
  const fastB = await capture(30, 1);
  const project = (value) => value.result.pageData.pages.map(({ id, requestedUrl, finalUrl }) => ({ id, requestedUrl, finalUrl }));
  assert.deepEqual(project(fastA), project(fastB));
  assert.equal(fastA.result.pageData.pages[1].requestedUrl, 'https://fixture.test/a');
  for (const value of [fastA, fastB]) {
    const aliasOutcome = value.packedAudit.coverage.urls.find((item) => item.url.endsWith('/a'));
    const otherOutcome = value.packedAudit.coverage.urls.find((item) => item.url.endsWith('/b'));
    assert.equal(aliasOutcome.outcome, 'captured');
    assert.equal(otherOutcome.outcome, 'skipped');
    assert.equal(aliasOutcome.finalUrl, 'https://fixture.test/common');
    assert.deepEqual(aliasOutcome.redirectChain, ['https://fixture.test/common']);
    assert.equal(value.packedPages[1].id, value.result.pageData.pages[1].id);
    assert.ok(value.graph.relations.some((relation) => relation.targetPageId === value.packedPages[1].id));
    assert.equal(value.manifest.coverage.captured, value.packedAudit.crawl.captured);
  }
});

test('default image probe budget is 50 unique same-host HEAD checks and zero disables probes', async () => {
  assert.equal(DEFAULT_CRAWL_LIMITS.maxImageChecks, 50);
  assert.equal(DEFAULT_CRAWL_LIMITS.largeImageThresholdBytes, 500_000);
  const imgMarkup = `${Array.from({ length: 51 }, (_, index) => `<img src="/image-${index}.webp" alt="">`).join('')}<img src="/image-0.webp" alt="duplicate">`;
  const methods = [];
  const request = async (url, _addresses, options) => {
    methods.push([url.pathname, options.method]);
    if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
    if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(imgMarkup) };
    return { status: 200, headers: { 'content-type': 'image/webp', 'content-length': url.pathname.endsWith('0.webp') ? '500001' : '500000' }, body: Buffer.alloc(0) };
  };
  const base = config(false);
  const defaultAudit = await auditWebsite({ ...base, policy: { ...base.policy, maxPages: 1, maxRequests: 80 }, request });
  const headChecks = methods.filter(([, method]) => method === 'HEAD');
  assert.equal(headChecks.length, 50);
  assert.equal(new Set(headChecks.map(([path]) => path)).size, 50);
  assert.equal(defaultAudit.coverage.checks.imageSizes.discovered, 51);
  assert.equal(defaultAudit.coverage.checks.imageSizes.checked, 50);
  assert.equal(defaultAudit.coverage.checks.imageSizes.omittedTargets, 1);
  assert.equal(defaultAudit.coverage.checks.imageSizes.thresholdBytes, 500_000);
  assert.equal(defaultAudit.findings.some((finding) => finding.code === 'image_file_too_large' && finding.evidence.some((item) => item.value === 500001)), true);

  methods.length = 0;
  const disabled = await auditWebsite({ ...base, policy: { ...base.policy, maxPages: 1, maxRequests: 8, maxImageChecks: 0 }, request });
  assert.equal(methods.some(([, method]) => method === 'HEAD'), false);
  assert.equal(disabled.coverage.checks.imageSizes.status, 'disabled');
});

test('HTTP error HTML is retained as response evidence but not inspected for contacts or healthy content', async () => {
  const onlyDenied = await auditWebsiteWithPageData({
    ...config(), policy: { ...config().policy, maxPages: 1 },
    request: async (url) => url.pathname === '/robots.txt'
      ? { status: 404, headers: {}, body: Buffer.alloc(0) }
      : { status: 403, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Access denied</title><main>Access denied <a href="mailto:denied@fixture.test">Bookings</a></main>') },
  }, { maxPages: 1 });
  const deniedPage = onlyDenied.pageData.pages[0];
  assert.equal(deniedPage.statusCode, 403);
  assert.equal(deniedPage.contentStatus, 'response_body_captured');
  assert.equal(onlyDenied.pageData.truncatedPages, 0);
  assert.equal(deniedPage.extractionQuality.status, 'unavailable');
  assert.equal(deniedPage.extractionQuality.reasons[0], 'http_error_response_not_inspected');
  assert.equal(deniedPage.textStatus, 'NOT_CHECKED');
  assert.equal(deniedPage.text, '');
  assert.match(deniedPage.sourceSha256, /^[a-f0-9]{64}$/u);
  assert.equal(onlyDenied.audit.contacts.candidates.length, 0);
  assert.equal(onlyDenied.audit.contacts.suggestedPrimary.email, null);
  assert.equal(onlyDenied.audit.capabilities.contacts, 'partial');
  assert.equal(onlyDenied.audit.capabilities.technicalSeo, 'partial');
  assert.ok(onlyDenied.audit.findings.some((finding) => finding.code === 'http_status_error'));
  assert.equal(onlyDenied.audit.findings.some((finding) => finding.code === 'missing_title'), false);
  const verified = verifyEvidencePack(createEvidencePack(onlyDenied.audit, onlyDenied.pageData));
  const packedPage = JSON.parse(verified.members.find((member) => member.name === 'pages.jsonl').content.toString('utf8'));
  assert.equal(packedPage.contentStatus, 'response_body_captured');
  assert.equal(packedPage.statusCode, 403);

  const mixed = await auditWebsiteWithPageData({
    ...config(), policy: { ...config().policy, maxPages: 3, maxRequests: 8 },
    request: async (url) => {
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<a href="/ok">Good</a><a href="/denied">Denied</a>') };
      if (url.pathname === '/denied') return { status: 403, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main><a href="mailto:denied@fixture.test">Bookings</a></main>') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main><a href="mailto:good@fixture.test">Email</a></main>') };
    },
  }, { maxPages: 3 });
  assert.deepEqual(mixed.audit.contacts.candidates.map((item) => item.normalizedValue), ['good@fixture.test']);
  assert.equal(mixed.audit.contacts.suggestedPrimary.email, null);
  assert.equal(mixed.pageData.pages.find((item) => item.statusCode === 403).contentStatus, 'response_body_captured');
  assert.equal(verifyEvidencePack(createEvidencePack(mixed.audit, mixed.pageData)).members.length, 5);
});

test('crawl cleanup clears its owned deadline timer when progress reporting throws', async () => {
  const timeoutCount = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const before = timeoutCount();
  await assert.rejects(crawlSite({ ...config(false), policy: { ...config(false).policy, maxRuntimeMs: 60_000 }, onProgress: () => { throw new Error('fixture_progress_failure'); } }), /fixture_progress_failure/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeoutCount(), before);
});

test('non-retaining capture feeds same-capture consumers then strips raw and rendered HTML from returned pages', async () => {
  const captured = { requestedUrl: 'https://fixture.test/', finalUrl: 'https://fixture.test/', statusCode: 200, contentType: 'text/html', fetchedAt: 'now', responseBytes: 4, html: '<p>http</p>', renderedHtml: '<p>rendered</p>' };
  const stripped = stripCapturedHtml(captured);
  assert.equal('html' in stripped, false);
  assert.equal('renderedHtml' in stripped, false);
  assert.equal(stripped.finalUrl, captured.finalUrl);

  let observedSource;
  const crawl = await crawlSite({ ...config(false), retainHtml: false, observeContactPage: (page) => { observedSource = page.html; } });
  assert.match(observedSource, /office@fixture\.test/u);
  assert.equal('html' in crawl.pages[0], false);
  assert.equal('renderedHtml' in crawl.pages[0], false);
});

test('robots disallow and retrieval failures remain observations while permitted pages are fetched', async () => {
  for (const robotsCase of [
    { status: 200, body: 'User-agent: *\nDisallow: /' , retrieval: 'available', disallowed: 2 },
    { status: 404, body: '', retrieval: 'missing', disallowed: 0 },
    { status: 500, body: 'server error', retrieval: 'unavailable', disallowed: 0 },
    { status: 200, body: 'malformed robots line', retrieval: 'available', disallowed: 0 },
  ]) {
    const seen = [];
    const transport = {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async (url) => {
        seen.push(url.pathname);
        if (url.pathname === '/robots.txt') return { status: robotsCase.status, headers: {}, body: Buffer.from(robotsCase.body) };
        return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(url.pathname === '/' ? '<main><a href="/private">Private</a></main>' : '<main>Private</main>') };
      },
    };
    const audit = await auditWebsite({ ...config(false), policy: { ...config(false).policy, maxPages: 2, maxRequests: 8, minRequestIntervalMs: 0 }, ...transport });
    assert.ok(seen.includes('/private'));
    assert.equal(audit.robotsObservation.retrieval, robotsCase.retrieval);
    assert.equal(audit.robotsObservation.advisoryDisallowed, robotsCase.disallowed);
    assert.equal(audit.crawl.captured, 2);
    assert.equal(audit.coverage.urls.some((item) => item.outcome === 'robots_blocked'), false);
    assert.equal(audit.robotsObservation.knownDiscoveredUrls, audit.robotsObservation.advisoryAllowed + audit.robotsObservation.advisoryDisallowed + audit.robotsObservation.advisoryUnknown);
    if (robotsCase.disallowed) {
      assert.deepEqual(audit.robotsObservation.capturedDisallowedSamples.sort(), ['https://fixture.test/', 'https://fixture.test/private']);
      assert.equal(audit.robotsObservation.capturedDisallowedCount, 2);
    }
  }
});

test('robots observation preserves one request and the configured page-byte budget for the actual scan', async () => {
  const requests = [];
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => { requests.push(url.pathname); return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>home</main>') }; },
  };
  const audit = await auditWebsite({ ...config(false), policy: { ...config(false).policy, maxRequests: 1, maxPages: 1, maxTotalResponseBytes: 100_000 }, ...transport });
  assert.deepEqual(requests, ['/']);
  assert.equal(audit.crawl.captured, 1);
  assert.equal(audit.crawl.physicalRequests, 1);
  assert.equal(audit.robotsObservation.retrieval, 'unavailable');
  assert.equal(audit.robotsObservation.error, 'budget_exhausted');
});

test('robots follows same-host redirects only within budgets that reserve the start page', async () => {
  for (const [maxRequests, maxTotalResponseBytes, expected] of [[4, 4000, 'available'], [2, 4000, 'unavailable'], [4, 2000, 'unavailable']]) {
    const requests = [];
    const base = config(false);
    const audit = await auditWebsite({ ...base, policy: { ...base.policy, maxPages: 1, maxRequests, maxResponseBytes: 1000, maxTotalResponseBytes, maxRetries: 0, minRequestIntervalMs: 0 }, resolveAddresses: async () => ['93.184.216.34'], request: async url => {
      requests.push(url.pathname);
      if (url.pathname === '/robots.txt') return { status: 302, headers: { location: '/en/robots.txt/' }, body: Buffer.alloc(0) };
      if (url.pathname === '/en/robots.txt/') return { status: 301, headers: { location: '/en/robots.txt' }, body: Buffer.alloc(0) };
      if (url.pathname === '/en/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nDisallow: /private') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Home</main>') };
    } });
    assert.equal(audit.robotsObservation.retrieval, expected);
    assert.equal(audit.crawl.captured, 1);
    assert.equal(requests.at(-1), '/');
    assert.ok(requests.length <= maxRequests);
  }
});

test('robots arithmetic applies only to the exact origin observed and leaves other allowed origins unknown', async () => {
  const requests = [];
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      requests.push(url.origin + url.pathname);
      if (url.pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nDisallow: /private') };
      const html = url.pathname === '/' ? '<main><a href="/private">Same origin</a><a href="https://cdn.fixture.test/private">Other origin</a></main>' : '<main>Captured</main>';
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
    },
  };
  const base = config(false);
  const audit = await auditWebsite({ ...base, policy: { ...base.policy, allowedHosts: ['fixture.test', 'cdn.fixture.test'], maxPages: 3 }, ...transport });
  assert.deepEqual(audit.robotsObservation, {
    policy: 'observation-only', revision: 'robots-observation-only-v1', retrieval: 'available', crawlerUserAgent: 'webcrawl/0.1', googlebotEvaluation: 'NOT_VERIFIED',
    knownDiscoveredUrls: 3, advisoryAllowed: 1, advisoryDisallowed: 1, advisoryUnknown: 1,
    capturedDisallowedCount: 1, capturedDisallowedSamples: ['https://fixture.test/private'], omittedCapturedDisallowedSamples: 0,
  });
  assert.ok(requests.includes('https://cdn.fixture.test/private'));
  assert.equal(audit.robotsObservation.knownDiscoveredUrls, audit.robotsObservation.advisoryAllowed + audit.robotsObservation.advisoryDisallowed + audit.robotsObservation.advisoryUnknown);
});

test('non-HTML HTTP denials remain failed outcomes with status while successful media skips remain skips', async () => {
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main><a href="/forbidden">403</a><a href="/throttled">429</a><a href="/server-error">503</a><a href="/image">Image</a></main>') };
      const status = ({ '/forbidden': 403, '/throttled': 429, '/server-error': 503 }[url.pathname] ?? 200);
      return { status, headers: { 'content-type': url.pathname === '/image' ? 'image/png' : 'text/plain' }, body: Buffer.from('not html') };
    },
  };
  const base = config(false);
  const audit = await auditWebsite({ ...base, policy: { ...base.policy, maxPages: 5, maxRequests: 10 }, ...transport });
  const outcomes = new Map(audit.coverage.urls.map((item) => [new URL(item.url).pathname, item]));
  for (const [path, status] of [['/forbidden', 403], ['/throttled', 429], ['/server-error', 503]]) {
    assert.deepEqual(outcomes.get(path), { url: `https://fixture.test${path}`, outcome: 'failed', statusCode: status, finalUrl: `https://fixture.test${path}`, redirectChain: [], reason: 'http_status_error' });
  }
  assert.equal(outcomes.get('/image').outcome, 'skipped');
  assert.equal(outcomes.get('/image').statusCode, 200);
  assert.equal(audit.crawl.failed, 3);
  assert.equal(audit.crawl.skipped, 1);
});

test('robots disallow does not gate sitemap, same-host redirects, browser-independent probes, or security.txt', async () => {
  const dispatched = [];
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url, _addresses, options) => {
      dispatched.push([options.method, url.pathname]);
      if (url.pathname === '/robots.txt') return { status: 200, headers: {}, body: Buffer.from('User-agent: *\nDisallow: /\nSitemap: https://fixture.test/sitemap.xml') };
      if (url.pathname === '/sitemap.xml') return { status: 200, headers: {}, body: Buffer.from('<urlset><url><loc>https://fixture.test/from-sitemap</loc></url></urlset>') };
      if (url.pathname === '/start') return { status: 302, headers: { location: '/private' }, body: Buffer.alloc(0) };
      if (url.pathname === '/image.png') return { status: 200, headers: { 'content-type': 'image/png', 'content-length': '1000' }, body: Buffer.alloc(0) };
      if (url.pathname === '/.well-known/security.txt') return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Contact: https://fixture.test/security\nExpires: 2027-01-01T00:00:00Z\n') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main><a href="/from-link">Next</a><img src="/image.png" alt="test"></main>') };
    },
  };
  const base = config(false);
  const audit = await auditWebsite({ ...base, startUrl: 'https://fixture.test/start', policy: { ...base.policy, maxPages: 3, maxRequests: 20, maxImageChecks: 2 }, checkSecurityTxt: true, includeSitemapEvidence: true, ...transport });
  assert.ok(dispatched.some(([method, path]) => method === 'GET' && path === '/private'));
  assert.ok(dispatched.some(([method, path]) => method === 'GET' && path === '/sitemap.xml'));
  assert.ok(dispatched.some(([method, path]) => method === 'GET' && path === '/from-sitemap'));
  assert.ok(dispatched.some(([method, path]) => method === 'HEAD' && path === '/image.png'));
  assert.ok(dispatched.some(([method, path]) => method === 'GET' && path === '/.well-known/security.txt'));
  assert.equal(audit.coverage.urls.some((item) => item.outcome === 'robots_blocked'), false);
  assert.equal(audit.findings.some((finding) => finding.code === 'robots_disallowed_urls'), false);
});

test('explicit built-in contact enrichment is deduplicated while a distinct custom enrichment remains', async () => {
  let runs = 0;
  const custom = { name: 'fixture-custom', async run() { runs++; return { status: 'complete', findings: [] }; } };
  const audit = await auditWebsite(config(), [contactEnrichment, custom]);
  assert.equal(audit.crawlSettings.enrichments.filter((name) => name === 'contacts').length, 1);
  assert.equal(audit.crawlSettings.enrichments.includes('fixture-custom'), true);
  assert.equal(runs, 1);
  assert.equal(audit.contacts.candidates.length, 2);
});

test('single-site CLI writes default contacts to audit JSON and the existing five-member evidence ZIP; opt-out writes no inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-cli-contacts-'));
  try {
    const enabledBase = join(root, 'enabled');
    const archive = join(root, 'enabled.zip');
    await runCli(['https://fixture.test/', '--out', enabledBase, '--evidence-pack', archive, '--pages', '1', '--requests', '12', '--runtime-ms', '60000', '--concurrency', '1', '--interval-ms', '0', '--retries', '0', '--image-checks', '0', '--no-pagespeed', '--no-pdf'], fixtureTransport());
    const audit = JSON.parse(await readFile(`${enabledBase}.json`, 'utf8'));
    assert.equal(audit.capabilities.contacts, 'complete');
    assert.equal(audit.contacts.candidates.find((candidate) => candidate.kind === 'phone').channels.includes('whatsapp'), true);
    const packed = verifyEvidencePack(await readFile(archive));
    assert.equal(packed.members.length, 5);
    const packedAudit = JSON.parse(packed.members.find((member) => member.name === 'audit.json').content.toString('utf8'));
    const manifest = JSON.parse(packed.members.find((member) => member.name === 'manifest.json').content.toString('utf8'));
    assert.deepEqual(packedAudit.contacts, audit.contacts);
    assert.deepEqual(packedAudit.robotsObservation, audit.robotsObservation);
    assert.deepEqual(manifest.robotsObservation, audit.robotsObservation);
    assert.equal((await readFile(`${enabledBase}.html`, 'utf8')).includes('office@fixture.test'), false);

    const disabledBase = join(root, 'disabled');
    await runCli(['https://fixture.test/', '--out', disabledBase, '--pages', '1', '--requests', '12', '--runtime-ms', '60000', '--concurrency', '1', '--interval-ms', '0', '--retries', '0', '--image-checks', '0', '--no-pagespeed', '--no-pdf', '--no-contacts'], fixtureTransport());
    const disabled = JSON.parse(await readFile(`${disabledBase}.json`, 'utf8'));
    assert.equal(disabled.capabilities.contacts, 'disabled');
    assert.equal('contacts' in disabled, false);

    const csv = join(root, 'schools.csv');
    const batchOut = join(root, 'batch');
    await writeFile(csv, 'website\nhttps://fixture.test/\n');
    await runCli(['--batch', csv, '--out', batchOut, '--no-pagespeed'], fixtureTransport());
    let state = JSON.parse(await readFile(join(batchOut, 'batch-state.json'), 'utf8'));
    let batchAudit = JSON.parse(await readFile(join(batchOut, state.completed[Object.keys(state.completed)[0]].file), 'utf8'));
    assert.equal(batchAudit.contacts.candidates.length, 2);
    await runCli(['--batch', csv, '--out', batchOut, '--resume', '--no-contacts', '--no-pagespeed'], fixtureTransport());
    state = JSON.parse(await readFile(join(batchOut, 'batch-state.json'), 'utf8'));
    batchAudit = JSON.parse(await readFile(join(batchOut, state.completed[Object.keys(state.completed)[0]].file), 'utf8'));
    assert.equal(batchAudit.capabilities.contacts, 'disabled');
    assert.equal('contacts' in batchAudit, false);
    await runCli(['--batch', csv, '--out', batchOut, '--resume', '--no-pagespeed'], fixtureTransport());
    state = JSON.parse(await readFile(join(batchOut, 'batch-state.json'), 'utf8'));
    batchAudit = JSON.parse(await readFile(join(batchOut, state.completed[Object.keys(state.completed)[0]].file), 'utf8'));
    assert.equal(batchAudit.contacts.candidates.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
