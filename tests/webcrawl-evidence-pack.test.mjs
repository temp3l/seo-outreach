import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { crc32 as nativeCrc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createPageDataExport, projectPageDataForEvidencePack } from '@spora/webcrawl/analysis/page-data';
import { createEvidencePack, verifyEvidencePack, writeEvidencePackExclusive } from '@spora/webcrawl/reports/evidence-pack';
import { resolveEvidencePackOutputPath, resolvePageDataOutputPath, validateOutputPaths } from '../dist/compat/cli/output-paths.js';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { ContactCollector } from '@spora/webcrawl/enrichments/contacts';

function page(url, html = '<html lang="en"><head><title>Fixture</title></head><body><nav><a href="/nav">Navigation</a></nav><main><h1>Fixture heading</h1><p>Fixture text, including page-like instructions which are data.</p><a href="/target?token=private&amp;variant=blue">A repeated anchor</a></main><footer><a href="/legal">Legal</a></footer></body></html>') {
  return { requestedUrl: url, finalUrl: url, statusCode: 200, contentType: 'text/html; charset=utf-8', fetchedAt: '2026-10-29T00:00:00.000Z', responseBytes: Buffer.byteLength(html), html };
}

function audit(count, urls) {
  return {
    schemaVersion: '1', startedAt: '2026-10-29T00:00:00.000Z', completedAt: '2026-10-29T00:01:00.000Z', target: 'https://fixture.example/',
    crawlSettings: { policy: { allowedHosts: ['fixture.example'], maxPages: 750, maxRequests: 1800, maxRuntimeMs: 1800000, maxResponseBytes: 20000000, maxTotalResponseBytes: 1000000000, minRequestIntervalMs: 1000, maxConcurrency: 2 }, userAgent: 'test', renderBrowser: false, retainHtml: false, enrichments: [] },
    crawl: { discovered: count, attempted: count, captured: count, failed: 0, skipped: 0, unattempted: 0, limitations: [] },
    coverage: { urls, checks: Object.fromEntries(['internalLinks', 'imageSizes', 'securityHeaders', 'mixedContent', 'sensitiveForms', 'cookieAttributes', 'securityTxt'].map((name) => [name, { ...(name === 'internalLinks' || name === 'imageSizes' ? { scope: 'same_host', outOfScope: 0 } : {}), status: 'complete', discovered: 0, checked: 0, findings: 0, failed: 0, skipped: 0, unattempted: 0 }])), findings: { records: 0, checkCodes: 0, affectedPages: 0, evidenceOccurrences: 0, byCheck: [] } },
    capabilities: { http: 'complete' }, findings: [],
  };
}

function syncFindingCoverage(value) {
  const groups = new Map();
  for (const finding of value.findings) {
    const group = groups.get(finding.code) ?? { records: 0, pages: new Set(), evidenceOccurrences: 0 };
    group.records++;
    group.evidenceOccurrences += finding.evidence.length;
    for (const item of finding.evidence) group.pages.add(item.pageUrl);
    groups.set(finding.code, group);
  }
  value.coverage.findings = {
    records: value.findings.length,
    checkCodes: groups.size,
    affectedPages: new Set(value.findings.flatMap((finding) => finding.evidence.map((item) => item.pageUrl))).size,
    evidenceOccurrences: [...groups.values()].reduce((sum, group) => sum + group.evidenceOccurrences, 0),
    byCheck: [...groups].map(([code, group]) => ({ code, records: group.records, affectedPages: group.pages.size, evidenceOccurrences: group.evidenceOccurrences })).sort((a, b) => a.code.localeCompare(b.code)),
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function packMembers(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.bytes, { level: 6 });
    const crc = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(entry.bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt16LE(33, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(entry.bytes.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function rehashedMembers(validArchive, mutate, mutateManifestAfterHashes) {
  const entries = verifyEvidencePack(validArchive).members.map((item) => ({ name: item.name, bytes: Buffer.from(item.content) }));
  const manifestEntry = entries.find((item) => item.name === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.bytes.toString('utf8'));
  mutate(entries, manifest);
  manifest.members = entries.filter((item) => item.name !== 'manifest.json').map((item) => ({ name: item.name, bytes: item.bytes.length, sha256: createHash('sha256').update(item.bytes).digest('hex') }));
  mutateManifestAfterHashes?.(manifest);
  manifestEntry.bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return packMembers(entries);
}

test('WC-003 ZIP verifier rejects duplicate per-check identities even when aggregate sums match', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const evidence = () => ({ pageUrl: audit.coverage.urls[0].url, source: 'derived', observedAt: audit.startedAt });
  audit.findings = ['fixture_seo', 'fixture_performance'].map((code, index) => ({ code, category: index ? 'performance' : 'content', observed: 'Two observations', evidence: [evidence(), evidence()] }));
  syncFindingCoverage(audit);
  const archive = createEvidencePack(audit, pageData);
  for (const retainedIndex of [0, 1]) {
    const forged = rehashedMembers(archive, entries => {
      const member = entries.find(item => item.name === 'audit.json');
      const packed = JSON.parse(member.bytes);
      const row = packed.coverage.findings.byCheck[retainedIndex];
      packed.coverage.findings.byCheck = [structuredClone(row), structuredClone(row)];
      member.bytes = Buffer.from(JSON.stringify(packed));
    });
    assert.throws(() => verifyEvidencePack(forged), /evidence_audit_structure_invalid/);
  }
});

test('WC-021 direct and projected page-data limits exclude caller raw extensions without mutation', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const augmented = { ...pageData, limits: { ...pageData.limits, rawHtml: '<main>LIMITS_RAW_SENTINEL</main>', debug: { capture: { rawHtml: '<main>LIMITS_RAW_SENTINEL</main>' } } } };
  const original = JSON.stringify(augmented);
  for (const input of [augmented, projectPageDataForEvidencePack(augmented)]) {
    const verified = verifyEvidencePack(createEvidencePack(audit, input));
    assert.equal(verified.manifest.rawSource.included, false);
    assert.deepEqual(verified.manifest.limits.pageData, pageData.limits);
    for (const member of verified.members) assert.doesNotMatch(member.content.toString(), /LIMITS_RAW_SENTINEL|"debug"|"rawHtml"/);
  }
  assert.equal(JSON.stringify(augmented), original);
  const privateCapture = { ...augmented, limits: { ...augmented.limits, includeRawHtml: true } };
  assert.throws(() => createEvidencePack(audit, privateCapture), /evidence_raw_capture_option_forbidden/);
  assert.equal(verifyEvidencePack(createEvidencePack(audit, projectPageDataForEvidencePack(privateCapture))).manifest.limits.pageData.includeRawHtml, false);
});

test('WC-021 ZIP readback rejects rehashed unknown, malformed or raw-enabled limit metadata', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const archive = createEvidencePack(audit, pageData);
  for (const mutate of [
    limits => { limits.rawHtml = '<main>LIMITS_RAW_SENTINEL</main>'; },
    limits => { limits.debug = { rawHtml: '<main>LIMITS_RAW_SENTINEL</main>' }; },
  ]) {
    assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (_entries, manifest) => { mutate(manifest.limits.pageData); })), /evidence_page_data_limits_unknown_field/);
  }
  for (const [field, value] of [['maxPages', {}], ['maxPages', ['750']], ['maxPages', -1], ['includeSourceEvidenceSamples', 'false']]) {
    assert.throws(() => createEvidencePack(audit, { ...pageData, limits: { ...pageData.limits, [field]: value } }), /evidence_page_data_limits_invalid/);
    assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (_entries, manifest) => { manifest.limits.pageData[field] = value; })), /evidence_page_data_limits_invalid/);
  }
  assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (_entries, manifest) => { manifest.limits.pageData.includeRawHtml = true; })), /evidence_raw_capture_option_forbidden/);
  // Older metadata may lack options added later; retain that distinction.
  const sparse = rehashedMembers(archive, (_entries, manifest) => { delete manifest.limits.pageData.includeSourceEvidenceSamples; });
  assert.equal(Object.hasOwn(verifyEvidencePack(sparse).manifest.limits.pageData, 'includeSourceEvidenceSamples'), false);
});

test('WC-021 verifier rejects rehashed root/nested audit and graph/settings extensions', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const archive = createEvidencePack(audit, pageData);
  for (const [name, mutate] of [
    ['audit.json', a => { a.rawHtml = '<main>PRIVATE_EXTENSION</main>'; }],
    ['audit.json', a => { a.coverage.urls[0].debug = { rawHtml: '<main>PRIVATE_EXTENSION</main>' }; }],
    ['site-graph.json', a => { a.sitemap.debug = { rawHtml: '<main>PRIVATE_EXTENSION</main>' }; }],
  ]) {
    const forged = rehashedMembers(archive, entries => {
      const member = entries.find(item => item.name === name);
      const value = JSON.parse(member.bytes); mutate(value); member.bytes = Buffer.from(JSON.stringify(value));
    });
    assert.throws(() => verifyEvidencePack(forged), /evidence_(audit|sitemap)_unknown_field/);
  }
  assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (_entries, manifest) => { manifest.crawlSettings.debug = { rawHtml: 'PRIVATE_EXTENSION' }; })), /evidence_settings_unknown_field/);
});

test('WC-003 rejects contradictory complete sitemap omissions at admission and rehashed ZIP verification', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const archive = createEvidencePack(audit, pageData);
  for (const detail of [
    { omittedDocuments: 1 },
    { documents: [{ url: 'https://fixture.example/sitemap.xml', source: 'robots', status: 301 }] },
    { documents: [{ url: 'https://fixture.example/sitemap.xml', source: 'robots', status: 200, error: 'truncated' }] },
    { documents: [{ url: 'https://fixture.example/sitemap.xml', source: 'robots', status: 'NOT_CHECKED' }] },
    { documents: [{ url: 'https://fixture.example/sitemap.xml', source: 'robots', status: 200, membershipOmitted: 1 }] },
  ]) {
    const sitemap = { status: 'complete', declarations: [], documents: [], omittedDocuments: 0, ...detail };
    assert.throws(() => createEvidencePack({ ...audit, sitemap }, pageData), /evidence_audit_structure_invalid/);
    const forged = rehashedMembers(archive, entries => {
      const member = entries.find(item => item.name === 'site-graph.json');
      const graph = JSON.parse(member.bytes); graph.sitemap = sitemap; member.bytes = Buffer.from(JSON.stringify(graph));
    });
    assert.throws(() => verifyEvidencePack(forged), /evidence_sitemap_structure_invalid/);
  }
  for (const [status, omittedDocuments, expected] of [['complete', 0, 'COMPLETE'], ['partial', 1, 'PARTIAL']]) {
    const sitemap = { status, omittedDocuments, declarations: [], documents: [] };
    assert.equal(verifyEvidencePack(createEvidencePack({ ...audit, sitemap }, pageData)).manifest.status, expected);
  }
});

test('WC-003 rehashed ZIP rejects array enum fields that formerly passed direct admission', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const archive = createEvidencePack(audit, pageData);
  for (const mutate of [a => { a.coverage.checks.securityHeaders.status = ['complete']; }, a => { a.coverage.urls[0].outcome = ['captured']; }, a => { a.capabilities.http = ['complete']; }, a => { a.coverage.urls[0].reason = ['request_budget']; }]) {
    const forged = rehashedMembers(archive, entries => {
      const member = entries.find(item => item.name === 'audit.json');
      const value = JSON.parse(member.bytes); mutate(value); member.bytes = Buffer.from(JSON.stringify(value));
    });
    assert.throws(() => verifyEvidencePack(forged), /evidence_audit_structure_invalid/);
  }
});

test('closed evidence schema strips unknown private fields and rejects rehashed unknown nested fields', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const extra = { ...pageData, pages: [{ ...pageData.pages[0], rawSource: 'PRIVATE_SOURCE_REVIEW', headings: [{ ...pageData.pages[0].headings[0], privatePayload: 'PRIVATE_SOURCE_REVIEW' }] }] };
  assert.throws(() => createEvidencePack(audit, extra), /evidence_page_unknown_field/u);
  const safe = projectPageDataForEvidencePack(extra);
  const archive = createEvidencePack(audit, safe);
  for (const member of verifyEvidencePack(archive).members) assert.doesNotMatch(member.content.toString(), /PRIVATE_SOURCE_REVIEW/u);
  for (const nested of [false, true]) {
    const tampered = rehashedMembers(archive, members => {
      const member = members.find(item => item.name === 'pages.jsonl');
      const row = JSON.parse(member.bytes.toString().trim());
      if (nested) row.headings[0].privatePayload = 'PRIVATE_SOURCE_REVIEW';
      else row.rawSource = 'PRIVATE_SOURCE_REVIEW';
      member.bytes = Buffer.from(JSON.stringify(row) + '\n');
    });
    assert.throws(() => verifyEvidencePack(tampered), /evidence_page_unknown_field/u);
  }
});

test('schema-1 archives without rawSource declaration remain readable while false declarations fail', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const archive = createEvidencePack(audit, pageData);
  const legacy = rehashedMembers(archive, (_members, manifest) => { delete manifest.rawSource; });
  assert.equal(verifyEvidencePack(legacy).members.length, 5);
  const falseDeclaration = rehashedMembers(archive, (_members, manifest) => { manifest.rawSource.included = true; });
  assert.throws(() => verifyEvidencePack(falseDeclaration), /evidence_manifest_raw_source_invalid/u);
});

test('semantic ZIP readback rejects rehashed audit and page URLs with credentials or sensitive query data', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const valid = createEvidencePack(fixtureAudit, pageData);
  const auditTamper = rehashedMembers(valid, (members) => {
    const member = members.find((item) => item.name === 'audit.json');
    const audit = JSON.parse(member.bytes.toString('utf8'));
    audit.coverage.urls[0].url = 'https://fixture.example/?email=private@example.test';
    member.bytes = Buffer.from(JSON.stringify(audit));
  });
  assert.throws(() => verifyEvidencePack(auditTamper), /evidence_url_unsanitized/u);

  const pageTamper = rehashedMembers(valid, (members) => {
    const member = members.find((item) => item.name === 'pages.jsonl');
    const page = JSON.parse(member.bytes.toString('utf8').trim());
    page.requestedUrl = 'https://user:pass@fixture.example/page-000';
    member.bytes = Buffer.from(`${JSON.stringify(page)}\n`);
  });
  assert.throws(() => verifyEvidencePack(pageTamper), /evidence_url_unsanitized/u);
});

test('evidence creation and semantic readback reject raw page fields', () => {
  const source = page('https://fixture.example/', '<html><body><script>PRIVATE_HTML_ONLY_X9B7</script><main>Fixture</main></body></html>');
  const privateData = createPageDataExport([source], { includeRawHtml: true, maxRawHtmlBytesPerPage: 10_000, maxTotalRawHtmlBytes: 10_000 });
  const value = audit(1, [{ url: source.requestedUrl, finalUrl: source.finalUrl, outcome: 'captured', statusCode: 200 }]);
  assert.throws(() => createEvidencePack(value, privateData), /evidence_raw_page_fields_forbidden/u);
  assert.throws(() => createEvidencePack(value, { ...privateData, pages: [{ ...privateData.pages[0], rawHtml: undefined }] }), /evidence_raw_page_fields_forbidden/u);
  const safeData = projectPageDataForEvidencePack(privateData);
  assert.throws(() => createEvidencePack(value, { ...safeData, limits: { ...safeData.limits, includeRawHtml: true } }), /evidence_raw_capture_option_forbidden/u);
  const valid = createEvidencePack(value, safeData);
  const checked = verifyEvidencePack(valid);
  assert.equal(checked.members.length, 5);
  for (const member of checked.members) {
    assert.doesNotMatch(member.content.toString('utf8'), /PRIVATE_HTML_ONLY_X9B7/u);
    assert.doesNotMatch(member.content.toString('utf8'), /"rawHtml(?:Truncated)?"/u);
  }
  for (const field of ['rawHtml', 'rawHtmlTruncated']) {
    const tampered = rehashedMembers(valid, (members) => {
      const member = members.find((item) => item.name === 'pages.jsonl');
      const row = JSON.parse(member.bytes.toString('utf8').trim());
      row[field] = field === 'rawHtml' ? 'PRIVATE_HTML_ONLY_X9B7' : true;
      member.bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    });
    assert.throws(() => verifyEvidencePack(tampered), /evidence_page_raw_fields_forbidden/u);
  }
});

test('evidence pack exports more than the old 100-page default and validates ZIP member hashes', async () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(110);
  const bytes = createEvidencePack(fixtureAudit, pageData);
  for (const mutation of [row => { row.referenceScope = 'unknown_or_out_of_scope'; }, row => { row.pageId = 'not-exported'; }, row => { row.pageId = pageData.pages[1].id; }]) {
    const badReference = rehashedMembers(bytes, entries => {
      const entry = entries.find(item => item.name === 'audit.json');
      const audit = JSON.parse(entry.bytes.toString());
      mutation(audit.coverage.urls[0]);
      entry.bytes = Buffer.from(JSON.stringify(audit));
    });
    assert.throws(() => verifyEvidencePack(badReference), /evidence_audit_reference_invalid/u);
  }
  const checked = verifyEvidencePack(bytes);
  assert.equal(checked.members.length, 5);
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-evidence-'));
  try {
    const zipPath = join(root, 'fixture.zip');
    const digest = await writeEvidencePackExclusive(zipPath, bytes);
    assert.match(digest, /^[a-f0-9]{64}$/u);
    assert.equal((await stat(zipPath)).mode & 0o777, 0o600);
    assert.match(execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' }), /No errors detected/u);
    const manifest = checked.manifest;
    assert.equal(manifest.status, 'COMPLETE');
    assert.deepEqual(manifest.coverage, { discovered: 110, attempted: 110, captured: 110, failed: 0, skipped: 0, unattempted: 0, urlOutcomeCounts: { captured: 110, failed: 0, skipped: 0, robots_blocked: 0, unattempted: 0 }, attemptedDefinition: 'captured + failed + skipped outcomes; robots_blocked outcomes are not attempted', capturedEligible: 110, exported: 110, omitted: 0, pageDataTarget: 110, truncatedPages: 0 });
    const graph = JSON.parse(checked.members.find((member) => member.name === 'site-graph.json').content.toString('utf8'));
    assert.equal(graph.relations.length, 330);
    assert.deepEqual(new Set(graph.relations.map((item) => item.region)), new Set(['main', 'nav', 'footer']));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('robots observation is copied into the manifest and semantic readback rejects policy or sample tampering', () => {
  const { audit: value, pageData } = createEvidenceFixture(1);
  value.crawlSettings.policy.robots = 'observation-only';
  value.robotsObservation = { origin: 'https://fixture.example', policy: 'observation-only', revision: 'robots-observation-only-v1', retrieval: 'available', crawlerUserAgent: 'webcrawl-test', googlebotEvaluation: 'NOT_VERIFIED', knownDiscoveredUrls: 1, advisoryAllowed: 0, advisoryDisallowed: 1, advisoryUnknown: 0, capturedDisallowedCount: 1, capturedDisallowedSamples: ['https://fixture.example/page-000'], omittedCapturedDisallowedSamples: 0 };
  const valid = createEvidencePack(value, pageData);
  const checked = verifyEvidencePack(valid);
  const manifest = checked.members.find((item) => item.name === 'manifest.json');
  assert.deepEqual(JSON.parse(manifest.content.toString('utf8')).robotsObservation, value.robotsObservation);
  for (const mutate of [
    (members) => { const audit = JSON.parse(members.find((item) => item.name === 'audit.json').bytes.toString('utf8')); audit.robotsObservation.policy = 'respect'; members.find((item) => item.name === 'audit.json').bytes = Buffer.from(JSON.stringify(audit)); },
    (members) => { const audit = JSON.parse(members.find((item) => item.name === 'audit.json').bytes.toString('utf8')); audit.robotsObservation.capturedDisallowedSamples = ['https://fixture.example/not-captured']; members.find((item) => item.name === 'audit.json').bytes = Buffer.from(JSON.stringify(audit)); },
    (members) => { const audit = JSON.parse(members.find((item) => item.name === 'audit.json').bytes.toString('utf8')); audit.robotsObservation.omittedCapturedDisallowedSamples = 1; members.find((item) => item.name === 'audit.json').bytes = Buffer.from(JSON.stringify(audit)); },
    (members, manifest) => { const auditMember = members.find((item) => item.name === 'audit.json'); const audit = JSON.parse(auditMember.bytes.toString('utf8')); delete audit.robotsObservation; auditMember.bytes = Buffer.from(JSON.stringify(audit)); delete manifest.robotsObservation; },
  ]) assert.throws(() => verifyEvidencePack(rehashedMembers(valid, mutate)), /evidence.*(?:robots|audit_structure)/u);
});

test('ZIP CRC uses standard CRC-32 vectors and matches every original member byte sequence', () => {
  assert.equal(nativeCrc32(Buffer.alloc(0)), 0);
  assert.equal(nativeCrc32(Buffer.from('123456789')), 0xcbf43926);
  const bytes = Buffer.from([0, 1, 127, 128, 255, 13, 10]);
  assert.equal(nativeCrc32(bytes), 0x2b086e40);
  const unicodePage = page('https://fixture.example/unicode', '<html><body><main>Grüße ☕</main></body></html>');
  const pageData = createPageDataExport([unicodePage]);
  const fixtureAudit = audit(1, [{ url: unicodePage.requestedUrl, finalUrl: unicodePage.finalUrl, outcome: 'captured', statusCode: 200 }]);
  const archive = createEvidencePack(fixtureAudit, pageData);
  const checked = verifyEvidencePack(archive);
  assert.match(checked.members.find((member) => member.name === 'pages.jsonl').content.toString('utf8'), /Grüße ☕/u);
  let offset = 0;
  for (const member of checked.members) {
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    assert.equal(archive.readUInt32LE(offset + 14), nativeCrc32(member.content));
    assert.equal(archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), member.name);
    offset += 30 + nameLength + extraLength + archive.readUInt32LE(offset + 18);
  }
});

test('empty page JSONL is a valid bounded ZIP member for a zero-capture audit', () => {
  const pageData = createPageDataExport([]);
  const checked = verifyEvidencePack(createEvidencePack(audit(0, []), pageData));
  const pages = checked.members.find((member) => member.name === 'pages.jsonl');
  assert.equal(pages.size, 0);
  assert.equal(pages.content.length, 0);
  assert.equal(checked.manifest.status, 'COMPLETE');
  assert.equal(checked.manifest.reviewReadiness.boundedTechnicalReview, 'NOT_READY_EMPTY_OR_UNCHECKED_CAPTURE');
  assert.equal(checked.manifest.reviewReadiness.siteSeoReady, false);
});

test('a captured page with declared technical checker execution is ready only for bounded review', () => {
  const pageData = createPageDataExport([page('https://fixture.example/')], { includeSourceEvidenceSamples: true });
  const value = audit(1, [{ url: 'https://fixture.example/', finalUrl: 'https://fixture.example/', outcome: 'captured', statusCode: 200 }]);
  value.capabilities.technicalSeo = 'complete';
  const checked = verifyEvidencePack(createEvidencePack(value, pageData));
  assert.equal(checked.manifest.reviewReadiness.boundedTechnicalReview, 'READY_FOR_BOUNDED_REVIEW');
  assert.equal(checked.manifest.reviewReadiness.siteSeoReady, false);
  const pages = checked.members.find((member) => member.name === 'pages.jsonl').content.toString('utf8');
  assert.match(pages, /sourceEvidenceSample/u);
});

test('page IDs remain unique after sensitive query redaction and page-text instructions stay data', () => {
  const data = createPageDataExport([
    page('https://fixture.example/item?token=alpha&variant=blue'),
    page('https://fixture.example/item?token=bravo&variant=blue'),
  ]);
  assert.notEqual(data.pages[0]?.id, data.pages[1]?.id);
  assert.equal(data.pages[0]?.requestedUrl, data.pages[1]?.requestedUrl);
  assert.equal(data.pages[0]?.links[0]?.region, 'nav');
  assert.match(data.pages[0]?.text ?? '', /instructions which are data/u);
  const result = verifyEvidencePack(createEvidencePack(audit(2, data.pages.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: item.statusCode }))), data));
  assert.equal(result.members.length, 5);
});

test('credential-like values in shareable page fields block pack creation', () => {
  const data = createPageDataExport([page('https://fixture.example/', '<html><head><title>api_key=AbCdEf0123456789AbCdEf0123456789</title></head><body><main>Safe</main></body></html>')]);
  assert.throws(() => createEvidencePack(audit(1, [{ url: 'https://fixture.example/', finalUrl: 'https://fixture.example/', outcome: 'captured', statusCode: 200 }]), data), /confirmed_credential_leak/u);
});

test('x-default and reciprocal hreflang are not reported malformed, and sitemap membership is exported safely', () => {
  const enUrl = 'https://fixture.example/en';
  const frUrl = 'https://fixture.example/fr';
  const en = page(enUrl, `<html lang="en"><head><link rel="alternate" hreflang="fr" href="${frUrl}"><link rel="alternate" hreflang="x-default" href="${enUrl}"></head><body><main>English page</main></body></html>`);
  const fr = page(frUrl, `<html lang="fr"><head><link rel="alternate" hreflang="en" href="${enUrl}"></head><body><main>French page</main></body></html>`);
  const pageData = createPageDataExport([en, fr]);
  const value = audit(2, [{ url: enUrl, finalUrl: enUrl, outcome: 'captured', statusCode: 200 }, { url: frUrl, finalUrl: frUrl, outcome: 'captured', statusCode: 200 }]);
  value.sitemap = { declarations: ['https://fixture.example/sitemap.xml'], documents: [{ url: 'https://fixture.example/sitemap.xml', source: 'robots', status: 200, kind: 'urlset', urlsObserved: 1, memberships: ['https://fixture.example/en?token=private'], membershipOmitted: 0 }], status: 'complete', omittedDocuments: 0 };
  const members = verifyEvidencePack(createEvidencePack(value, pageData)).members;
  const graph = JSON.parse(members.find((member) => member.name === 'site-graph.json').content.toString('utf8'));
  assert.equal(graph.assessments.some((item) => item.kind === 'hreflang_invalid_declaration' || item.kind === 'hreflang_missing_reciprocal'), false);
  assert.equal(graph.sitemap.documents[0].memberships[0], 'https://fixture.example/en');
  assert.equal(graph.sitemap.documents[0].membershipOmitted, 0);
});

test('corrupt member bytes fail CRC validation and existing artifacts are not overwritten', async () => {
  const data = createPageDataExport([page('https://fixture.example/')]);
  const bytes = createEvidencePack(audit(1, [{ url: 'https://fixture.example/', finalUrl: 'https://fixture.example/', outcome: 'captured', statusCode: 200 }]), data);
  const corrupt = Buffer.from(bytes);
  corrupt[40] ^= 0xff;
  assert.throws(() => verifyEvidencePack(corrupt));
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-evidence-existing-'));
  try {
    const path = join(root, 'existing.zip');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, 'keep', { mode: 0o600 }));
    await assert.rejects(writeEvidencePackExclusive(path, bytes));
    assert.equal(await readFile(path, 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('semantic ZIP readback rejects rehashed manifest, page, and graph inconsistencies', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(2);
  const bytes = createEvidencePack(fixtureAudit, pageData);
  const duplicateManifest = rehashedMembers(bytes, () => {}, (manifest) => { manifest.members[3] = { ...manifest.members[0] }; });
  assert.throws(() => verifyEvidencePack(duplicateManifest), /evidence_manifest_members_incomplete/u);
  const duplicateIds = rehashedMembers(bytes, (entries) => {
    const pagesEntry = entries.find((item) => item.name === 'pages.jsonl');
    const rows = pagesEntry.bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    rows[1].id = rows[0].id;
    pagesEntry.bytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  });
  assert.throws(() => verifyEvidencePack(duplicateIds), /evidence_page_id_invalid_or_duplicate/u);
  const dangling = rehashedMembers(bytes, (entries) => {
    const graphEntry = entries.find((item) => item.name === 'site-graph.json');
    const value = JSON.parse(graphEntry.bytes.toString('utf8'));
    value.relations[0].targetPageId = 'not-exported';
    graphEntry.bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  });
  assert.throws(() => verifyEvidencePack(dangling), /evidence_graph_target_dangling/u);
  const badCounts = rehashedMembers(bytes, (_entries, manifest) => { manifest.coverage.exported++; });
  assert.throws(() => verifyEvidencePack(badCounts), /evidence_manifest_page_arithmetic_invalid/u);
});

test('semantic ZIP readback rejects checksum-correct page records that retain only IDs', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const valid = createEvidencePack(fixtureAudit, pageData);
  const malformed = rehashedMembers(valid, (entries) => {
    const member = entries.find((item) => item.name === 'pages.jsonl');
    const id = JSON.parse(member.bytes.toString('utf8').trim()).id;
    member.bytes = Buffer.from(`${JSON.stringify({ id })}\n`);
  });
  assert.throws(() => verifyEvidencePack(malformed), /evidence_page_(?:capture_fields|content_fields|id)/u);

  const partialPage = page('https://fixture.example/partial', `<main>${'bounded text '.repeat(20)}</main>`);
  const partialData = createPageDataExport([partialPage], { maxTextCharsPerPage: 32 });
  const partialArchive = verifyEvidencePack(createEvidencePack(audit(1, [{ url: partialPage.requestedUrl, finalUrl: partialPage.finalUrl, outcome: 'captured', statusCode: 200 }]), partialData));
  assert.equal(partialArchive.manifest.status, 'PARTIAL');
  assert.equal(partialArchive.members.find((member) => member.name === 'pages.jsonl').content.length > 0, true);
});

test('semantic ZIP readback validates page array element shapes after hashes are recomputed', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const valid = createEvidencePack(fixtureAudit, pageData);
  assert.equal(verifyEvidencePack(valid).members.length, 5);

  for (const [field, value, error] of [
    ['headings', [42], /evidence_page_content_fields_invalid/u],
    ['canonicalCandidates', [{ status: 'observed', value: 'not-a-url' }], /evidence_page_declaration_invalid/u],
    ['hreflang', [{ locale: 42, status: 'observed' }], /evidence_page_declaration_invalid/u],
    ['metaRobotsDeclarations', [{ name: 'robots', content: 42, status: 'observed' }], /evidence_page_declaration_invalid/u],
    ['structuredDataTypes', [42], /evidence_page_content_fields_invalid/u],
    ['documentImages', [null], /evidence_page_image_invalid/u],
  ]) {
    const malformed = rehashedMembers(valid, (entries) => {
      const member = entries.find((item) => item.name === 'pages.jsonl');
      const row = JSON.parse(member.bytes.toString('utf8').trim());
      row[field] = value;
      member.bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    });
    assert.throws(() => verifyEvidencePack(malformed), error, `${field} malformed item`);
  }
});

test('source samples with canonical declarations survive ZIP verification', () => {
  const url = 'https://fixture.example/';
  const value = audit(1, [{ url, finalUrl: url, outcome: 'captured', statusCode: 200 }]);
  const data = createPageDataExport([page(url, `<html><head><title>Fixture</title><link rel="canonical" href="${url}"></head><body><h1>Fixture</h1></body></html>`)], { includeSourceEvidenceSamples: true });
  const canonical = JSON.parse(data.pages[0].sourceEvidenceSample.excerpt).canonical;
  assert.deepEqual(canonical, [{ value: url, status: 'observed' }]);
  assert.equal(verifyEvidencePack(createEvidencePack(value, data)).members.length, 5);
});

test('evidence packaging requires current audit coverage and rejects malformed source sample JSON shape', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const incompleteAudit = structuredClone(fixtureAudit);
  delete incompleteAudit.coverage.checks.securityTxt;
  assert.throws(() => createEvidencePack(incompleteAudit, pageData), /evidence_audit_structure_invalid/u);

  const url = 'https://fixture.example/sample';
  const data = createPageDataExport([page(url, '<html><head><title>Sample</title></head><body><main>Sample</main></body></html>')], { includeSourceEvidenceSamples: true });
  const value = audit(1, [{ url, finalUrl: url, outcome: 'captured', statusCode: 200 }]);
  const valid = createEvidencePack(value, data);
  const malformedSample = rehashedMembers(valid, (entries) => {
    const member = entries.find((item) => item.name === 'pages.jsonl');
    const row = JSON.parse(member.bytes.toString('utf8').trim());
    row.sourceEvidenceSample.excerpt = '{}';
    row.sourceEvidenceSample.excerptBytes = 2;
    row.sourceEvidenceSample.excerptSha256 = createHash('sha256').update('{}').digest('hex');
    member.bytes = Buffer.from(`${JSON.stringify(row)}\n`);
  });
  assert.throws(() => verifyEvidencePack(malformedSample), /evidence_source_sample_contents_invalid/u);
});

test('semantic ZIP readback rejects rehashed duplicate and malformed contact candidates', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const collector = new ContactCollector();
  collector.observe({ requestedUrl: 'https://fixture.example/page-000', finalUrl: 'https://fixture.example/page-000', statusCode: 200, contentType: 'text/html', fetchedAt: '2026-10-29T00:00:00.000Z', responseBytes: 70, html: '<main><address><a href="mailto:operator@fixture.test">Email</a></address></main>' });
  fixtureAudit.contacts = collector.result(1);
  fixtureAudit.capabilities.contacts = 'complete';
  const archive = createEvidencePack(fixtureAudit, pageData);
  assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (entries) => {
    const member = entries.find((item) => item.name === 'audit.json');
    const audit = JSON.parse(member.bytes.toString('utf8'));
    audit.contacts.candidates.push(structuredClone(audit.contacts.candidates[0]));
    member.bytes = Buffer.from(JSON.stringify(audit));
  })), /evidence_(?:audit_structure_invalid|contact_duplicate_key)/u);
  assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (entries) => {
    const member = entries.find((item) => item.name === 'audit.json');
    const audit = JSON.parse(member.bytes.toString('utf8'));
    audit.contacts.candidates[0].normalizedValue = 'malformed-contact';
    member.bytes = Buffer.from(JSON.stringify(audit));
  })), /evidence_(?:audit_structure_invalid|contact_candidate_format_invalid)/u);
});

test('semantic ZIP readback rejects removal of WhatsApp channel provenance after archive hashes are recomputed', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const collector = new ContactCollector();
  collector.observe({ requestedUrl: 'https://fixture.example/page-000', finalUrl: 'https://fixture.example/page-000', statusCode: 200, contentType: 'text/html', fetchedAt: '2026-10-29T00:00:00.000Z', responseBytes: 90, html: '<main><address><a href="tel:+34603518875">Phone</a><a href="https://wa.me/34603518875?text=private">WhatsApp</a></address></main>' });
  fixtureAudit.contacts = collector.result(1);
  fixtureAudit.capabilities.contacts = 'complete';
  const archive = createEvidencePack(fixtureAudit, pageData);
  assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (entries) => {
    const member = entries.find((item) => item.name === 'audit.json');
    const audit = JSON.parse(member.bytes.toString('utf8'));
    audit.contacts.candidates[0].channels = ['phone'];
    member.bytes = Buffer.from(JSON.stringify(audit));
  })), /evidence_contact_whatsapp_provenance_invalid/u);
});

test('semantic ZIP readback does not accept WhatsApp evidence on an email or an incompatible source type', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const collector = new ContactCollector();
  collector.observe({ requestedUrl: 'https://fixture.example/page-000', finalUrl: 'https://fixture.example/page-000', statusCode: 200, contentType: 'text/html', fetchedAt: '2026-10-29T00:00:00.000Z', responseBytes: 50, html: '<main><address><a href="mailto:operator@fixture.test">Email</a></address></main>' });
  fixtureAudit.contacts = collector.result(1);
  fixtureAudit.capabilities.contacts = 'complete';
  const archive = createEvidencePack(fixtureAudit, pageData);
  assert.throws(() => verifyEvidencePack(rehashedMembers(archive, (entries) => {
    const member = entries.find((item) => item.name === 'audit.json');
    const audit = JSON.parse(member.bytes.toString('utf8'));
    const candidate = audit.contacts.candidates[0];
    candidate.channels.push('whatsapp');
    Object.assign(candidate.sources[0], { channel: 'whatsapp', whatsappEvidenceKind: 'VALID_DIRECT_WHATSAPP_LINK', whatsappLinkState: 'VALID_DIRECT_WHATSAPP_LINK' });
    member.bytes = Buffer.from(JSON.stringify(audit));
  })), /evidence_contact_whatsapp_evidence_invalid/u);
});

test('original audit provenance is verified before sanitization; legacy fixture linkage stays explicit', () => {
  const { audit: fixtureAudit, pageData } = createEvidenceFixture(1);
  const bytes = createEvidencePack(fixtureAudit, pageData);
  assert.equal(verifyEvidencePack(bytes).manifest.originalAuditProvenance, 'UNVERIFIED_SYNTHETIC_OR_LEGACY_INPUT');
  const digest = createHash('sha256').update(JSON.stringify(fixtureAudit)).digest('hex');
  const linked = { ...pageData, target: fixtureAudit.target, auditStartedAt: fixtureAudit.startedAt, auditCompletedAt: fixtureAudit.completedAt, auditSha256: digest };
  assert.equal(verifyEvidencePack(createEvidencePack(fixtureAudit, linked)).manifest.originalAuditProvenance, 'VERIFIED_AT_PACK_CREATION');
  assert.throws(() => createEvidencePack(fixtureAudit, { ...linked, auditSha256: '0'.repeat(64) }), /evidence_original_audit_digest_mismatch/u);
});

test('page omissions and field truncation force truthful partial coverage', () => {
  const twoPages = [page('https://fixture.example/a'), page('https://fixture.example/b')];
  const limited = createPageDataExport(twoPages, { maxPages: 1 });
  const twoAudit = audit(2, twoPages.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 })));
  let manifest = verifyEvidencePack(createEvidencePack(twoAudit, limited)).manifest;
  assert.equal(manifest.status, 'PARTIAL');
  assert.equal(manifest.coverage.omitted, 1);
  assert.equal(manifest.omissions.reasonCounts.page_data_page_limit, 1);
  const truncated = createPageDataExport([page('https://fixture.example/long', '<html><body><main>one two three four five six seven eight nine</main></body></html>')], { maxTextCharsPerPage: 5, maxTotalTextChars: 5 });
  manifest = verifyEvidencePack(createEvidencePack(audit(1, [{ url: truncated.pages[0].requestedUrl, finalUrl: truncated.pages[0].finalUrl, outcome: 'captured', statusCode: 200 }]), truncated)).manifest;
  assert.equal(manifest.status, 'PARTIAL');
  assert.equal(manifest.coverage.truncatedPages, 1);
});

test('capture counts above the page-data ceiling export the bounded set and declare every omitted page', () => {
  const captured = Array.from({ length: 1_001 }, (_, index) => page(`https://fixture.example/${index}`));
  const pageData = createPageDataExport(captured, { maxPages: 1_000 });
  const outcomes = captured.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 }));
  const manifest = verifyEvidencePack(createEvidencePack(audit(captured.length, outcomes), pageData)).manifest;
  assert.equal(manifest.status, 'PARTIAL');
  assert.equal(manifest.coverage.captured, 1_001);
  assert.equal(manifest.coverage.exported, 1_000);
  assert.equal(manifest.coverage.omitted, 1);
  assert.equal(manifest.omissions.reasonCounts.page_data_page_limit, 1);
});

test('site graph caps preserve occurrence and omission arithmetic and force partial status', () => {
  const pages = Array.from({ length: 3 }, (_, pageIndex) => page(`https://fixture.example/source-${pageIndex}`));
  const initial = createPageDataExport(pages, { maxPages: 5 });
  const longTarget = `https://fixture.example/${'y'.repeat(4_050)}`;
  const links = Array.from({ length: 2_000 }, () => ({ href: longTarget, text: 'Anchor', region: 'main' }));
  const shortTarget = 'https://fixture.example/s';
  const pageData = { ...initial, pages: initial.pages.map((record, index) => ({ ...record, links: index === 2 ? [...links, { href: shortTarget, text: 'Short', region: 'main' }] : links, linksStatus: 'OBSERVED' })) };
  const outcomes = pages.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 }));
  const archive = createEvidencePack(audit(pages.length, outcomes), pageData);
  const checked = verifyEvidencePack(archive);
  const graph = JSON.parse(checked.members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.relationCoverage.omitted > 0 || graph.relationCoverage.omittedEdgesBeforeGraph > 0);
  assert.equal(graph.relationCoverage.eligibleEdges, 3 * 2_000 + 1);
  assert.ok(graph.relations.some((relation) => relation.target === shortTarget), 'a later short relation can fit after long rows are omitted');
  assert.equal(checked.manifest.status, 'PARTIAL');
});

test('page JSONL byte cap omits complete records explicitly instead of returning COMPLETE', () => {
  const longImageUrl = `https://fixture.example/${'x'.repeat(4_050)}`;
  const captured = Array.from({ length: 12 }, (_, index) => page(`https://fixture.example/image-heavy-${index}`));
  const initial = createPageDataExport(captured, { maxPages: 20 });
  const images = Array.from({ length: 1_000 }, (_, index) => ({ src: longImageUrl, occurrence: index + 1, scope: 'main', srcAttribute: 'src', altStatus: 'missing', widthStatus: 'missing', heightStatus: 'missing' }));
  const pageData = { ...initial, pages: initial.pages.map((record) => ({ ...record, images, imagesStatus: 'OBSERVED' })) };
  const outcomes = captured.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 }));
  const manifest = verifyEvidencePack(createEvidencePack(audit(captured.length, outcomes), pageData)).manifest;
  assert.equal(manifest.status, 'PARTIAL');
  assert.ok(manifest.omissions.archiveByteLimit > 0);
  assert.equal(manifest.omissions.pageDataLimit, 0);
});

test('link graph counts repeated eligible occurrences and excludes unsupported or missing hrefs', () => {
  const html = '<html><body><main><a href="/same">one</a><a href="/same">two</a><a href="javascript:alert(1)">unsafe</a><a>missing</a></main></body></html>';
  const data = createPageDataExport([page('https://fixture.example/', html)]);
  assert.equal(data.pages[0].links.length, 2);
  const value = audit(1, [{ url: 'https://fixture.example/', finalUrl: 'https://fixture.example/', outcome: 'captured', statusCode: 200 }]);
  const graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, data)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.equal(graph.relations.length, 2);
  assert.equal(graph.relationCoverage.eligibleEdges, 2);
  assert.equal(graph.relations[0].target, graph.relations[1].target);
});

test('graph never joins redacted link identities and preserves exact ordinary target joins', () => {
  const sourceUrl = 'https://fixture.example/source';
  const privateTarget = 'https://fixture.example/dest?token=alpha';
  const aliasTarget = 'https://fixture.example/dest?token=bravo';
  const source = page(sourceUrl, `<main><a href="${privateTarget}">Exact private target</a><a href="/plain">Exact ordinary target</a></main>`);
  const alias = page(aliasTarget, '<main>different page</main>');
  const plain = page('https://fixture.example/plain', '<main>plain page</main>');
  const data = createPageDataExport([source, alias, plain]);
  const value = audit(3, [sourceUrl, aliasTarget, plain.finalUrl].map((url) => ({ url, finalUrl: url, outcome: 'captured', statusCode: 200 })));
  const graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, data)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  const redacted = graph.relations.find((item) => item.anchorText === 'Exact private target');
  const ordinary = graph.relations.find((item) => item.anchorText === 'Exact ordinary target');
  assert.equal(redacted.targetPageId, null);
  assert.equal(redacted.targetOutcome, 'NOT_VERIFIED');
  assert.equal(redacted.targetScope, 'unknown_uncaptured');
  assert.ok(ordinary.targetPageId);
  assert.equal(JSON.stringify(graph).includes('alpha'), false);
  assert.equal(JSON.stringify(graph).includes('bravo'), false);
});

test('hreflang reciprocity requires complete observed declarations and x-default stays a separate semantic case', () => {
  const enUrl = 'https://fixture.example/en';
  const frUrl = 'https://fixture.example/fr';
  const en = page(enUrl, `<html lang="en"><head><link rel="alternate" hreflang="fr" href="${frUrl}"></head><body><main>English</main></body></html>`);
  const fr = page(frUrl, '<html lang="fr"><body><main>French</main></body></html>');
  const data = createPageDataExport([en, fr]);
  const value = audit(2, [{ url: enUrl, finalUrl: enUrl, outcome: 'captured', statusCode: 200 }, { url: frUrl, finalUrl: frUrl, outcome: 'captured', statusCode: 200 }]);
  let graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, data)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'hreflang_missing_reciprocal' && item.status === 'VERIFIED_DEFECT'));
  const locales = ['fr', 'fr-CA', 'fr-FR', 'fr-BE'];
  const many = Array.from({ length: 101 }, (_, index) => `<link rel="alternate" hreflang="${locales[index % locales.length]}" href="${frUrl}">`).join('');
  const truncated = createPageDataExport([page(enUrl, `<html><head>${many}</head><body>English</body></html>`), fr]);
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, truncated)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => ['hreflang_reciprocity_uncertain', 'hreflang_target_uncaptured'].includes(item.kind) && item.status === 'NOT_VERIFIED'));
  assert.equal(graph.assessments.some((item) => item.kind === 'hreflang_missing_reciprocal' && item.status === 'VERIFIED_DEFECT'), false);
  const defaultOnly = createPageDataExport([page(enUrl, `<html><head><link rel="alternate" hreflang="x-default" href="${frUrl}"></head><body>English</body></html>`), fr]);
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, defaultOnly)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.equal(graph.assessments.some((item) => item.kind === 'hreflang_missing_reciprocal'), false);
});

test('hreflang aliases and targets without complete declarations remain uncertain', () => {
  const enUrl = 'https://fixture.example/en';
  const frUrl = 'https://fixture.example/fr';
  const source = page(enUrl, `<html><head><link rel="alternate" hreflang="fr" href="${frUrl}?token=private"></head><body>English</body></html>`);
  const uncapturedData = createPageDataExport([source, { ...page(frUrl), html: undefined }]);
  const uncapturedAudit = audit(2, [{ url: enUrl, finalUrl: enUrl, outcome: 'captured', statusCode: 200 }, { url: frUrl, finalUrl: frUrl, outcome: 'captured', statusCode: 200 }]);
  let graph = JSON.parse(verifyEvidencePack(createEvidencePack(uncapturedAudit, uncapturedData)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => ['hreflang_reciprocity_uncertain', 'hreflang_target_uncaptured'].includes(item.kind) && item.status === 'NOT_VERIFIED'));
  const ambiguous = createPageDataExport([source, page(`${frUrl}?token=alpha`), page(`${frUrl}?token=bravo`)]);
  const ambiguousAudit = audit(3, [enUrl, `${frUrl}?token=alpha`, `${frUrl}?token=bravo`].map((url) => ({ url, finalUrl: url, outcome: 'captured', statusCode: 200 })));
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(ambiguousAudit, ambiguous)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => ['hreflang_reciprocity_uncertain', 'hreflang_target_uncaptured'].includes(item.kind) && item.status === 'NOT_VERIFIED'));
  assert.equal(graph.assessments.some((item) => item.kind === 'hreflang_missing_reciprocal' && item.status === 'VERIFIED_DEFECT'), false);
  const redirectedTarget = { ...page(frUrl, '<html lang="fr"><body>French</body></html>'), finalUrl: 'https://fixture.example/fr-final' };
  const redirectedData = createPageDataExport([page(enUrl, `<html lang="en"><head><link rel="alternate" hreflang="fr" href="${frUrl}"></head><body>English</body></html>`), redirectedTarget]);
  const redirectedAudit = audit(2, [{ url: enUrl, finalUrl: enUrl, outcome: 'captured', statusCode: 200 }, { url: frUrl, finalUrl: redirectedTarget.finalUrl, outcome: 'captured', statusCode: 200 }]);
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(redirectedAudit, redirectedData)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'hreflang_target_redirect_observed' && item.status === 'REVIEW_REQUIRED'));
  assert.equal(graph.assessments.some((item) => item.kind === 'hreflang_missing_reciprocal' && item.status === 'VERIFIED_DEFECT'), false);
});

test('canonical assessments use exact requested URL outcomes and finding groups require every occurrence', () => {
  const sourceUrl = 'https://fixture.example/source';
  const oldUrl = 'https://fixture.example/old';
  const newUrl = 'https://fixture.example/new';
  const source = page(sourceUrl, `<html><head><link rel="canonical" href="${oldUrl}"></head><body>Source</body></html>`);
  const redirected = { ...page(oldUrl, '<html><body>Moved</body></html>'), finalUrl: newUrl };
  const data = createPageDataExport([source, redirected]);
  const value = audit(2, [{ url: sourceUrl, finalUrl: sourceUrl, outcome: 'captured', statusCode: 200 }, { url: oldUrl, finalUrl: newUrl, outcome: 'captured', statusCode: 200 }]);
  value.findings = [{ code: 'broken_internal_link', category: 'indexability', observed: 'mixed evidence', evidence: [{ pageUrl: sourceUrl, observedAt: value.completedAt, source: 'http', value: 404 }, { pageUrl: sourceUrl, observedAt: value.completedAt, source: 'http' }] }];
  syncFindingCoverage(value);
  let graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, data)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'canonical_target_redirect_observed' && item.status === 'REVIEW_REQUIRED' && item.requestedUrl === oldUrl && item.finalUrl === newUrl));
  assert.ok(graph.findingAssessments.some((item) => item.code === 'broken_internal_link' && item.status === 'REVIEW_REQUIRED'));
  value.findings[0].evidence = [{ pageUrl: sourceUrl, observedAt: value.completedAt, source: 'http', value: 404 }];
  const singleValue = audit(1, [{ url: sourceUrl, finalUrl: sourceUrl, outcome: 'captured', statusCode: 200 }]);
  singleValue.findings = value.findings;
  syncFindingCoverage(singleValue);
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(singleValue, createPageDataExport([source]))).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.findingAssessments.some((item) => item.code === 'broken_internal_link' && item.status === 'VERIFIED_DEFECT'));
});

test('canonical target errors, unknown targets, cycles, and chains retain their evidence level', () => {
  const make = (path, canonical) => page(`https://fixture.example/${path}`, `<html><head>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head><body>${path}</body></html>`);
  const base = 'https://fixture.example/';
  const source = make('source', `${base}missing`);
  let value = audit(1, [{ url: source.requestedUrl, finalUrl: source.finalUrl, outcome: 'captured', statusCode: 200 }]);
  let graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, createPageDataExport([source]))).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'canonical_target_uncaptured' && item.status === 'NOT_VERIFIED'));
  const broken = make('broken');
  const sourceBroken = make('source', broken.requestedUrl);
  broken.statusCode = 404;
  value = audit(2, [sourceBroken, broken].map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: item.statusCode })));
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, createPageDataExport([sourceBroken, broken]))).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'canonical_target_http_error' && item.status === 'VERIFIED_DEFECT'));
  const a = make('a', `${base}b`); const b = make('b', `${base}a`); const d = make('d', `${base}e`); const e = make('e', `${base}f`); const f = make('f');
  value = audit(5, [a, b, d, e, f].map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 })));
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, createPageDataExport([a, b, d, e, f]))).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'canonical_cycle_observed' && item.status === 'REVIEW_REQUIRED'));
  assert.ok(graph.assessments.some((item) => item.kind === 'canonical_chain_observed' && item.status === 'REVIEW_REQUIRED'));
  const wholeExport = [make('a', `${base}b`), make('b', `${base}a`)];
  value = audit(2, wholeExport.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 })));
  graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, createPageDataExport(wholeExport))).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(graph.assessments.some((item) => item.kind === 'canonical_cycle_observed' && item.status === 'REVIEW_REQUIRED'));
});

test('hreflang compares canonical primary language identities', () => {
  const origin = 'https://fixture.example';
  for (const [locale, targetLanguage, mismatch] of [['de-DE', 'de', false], ['ger', 'de', false], ['de', 'del', true], ['fr', 'de', true]]) {
    const enUrl = `${origin}/en`, targetUrl = `${origin}/target`;
    const en = page(enUrl, `<html lang="en"><head><link rel="alternate" hreflang="${locale}" href="${targetUrl}"></head><body>English</body></html>`);
    const target = page(targetUrl, `<html lang="${targetLanguage}"><head><link rel="alternate" hreflang="en" href="${enUrl}"></head><body>Target</body></html>`);
    const value = audit(2, [en, target].map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 })));
    const graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, createPageDataExport([en, target]))).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
    assert.equal(graph.assessments.some((item) => item.kind === 'hreflang_target_language_mismatch'), mismatch, `${locale} → ${targetLanguage}`);
  }
});

test('duplicate metadata remains review-only and excludes observed noindex or alternate canonicals', () => {
  const same = (url, directives = '') => page(url, `<html><head><title>Shared title</title>${directives}</head><body><main>Different page content</main></body></html>`);
  const pages = [same('https://fixture.example/a'), same('https://fixture.example/b', '<meta name="robots" content="noindex">')];
  const data = createPageDataExport(pages);
  const value = audit(2, pages.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 })));
  const graph = JSON.parse(verifyEvidencePack(createEvidencePack(value, data)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.equal(graph.assessments.some((item) => item.kind === 'duplicate_title_group'), false);
  const eligible = createPageDataExport([same('https://fixture.example/a'), same('https://fixture.example/b')]);
  const eligibleAudit = audit(2, pages.map((item) => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 })));
  const eligibleGraph = JSON.parse(verifyEvidencePack(createEvidencePack(eligibleAudit, eligible)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.ok(eligibleGraph.assessments.some((item) => item.kind === 'duplicate_title_group' && item.status === 'REVIEW_REQUIRED'));
  const ambiguousCanonical = createPageDataExport([same('https://fixture.example/a'), page('https://fixture.example/b', '<html><head><title>Shared title</title><link rel="canonical" href="/b"><link rel="canonical" href="/a"></head><body><main>Different page content</main></body></html>')]);
  const ambiguousGraph = JSON.parse(verifyEvidencePack(createEvidencePack(eligibleAudit, ambiguousCanonical)).members.find((item) => item.name === 'site-graph.json').content.toString('utf8'));
  assert.equal(ambiguousGraph.assessments.some((item) => item.kind === 'duplicate_title_group'), false);
});

test('output validation rejects ordinary collisions, duplicate paths, and missing directories without changing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-cli-contract-'));
  try {
    const existing = join(root, 'ordinary.json');
    await writeFile(existing, 'preserve');
    await assert.rejects(validateOutputPaths([existing]), /output_file_already_exists/u);
    await assert.rejects(validateOutputPaths([join(root, 'fresh'), join(root, 'fresh')]), /output_paths_must_be_distinct/u);
    await assert.rejects(validateOutputPaths([join(root, 'missing', 'output')]), /output_directory_not_found/u);
    assert.deepEqual((await readdir(root)).sort(), ['ordinary.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pack CLI path selection supports a separate private page-data artifact while preserving legacy defaults', () => {
  assert.equal(resolveEvidencePackOutputPath(['https://example.com/', '--evidence-pack', '/tmp/review.zip']), '/tmp/review.zip');
  assert.throws(() => resolveEvidencePackOutputPath(['https://example.com/', '--evidence-pack', '--no-pagespeed']), /requires a ZIP path/u);
  assert.equal(resolvePageDataOutputPath('/tmp/review', true, false), undefined);
  assert.equal(resolvePageDataOutputPath('/tmp/review', true, false, '/tmp/private.json'), '/tmp/private.json');
  assert.equal(resolvePageDataOutputPath('/tmp/review', true, false, undefined, true), '/tmp/review.page-data.json');
  assert.equal(resolvePageDataOutputPath('/tmp/review', true, false, '/tmp/private.json', true), '/tmp/private.json');
  assert.equal(resolvePageDataOutputPath('/tmp/review', false, false), '/tmp/review.page-data.json');
  assert.equal(resolvePageDataOutputPath('/tmp/review', false, true), undefined);
  assert.equal(resolvePageDataOutputPath('/tmp/review', true, true, '/tmp/private.json', true), undefined);
  assert.equal(resolvePageDataOutputPath('/tmp/review', false, false, '/tmp/custom-pages.json'), '/tmp/custom-pages.json');
});
test('privacy-colliding finding URLs retain original counts while projected audit verifies', () => {
 const pages=['alpha','beta'].map(name=>page(`https://fixture.example/booking?username=${name}`));
 const value=audit(2,pages.map(item=>({url:item.requestedUrl,finalUrl:item.finalUrl,outcome:'captured',statusCode:200})));
 value.findings=pages.map(item=>({code:'missing_h1',category:'content',observed:'No H1',evidence:[{pageUrl:item.finalUrl,observedAt:item.fetchedAt,source:'http'}]}));
 value.coverage.findings={records:2,checkCodes:1,affectedPages:2,evidenceOccurrences:2,byCheck:[{code:'missing_h1',records:2,affectedPages:2,evidenceOccurrences:2}]};
 const pack=verifyEvidencePack(createEvidencePack(value,createPageDataExport(pages)));
 const projected=JSON.parse(pack.members.find(member=>member.name==='audit.json').content.toString());
 assert.equal(projected.coverage.findings.identityProjection,'sanitized-url-v1');
 assert.equal(projected.coverage.findings.affectedPages,1);assert.equal(projected.coverage.findings.originalAffectedPages,2);
 assert.equal(projected.coverage.findings.byCheck[0].affectedPages,1);assert.equal(projected.coverage.findings.byCheck[0].originalAffectedPages,2);
});

test('finding graph assessments use original query identity before privacy projection', () => {
  const alpha = 'https://fixture.example/item?token=alpha';
  const bravo = 'https://fixture.example/item?token=bravo';
  for (const capturedUrls of [[bravo], [alpha, bravo]]) {
    const captured = capturedUrls.map(url => page(url));
    const data = createPageDataExport(captured);
    const { audit: value } = createEvidenceFixture(captured.length);
    value.crawl.discovered = captured.length;
    value.crawl.attempted = captured.length;
    value.crawl.captured = captured.length;
    value.coverage.urls = captured.map(item => ({ url: item.requestedUrl, finalUrl: item.finalUrl, outcome: 'captured', statusCode: 200 }));
    value.findings = [{ code: 'fixture_finding', category: 'content', observed: 'Synthetic finding', evidence: [{ pageUrl: alpha, source: 'derived', observedAt: value.startedAt }] }];
    value.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'fixture_finding', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
    const checked = verifyEvidencePack(createEvidencePack(value, data));
    const projected = JSON.parse(checked.members.find(item => item.name === 'audit.json').content.toString('utf8'));
    const graph = JSON.parse(checked.members.find(item => item.name === 'site-graph.json').content.toString('utf8'));
    assert.equal(projected.findings[0].evidence[0].referenceScope, capturedUrls.includes(alpha) ? 'captured' : 'unknown_or_out_of_scope');
    assert.equal(graph.findingAssessments[0].status, capturedUrls.includes(alpha) ? 'OBSERVATION' : 'NOT_VERIFIED');
    assert.deepEqual(graph.findingAssessments[0].pageIds, capturedUrls.includes(alpha) ? [data.pages[capturedUrls.indexOf(alpha)].id] : []);
  }
});

test('semantic ZIP readback rejects COMPLETE when contacts require PARTIAL', () => {
  const { audit: value } = createEvidenceFixture(1);
  const url = value.coverage.urls[0].url;
  const source = '<html><head><title>Fixture</title></head><body><main>Fixture</main><footer>' + ' '.repeat(6_000) + '</footer></body></html>';
  const captured = page(url, source);
  const collector = new ContactCollector();
  collector.observe(captured);
  value.contacts = collector.result(1);
  value.capabilities.contacts = value.contacts.status;
  const valid = createEvidencePack(value, createPageDataExport([captured]));
  const checked = verifyEvidencePack(valid);
  assert.equal(checked.manifest.status, 'PARTIAL');
  assert.ok(value.contacts.coverage.omittedVisibleText > 0);
  assert.equal(checked.manifest.coverage.truncatedPages, 0);
  const forged = rehashedMembers(valid, (_entries, manifest) => { manifest.status = 'COMPLETE'; });
  assert.throws(() => verifyEvidencePack(forged), /evidence_false_complete_status/u);
  const capabilityForgery = rehashedMembers(valid, (_entries, manifest) => { manifest.capabilities.evidencePack = 'complete'; });
  assert.throws(() => verifyEvidencePack(capabilityForgery), /evidence_manifest_completeness_mismatch/u);
});
