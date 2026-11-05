import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runCli } from '../dist/compat/cli.js';
import { auditResultSha256 } from '../dist/reports/qualification.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('CLI review sidecar records the exact persisted clean PDF bytes', async () => {
  const root = await mkdtemp('/tmp/webcrawl-review-cli-');
  try {
    const prefix = join(root, 'audit');
    const contact = join(root, 'issuer.json');
    await writeFile(contact, JSON.stringify({ name: 'Synthetic Review Issuer', email: 'reviewer@example.test', phone: '+1 555 555 0100' }), { mode: 0o600 });
    await runCli([
      'https://fixture.example/', '--out', prefix, '--report-contact-file', contact,
      '--pages', '1', '--requests', '5', '--runtime-ms', '8000', '--response-bytes', '100000', '--total-bytes', '300000',
      '--concurrency', '1', '--interval-ms', '0', '--retries', '0', '--image-checks', '0',
      '--no-pagespeed', '--no-contacts', '--no-technology', '--no-security-txt', '--pdf-locale', 'en',
    ], {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async url => url.pathname === '/'
        ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Fixture</title><meta name="description" content="Synthetic fixture"><h1>Fixture</h1>') }
        : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') },
    });
    const audit = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
    const reviewBytes = await readFile(`${prefix}.review.json`);
    const review = JSON.parse(reviewBytes);
    assert.equal(review.schema, 'webcrawl-customer-review-v1');
    assert.equal(review.target, audit.target);
    assert.equal(review.auditSha256, auditResultSha256(audit));
    assert.equal(review.reportStatus, 'HOLD');
    assert.equal(review.outboundApproval, false);
    assert.deepEqual(review.artifacts.map(({ role, locale }) => ({ role, locale })), [
      { role: 'a4', locale: 'en' }, { role: 'mobile', locale: 'en' },
    ]);
    for (const artifact of review.artifacts) {
      const bytes = await readFile(artifact.path);
      assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
      assert.equal(artifact.bytes, bytes.length);
      assert.equal(artifact.sha256, hash(bytes));
    }
    assert.ok((await readdir(root)).includes('audit.review.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
