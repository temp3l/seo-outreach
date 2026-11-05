import assert from 'node:assert/strict';
import * as http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyAddress, validateWebUrl } from '@spora/webcrawl/core/network-policy';
import { analyzePage } from '@spora/webcrawl/analysis/technical';
import { fetchRobots, parseRobots, robotsAdmission, robotsAllows } from '@spora/webcrawl/crawler/robots';
import { parseSitemap, parseSitemapDocument } from '@spora/webcrawl/crawler/sitemap';
import { renderAuditHtml } from '../dist/reports/html.js';
import { FileRecordingStore, recordingDigest } from '@spora/webcrawl/recordings/store';

test('destination policy rejects local, private, documentation, and metadata targets', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'localhost');
  assert.equal(classifyAddress('10.2.3.4'), 'private_address');
  assert.equal(classifyAddress('169.254.169.254'), 'metadata_endpoint');
  assert.equal(classifyAddress('2001:db8::1'), 'non_global_address');
  assert.equal(classifyAddress('198.18.0.1'), 'non_global_address');
  assert.equal(classifyAddress('203.0.113.9'), 'non_global_address');
  assert.equal(classifyAddress('3fff::1'), 'non_global_address');
  assert.throws(() => validateWebUrl('file:///etc/passwd'), /unsupported_scheme/u);
  assert.throws(() => validateWebUrl('http://127.0.0.1/'), /localhost/u);
  assert.equal(validateWebUrl('https://example.com/a#fragment').href, 'https://example.com/a');
});

test('IPv6 classification is invariant across compressed and expanded spellings', () => {
  const spellings = [
    ['fc00::1', 'fc00:0000:0000:0000:0000:0000:0000:0001', 'fc00:0:0:0:0:0:0:1'],
    ['fe80::1', 'fe80:0000:0000:0000:0000:0000:0000:0001'],
    ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001'],
  ];
  for (const group of spellings) assert.equal(new Set(group.map(classifyAddress)).size, 1);
  assert.equal(classifyAddress('2606:4700:4700::1111'), null);
});

test('robots longest agent selection considers only tokens matching the requested agent', () => {
  const parsed = parseRobots('User-agent: bot\nDisallow: /bot\nUser-agent: bot-extra\nDisallow: /extra', 'bot/1.0');
  assert.deepEqual(parsed.rules, [{ allow: false, path: '/bot' }]);
});

test('page noindex uses exact directive tokens, including none, without enforcing robots requests', async () => {
  const { hasNoindexDirective } = await import('@spora/webcrawl/core/robots-directives');
  assert.equal(hasNoindexDirective(['NONE']), true);
  assert.equal(hasNoindexDirective(['index, follow']), false);
  assert.equal(hasNoindexDirective(['not-noindex']), false);
  assert.equal(hasNoindexDirective(['googlebot: none']), true);
});

test('first rejected document base falls back to document URL instead of a later base', async () => {
  const { effectiveDocumentBase } = await import('@spora/webcrawl/analysis/html-links');
  const { parse } = await import('parse5');
  const doc = parse('<base href="javascript:alert(1)"><base href="https://other.example/"><a href="/x">x</a>');
  const nodes = [];
  const stack = [doc];
  while (stack.length) { const node = stack.pop(); nodes.push(node); if ('childNodes' in node) stack.push(...[...node.childNodes].reverse()); }
  assert.equal(effectiveDocumentBase(nodes, 'https://origin.example/path'), 'https://origin.example/path');
});

test('robots rules use longest path match and fail closed when unavailable', () => {
  const parsed = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/open\nSitemap: https://example.com/sitemap.xml');
  const policy = { status: 'available', ...parsed, fetchedAt: '2026-01-01T00:00:00.000Z', requestCount: 1 };
  assert.equal(robotsAllows(policy, new URL('https://example.com/private/open/page')), true);
  assert.equal(robotsAllows(policy, new URL('https://example.com/private/page')), false);
  assert.equal(robotsAllows({ ...policy, status: 'unavailable' }, new URL('https://example.com/')), false);
  assert.equal(robotsAllows({ ...policy, status: 'missing', rules: [] }, new URL('https://example.com/')), true);
});

test('robots directives are observation-only and explicit enforcement requests are rejected', async () => {
  const { robotsAdmits, assertRobotsObservationOnly } = await import('@spora/webcrawl/crawler/robots');
  const url = new URL('https://example.com/private/page');
  const disallowed = { status: 'available', rules: [{ allow: false, path: '/private/' }], sitemapUrls: [], fetchedAt: 'now', requestCount: 1, responseBytes: 0 };
  const unavailable = { ...disallowed, status: 'unavailable', rules: [] };
  assert.equal(robotsAdmits(undefined, disallowed, url), true);
  assert.equal(robotsAdmits('ignore', disallowed, url), true);
  assert.equal(robotsAdmits('ignore', unavailable, url), true);
  assert.equal(robotsAdmits('respect', disallowed, url), false);
  assert.equal(robotsAdmits('respect', unavailable, url), false);
  assert.equal(robotsAdmission('respect', disallowed, url), 'disallowed');
  assert.equal(robotsAdmission('respect', unavailable, url), 'unavailable');
  assert.doesNotThrow(() => assertRobotsObservationOnly('respect'));
  assert.doesNotThrow(() => assertRobotsObservationOnly('ignore'));
});

test('robots fetch distinguishes available, missing, HTTP unavailable, and sanitized transport causes', async () => {
  const origin = new URL('https://fixture.example/');
  const base = { allowedHosts: ['fixture.example'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2, maxRetries: 0, resolveAddresses: async () => ['8.8.8.8'] };
  const response = (status, body = '') => ({ status, headers: {}, body: Buffer.from(body) });
  const available = await fetchRobots(origin, { ...base, request: async () => response(200, 'User-agent: *\nDisallow: /private') });
  assert.equal(available.status, 'available');
  assert.deepEqual(available.rules, [{ allow: false, path: '/private' }]);
  assert.equal(available.failureCode, undefined);
  for (const status of [404, 410]) {
    const missing = await fetchRobots(origin, { ...base, request: async () => response(status) });
    assert.equal(missing.status, 'missing');
    assert.equal(missing.failureCode, undefined);
  }
  const forbidden = await fetchRobots(origin, { ...base, request: async () => response(403) });
  assert.equal(forbidden.status, 'unavailable');
  assert.equal(forbidden.failureCode, 'http_status_error');
  const dns = await fetchRobots(origin, { ...base, resolveAddresses: async () => { throw Object.assign(new Error('private detail hidden'), { code: 'EAI_AGAIN' }); } });
  assert.equal(dns.status, 'unavailable');
  assert.equal(dns.failureCode, 'dns_lookup_failed');
  assert.equal(dns.requestCount, 0);
  assert.equal(JSON.stringify(dns).includes('private detail hidden'), false);
  const unsafe = await fetchRobots(origin, { ...base, resolveAddresses: async () => ['127.0.0.1'] });
  assert.equal(unsafe.failureCode, 'unsafe_address');
  const reset = await fetchRobots(origin, { ...base, request: async () => { throw Object.assign(new Error('sensitive socket detail'), { code: 'ECONNRESET' }); } });
  assert.equal(reset.failureCode, 'network_unreachable');
  assert.equal(JSON.stringify(reset).includes('sensitive socket detail'), false);
});

test('sitemap parser restricts entries to authorized hosts and caps expansion', () => {
  const xml = '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://other.example/b</loc></url><url><loc>https://example.com/c</loc></url></urlset>';
  assert.deepEqual(parseSitemap(xml, 'https://example.com/sitemap.xml', ['example.com'], 1), ['https://example.com/a']);
});

test('sitemap parser distinguishes bounded sitemap indexes from page URL sets', () => {
  const index = parseSitemapDocument('<sitemapindex><sitemap><loc>https://example.com/posts.xml</loc></sitemap><sitemap><loc>https://outside.example/other.xml</loc></sitemap></sitemapindex>', 'https://example.com/sitemap.xml', ['example.com']);
  assert.deepEqual(index, { kind: 'index', urls: ['https://example.com/posts.xml'], truncated: false, malformed: false, omittedUrls: 0, rejectedUrls: 1 });
  const pages = parseSitemapDocument('<urlset><url><loc>https://example.com/page</loc></url></urlset>', 'https://example.com/pages.xml', ['example.com']);
  assert.deepEqual(pages, { kind: 'urlset', urls: ['https://example.com/page'], truncated: false, malformed: false, omittedUrls: 0 });
});

test('sitemap parser handles namespaced tags and escaped query ampersands within its cap', () => {
  const xml = '<x:urlset xmlns:x="http://www.sitemaps.org/schemas/sitemap/0.9"><x:url><x:loc>https://example.com/a?one=1&amp;two=2</x:loc></x:url><x:url><x:loc>https://example.com/b</x:loc></x:url></x:urlset>';
  assert.deepEqual(parseSitemapDocument(xml, 'https://example.com/sitemap.xml', ['example.com'], 1), { kind: 'urlset', urls: ['https://example.com/a?one=1&two=2'], truncated: true, malformed: false, omittedUrls: 1 });
  assert.equal(parseSitemapDocument('<urlset><url><loc>https://example.com/a</loc>', 'https://example.com/sitemap.xml', ['example.com']).malformed, true);
  assert.equal(parseSitemapDocument('<urlset><url><loc>https://example.com/a</loc></bad></urlset>', 'https://example.com/sitemap.xml', ['example.com']).malformed, true);
});

test('technical analysis parses malformed-but-recoverable HTML and emits evidence', () => {
  const findings = analyzePage({ requestedUrl: 'https://example.com', finalUrl: 'https://example.com', statusCode: 200, contentType: 'text/html', fetchedAt: '2026-01-01T00:00:00.000Z', responseBytes: 12, html: '<TITLE>A &amp; B</TITLE><img src="x"><h1>One</h1><h1>Two</h1>' });
  assert.ok(findings.some((item) => item.code === 'missing_meta_description'));
  assert.ok(findings.some((item) => item.code === 'multiple_h1'));
  assert.ok(findings.some((item) => item.code === 'images_missing_alt'));
  assert.ok(findings.every((item) => item.evidence[0]?.pageUrl === 'https://example.com'));
});

test('link discovery ignores script-shaped markup and inert templates', async () => {
  const { extractPageLinks } = await import('@spora/webcrawl/crawler/link-extractor');
  const html = '<script>const view = \'<a href="/itemDataObject.url">\';</script><a href="/real?a=1&amp;b=2">Real</a><template><a href="/inert">Inert</a></template>';
  assert.deepEqual(extractPageLinks(html), ['/real?a=1&b=2']);
});

test('HTTP error pages emit status findings without content SEO findings', () => {
  const findings = analyzePage({ requestedUrl: 'https://example.com/missing', finalUrl: 'https://example.com/missing', statusCode: 404, contentType: 'text/html', fetchedAt: '2026-01-01T00:00:00.000Z', responseBytes: 20, html: '<title>Not Found</title><meta name="robots" content="noindex"><h1>Not Found</h1>' });
  assert.deepEqual(findings.map((finding) => finding.code), ['http_status_error']);
  assert.equal(findings[0].severity, 'medium');
});

test('HTML report escapes findings and keeps links source-backed', () => {
  const html = renderAuditHtml({ schemaVersion: '1', startedAt: 'a', completedAt: 'b', target: 'https://example.com/?x=1&y=2', crawl: { discovered: 1, attempted: 1, captured: 1, failed: 0, skipped: 0, unattempted: 0, limitations: [] }, capabilities: {}, findings: [{ code: '<script>', category: 'metadata', observed: '<bad>', evidence: [{ pageUrl: 'https://example.com/', observedAt: 'now', source: 'http' }] }] });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('https://example.com/'));
  const german = renderAuditHtml({ schemaVersion: '1', startedAt: 'a', completedAt: 'b', target: 'https://example.com', crawl: { discovered: 0, attempted: 0, captured: 0, failed: 0, skipped: 0, unattempted: 0, limitations: [] }, capabilities: {}, findings: [] }, { locale: 'de' });
  assert.ok(german.includes('lang="de"'));
  assert.ok(german.includes('Abdeckung'));
});

test('file recording store validates content digest and confines identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-'));
  try {
    const payload = { pages: 1 };
    const unsigned = { schemaVersion: '1', id: 'capture-1', capturedAt: '2026-01-01T00:00:00.000Z', target: 'https://example.com', payload };
    const record = { ...unsigned, sha256: recordingDigest(unsigned) };
    const store = new FileRecordingStore(root);
    await store.put(record);
    assert.deepEqual(await store.get(record.id), record);
    await assert.rejects(store.put({ ...record, id: '../escape' }), /invalid_recording_id/u);
    await assert.rejects(store.put({ ...record, sha256: '0'.repeat(64) }), /recording_digest_mismatch/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recording store rejects a FIFO promptly without a peer writer', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-fifo-'));
  try {
    execFileSync('mkfifo', [join(root, 'blocked.json')]);
    const store = new FileRecordingStore(root);
    await assert.rejects(Promise.race([store.get('blocked'), new Promise((_, reject) => setTimeout(() => reject(new Error('timed_out')), 500))]), /unsafe_recording_file/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('safe transport blocks private DNS answers before any request dispatch', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  let dispatched = false;
  await assert.rejects(safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2, resolveAddresses: async () => ['127.0.0.1'], request: async () => { dispatched = true; return { status: 200, headers: {}, body: Buffer.alloc(0) }; } }), /unsafe_dns_resolution/u);
  assert.equal(dispatched, false);
});

test('safe transport stops an external redirect before dispatching its target', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const dispatched = [];
  await assert.rejects(safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2, resolveAddresses: async () => ['93.184.216.34'], request: async (url) => { dispatched.push(url.href); return { status: 302, headers: { location: 'https://outside.example/' }, body: Buffer.alloc(0) }; } }), /external_host_blocked/u);
  assert.deepEqual(dispatched, ['https://example.com/']);
});

test('safe transport applies caller admission policy to every redirect hop', async () => {
  const { safeGet, SafeRequestError } = await import('@spora/webcrawl/crawler/safe-transport');
  const dispatched = [];
  await assert.rejects(safeGet('https://example.com/public', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2, admitUrl: (url) => !url.pathname.startsWith('/private'), resolveAddresses: async () => ['93.184.216.34'], request: async (url) => {
    dispatched.push(url.href);
    return { status: 302, headers: { location: '/private/image.webp' }, body: Buffer.alloc(0) };
  } }), (error) => error instanceof SafeRequestError && error.message === 'robots_disallowed_redirect' && error.requestCount === 1);
  assert.deepEqual(dispatched, ['https://example.com/public']);
});

test('sensitive and transactional URLs are rejected before capture', () => {
  for (const query of ['add-to-cart=123', 'add_to_cart=123', 'addToCart=123', 'remove-from-cart=abc', 'wc-ajax=add_to_cart', 'action=update_cart']) {
    assert.throws(() => validateWebUrl(`https://example.com/product/item/?${query}`), /sensitive_or_transactional_url/u);
  }
  assert.equal(validateWebUrl('https://example.com/product/item/?color=blue').href, 'https://example.com/product/item/?color=blue');
  assert.throws(() => validateWebUrl('https://example.com/reset?token=private'), /sensitive_or_transactional_url/u);
  assert.throws(() => validateWebUrl('https://example.com/?jwt=private'), /sensitive_or_transactional_url/u);
  assert.throws(() => validateWebUrl('https://example.com/?auth=private'), /sensitive_or_transactional_url/u);
  assert.throws(() => validateWebUrl('https://example.com/logout'), /sensitive_or_transactional_url/u);
});

test('safe transport summarizes Set-Cookie attributes without returning cookie values', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const response = await safeGet('https://example.com/', {
    allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 0,
    resolveAddresses: async () => ['93.184.216.34'],
    request: async () => ({ status: 200, headers: { 'Set-Cookie': 'token=should-not-leak' }, setCookies: ['sessionid=should-not-leak; Secure; HttpOnly; SameSite=Lax'], body: Buffer.from('ok') }),
  });
  assert.deepEqual(response.cookieObservations, [{ name: 'sessionid', deleted: false, secure: true, httpOnly: true, sameSite: 'lax', sessionLike: true, responseUrl: 'https://example.com/', responseStatus: 200, redirectHop: 0, retryAttempt: 0 }]);
  assert.deepEqual(response.headers, {});
  assert.equal(JSON.stringify(response).includes('should-not-leak'), false);
});

test('safe transport accumulates privacy-safe cookie attributes across redirects and retries', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  let calls = 0;
  const response = await safeGet('https://example.com/start', {
    allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 1, maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0,
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      calls++;
      if (url.pathname === '/start') return { status: 302, headers: { location: '/done' }, setCookies: ['sessionid=redirect-secret; HttpOnly'], body: Buffer.alloc(0) };
      if (calls === 2) return { status: 429, headers: {}, setCookies: ['csrf=retry-secret; Secure; SameSite=Lax'], body: Buffer.alloc(0) };
      return { status: 200, headers: {}, setCookies: ['preference=final-secret; Secure'], body: Buffer.alloc(0) };
    },
  });
  assert.deepEqual(response.cookieObservations.map(({ name }) => name), ['sessionid', 'csrf', 'preference']);
  assert.equal(response.cookieObservationsTruncated, false);
  assert.ok(!JSON.stringify(response).includes('redirect-secret'));
  assert.ok(!JSON.stringify(response).includes('retry-secret'));
  assert.ok(!JSON.stringify(response).includes('final-secret'));
});

test('package root and subpath exports expose the documented consumer API', async () => {
  const api = await import('@spora/webcrawl');
  const crawler = await import('@spora/webcrawl/crawler');
  const reports = await import('@spora/seo-outreach/reports');
  const enrichments = await import('@spora/webcrawl/enrichments');
  assert.equal(typeof api.auditWebsite, 'function');
  assert.equal(typeof api.auditWebsiteWithPageData, 'function');
  assert.equal(typeof crawler.safeGet, 'function');
  assert.equal(typeof reports.renderAuditPdf, 'function');
  assert.equal(typeof enrichments.createPageSpeedEnrichment, 'function');
});

test('PageSpeed adapter keeps API credentials out of the URL and projects scores only', async () => {
  const { createPageSpeedEnrichment } = await import('@spora/webcrawl/enrichments/pagespeed');
  let requestUrl = '';
  let requestKey = '';
  const enrichment = createPageSpeedEnrichment({ apiKey: 'secret-key', fetch: async (input, init) => {
    requestUrl = String(input);
    requestKey = new Headers(init?.headers).get('x-goog-api-key') ?? '';
    return new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.91 } } } }), { status: 200 });
  } });
  const result = await enrichment.run({ target: 'https://example.com/', capturedAt: '2026-01-01T00:00:00.000Z', pages: [] });
  assert.equal(new URL(requestUrl).searchParams.has('key'), false);
  assert.equal(requestKey, 'secret-key');
  assert.equal(result.findings[0]?.evidence[0]?.value, 91);
});

test('audit recordings validate, hash, and replay typed results offline', async () => {
  const { createAuditRecording, replayAuditRecording } = await import('@spora/webcrawl/recordings/replay');
  const { createEvidenceFixture } = await import('./fixtures/evidence-pack-fixture.mjs');
  const { audit } = createEvidenceFixture(1);
  const recording = createAuditRecording({ id: 'fixture-1', capturedAt: audit.completedAt, target: audit.target, audit });
  assert.deepEqual(replayAuditRecording(recording), audit);
  assert.throws(() => replayAuditRecording({ ...recording, payload: { ...audit, target: 'https://other.example' } }), /recording_digest_mismatch/u);
  assert.throws(() => createAuditRecording({ id: 'fixture-2', capturedAt: audit.completedAt, target: 'https://other.example', audit }), /recording_identity_mismatch/u);
  const conflictingTarget = { ...recording, target: 'https://other.example' };
  const { sha256: _oldTargetHash, ...targetUnsigned } = conflictingTarget;
  assert.throws(() => replayAuditRecording({ ...targetUnsigned, sha256: recordingDigest(targetUnsigned) }), /recording_identity_mismatch/u);
  const conflictingTime = { ...recording, capturedAt: '2026-01-02T00:00:00.000Z' };
  const { sha256: _oldTimeHash, ...timeUnsigned } = conflictingTime;
  assert.throws(() => replayAuditRecording({ ...timeUnsigned, sha256: recordingDigest(timeUnsigned) }), /recording_identity_mismatch/u);
});

test('audit replay upgrades legacy coverage with explicit unavailable security checks', async () => {
  const { parseAuditResult } = await import('@spora/webcrawl/recordings/replay');
  const localLinkCheck = { status: 'complete', scope: 'same_host', discovered: 0, checked: 0, findings: 0, failed: 0, skipped: 0, unattempted: 0, outOfScope: 0 };
  const parsed = parseAuditResult({
    schemaVersion: '1', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:00Z', target: 'https://example.com/',
    crawlSettings: { policy: { allowedHosts: ['example.com'], maxPages: 1, maxRequests: 1, maxRuntimeMs: 1000, maxResponseBytes: 1000, maxTotalResponseBytes: 1000, maxConcurrency: 1, minRequestIntervalMs: 0 }, userAgent: 'fixture', renderBrowser: false, retainHtml: false, enrichments: [] },
    crawl: { discovered: 0, attempted: 0, captured: 0, failed: 0, skipped: 0, unattempted: 0, limitations: [] },
    capabilities: {}, findings: [],
    coverage: { urls: [], checks: { internalLinks: localLinkCheck, imageSizes: localLinkCheck }, findings: { records: 0, checkCodes: 0, affectedPages: 0, evidenceOccurrences: 0, byCheck: [] } },
  }, { legacy: true });
  assert.equal(parsed.coverage?.checks.securityHeaders.status, 'unavailable');
  assert.equal(parsed.coverage?.checks.securityTxt.status, 'disabled');
});

test('sensitive filtering normalizes camel case and encoded action paths', () => {
  assert.throws(() => validateWebUrl('https://example.com/?accessToken=secret'), /sensitive_or_transactional_url/u);
  assert.throws(() => validateWebUrl('https://example.com/%256cogout'), /sensitive_or_transactional_url/u);
});

test('robots fetching is constrained to the origin host and browser budget is shared', async () => {
  const { robotsFetchOptions } = await import('@spora/webcrawl/crawler/robots');
  const { remainingCrawlPolicy, securityTxtRobotsOrigin } = await import('@spora/webcrawl/crawler/crawl');
  const opts = { allowedHosts: ['example.com', 'cdn.example.com'], timeoutMs: 1, maxResponseBytes: 10, maxRedirects: 5 };
  assert.deepEqual(robotsFetchOptions(new URL('https://example.com'), opts).allowedHosts, ['example.com']);
  const policy = { allowedHosts: ['example.com'], robots: 'respect', maxPages: 10, maxRequests: 50, maxRuntimeMs: 1000, maxResponseBytes: 100, maxTotalResponseBytes: 1000, minRequestIntervalMs: 5, maxConcurrency: 1 };
  assert.deepEqual(remainingCrawlPolicy(policy, 20, 400, 250), { ...policy, maxRequests: 30, maxTotalResponseBytes: 600, maxRuntimeMs: 750 });
  assert.equal(securityTxtRobotsOrigin(new URL('http://example.com/path')).href, 'https://example.com/');
  assert.equal(securityTxtRobotsOrigin(new URL('https://example.com/path')).href, 'https://example.com/');
});

test('browser rendering rejects empty remaining budgets before launching Playwright', async () => {
  const { renderPageInBrowser } = await import('@spora/webcrawl/crawler/browser-render');
  await assert.rejects(renderPageInBrowser({ url: 'https://example.com/', policy: { allowedHosts: ['example.com'], robots: 'ignore', maxPages: 1, maxRequests: 0, maxRuntimeMs: 1000, maxResponseBytes: 100, maxTotalResponseBytes: 100, minRequestIntervalMs: 0, maxConcurrency: 1 }, robots: { status: 'available', rules: [], sitemapUrls: [], fetchedAt: 'now', requestCount: 1, responseBytes: 0 }, userAgent: 'webcrawl-test', timeoutMs: 1000 }), /browser_budget_exhausted/u);
});

test('safe transport reports failed physical dispatches for budget accounting', async () => {
  const { safeGet, SafeRequestError } = await import('@spora/webcrawl/crawler/safe-transport');
  await assert.rejects(safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2, resolveAddresses: async () => ['93.184.216.34'], request: async () => { throw new Error('connection_reset'); } }), (error) => error instanceof SafeRequestError && error.requestCount === 1);
});

test('pinned DNS lookup supports Node all-address callbacks', async () => {
  const { createPinnedLookup } = await import('@spora/webcrawl/crawler/safe-transport');
  const server = http.createServer((_request, response) => response.end('pinned lookup passed'));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const body = await new Promise((resolve, reject) => {
      const fixtureUrl = `http://pinned-lookup.test:${address.port}/`;
      const lookup = createPinnedLookup(['127.0.0.1']);
      const fixtureGet = globalThis.__webcrawlOwnedPinnedGet?.(fixtureUrl, lookup) ?? http.get;
      const request = fixtureGet(fixtureUrl, { autoSelectFamily: true, lookup }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error', reject);
    });
    assert.equal(body, 'pinned lookup passed');
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('safe transport preserves partial bytes from a failed response', async () => {
  const { safeGet, SafeRequestError } = await import('@spora/webcrawl/crawler/safe-transport');
  await assert.rejects(safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 1000, maxRedirects: 2, resolveAddresses: async () => ['93.184.216.34'], request: async () => { throw new SafeRequestError(1, 37, new Error('body_timeout')); } }), (error) => error instanceof SafeRequestError && error.requestCount === 1 && error.responseBytes === 37);
});

test('safe transport retries bounded transient statuses and charges each physical request', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const { CrawlRequestBudget } = await import('@spora/webcrawl/crawler/request-control');
  const budget = new CrawlRequestBudget(2, 100);
  let dispatches = 0;
  const response = await safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 0, maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0, budget, resolveAddresses: async () => ['93.184.216.34'], request: async () => {
    dispatches++;
    return dispatches === 1 ? { status: 503, headers: {}, body: Buffer.from('retry') } : { status: 200, headers: {}, body: Buffer.from('ok') };
  } });
  assert.equal(response.status, 200);
  assert.equal(response.requestCount, 2);
  assert.equal(response.responseBytes, 7);
  assert.equal(budget.requestCount, 2);
  assert.equal(budget.responseBytes, 7);
});

test('short Retry-After defers sibling requests on the shared scheduler', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const { CrawlRequestBudget, CrawlRequestScheduler } = await import('@spora/webcrawl/crawler/request-control');
  const budget = new CrawlRequestBudget(4, 100);
  const scheduler = new CrawlRequestScheduler(2, 0);
  const starts = [];
  let firstAttempts = 0;
  const shared = { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 0, maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 1000, budget, scheduler, resolveAddresses: async () => ['93.184.216.34'] };
  const first = safeGet('https://example.com/first', { ...shared, request: async () => {
    starts.push(Date.now());
    firstAttempts++;
    return firstAttempts === 1 ? { status: 429, headers: { 'retry-after': '0.03' }, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: Buffer.alloc(0) };
  } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = safeGet('https://example.com/second', { ...shared, request: async () => { starts.push(Date.now()); return { status: 200, headers: {}, body: Buffer.alloc(0) }; } });
  await Promise.all([first, second]);
  assert.ok(starts[2] - starts[0] >= 20);
});

test('a final 429 still defers siblings even when retries are disabled', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const { CrawlRequestBudget, CrawlRequestScheduler } = await import('@spora/webcrawl/crawler/request-control');
  const budget = new CrawlRequestBudget(2, 100);
  const scheduler = new CrawlRequestScheduler(2, 0);
  const startTimes = [];
  const shared = { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 0, maxRetries: 0, retryMaxDelayMs: 1000, budget, scheduler, resolveAddresses: async () => ['93.184.216.34'] };
  await safeGet('https://example.com/limited', { ...shared, request: async () => { startTimes.push(Date.now()); return { status: 429, headers: { 'retry-after': '0.03' }, body: Buffer.alloc(0) }; } });
  await safeGet('https://example.com/sibling', { ...shared, request: async () => { startTimes.push(Date.now()); return { status: 200, headers: {}, body: Buffer.alloc(0) }; } });
  assert.ok(startTimes[1] - startTimes[0] >= 20);
});

test('safe transport retries transient coded socket failures', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  let dispatches = 0;
  const response = await safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 0, maxRetries: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0, resolveAddresses: async () => ['93.184.216.34'], request: async () => {
    dispatches++;
    if (dispatches === 1) throw Object.assign(new Error('socket failed'), { code: 'ECONNRESET' });
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  } });
  assert.equal(response.requestCount, 2);
});

test('safe transport enforces the shared byte cap for custom transports', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const { CrawlRequestBudget } = await import('@spora/webcrawl/crawler/request-control');
  const budget = new CrawlRequestBudget(2, 3);
  await assert.rejects(safeGet('https://example.com/', { allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 10, maxRedirects: 0, budget, resolveAddresses: async () => ['93.184.216.34'], request: async () => ({ status: 200, headers: {}, body: Buffer.from('four') }) }), /total_response_bytes_exceeded/u);
  assert.equal(budget.responseBytes, 4);
});

test('safe transport supports bounded HEAD probes through the shared request budget', async () => {
  const { safeGet } = await import('@spora/webcrawl/crawler/safe-transport');
  const { CrawlRequestBudget } = await import('@spora/webcrawl/crawler/request-control');
  const budget = new CrawlRequestBudget(1, 0);
  let dispatchedMethod = '';
  const response = await safeGet('https://example.com/image.webp', { method: 'HEAD', allowedHosts: ['example.com'], timeoutMs: 1000, maxResponseBytes: 100, maxRedirects: 0, budget, resolveAddresses: async () => ['93.184.216.34'], request: async (_url, _addresses, options) => {
    dispatchedMethod = options.method;
    return { status: 200, headers: { 'content-type': 'image/webp', 'content-length': '640000' }, body: Buffer.alloc(0) };
  } });
  assert.equal(dispatchedMethod, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.responseBytes, 0);
  assert.equal(budget.requestCount, 1);
  assert.equal(budget.responseBytes, 0);
});

test('failed browser render errors retain consumed request and byte usage', async () => {
  const { BrowserRenderError } = await import('@spora/webcrawl/crawler/browser-render');
  const error = new BrowserRenderError(4, 1200, new Error('navigation_failed'));
  assert.equal(error.requests, 4);
  assert.equal(error.responseBytes, 1200);
  assert.equal(error.message, 'navigation_failed');
});

test('crawl API rejects header-injection user agents before network work', async () => {
  const { crawlSite } = await import('@spora/webcrawl/crawler/crawl');
  await assert.rejects(crawlSite({ startUrl: 'https://example.com/', userAgent: 'webcrawl\r\nX-Injected: yes', policy: { allowedHosts: ['example.com'], maxPages: 1, maxRequests: 1, maxRuntimeMs: 1000, maxResponseBytes: 1000, maxTotalResponseBytes: 1000, minRequestIntervalMs: 0, maxConcurrency: 1 } }), /invalid_user_agent/u);
});
