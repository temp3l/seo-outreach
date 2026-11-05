import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScanCompletion } from '@spora/webcrawl/core/scan-completion';
import { safeGet } from '@spora/webcrawl/crawler/safe-transport';
import { CrawlRequestScheduler } from '@spora/webcrawl/crawler/request-control';
import { createEvidencePack, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { createPageDataExport } from '@spora/webcrawl/analysis/page-data';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { runCli } from '../dist/compat/cli.js';
import { auditWebsite, auditWebsiteWithPageData } from '@spora/webcrawl/core/audit';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { renderOperatorStatusHtml } from '../dist/reports/summary.js';
import { ProgressReporter } from '../dist/compat/cli/progress.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seed = 'https://example.com/';
function fixture(extra = [], seedRow = { url: seed, outcome: 'captured', statusCode: 200 }) {
  const { audit } = createEvidenceFixture(1);
  audit.target = seed;
  audit.crawlSettings.policy.allowedHosts = ['example.com'];
  audit.coverage.urls = [seedRow, ...extra];
  const count = outcome => audit.coverage.urls.filter(row => row.outcome === outcome).length;
  audit.crawl = { discovered: audit.coverage.urls.length, attempted: count('captured') + count('failed') + count('skipped'), captured: count('captured'), failed: count('failed'), skipped: count('skipped'), unattempted: count('unattempted'), limitations: [] };
  const pageData = createPageDataExport(audit.coverage.urls.filter(row => row.outcome === 'captured').map(row => ({ requestedUrl: row.url, finalUrl: row.finalUrl ?? row.url, statusCode: row.statusCode, contentType: 'text/html', fetchedAt: audit.startedAt, responseBytes: 40, html: '<html><body><h1>Fixture</h1></body></html>' })));
  assert.ok(isAuditResultRecord(audit));
  return { audit, pageData };
}

test('captured 403 and 404 are settled outcomes while check limitations stay visible', () => {
  const { audit, pageData } = fixture([{ url: seed + 'missing', outcome: 'captured', statusCode: 404 }, { url: seed + 'private', outcome: 'captured', statusCode: 403 }]);
  audit.crawl.limitations.push('content_inspection_incomplete');
  const result = classifyScanCompletion(audit, pageData);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.executionStatus, 'COMPLETED');
  assert.equal(result.coverageStatus, 'PARTIAL');
  assert.equal(result.missingUrls, 1); assert.equal(result.blockedUrls, 1);
  assert.deepEqual(result.coverageLimitations, ['content_inspection_incomplete']);
});

test('an observed HTTP 500 is settled, whereas failed requests and rate limits are gaps', () => {
  const { audit, pageData } = fixture([{ url: seed + 'error', outcome: 'captured', statusCode: 500 }]);
  audit.crawl.limitations.push('content_inspection_incomplete');
  const result = classifyScanCompletion(audit, pageData);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.serverErrorUrls, 1);
  assert.equal(result.transientOrOtherFailures, 0);
  for (const row of [{ url: seed + 'limited', outcome: 'captured', statusCode: 429 }, { url: seed + 'auth-failed', outcome: 'failed', statusCode: 401 }, { url: seed + 'denied', outcome: 'failed', statusCode: 403 }, { url: seed + 'failed', outcome: 'failed', statusCode: 500 }]) {
    const next = fixture([row]);
    assert.equal(classifyScanCompletion(next.audit, next.pageData).status, 'INCOMPLETE');
  }
});

test('429, network failures and unattempted URLs remain incomplete; failed seed fetches are FAILED', () => {
  for (const row of [{ url: seed + 'limit', outcome: 'captured', statusCode: 429 }, { url: seed + 'unavailable', outcome: 'captured', statusCode: 503 }, { url: seed + 'timeout', outcome: 'failed', reason: 'request_timeout' }, { url: seed + 'later', outcome: 'unattempted' }]) {
    const { audit, pageData } = fixture([row]); assert.equal(classifyScanCompletion(audit, pageData).status, 'INCOMPLETE');
    assert.equal(classifyScanCompletion(audit, pageData).executionStatus, 'INCOMPLETE');
  }
  const failed = fixture([], { url: seed, outcome: 'failed', reason: 'request_timeout' });
  assert.equal(classifyScanCompletion(failed.audit).status, 'FAILED');
  assert.equal(classifyScanCompletion(failed.audit, failed.pageData).status, 'FAILED');
});

test('completion is independent of absent, omitted or source-limited page-data exports', () => {
  const { audit, pageData } = fixture();
  assert.equal(classifyScanCompletion(audit).executionStatus, 'COMPLETED');
  assert.equal(classifyScanCompletion(audit).coverageStatus, 'COMPLETE');
  const omitted = { ...pageData, pages: [], exportedPages: 0, omittedPages: 1 };
  const sourceLimited = { ...pageData, pages: pageData.pages.map(page => ({ ...page, contentStatus: 'source_limit', extractionQuality: { status: 'unavailable', reasons: ['source_limit'] } })) };
  for (const data of [undefined, pageData, omitted, sourceLimited]) {
    const status = classifyScanCompletion(audit, data);
    assert.equal(status.status, 'COMPLETED');
    if (data !== pageData) { assert.equal(status.seedHtmlAnalyzed, null); assert.equal(status.analyzedHtmlPages, null); }
  }
});

test('known crawl gaps stay incomplete with and without exported content', () => {
  const { audit, pageData } = fixture([{ url: seed + 'timeout', outcome: 'failed', reason: 'request_timeout' }]);
  assert.equal(classifyScanCompletion(audit).status, 'INCOMPLETE');
  assert.equal(classifyScanCompletion(audit, pageData).status, 'INCOMPLETE');
  for (const reason of ['page_limit', 'html_analysis_incomplete', 'page_discovery_incomplete']) {
    const next = fixture(); next.audit.crawl.limitations.push(reason);
    assert.equal(classifyScanCompletion(next.audit).status, 'INCOMPLETE');
    assert.equal(classifyScanCompletion(next.audit, next.pageData).status, 'INCOMPLETE');
  }
});

const policy = { allowedHosts: ['fixture.test'], maxPages: 10, maxRequests: 30, maxRuntimeMs: 20_000, maxResponseBytes: 2_000_000, maxTotalResponseBytes: 5_000_000, minRequestIntervalMs: 0, maxConcurrency: 1, maxRetries: 0, maxImageChecks: 0 };
const htmlResponse = html => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) });
const simpleHtml = '<html><head><title>Fixture</title></head><body><h1>Fixture</h1></body></html>';
function config(request, overrides = {}) {
  return { startUrl: 'https://fixture.test/', pagespeed: false, contacts: false, technology: false, renderBrowser: false, policy, resolveAddresses: async () => ['93.184.216.34'], request: async url => url.pathname === '/robots.txt' ? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') } : request(url), ...overrides };
}
function assertCompletion(audit, expected, pageData) {
  assert.ok(isAuditResultRecord(audit));
  assert.equal(classifyScanCompletion(audit, pageData).status, expected);
  const partial = expected === 'INCOMPLETE' || expected === 'FAILED';
  assert.match(renderOperatorStatusHtml(audit, 'en'), partial ? /Crawl incomplete/u : /Crawl complete/u);
  const lines = [];
  const reporter = new ProgressReporter(line => lines.push(line));
  try { reporter.result(audit, pageData); reporter.succeed(); }
  finally { reporter.close(); }
  const label = expected === 'COMPLETED' ? 'complete' : expected === 'FAILED' ? 'failed' : 'partial';
  assert.ok(lines.some(line => line.includes(`success status=${label}`)));
}

test('optional image request and byte budgets do not turn a finished page crawl partial', async () => {
  // Reserve exactly one page response, leaving the robots response allowance.
  // Both exhaust the shared byte budget so only optional probes remain.
  const html = simpleHtml.replace('</body>', '<img src="/image.png" alt="Fixture" width="10" height="10"></body>');
  for (const budget of [{ maxRequests: 2 }, { maxResponseBytes: Buffer.byteLength(html), maxTotalResponseBytes: Buffer.byteLength(html) + Buffer.byteLength('missing') }]) {
    const audit = await auditWebsite(config(() => htmlResponse(html), { policy: { ...policy, maxImageChecks: 1, ...budget } }));
    assert.equal(audit.crawl.captured, 1);
    assert.equal(audit.crawl.unattempted, 0);
    assert.equal(audit.coverage.checks.imageSizes.unattempted, 1);
    assert.ok(audit.crawl.limitations.includes('image_check_budget_limit'));
    assert.ok(!audit.crawl.limitations.some(reason => ['request_limit', 'total_response_byte_limit'].includes(reason)));
    assert.equal(audit.capabilities.http, 'complete');
    assert.equal(audit.capabilities.robots, 'complete');
    assert.equal(audit.robotsObservation.retrieval, 'missing');
    assertCompletion(audit, 'COMPLETED');
  }
});

test('the same exhausted request budget remains a gap when a page is still queued', async () => {
  const audit = await auditWebsite(config(() => htmlResponse(simpleHtml.replace('</body>', '<a href="/next">Next</a></body>')), { policy: { ...policy, maxRequests: 2 } }));
  assert.equal(audit.crawl.unattempted, 1);
  assert.ok(audit.crawl.limitations.includes('request_limit'));
  assertCompletion(audit, 'INCOMPLETE');
});

test('received HTTP outcomes agree across the public audit, scan, log and operator report', async () => {
  for (const status of [401, 403, 404, 410, 500, 429, 503]) {
    const output = await auditWebsiteWithPageData(config(() => ({ ...htmlResponse(simpleHtml), status })));
    const expected = [429, 503].includes(status) ? 'INCOMPLETE' : 'COMPLETED';
    assert.equal(output.audit.capabilities.http, expected === 'COMPLETED' ? 'complete' : 'partial');
    assert.equal(output.audit.capabilities.technicalSeo, 'partial');
    assertCompletion(output.audit, expected);
    assertCompletion(output.audit, expected, output.pageData);
  }
});

test('received 401 responses complete with authentication counts and uninspected content for every media type', async () => {
  for (const contentType of ['text/html', 'text/plain', 'application/json', '']) {
    for (const authAtSeed of [true, false]) {
      const output = await auditWebsiteWithPageData(config(url => {
        if (!authAtSeed && url.pathname === '/') return htmlResponse(simpleHtml.replace('</body>', '<a href="/private">Private</a></body>'));
        return { status: 401, headers: { 'content-type': contentType }, body: Buffer.from('Authentication required') };
      }));
      const { audit, pageData } = output;
      const status = classifyScanCompletion(audit, pageData);
      assertCompletion(audit, 'COMPLETED', pageData);
      assert.equal(audit.crawl.failed, 0);
      assert.equal(audit.capabilities.http, 'complete');
      assert.equal(audit.capabilities.technicalSeo, 'partial');
      assert.equal(status.authenticationRequiredUrls, 1);
      assert.equal(status.blockedUrls, 0);
      assert.equal(status.transientOrOtherFailures, 0);
      assert.ok(status.coverageLimitations.includes('content_inspection_incomplete'));
      assert.equal(status.seedHtmlAnalyzed, !authAtSeed);
      const authUrl = 'https://fixture.test/' + (authAtSeed ? '' : 'private');
      assert.equal(audit.coverage.urls.find(row => row.url === authUrl).outcome, 'captured');
      const protectedPage = pageData.pages.find(page => page.requestedUrl === authUrl);
      assert.equal(protectedPage.extractionQuality.status, 'unavailable');
      assert.ok(protectedPage.extractionQuality.reasons.includes('http_error_response_not_inspected'));
      assert.equal(protectedPage.linksStatus, 'NOT_CHECKED');
      assert.ok(audit.findings.some(f => f.code === 'http_status_error' && f.evidence.some(e => e.pageUrl === authUrl && e.value === 401)));
      const lines = [];
      const reporter = new ProgressReporter(line => lines.push(line));
      try { reporter.result(audit); } finally { reporter.close(); }
      assert.ok(lines.some(line => line.includes('authentication_required=1')));
    }
  }
});

test('a failed seed fetch is FAILED with and without page-data export', async () => {
  const input = config(() => { throw Error('mock fetch failure'); });
  const audit = await auditWebsite(input);
  assert.equal(audit.crawl.failed, 1);
  assertCompletion(audit, 'FAILED');
  const output = await auditWebsiteWithPageData(input);
  assertCompletion(output.audit, 'FAILED', output.pageData);
});

test('a target omitted by the HTML link cap is a discovery gap unless another discovery source covers it', async () => {
  const links = Array.from({ length: 10_000 }, (_, index) => `<a href="https://outside.test/${index}">External</a>`).join('');
  for (const host of ['fixture.test', 'secondary.test']) for (const sitemap of [false, true]) {
    const target = `https://${host}/included`;
    const html = simpleHtml.replace('</body>', `${links}<a href="${target}">Eligible</a></body>`);
    const request = async url => {
      if (url.pathname === '/robots.txt') return { status: sitemap ? 200 : 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from(sitemap ? 'Sitemap: https://fixture.test/map.xml' : 'missing') };
      if (url.pathname === '/map.xml') return { status: 200, headers: { 'content-type': 'application/xml' }, body: Buffer.from(`<urlset><url><loc>${target}</loc></url></urlset>`) };
      return htmlResponse(url.pathname === '/' ? html : simpleHtml);
    };
    const audit = await auditWebsite(config(request, { request, policy: { ...policy, allowedHosts: ['fixture.test', 'secondary.test'] } }));
    if (host === 'fixture.test') assert.ok(audit.crawl.limitations.includes('internal_link_target_limit'));
    assert.equal(audit.crawl.limitations.includes('page_discovery_incomplete'), !sitemap);
    assert.equal(audit.coverage.urls.some(row => row.url.endsWith('/included')), sitemap);
    assertCompletion(audit, sitemap ? 'COMPLETED' : 'INCOMPLETE');
  }
});

test('export choices do not change completion of unsupported content or successful HTML captures', async () => {
  for (const contentType of ['text/html', 'application/xhtml+xml']) {
    const input = config(() => ({ ...htmlResponse(simpleHtml), headers: { 'content-type': contentType } }));
    const audit = await auditWebsite(input);
    assertCompletion(audit, 'COMPLETED');
    for (const options of [{}, { maxSourceBytesPerPage: 16, maxTotalSourceBytes: 16 }]) {
      const output = await auditWebsiteWithPageData(input, options);
      assertCompletion(output.audit, 'COMPLETED', output.pageData);
      if (contentType === 'text/html' && options.maxSourceBytesPerPage) {
        assert.equal(classifyScanCompletion(output.audit, output.pageData).seedHtmlAnalyzed, null);
        assert.equal(classifyScanCompletion(output.audit, output.pageData).analyzedHtmlPages, null);
      }
    }
  }
  const output = await auditWebsiteWithPageData(config(url => htmlResponse(url.pathname === '/' ? simpleHtml.replace('</body>', '<a href="/next">Next</a></body>') : simpleHtml)), { maxPages: 1 });
  assert.equal(output.pageData.omittedPages, 1);
  assertCompletion(output.audit, 'COMPLETED', output.pageData);
  assert.equal(classifyScanCompletion(output.audit, output.pageData).analyzedHtmlPages, null);
});

test('legacy analysis failure/truncation findings are crawl gaps even without the new limitation flag', () => {
  for (const code of ['analysis_failed', 'html_analysis_truncated']) {
    const { audit, pageData } = fixture();
    audit.findings = [{ code, category: 'content', observed: 'Incomplete HTML analysis', evidence: [{ pageUrl: seed, source: 'http', observedAt: audit.startedAt }] }];
    audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code, records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
    assertCompletion(audit, 'INCOMPLETE');
    assertCompletion(audit, 'INCOMPLETE', pageData);
  }
});

test('safety exclusions retain their reason without treating an ordinary child skip as a failed fetch', async () => {
  const audit = await auditWebsite(config(url => url.pathname === '/' ? htmlResponse(simpleHtml.replace('</body>', '<a href="/outside">Outside redirect</a></body>')) : { status: 302, headers: { location: 'https://outside.test/' }, body: Buffer.alloc(0) }));
  const skipped = audit.coverage.urls.find(row => row.url.endsWith('/outside'));
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.reason, 'external_host_blocked');
  assert.equal(audit.crawl.failed, 0);
  assertCompletion(audit, 'COMPLETED');
  const excludedSeed = await auditWebsite(config(() => ({ status: 302, headers: { location: 'https://outside.test/' }, body: Buffer.alloc(0) })));
  assert.ok(excludedSeed.crawl.limitations.includes('seed_url_safety_excluded'));
  assertCompletion(excludedSeed, 'INCOMPLETE');
});

test('unavailable optional robots observations do not hide their cause or change page completion', async () => {
  const audit = await auditWebsite(config(() => htmlResponse(simpleHtml), { request: async url => {
    if (url.pathname === '/robots.txt') throw Error('mock retrieval failure');
    return htmlResponse(simpleHtml);
  } }));
  assert.equal(audit.capabilities.robots, 'unavailable');
  assert.equal(audit.robotsObservation.retrieval, 'unavailable');
  assert.ok(audit.robotsObservation.error);
  assertCompletion(audit, 'COMPLETED');
});

test('429 applies exponential backoff even with a shorter Retry-After and respects a longer one', async () => {
  const events = []; let calls = 0;
  const options = { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 0, maxRetries: 2, retryBaseDelayMs: 10, retryMaxDelayMs: 100, resolveAddresses: async () => ['93.184.216.34'], scheduler: new CrawlRequestScheduler(1, 0), onRequestEvent: e => events.push(e), request: async () => ({ status: ++calls < 3 ? 429 : 200, headers: { 'retry-after': '0.001' }, body: Buffer.alloc(0) }) };
  assert.equal((await safeGet(seed, options)).status, 200);
  assert.deepEqual(events.filter(e => e.kind === 'retry').map(e => e.delayMs), [10, 20]);
  calls = 0; events.length = 0;
  const overCap = await safeGet(seed, { ...options, request: async () => { calls++; return { status: 429, headers: { 'retry-after': '1' }, body: Buffer.alloc(0) }; } });
  assert.equal(overCap.status, 429); assert.equal(calls, 1);
  assert.ok(events.some(e => e.kind === 'retry_after_exceeds_cap'));
});

test('standalone 404 is not a confirmed defect and 403 requires review', () => {
  for (const httpStatus of [404, 403]) {
    const { audit } = createEvidenceFixture(1);
    const url = 'https://fixture.example/page-000';
    audit.coverage.urls[0].statusCode = httpStatus;
    audit.findings = [{ code: 'http_status_error', category: 'indexability', observed: `Page returned HTTP ${httpStatus}.`, evidence: [{ pageUrl: url, observedAt: audit.startedAt, source: 'http', value: httpStatus }] }];
    audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'http_status_error', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
    const data = createPageDataExport([{ requestedUrl: url, finalUrl: url, statusCode: httpStatus, contentType: 'text/html', fetchedAt: audit.startedAt, responseBytes: 4, html: 'test' }]);
    const archive = verifyEvidencePack(createEvidencePack(audit, data));
    const graph = JSON.parse(archive.members.find(x => x.name === 'site-graph.json').content.toString());
    assert.notEqual(graph.findingAssessments[0].status, 'VERIFIED_DEFECT');
    if (httpStatus === 403) assert.equal(graph.findingAssessments[0].status, 'REVIEW_REQUIRED');
  }
});

test('single-site CLI writes separate completion status and keeps HTTP findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-completion-'));
  try {
    const out = join(dir, 'audit');
    await runCli(['https://fixture.example/', '--profile', 'default', '--out', out, '--pages', '10', '--requests', '30', '--runtime-ms', '30000', '--concurrency', '2', '--interval-ms', '0', '--retries', '0', '--image-checks', '0', '--page-data', `${out}.page-data.json`, '--no-pdf', '--no-pagespeed', '--no-browser', '--no-progress'], {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async url => {
        if (url.pathname === '/robots.txt') return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') };
        const status = url.pathname === '/missing' ? 404 : url.pathname === '/blocked' ? 403 : url.pathname === '/private' ? 401 : 200;
        return { status, headers: { 'content-type': status === 401 ? 'text/plain' : 'text/html' }, body: Buffer.from(status === 200 ? '<html><body><a href="/missing">Missing</a><a href="/blocked">Blocked</a><a href="/private">Private</a></body></html>' : '<html><body>Error</body></html>') };
      },
    });
    const status = JSON.parse(await readFile(`${out}.scan-status.json`, 'utf8'));
    const audit = JSON.parse(await readFile(`${out}.json`, 'utf8'));
    assert.equal(status.status, 'COMPLETED'); assert.equal(status.missingUrls, 1); assert.equal(status.blockedUrls, 1);
    assert.equal(status.authenticationRequiredUrls, 1);
    assert.equal(status.transientOrOtherFailures, 0);
    assert.ok(status.coverageLimitations.includes('content_inspection_incomplete'));
    assert.ok(audit.findings.some(f => f.code === 'broken_internal_link'));
    assert.ok(audit.findings.some(f => f.code === 'http_status_error' && f.evidence.some(e => e.value === 403)));
    assert.ok(audit.findings.some(f => f.code === 'http_status_error' && f.evidence.some(e => e.value === 401)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
