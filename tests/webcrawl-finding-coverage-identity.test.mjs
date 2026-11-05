import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { parseAuditResult, createAuditRecording, replayAuditRecording } from '@spora/webcrawl/recordings/replay';
import { MemoryRecordingStore, FileRecordingStore, recordingDigest } from '@spora/webcrawl/recordings/store';
import { createEvidencePack, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { renderWhatsAppDraft } from '../dist/reports/whatsapp-draft.js';

function fixture(sharedCode = false) {
  const { audit, pageData } = createEvidenceFixture(1);
  const evidence = () => ({ pageUrl: audit.coverage.urls[0].url, source: 'derived', observedAt: audit.startedAt });
  audit.findings = [
    { code: 'fixture_seo', category: 'content', observed: 'Two content observations', evidence: [evidence(), evidence()] },
    { code: sharedCode ? 'fixture_seo' : 'fixture_performance', category: 'performance', observed: 'Two performance observations', evidence: [evidence(), evidence()] },
  ];
  const groups = new Map();
  for (const finding of audit.findings) {
    const row = groups.get(finding.code) ?? { code: finding.code, records: 0, affectedPages: 1, evidenceOccurrences: 0 };
    row.records++; row.evidenceOccurrences += finding.evidence.length; groups.set(finding.code, row);
  }
  audit.coverage.findings = { records: 2, checkCodes: groups.size, affectedPages: 1, evidenceOccurrences: 4, byCheck: [...groups.values()] };
  return { audit, pageData };
}

const corruptions = [
  ['duplicate-seo', audit => { audit.coverage.findings.byCheck[1] = structuredClone(audit.coverage.findings.byCheck[0]); }],
  ['duplicate-performance', audit => { audit.coverage.findings.byCheck[0] = structuredClone(audit.coverage.findings.byCheck[1]); }],
  ['missing', audit => { audit.coverage.findings.byCheck.pop(); }],
  ['unknown', audit => { audit.coverage.findings.byCheck[1].code = 'unknown_check'; }],
  ['extra', audit => { audit.coverage.findings.byCheck.push(structuredClone(audit.coverage.findings.byCheck[0])); }],
  ['wrong-count', audit => { audit.coverage.findings.byCheck[0].evidenceOccurrences = 4; }],
];
for (const [name, corrupt] of corruptions) test(`WC-003 per-check ${name} rejects every persisted audit boundary`, async () => {
  const { audit, pageData } = fixture(); corrupt(audit);
  const input = JSON.parse(JSON.stringify(audit));
  if (name.startsWith('duplicate-')) {
    assert.equal(input.coverage.findings.byCheck.reduce((sum, row) => sum + row.records, 0), input.coverage.findings.records);
    assert.equal(input.coverage.findings.byCheck.reduce((sum, row) => sum + row.evidenceOccurrences, 0), input.coverage.findings.evidenceOccurrences);
  }
  assert.equal(isAuditResultRecord(input), false);
  assert.throws(() => parseAuditResult(input), /invalid_audit/);
  assert.throws(() => createAuditRecording({ id: name, target: input.target, capturedAt: input.completedAt, audit: input }), /invalid_audit/);
  const unsigned = { schemaVersion: '1', id: name, target: input.target, capturedAt: input.completedAt, payload: input };
  const record = { ...unsigned, sha256: recordingDigest(unsigned) };
  assert.throws(() => replayAuditRecording(record), /invalid_audit/);
  assert.throws(() => createEvidencePack(input, pageData), /evidence_audit_structure_invalid/);
  const directory = await mkdtemp('/tmp/webcrawl-check-identity-negative-');
  try {
    for (const store of [new MemoryRecordingStore(), new FileRecordingStore(directory)]) {
      await assert.rejects(store.put(record), /invalid_audit/);
      assert.equal(await store.get(name), null);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  // A direct draft must still use the observations rather than a corrupt cache.
  const draft = renderWhatsAppDraft(input);
  assert.match(draft, /REVIEW_REQUIRED/);
  assert.match(draft, /selected_send_target:\*\* null/);
});

for (const name of ['unique', 'reordered', 'shared-code-categories', 'shared-code-same-category', 'empty']) test(`per-check ${name} retains roundtrip, archive and actual draft totals`, async () => {
  const { audit, pageData } = name === 'empty' ? createEvidenceFixture(1) : fixture(name.startsWith('shared-code'));
  if (name === 'reordered') audit.coverage.findings.byCheck.reverse();
  if (name === 'shared-code-same-category') audit.findings[1].category = 'content';
  const expected = name === 'empty' ? 0 : name === 'shared-code-same-category' ? 4 : 2;
  const original = JSON.stringify(audit), parsed = parseAuditResult(JSON.parse(original));
  const directory = await mkdtemp('/tmp/webcrawl-check-identity-positive-');
  try {
    for (const store of [new MemoryRecordingStore(), new FileRecordingStore(directory)]) {
      await store.put(createAuditRecording({ id: name, target: parsed.target, capturedAt: parsed.completedAt, audit: parsed }));
      const saved = replayAuditRecording(await store.get(name));
      assert.deepEqual(saved, parsed);
      assert.match(renderWhatsAppDraft(saved), /Report release:\*\* HOLD/);
      assert.match(renderWhatsAppDraft(saved), /recipient_review_required:\*\* true/);
      verifyEvidencePack(createEvidencePack(saved, pageData));
    }
    assert.equal(JSON.stringify(audit), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy missing-coverage draft retains category-specific occurrence counting', () => {
  const { audit } = fixture(true); delete audit.coverage;
  assert.match(renderWhatsAppDraft(audit), /REVIEW_REQUIRED/);
});

test('English outreach uses evidence-specific internal wording and labels HOLD artifacts', () => {
  const { audit } = fixture();
  const draft = renderWhatsAppDraft(audit, 'report.pdf');
  const message = draft.split('```text\n')[1].split('\n```')[0].trimEnd();
  assert.match(message, /REVIEW_REQUIRED/);
  assert.doesNotMatch(draft, /rank higher|rankings|SEO finding occurrences/);
  assert.match(draft, /Report artifact:\*\* `report\.pdf` \(HOLD preview; do not attach to customer message\)/);
  assert.match(draft, /recipient_review_required:\*\* true/);
  assert.match(draft, /selected_send_target:\*\* null/);
});
