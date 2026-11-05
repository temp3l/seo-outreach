import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { ContactCollector } from '@spora/webcrawl/enrichments/contacts';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { parseAuditResult, createAuditRecording, replayAuditRecording } from '@spora/webcrawl/recordings/replay';
import { MemoryRecordingStore, FileRecordingStore, recordingDigest } from '@spora/webcrawl/recordings/store';
import { createEvidencePack, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { renderAuditHtml } from '../dist/reports/html.js';
import { renderOperatorStatusHtml } from '../dist/reports/summary.js';

function fixture() {
  const { audit, pageData } = createEvidenceFixture(1);
  const url = audit.coverage.urls[0].url;
  const collector = new ContactCollector();
  collector.observe({ requestedUrl: url, finalUrl: url, statusCode: 200, contentType: 'text/html', fetchedAt: audit.startedAt, responseBytes: 100, html: '<footer><a href="mailto:office@fixture.example">Email</a></footer>' });
  audit.contacts = collector.result(1);
  audit.capabilities.contacts = audit.contacts.status;
  audit.findings = [{ code: 'fixture', category: 'content', severity: 'low', observed: 'Fixture', evidence: [{ pageUrl: url, observedAt: audit.startedAt, source: 'derived' }] }];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'fixture', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  audit.crawlSettings.policy.robots = 'observation-only';
  audit.robotsObservation = { origin: 'https://fixture.example', policy: 'observation-only', revision: 'robots-observation-only-v1', retrieval: 'available', crawlerUserAgent: 'fixture', googlebotEvaluation: 'NOT_VERIFIED', knownDiscoveredUrls: 1, advisoryAllowed: 1, advisoryDisallowed: 0, advisoryUnknown: 0, capturedDisallowedCount: 0, capturedDisallowedSamples: [], omittedCapturedDisallowedSamples: 0 };
  audit.sitemap = { declarations: [], documents: [], status: 'complete', omittedDocuments: 0 };
  return { audit, pageData };
}

function envelope(audit, id) {
  const unsigned = { schemaVersion: '1', id, target: audit.target, capturedAt: audit.completedAt, payload: audit };
  return { ...unsigned, sha256: recordingDigest(unsigned) };
}

const mutations = [
  ['capability', a => { a.capabilities.http = ['complete']; }],
  ...['internalLinks', 'imageSizes', 'securityHeaders', 'mixedContent', 'sensitiveForms', 'cookieAttributes', 'securityTxt'].map(key => [`check-${key}`, a => { a.coverage.checks[key].status = ['complete']; }]),
  ['outcome', a => { a.coverage.urls[0].outcome = ['captured']; }],
  ...[null, 7, true, ['request_budget'], { detail: 'request_budget' }].map((reason, index) => [`url-reason-${index}`, a => { a.coverage.urls[0].reason = reason; }]),
  ['category', a => { a.findings[0].category = ['content']; }],
  ['severity', a => { a.findings[0].severity = ['low']; }],
  ['source', a => { a.findings[0].evidence[0].source = ['derived']; }],
  ['sitemap-status', a => { a.sitemap.status = ['complete']; }],
  ['internal-unavailable', a => { a.coverage.checks.internalLinks.status = 'unavailable'; }],
  ['image-unavailable', a => { a.coverage.checks.imageSizes.status = 'unavailable'; }],
  ['sitemap-complete-redirect', a => { a.sitemap.documents = [{url: 'https://fixture.example/map.xml', source: 'robots', status: 301}]; }],
  ['sitemap-complete-error', a => { a.sitemap.documents = [{url: 'https://fixture.example/map.xml', source: 'robots', status: 200, error: 'truncated'}]; }],
  ['robots-retrieval', a => { a.robotsObservation.retrieval = ['available']; }],
  ['sitemap-complete-omissions', a => { a.sitemap.omittedDocuments = 1; }],
  ['sitemap-complete-unchecked', a => { a.sitemap.documents = [{url: 'https://fixture.example/map.xml', source: 'robots', status: 'NOT_CHECKED'}]; }],
  ['sitemap-complete-member-omissions', a => { a.sitemap.documents = [{url: 'https://fixture.example/map.xml', source: 'robots', status: 200, membershipOmitted: 1}]; }],
  ['contact-status', a => { a.contacts.status = ['complete']; a.capabilities.contacts = a.contacts.status; }],
  ['contact-kind', a => { a.contacts.candidates[0].kind = ['email']; }],
  ['contact-validation', a => { a.contacts.candidates[0].validation = ['FORMAT_VALID']; }],
  ['rank-string', a => { a.contacts.candidates[0].rank.tier = '1'; }],
  ['rank-array', a => { a.contacts.candidates[0].rank.tier = [1]; }],
  ['rank-reason', a => { a.contacts.candidates[0].rank.reasons = [['general_page_or_footer']]; }],
  ['channel', a => { a.contacts.candidates[0].channels.push(['email']); }],
  ['source-type', a => { a.contacts.candidates[0].sources[0].type = ['mailto-tel']; }],
  ['source-region', a => { a.contacts.candidates[0].sources[0].region = ['footer']; }],
  ['source-capture', a => { a.contacts.candidates[0].sources[0].captureMode = ['http']; }],
  ['source-channel', a => { a.contacts.candidates[0].sources[0].channel = ['email']; }],
  ['source-whatsapp', a => { a.contacts.candidates[0].sources[0].whatsappEvidenceKind = ['WHATSAPP_LABELLED_PHONE']; }],
  ['source-whatsapp-state', a => { a.contacts.candidates[0].sources[0].whatsappLinkState = ['WHATSAPP_LABELLED_PHONE']; }],
  ['candidate-whatsapp-state', a => { a.contacts.candidates[0].whatsappLinkState = ['WHATSAPP_LABELLED_PHONE']; }],
  ['render-mode', a => { a.crawlSettings.renderMode = ['all']; }],
  ['robots-policy', a => { a.crawlSettings.policy.robots = ['ignore']; }],
];
for (const [name, mutate] of mutations) test(`WC-003 rejects JSON scalar coercion: ${name} at every audit boundary`, async () => {
  const { audit, pageData } = fixture();
  mutate(audit);
  const input = JSON.parse(JSON.stringify(audit));
  assert.equal(isAuditResultRecord(input), false);
  assert.throws(() => parseAuditResult(input), /invalid_audit/);
  assert.throws(() => createAuditRecording({ id: name, target: input.target, capturedAt: input.completedAt, audit: input }), /invalid_audit/);
  const record = envelope(input, name);
  assert.throws(() => replayAuditRecording(record), /invalid_audit/);
  assert.throws(() => createEvidencePack(input, pageData), /evidence_audit_structure_invalid/);
  const root = await mkdtemp('/tmp/webcrawl-admission-');
  try {
    for (const store of [new MemoryRecordingStore(), new FileRecordingStore(root)]) await assert.rejects(store.put(record), /invalid_audit/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WC-003 valid scalar audit traverses both stores, replay, reports and ZIP', async () => {
  const { audit, pageData } = fixture();
  const root = await mkdtemp('/tmp/webcrawl-admission-positive-');
  try {
    for (const store of [new MemoryRecordingStore(), new FileRecordingStore(root)]) {
      await store.put(createAuditRecording({ id: 'positive', target: audit.target, capturedAt: audit.completedAt, audit }));
      const saved = replayAuditRecording(await store.get('positive'));
      assert.deepEqual(saved, audit);
      assert.doesNotThrow(() => renderAuditHtml(saved));
      assert.doesNotThrow(() => renderOperatorStatusHtml(saved));
      assert.equal(verifyEvidencePack(createEvidencePack(saved, pageData)).manifest.status, 'COMPLETE');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WC-003 omitted, empty and scalar URL reasons retain report and persistence compatibility', async () => {
  for (const reason of [undefined, '', 'request_budget', '<b>REASON_TEXT</b>']) {
    const { audit, pageData } = fixture();
    if (reason !== undefined) audit.coverage.urls[0].reason = reason;
    const directory = await mkdtemp('/tmp/webcrawl-reason-positive-');
    try {
      for (const store of [new MemoryRecordingStore(), new FileRecordingStore(directory)]) {
        const parsed = parseAuditResult(JSON.parse(JSON.stringify(audit)));
        await store.put(createAuditRecording({ id: 'reason-positive', target: parsed.target, capturedAt: parsed.completedAt, audit: parsed }));
        const saved = replayAuditRecording(await store.get('reason-positive'));
        assert.equal(saved.coverage.urls[0].reason, reason);
        const html = renderAuditHtml(saved);
        if (reason === '<b>REASON_TEXT</b>') { assert.match(html, /&lt;b&gt;REASON_TEXT&lt;\/b&gt;/); assert.doesNotMatch(html, /<b>REASON_TEXT<\/b>/); }
        assert.doesNotThrow(() => renderOperatorStatusHtml(saved));
        verifyEvidencePack(createEvidencePack(saved, pageData));
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('WC-021 private augmented audits survive stores while every ZIP member excludes extensions', async () => {
  const { audit, pageData } = fixture();
  const sentinel = '<main>RAW_EXTENSION_ONLY_SYNTHETIC</main>';
  const extend = object => { object.rawHtml = sentinel; object.debug = { capture: { rawHtml: sentinel } }; };
  for (const object of [audit, audit.crawlSettings, audit.crawlSettings.policy, audit.crawl, audit.coverage, audit.coverage.urls[0], audit.coverage.checks, audit.coverage.checks.securityHeaders, audit.coverage.findings, audit.coverage.findings.byCheck[0], audit.findings[0], audit.findings[0].evidence[0], audit.sitemap, audit.contacts, audit.contacts.coverage, audit.contacts.candidates[0], audit.contacts.candidates[0].rank, audit.contacts.candidates[0].sources[0], audit.contacts.suggestedPrimary, audit.robotsObservation]) extend(object);
  const original = JSON.stringify(audit);
  const root = await mkdtemp('/tmp/webcrawl-extension-');
  try {
    for (const store of [new MemoryRecordingStore(), new FileRecordingStore(root)]) {
      const parsed = parseAuditResult(JSON.parse(original));
      await store.put(createAuditRecording({ id: 'extended', target: parsed.target, capturedAt: parsed.completedAt, audit: parsed }));
      const saved = replayAuditRecording(await store.get('extended'));
      assert.equal(JSON.stringify(saved), original);
      const verified = verifyEvidencePack(createEvidencePack(saved, pageData));
      for (const member of verified.members) assert.doesNotMatch(member.content.toString(), /RAW_EXTENSION_ONLY_SYNTHETIC|"debug"|"rawHtml"/);
      const packed = JSON.parse(verified.members.find(m => m.name === 'audit.json').content);
      assert.equal(packed.contacts.candidates[0].sources[0].type, 'mailto-tel');
      assert.equal(packed.findings[0].evidence[0].source, 'derived');
    }
    assert.equal(JSON.stringify(audit), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
