import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { auditWebsite, auditWebsiteWithPageData } from '@spora/webcrawl/core/audit';
import { createDefaultCrawlPolicy } from '@spora/webcrawl/core/defaults';
import { createPageDataExport } from '@spora/webcrawl/analysis/page-data';
import { createEvidencePack, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';

const target = 'https://fixture.example/';
const html = '<html lang="en"><title>Fixture</title><h1>Fixture</h1></html>';
function config(source = html, contentType = 'text/html', status = 200) {
  return { startUrl: target, contacts: false, pagespeed: false,
    policy: createDefaultCrawlPolicy(target, { maxRequests: 3, maxPages: 1, maxImageChecks: 0, minRequestIntervalMs: 0, maxRetries: 0 }),
    resolveAddresses: async () => ['93.184.216.34'], request: async url => ({ status: url.pathname === '/robots.txt' ? 404 : status, headers: { 'content-type': contentType }, body: Buffer.from(url.pathname === '/robots.txt' ? '' : source) }) };
}
test('adapter evidence admission isolates malformed optional fields and accepts complete valid evidence', async () => {
  const evidence = { pageUrl: target, observedAt: '2026-10-30T00:00:00Z', source: 'derived' };
  const adapter = (name, extra) => ({ name, requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [{ code: 'fixture', category: 'content', observed: 'Fixture', evidence: [{ ...evidence, ...extra }] }] }) });
  const good = adapter('good', { requestedUrl: target, redirectChain: [target], value: 1, excerpt: 'short', excerptOriginalLength: 10, excerptTruncated: true });
  for (const extra of [{ requestedUrl: 'invalid' }, { finalUrl: 'file:///tmp/private' }, { redirectChain: 'wrong' }, { anchorText: 'x'.repeat(241) }, { excerpt: 'short', excerptOriginalLength: 0, excerptTruncated: true }, { value: NaN }, { value: Infinity }, { imageObservations: {} }, { imageObservations: [{ occurrence: -1 }] }, { imageObservationsOmitted: -1 }, { fragmentStatus: 'checked' }, { source: ['http'] }]) {
    const audit = await auditWebsite(config(), [good, adapter('bad', extra)]);
    assert.equal(audit.capabilities.good, 'complete');
    assert.equal(audit.capabilities.bad, 'failed', JSON.stringify(extra));
    assert.equal(audit.enrichmentLimitations.bad, 'invalid_enrichment_result');
  }
  for (const result of [
    { status: ['complete'], findings: [] },
    { status: { toString: () => 'complete' }, findings: [] },
    { status: 'complete', findings: [{ code: 'fixture', category: ['content'], observed: 'Fixture', evidence: [] }] },
    { status: 'complete', findings: [{ code: 'fixture', category: 'content', severity: ['low'], observed: 'Fixture', evidence: [] }] },
  ]) {
    const audit = await auditWebsite(config(), [good, { name: 'bad', requirements: { input: 'target' }, run: async () => result }]);
    assert.equal(audit.capabilities.good, 'complete');
    assert.equal(audit.capabilities.bad, 'failed');
    assert.equal(audit.enrichmentLimitations.bad, 'invalid_enrichment_result');
  }
});

test('saved audit admission validates supported optional structures and safe report sinks', async () => {
  const { parseAuditResult, createAuditRecording, replayAuditRecording } = await import('@spora/webcrawl/recordings/replay');
  const { MemoryRecordingStore } = await import('@spora/webcrawl/recordings/store');
  const { renderAuditHtml } = await import('../dist/reports/html.js');
  const { renderOperatorStatusHtml } = await import('../dist/reports/summary.js');
  const { audit, pageData } = createEvidenceFixture(1);
  audit.crawlSettings.policy.robots = 'observation-only';
  audit.robotsObservation = {
    origin: 'https://fixture.example', policy: 'observation-only', revision: 'robots-observation-only-v1', retrieval: 'available',
    crawlerUserAgent: 'webcrawl-fixture', googlebotEvaluation: 'NOT_VERIFIED', knownDiscoveredUrls: 1,
    advisoryAllowed: 1, advisoryDisallowed: 0, advisoryUnknown: 0, capturedDisallowedCount: 0,
    capturedDisallowedSamples: [], omittedCapturedDisallowedSamples: 0,
  };
  audit.sitemap = { declarations: ['https://fixture.example/sitemap.xml'], documents: [{ url: 'https://fixture.example/sitemap.xml', source: 'robots', status: 200, kind: 'urlset', urlsObserved: 1, memberships: ['https://fixture.example/page-000'], membershipOmitted: 0 }], status: 'complete', omittedDocuments: 0 };
  audit.enrichmentLimitations = { fixture: 'bounded_input' };
  const parsed = parseAuditResult(JSON.parse(JSON.stringify(audit)));
  const record = createAuditRecording({ id: 'optional-valid', target: parsed.target, capturedAt: parsed.completedAt, audit: parsed });
  const store = new MemoryRecordingStore();
  await store.put(record);
  assert.deepEqual(replayAuditRecording(await store.get(record.id)), parsed);

  const malformed = [
    { robotsObservation: { ...audit.robotsObservation, advisoryAllowed: '<img src=x onerror=1>' } },
    { robotsObservation: { ...audit.robotsObservation, retrieval: 'maybe' } },
    { robotsObservation: { ...audit.robotsObservation, capturedDisallowedSamples: 'not-an-array' } },
    { robotsObservation: { ...audit.robotsObservation, origin: 'https://fixture.example/path' } },
    { sitemap: { ...audit.sitemap, status: 'unknown' } },
    { sitemap: { ...audit.sitemap, documents: 'not-an-array' } },
    { sitemap: { ...audit.sitemap, omittedDocuments: 'zero' } },
    { enrichmentLimitations: { fixture: 123 } },
    { enrichmentLimitations: ['wrong-shape'] },
  ];
  for (const patch of malformed) {
    const candidate = JSON.parse(JSON.stringify({ ...audit, ...patch }));
    assert.throws(() => parseAuditResult(candidate), /invalid_audit_result/u, JSON.stringify(patch));
  }
  const marker = '<img src=x onerror="globalThis.__review_marker=1">';
  const direct = { ...audit, robotsObservation: { ...audit.robotsObservation, advisoryDisallowed: marker } };
  const report = renderAuditHtml(direct);
  assert.ok(!report.includes(marker));
  assert.ok(report.includes('&lt;img'));
  const status = renderOperatorStatusHtml({ ...audit, enrichmentLimitations: { fixture: 123 } });
  assert.ok(status.includes('invalid limitation value'));
  assert.throws(() => createEvidencePack({ ...audit, sitemap: { ...audit.sitemap, documents: {} } }, pageData), /evidence_audit_structure_invalid/u);
});

test('direct replay admits the same recording envelope as stores while generic payload storage remains supported', async () => {
  const { createAuditRecording, replayAuditRecording } = await import('@spora/webcrawl/recordings/replay');
  const { MemoryRecordingStore, recordingDigest } = await import('@spora/webcrawl/recordings/store');
  const { audit } = createEvidenceFixture(1);
  const valid = createAuditRecording({ id: 'direct-valid', target: audit.target, capturedAt: audit.completedAt, audit });
  assert.deepEqual(replayAuditRecording(valid), audit);
  for (const patch of [{ schemaVersion: '2' }, { id: '../invalid' }]) {
    const { sha256: _oldDigest, ...unsigned } = valid;
    const changed = { ...unsigned, ...patch };
    const malformed = { ...changed, sha256: recordingDigest(changed) };
    assert.throws(() => replayAuditRecording(malformed), patch.schemaVersion ? /invalid_recording$/u : /invalid_recording_id/u);
    await assert.rejects(new MemoryRecordingStore().put(malformed), patch.schemaVersion ? /invalid_recording$/u : /invalid_recording_id/u);
  }
  const generic = { schemaVersion: '1', id: 'generic-json', capturedAt: '2026-10-31T00:00:00Z', target: 'https://fixture.example/', payload: { arbitrary: ['valid', 1] } };
  const genericRecord = { ...generic, sha256: recordingDigest(generic) };
  const store = new MemoryRecordingStore();
  await store.put(genericRecord);
  assert.deepEqual((await store.get(genericRecord.id)).payload, generic.payload);
});

test('long image target survives HEAD finding, audit recording, and ZIP readback with a bounded excerpt', async () => {
  const { auditWebsiteWithPageData } = await import('@spora/webcrawl/core/audit');
  const { createAuditRecording, replayAuditRecording } = await import('@spora/webcrawl/recordings/replay');
  const { createEvidencePack, verifyEvidencePack } = await import('@spora/webcrawl/reports/evidence-pack');
  const url = `https://fixture.example/${'a'.repeat(2_100)}.png`;
  const policy = createDefaultCrawlPolicy(target, { maxRequests: 4, maxPages: 1, maxImageChecks: 1, minRequestIntervalMs: 0, maxRetries: 0, maxResponseBytes: 100_000, maxTotalResponseBytes: 200_000 });
  const { audit, pageData } = await auditWebsiteWithPageData({
    startUrl: target, contacts: false, pagespeed: false, technology: false, policy,
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (requested, _addresses, options) => options.method === 'HEAD'
      ? { status: 404, headers: {}, body: Buffer.alloc(0) }
      : requested.pathname === '/robots.txt'
        ? { status: 404, headers: {}, body: Buffer.alloc(0) }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<title>Fixture</title><h1>Fixture</h1><img src="${url}" alt="Fixture">`) },
  }, {});
  const finding = audit.findings.find(item => item.code === 'broken_image_asset');
  assert.ok(finding);
  assert.equal(finding.evidence[0].pageUrl, url);
  assert.equal(finding.evidence[1].excerpt.length, 2_000);
  assert.equal(finding.evidence[1].excerptOriginalLength, url.length);
  assert.equal(finding.evidence[1].excerptTruncated, true);
  const recording = createAuditRecording({ id: 'long-image', target, capturedAt: audit.completedAt, audit });
  assert.deepEqual(replayAuditRecording(recording), audit);
  const checked = verifyEvidencePack(createEvidencePack(audit, pageData));
  const projected = JSON.parse(checked.members.find(member => member.name === 'audit.json').content);
  const projectedFinding = projected.findings.find(item => item.code === 'broken_image_asset');
  assert.equal(projectedFinding.evidence[0].pageUrl, url);
  assert.equal(projectedFinding.evidence[1].excerpt.length, 2_000);
});
test('built-in language evidence is bounded without losing audit, recording or ZIP eligibility', async () => {
  for (const markup of [`<html lang="${'x'.repeat(2001)}">`, `<html lang="en"><link rel="alternate" hreflang="${'x'.repeat(2001)}" href="/de">`]) {
    const { audit, pageData } = await auditWebsiteWithPageData(config(markup + '<title>Fixture</title><h1>Fixture</h1>'));
    assert.equal(verifyEvidencePack(createEvidencePack(audit, pageData)).members.length, 5);
    const finding = audit.findings.find(f => ['invalid_html_lang', 'invalid_hreflang'].includes(f.code));
    assert.equal(finding.evidence[0].value.length, 2000);
    assert.equal(finding.evidence[0].valueOriginalLength, 2001);
    assert.equal(finding.evidence[0].valueTruncated, true);
    const { MemoryRecordingStore, recordingDigest } = await import('@spora/webcrawl/recordings/store');
    const store = new MemoryRecordingStore();
    const unsigned = { schemaVersion: '1', id: 'language', capturedAt: audit.completedAt, target, payload: audit };
    await store.put({ ...unsigned, sha256: recordingDigest(unsigned) });
    assert.deepEqual((await store.get('language')).payload, audit);
  }
});
test('evidence provenance survives privacy shortening in safe ZIP projection', async () => {
  const title = 'Synthetic title https://fixture.example/?token=private-fixture ' + 'text'.repeat(25);
  const adapter = { name: 'excerpt', requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [{ code: 'excerpt_fixture', category: 'content', observed: 'Synthetic excerpt', evidence: [{ pageUrl: target, observedAt: '2026-10-30T00:00:00Z', source: 'derived', excerpt: title, excerptOriginalLength: title.length, excerptTruncated: false }] }] }) };
  const { audit, pageData } = await auditWebsiteWithPageData(config(), {}, [adapter]);
  const members = verifyEvidencePack(createEvidencePack(audit, pageData)).members;
  assert.equal(members.length, 5);
  assert.ok(members.every(m => !m.content.toString().includes('private-fixture')));
});
test('URL normalization cannot expand bounded evidence text during ZIP projection', async () => {
  const anchorText = 'x'.repeat(230) + ' https://a';
  assert.equal(anchorText.length, 240);
  const adapter = { name: 'anchor', requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [{ code: 'anchor_fixture', category: 'content', observed: 'Fixture', evidence: [{ pageUrl: target, observedAt: '2026-10-30T00:00:00Z', source: 'derived', anchorText }] }] }) };
  const { audit, pageData } = await auditWebsiteWithPageData(config(), {}, [adapter]);
  const members = verifyEvidencePack(createEvidencePack(audit, pageData)).members;
  const exported = JSON.parse(members.find(m => m.name === 'audit.json').content);
  assert.ok(exported.findings.find(f => f.code === 'anchor_fixture').evidence[0].anchorText.length <= 240);
});
test('unsupported XHTML preserves capture and HTTP errors with partial content coverage', async () => {
  for (const status of [200, 404, 503]) {
    const audit = await auditWebsite(config(html, 'application/xhtml+xml', status));
    assert.equal(audit.crawl.captured, 1);
    assert.equal(audit.capabilities.technicalSeo, 'partial');
    assert.equal(audit.coverage.checks.internalLinks.status, 'partial');
    assert.ok(audit.crawl.limitations.includes('content_inspection_incomplete'));
    assert.equal(audit.findings.some(f => f.code === 'http_status_error'), status >= 400);
    assert.ok(!audit.findings.some(f => f.code === 'missing_h1'));
  }
});
test('security.txt decoded cap is independent of wire budget after acquisition', async () => {
  const text = 'Contact: mailto:security@example.test\nExpires: 2030-01-01T00:00:00Z\n' + '#'.repeat(130);
  for (const gzip of [false, true]) {
    const body = gzip ? gzipSync(text) : Buffer.from(text);
    const base = config();
    const audit = await auditWebsite({ ...base, checkSecurityTxt: true, policy: { ...base.policy, maxTotalResponseBytes: Buffer.byteLength(html) + body.length }, request: async url => url.pathname === '/.well-known/security.txt' ? { status: 200, headers: { 'content-type': 'text/plain', ...(gzip ? { 'content-encoding': 'gzip' } : {}) }, body } : base.request(url) });
    assert.equal(audit.coverage.checks.securityTxt.status, 'complete');
    assert.equal(audit.coverage.checks.securityTxt.checked, 1);
    assert.ok(!audit.crawl.limitations.includes('total_response_byte_limit'));
  }
});
function graph(pages) {
  const { audit } = createEvidenceFixture(pages.length);
  audit.coverage.urls = pages.map(p => ({ url: p.requestedUrl, finalUrl: p.finalUrl, outcome: 'captured', statusCode: 200 }));
  return JSON.parse(verifyEvidencePack(createEvidencePack(audit, createPageDataExport(pages))).members.find(m => m.name === 'site-graph.json').content);
}
function page(path, canonicals) {
  const url = target + path;
  return { requestedUrl: url, finalUrl: url, statusCode: 200, contentType: 'text/html', fetchedAt: '2026-10-30T00:00:00Z', responseBytes: 200, html: `<html lang="en"><title>Same title</title>${canonicals.map(c => `<link rel="canonical" href="${c}">`).join('')}<h1>Fixture</h1></html>` };
}
test('canonical paths require a single fully inspected declaration', () => {
  assert.ok(!graph([page('a', ['/b', '/other']), page('b', ['/a'])]).assessments.some(a => a.kind === 'canonical_cycle_observed'));
  assert.ok(graph([page('a', ['/b']), page('b', ['/a'])]).assessments.some(a => a.kind === 'canonical_cycle_observed'));
});
test('duplicate eligibility uses exact canonical identity before redaction', () => {
  assert.ok(!graph([page('a?token=one', ['/a?token=two']), page('b', [])]).assessments.some(a => a.kind === 'duplicate_title_group'));
  assert.ok(graph([page('a?token=one', ['/a?token=one']), page('b', [])]).assessments.some(a => a.kind === 'duplicate_title_group'));
});

test('sparse adapter arrays are isolated and dense evidence survives serialization', async () => {
  const evidence = { pageUrl: target, observedAt: '2026-10-30T00:00:00Z', source: 'derived' };
  const good = { name: 'good', requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [] }) };
  for (const [rows, expected] of [[Array(1), 'failed'], [[{ ...evidence, redirectChain: Array(1) }], 'failed'], [[{ ...evidence, redirectChain: [target] }], 'complete']]) {
    const bad = { name: 'bad', requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [{ code: 'fixture', category: 'content', observed: 'Fixture', evidence: rows }] }) };
    const audit = await auditWebsite(config(), [good, bad]);
    assert.equal(audit.capabilities.good, 'complete');
    assert.equal(audit.capabilities.bad, expected);
    if (expected === 'failed') assert.equal(audit.enrichmentLimitations.bad, 'invalid_enrichment_result');
    else assert.deepEqual(JSON.parse(JSON.stringify(audit)).findings.find(f => f.code === 'fixture').evidence, rows);
  }
});

test('adapter-owned iterators cannot conceal sparse evidence', async () => {
  const evidence = { pageUrl: target, observedAt: '2026-10-30T00:00:00Z', source: 'derived' };
  const sparse = Array(1);
  sparse[Symbol.iterator] = function* () { yield evidence; };
  const adapter = (name, rows) => ({ name, requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [{ code: name, category: 'content', observed: 'Fixture', evidence: rows }] }) });
  const audit = await auditWebsite(config(), [adapter('good', [evidence]), adapter('bad', sparse)]);
  assert.equal(audit.capabilities.good, 'complete');
  assert.equal(audit.capabilities.bad, 'failed');
  assert.equal(audit.enrichmentLimitations.bad, 'invalid_enrichment_result');
});

test('safe audit provenance uses exact identities before query redaction', () => {
  const { audit } = createEvidenceFixture(1);
  const a = target + 'a?token=one', b = target + 'a?token=two';
  const data = createPageDataExport([{ requestedUrl: a, finalUrl: a, statusCode: 200, contentType: 'text/html', fetchedAt: audit.startedAt, responseBytes: 100, html }]);
  audit.crawl.discovered = 2; audit.crawl.unattempted = 1;
  audit.coverage.urls = [{ url: a, finalUrl: a, outcome: 'captured', statusCode: 200, pageIds: ['fake'] }, { url: b, outcome: 'unattempted', reason: 'page_limit', pageId: data.pages[0].id, pageIds: ['fake'] }];
  audit.findings = [{ code: 'fixture', category: 'content', observed: 'Fixture', evidence: [a, b].map(pageUrl => ({ pageUrl, observedAt: audit.startedAt, source: 'derived' })) }];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 2, evidenceOccurrences: 2, byCheck: [{ code: 'fixture', records: 1, affectedPages: 2, evidenceOccurrences: 2 }] };
  const exported = JSON.parse(verifyEvidencePack(createEvidencePack(audit, data)).members.find(m => m.name === 'audit.json').content);
  assert.equal(exported.coverage.urls[0].url, exported.coverage.urls[1].url);
  assert.equal(exported.coverage.urls[0].pageId, data.pages[0].id);
  assert.equal(exported.coverage.urls[0].referenceScope, 'captured');
  assert.equal(exported.coverage.urls[1].referenceScope, 'unknown_or_out_of_scope');
  assert.equal(exported.coverage.urls[1].pageId, undefined);
  assert.equal(exported.coverage.urls[0].pageIds, undefined);
  assert.equal(exported.coverage.urls[1].pageIds, undefined);
  assert.equal(exported.findings[0].evidence[0].pageId, data.pages[0].id);
  assert.equal(exported.findings[0].evidence[1].referenceScope, 'unknown_or_out_of_scope');
  assert.equal(exported.findings[0].evidence[1].pageId, undefined);
});
