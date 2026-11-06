import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, chmod, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { auditResultSha256 } from '../dist/reports/qualification.js';

const exec = promisify(execFile);
const script = new URL('../scripts/compat/release-customer-reports.mjs', import.meta.url).pathname;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = (files, out) => ['--audit', files.audit, '--qualification', files.qualification, '--review-manifest', files.review, '--out', out];

async function setup(root) {
  const { audit } = createEvidenceFixture(3);
  audit.target = audit.coverage.urls[0].url;
  audit.startedAt = new Date(Date.now() - 120_000).toISOString();
  audit.completedAt = new Date(Date.now() - 90_000).toISOString();
  audit.findings = [{ code: 'missing_meta_description', category: 'metadata', observed: 'Synthetic missing description', severity: 'medium', evidence: [{ pageUrl: audit.coverage.urls[0].url, source: 'http', observedAt: audit.completedAt }]}];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_meta_description', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  const files = { audit: join(root, 'audit.json'), qualification: join(root, 'qualification.json'), review: join(root, 'review.json') };
  const a4 = join(root, 'a4.pdf'), mobile = join(root, 'mobile.pdf');
  const pdf1 = Buffer.from('%PDF-1.4\nsynthetic A4 bytes\n'); const pdf2 = Buffer.from('%PDF-1.4\nsynthetic mobile bytes\n');
  await writeFile(files.audit, JSON.stringify(audit), { mode: 0o600 });
  const review = { schema: 'webcrawl-customer-review-v1', target: audit.target, auditSha256: auditResultSha256(audit), reportStatus: 'HOLD', outboundApproval: false, artifacts: [
    { role: 'a4', locale: 'en', path: a4, bytes: pdf1.length, sha256: digest(pdf1) },
    { role: 'mobile', locale: 'en', path: mobile, bytes: pdf2.length, sha256: digest(pdf2) },
  ] };
  const reviewBytes = Buffer.from(`${JSON.stringify(review)}\n`);
  await writeFile(files.review, reviewBytes, { mode: 0o600 });
  const qualification = { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED', reviewedManifestSha256: digest(reviewBytes) };
  await writeFile(files.qualification, JSON.stringify(qualification), { mode: 0o600 });
  await writeFile(a4, pdf1, { mode: 0o600 }); await writeFile(mobile, pdf2, { mode: 0o600 });
  const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, 'pdftotext'), '#!/bin/sh\nprintf "Synthetic report fixture.example clean text\\n"\n', { mode: 0o700 });
  await writeFile(join(bin, 'pdfinfo'), '#!/bin/sh\nprintf "https://fixture.example/\\n"\n', { mode: 0o700 });
  return { files, review, a4, mobile, bin, audit };
}

function qualification(audit, reviewBytes, changes = {}) {
  return { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED', reviewedManifestSha256: digest(reviewBytes), ...changes };
}

test('promotes exact reviewed PDF bytes and replays deterministically without rendering', async () => {
  const root = await mkdtemp('/tmp/webcrawl-reviewed-pdf-'); await chmod(root, 0o700);
  try {
    const data = await setup(root); const out = join(root, 'release');
    const env = { ...process.env, PATH: `${data.bin}:${process.env.PATH}` };
    await exec(process.execPath, [script, ...options(data.files, out)], { env });
    const first = await readFile(`${out}.release.json`); const manifest = JSON.parse(first);
    assert.equal(manifest.reportStatus, 'CLIENT_READY'); assert.equal(manifest.outboundApproval, false);
    assert.equal(manifest.reviewedManifestSha256, digest(await readFile(data.files.review)));
    assert.deepEqual(manifest.artifacts.map(item => item.role), ['a4', 'mobile']);
    assert.equal(digest(await readFile(data.a4)), data.review.artifacts[0].sha256);
    assert.equal(digest(await readFile(data.mobile)), data.review.artifacts[1].sha256);
    await exec(process.execPath, [script, ...options(data.files, out)], { env });
    assert.deepEqual(await readFile(`${out}.release.json`), first);
    await writeFile(`${out}.release.json`, '{"preserve":"collision"}\n', { mode: 0o600 });
    await assert.rejects(exec(process.execPath, [script, ...options(data.files, out)], { env }), error => /output_collision/u.test(error.stderr));
    assert.equal(await readFile(`${out}.release.json`, 'utf8'), '{"preserve":"collision"}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fails closed for mismatched review hash, changed PDF, missing or unsafe qualification, and unsafe PDF mode', async () => {
  for (const mode of ['wrong-hash', 'changed-pdf', 'missing-qualification', 'unsafe-mode', 'audit-mismatch', 'security-failed']) {
    const root = await mkdtemp('/tmp/webcrawl-reviewed-pdf-negative-'); await chmod(root, 0o700);
    try {
      const data = await setup(root);
      if (mode === 'wrong-hash') {
        const q = JSON.parse(await readFile(data.files.qualification)); q.reviewedManifestSha256 = '0'.repeat(64);
        await writeFile(data.files.qualification, JSON.stringify(q), { mode: 0o600 });
      }
      if (mode === 'audit-mismatch' || mode === 'security-failed') {
        const reviewBytes = await readFile(data.files.review);
        const q = qualification(data.audit, reviewBytes, mode === 'audit-mismatch' ? { auditSha256: '0'.repeat(64) } : { security: 'NOT_CLEARED' });
        await writeFile(data.files.qualification, JSON.stringify(q), { mode: 0o600 });
      }
      if (mode === 'changed-pdf') await writeFile(data.a4, '%PDF-1.4 changed\n', { mode: 0o600 });
      if (mode === 'missing-qualification') await rm(data.files.qualification);
      if (mode === 'unsafe-mode') await chmod(data.mobile, 0o644);
      await assert.rejects(exec(process.execPath, [script, ...options(data.files, join(root, 'release'))], { env: { ...process.env, PATH: `${data.bin}:${process.env.PATH}` } }));
      await assert.rejects(readFile(join(root, 'release.release.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('real Chromium review PDFs promote byte-for-byte without launching a renderer during finalization', async () => {
  const root = await mkdtemp('/tmp/webcrawl-reviewed-pdf-chromium-'); await chmod(root, 0o700);
  try {
    const data = await setup(root);
    const issuer = join(root, 'issuer.json');
    await writeFile(issuer, JSON.stringify({ name: 'Synthetic Issuer', email: 'issuer@example.test' }), { mode: 0o600 });
    const prefix = join(root, 'prepared');
    const prepareScript = new URL('../scripts/compat/prepare-customer-review.mjs', import.meta.url).pathname;
    await exec(process.execPath, [prepareScript, '--audit', data.files.audit, '--report-contact-file', issuer, '--out', prefix, '--pdf-locale', 'en']);
    const reviewPath = `${prefix}.review.json`;
    const reviewBytes = await readFile(reviewPath); const review = JSON.parse(reviewBytes);
    const before = await Promise.all(review.artifacts.map(item => readFile(item.path)));
    const qPath = join(root, 'qualification.json');
    await writeFile(qPath, JSON.stringify(qualification(data.audit, reviewBytes)), { mode: 0o600 });
    const files = { audit: data.files.audit, qualification: qPath, review: reviewPath };
    const out = join(root, 'released');
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, 'missing-browser'), PATH: process.env.PATH };
    await exec(process.execPath, [script, ...options(files, out)], { env, timeout: 60_000 });
    const released = JSON.parse(await readFile(`${out}.release.json`));
    assert.equal(released.reportStatus, 'CLIENT_READY'); assert.equal(released.outboundApproval, false);
    for (const [index, artifact] of released.artifacts.entries()) {
      const bytes = await readFile(artifact.path);
      assert.deepEqual(bytes, before[index]);
      assert.equal(digest(bytes), review.artifacts[index].sha256);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
