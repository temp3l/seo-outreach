import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, mkdir, chmod, rm, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { auditResultSha256 } from '../dist/reports/qualification.js';

const exec = promisify(execFile);
const script = new URL('../scripts/compat/release-customer-reports.mjs', import.meta.url).pathname;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function freshAudit() {
  const { audit } = createEvidenceFixture(3);
  audit.startedAt = new Date(Date.now() - 120_000).toISOString();
  audit.completedAt = new Date(Date.now() - 90_000).toISOString();
  const page = audit.coverage.urls[0].url;
  audit.findings = [{ code: 'missing_meta_description', category: 'metadata', observed: 'Synthetic missing description', severity: 'medium', evidence: [{ pageUrl: page, source: 'http', observedAt: audit.completedAt }]}];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_meta_description', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  return audit;
}
function qualification(audit) { return { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED' }; }
async function inputs(root, { audit = freshAudit(), q = undefined, issuer = { name: 'Synthetic Issuer', email: 'issuer@example.test', phone: '+31 20 123 4567' } } = {}) {
  const auditPath = join(root, 'audit.json'), qPath = join(root, 'qualification.json'), contactPath = join(root, 'issuer.json');
  await writeFile(auditPath, JSON.stringify(audit));
  await writeFile(qPath, JSON.stringify(q ?? qualification(audit)));
  await writeFile(contactPath, JSON.stringify(issuer), { mode: 0o600 });
  return { auditPath, qPath, contactPath, audit };
}
function command(args) { return exec(process.execPath, [script, ...args], { timeout: 60_000 }); }
const opts = (i, out) => ['--audit', i.auditPath, '--qualification', i.qPath, '--report-contact-file', i.contactPath, '--out', out, '--pdf-locale', 'en'];

function longUrlAudit() {
  const audit = freshAudit();
  const url = 'https://fixture.example/courses/' + Array.from({ length: 20 }, (_, i) => `diving-course-${i}`).join('-');
  audit.coverage.urls[0].url = url; audit.coverage.urls[0].finalUrl = url;
  audit.findings[0].evidence[0].pageUrl = url;
  return audit;
}

test('offline release accepts readable long evidence labels with exact linked URLs in EN/DE and mobile PDFs', async () => {
  const root = await mkdtemp('/tmp/webcrawl-local-release-wrapped-');
  try {
    const audit = longUrlAudit();
    const issuer = { name: 'Synthetic Multi Word Reviewer '.repeat(3).trim(), email: 'issuer@example.test' };
    const i = await inputs(root, { audit, issuer });
    const url = audit.findings[0].evidence[0].pageUrl;
    for (const locale of ['en', 'de']) {
      const out = join(root, `release-${locale}`);
      const args = opts(i, out); args[args.length - 1] = locale;
      await command(args);
      const manifest = JSON.parse(await readFile(`${out}.release.json`, 'utf8'));
      assert.equal(manifest.reportStatus, 'CLIENT_READY');
      assert.equal(manifest.outboundApproval, false);
      assert.equal(manifest.mobileLocale, locale);
      let wrappedIssuer = false;
      for (const artifact of manifest.artifacts) {
        assert.equal(digest(await readFile(artifact.path)), artifact.sha256);
        if (!artifact.path.endsWith('.pdf')) continue;
        const { stdout } = await exec('pdftotext', ['-layout', artifact.path, '-']);
        assert.doesNotMatch(stdout,new RegExp(url.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'u'),'long evidence URLs stay out of the readable page text');
        assert.match(stdout,/Diving course 0/u,'the long URL is represented by a readable page label');
        const { stdout: links } = await exec('pdfinfo', ['-url', artifact.path]);
        assert.ok(links.includes(url), 'the PDF link annotation retains the exact evidence URL');
        assert.ok(stdout.replace(/\s+/gu, '').includes(issuer.name.replace(/\s+/gu, '')));
        wrappedIssuer ||= !stdout.includes(issuer.name);
        assert.doesNotMatch(stdout, /HOLD/u);
      }
      assert.ok(wrappedIssuer, 'issuer name must actually wrap in at least one artifact');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('qualification expiry before real mobile rendering fails before publishing any artifact', async () => {
  for (const phase of ['before-mobile', 'after-mobile']) {
    const root = await mkdtemp('/tmp/webcrawl-local-release-expired-mobile-');
    try {
      const i = await inputs(root); const out = join(root, 'release');
      const clock = new URL('./fixtures/release-mobile-clock.mjs', import.meta.url).pathname;
      await assert.rejects(exec(process.execPath, ['--import', clock, script, ...opts(i, out)], { timeout: 60000, env: { ...process.env, WEBCRAWL_TEST_RELEASE_CLOCK_PHASE: phase } }), error => {
        assert.match(error.stderr, /mobile_release_not_ready|draft_release_not_ready|release_qualification_expired/u); return true;
      });
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith('release.')), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('malformed private audit and qualification JSON never appear in diagnostics or output files', async () => {
  for (const input of ['auditPath', 'qPath']) {
    const root = await mkdtemp('/tmp/webcrawl-local-release-private-json-');
    try {
      const i = await inputs(root); const out = join(root, 'release');
      await writeFile(i[input], 'SYNTHETIC_PRIVATE_CONTACT_SENTINEL');
      await assert.rejects(command(opts(i, out)), error => {
        assert.doesNotMatch(error.stderr + error.stdout, /SYNTHETIC|PRIVATE|SENTINEL/u);
        assert.match(error.stderr, input === 'auditPath' ? /audit_json_invalid/u : /qualification_json_invalid/u);
        return true;
      });
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith('release.')), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('unexpected renderer errors remain failures without exposing their private message', async () => {
  const root = await mkdtemp('/tmp/webcrawl-local-release-private-render-error-');
  try {
    const i = await inputs(root); const out = join(root, 'release');
    const fixture = new URL('./fixtures/release-mobile-clock.mjs', import.meta.url).pathname;
    await assert.rejects(exec(process.execPath, ['--import', fixture, script, ...opts(i, out)], { timeout: 60000, env: { ...process.env, WEBCRAWL_TEST_RELEASE_CLOCK_PHASE: 'renderer-error' } }), error => {
      assert.doesNotMatch(error.stderr + error.stdout, /SYNTHETIC|PRIVATE|RENDER_ERROR/u);
      assert.match(error.stderr, /release_failed: release_failed/u);
      return true;
    });
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('release.')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PDF text validation still rejects a different evidence URL after whitespace normalization', async () => {
  const root = await mkdtemp('/tmp/webcrawl-local-release-wrong-url-');
  try {
    const audit = longUrlAudit(); const i = await inputs(root, { audit }); const out = join(root, 'release');
    const bin = join(root, 'bin'); await mkdir(bin);
    const text = `fixture.example Synthetic Issuer ${audit.completedAt} https://fixture.example/courses/a-different-page`;
    await writeFile(join(bin, 'pdftotext'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(text)});\n`, { mode: 0o700 });
    await assert.rejects(exec(process.execPath, [script, ...opts(i, out)], { timeout: 60000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }), error => {
      assert.match(error.stderr, /pdf_content_validation_failed/u); return true;
    });
    await assert.rejects(readFile(`${out}.release.json`), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline release writes readable EN/DE and mobile PDFs, then a hash-verified manifest with sending false', async () => {
  const root = await mkdtemp('/tmp/webcrawl-local-release-'); await chmod(root, 0o700);
  try {
    const i = await inputs(root); const out = join(root, 'release');
    const { stdout } = await command(opts(i, out));
    const response = JSON.parse(stdout);
    assert.equal(response.result, 'LOCAL_REPORT_RELEASE_COMPLETE');
    assert.equal(response.reportStatus, 'CLIENT_READY');
    const manifestBytes = await readFile(`${out}.release.json`); const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.reportStatus, 'CLIENT_READY'); assert.equal(manifest.outboundApproval, false);
    assert.equal(manifest.auditSha256, auditResultSha256(i.audit)); assert.equal(manifest.qualificationSha256, digest(await readFile(i.qPath)));
    assert.equal(manifest.mobileLocale, 'en'); assert.equal(manifest.artifacts.length, 4);
    for (const artifact of manifest.artifacts) {
      const bytes = await readFile(artifact.path); assert.equal(digest(bytes), artifact.sha256);
      if (artifact.path.endsWith('.pdf')) { assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); }
      else { const draft = bytes.toString(); assert.match(draft, /recipient_review_required:\*\* true/u); assert.match(draft, /selected_send_target:\*\* null/u); assert.match(draft, /Outbound approval:\*\* false/u); }
    }
    const files = (await readdir(root)).filter(name => name.startsWith('release.'));
    assert.deepEqual(files.sort(), ['release.de.pdf', 'release.en.pdf', 'release.mobile-en.pdf', 'release.release.json', 'release.whatsapp-draft.md'].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid audit, stale or mismatched qualification and output collisions fail before any output writes', async () => {
  for (const mode of ['invalid-audit', 'mismatched', 'stale', 'missing-qualification', 'collision']) {
    const root = await mkdtemp('/tmp/webcrawl-local-release-invalid-'); await chmod(root, 0o700);
    try {
      const audit = freshAudit(); const q = qualification(audit);
      if (mode === 'invalid-audit') audit.schemaVersion = 'bad';
      if (mode === 'mismatched') q.auditSha256 = '0'.repeat(64);
      if (mode === 'stale') q.qualifiedAt = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
      const i = await inputs(root, { audit, q }); const out = join(root, 'release');
      if (mode === 'missing-qualification') await unlink(i.qPath);
      if (mode === 'collision') await writeFile(`${out}.de.pdf`, 'preserve-me');
      await assert.rejects(command(opts(i, out)));
      assert.equal((await readdir(root)).some(name => /\.release\.json$/u.test(name)), false);
      assert.equal((await readdir(root)).some(name => /\.en\.pdf$/u.test(name)), false);
      if (mode === 'collision') assert.equal((await readFile(`${out}.de.pdf`, 'utf8')), 'preserve-me');
      await assert.rejects(command([...opts(i, join(root, 'bad-options')), '--unknown', 'x']));
      await assert.rejects(command([...opts(i, join(root, 'duplicate-options')), '--out', join(root, 'other')]));
      await assert.rejects(command([...opts(i, join(root, 'missing-value')), '--pdf-locale']));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('a qualified audit that fails issuer layout readiness creates no output or success manifest', async () => {
  const root = await mkdtemp('/tmp/webcrawl-local-release-layout-'); await chmod(root, 0o700);
  try {
    const i = await inputs(root); const out = join(root, 'release');
    await writeFile(i.contactPath, JSON.stringify({ name: 'W'.repeat(100), company: 'W'.repeat(100), email: 'issuer@example.test', phone: '+31 20 123 4567' }), { mode: 0o600 });
    await assert.rejects(command(opts(i, out)));
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith('release.')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('readback failure after an artifact write reports partial paths and never writes the success manifest', async () => {
  const root = await mkdtemp('/tmp/webcrawl-local-release-partial-'); await chmod(root, 0o700);
  try {
    const i = await inputs(root); const out = join(root, 'release');
    const shim = join(root, 'bin'); await mkdir(shim); await chmod(shim, 0o700);
    const failingPdfText = join(shim, 'pdftotext');
    await writeFile(failingPdfText, '#!/bin/sh\nprintf SYNTHETIC_PRIVATE_CHILD_ERROR >&2\nexit 17\n', { mode: 0o700 }); await chmod(failingPdfText, 0o700);
    await assert.rejects(exec(process.execPath, [script, ...opts(i, out)], { timeout: 60_000, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } }), error => {
      assert.match(error.stderr, /alreadyWritten.*release-stage/u);
      assert.match(error.stderr, /pdf_content_extraction_failed/u);
      assert.doesNotMatch(error.stderr + error.stdout, /SYNTHETIC|PRIVATE|CHILD_ERROR/u);
      return true;
    });
    await assert.rejects(readFile(`${out}.en.pdf`), { code: 'ENOENT' });
    await command(opts(i, out));
    const first = await readFile(`${out}.release.json`);
    await command(opts(i, out));
    assert.deepEqual(await readFile(`${out}.release.json`), first);
    assert.equal(JSON.parse(first).outboundApproval, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
