import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectCheckCoverage, CHECK_KEYS } from '../dist/check-coverage.js';

const fixturePath = sampleFile('br-kite.json');

test('projects actual Cumbuco checker coverage and omission counts', async () => {
  const report = JSON.parse(await readFile(fixturePath, 'utf8'));
  const projected = projectCheckCoverage(report);
  assert.deepEqual(Object.keys(projected.checks), [...CHECK_KEYS]);
  assert.equal(projected.checks.internalLinks.status, 'complete');
  assert.equal(projected.checks.imageSizes.status, 'partial');
  assert.equal(projected.checks.securityTxt.status, 'disabled');
  assert.equal(projected.checks.imageSizes.omissions, 3);
  assert.equal(projected.knownOmissionCount, 3);
  assert.equal(projected.checks.imageSizes.outOfScope, 1);
  assert.equal(projected.checks.internalLinks.outOfScope, 4);
  assert.equal('omittedRelations' in projected.checks.imageSizes, false);
  assert.deepEqual(projected.checks.imageSizes.counts, {
    discovered: 18, checked: 15, findings: 0, failed: 0, skipped: 3, unattempted: 0,
  });
  assert.equal(JSON.stringify(projected).includes('https://'), false);
  assert.equal(JSON.stringify(projected).includes('escola.brkite'), false);
});

test('missing checker metadata is explicit unknown with no invented counts', () => {
  const p = projectCheckCoverage({ coverage: { checks: { mixedContent: {
    status: 'unavailable', discovered: 0, checked: 0, findings: 0, failed: 0, skipped: 0, unattempted: 0,
  } } } });
  assert.equal(p.checks.internalLinks.status, 'unknown');
  assert.equal(p.checks.internalLinks.counts, null);
  assert.equal(p.checks.internalLinks.omissions, null);
  assert.equal(p.knownOmissionCount, 0);
  assert.equal(p.checks.mixedContent.status, 'unavailable');
});

test('rejects malformed declared status, counters, and omission counts', () => {
  const local = { status: 'complete', discovered: 0, checked: 0, findings: 0, failed: 0, skipped: 0, unattempted: 0 };
  assert.throws(() => projectCheckCoverage({ coverage: { checks: { securityTxt: { ...local, status: 'not available' } } } }), /status/);
  assert.throws(() => projectCheckCoverage({ coverage: { checks: { mixedContent: { ...local, findings: -1 } } } }), /counter/);
  assert.throws(() => projectCheckCoverage({ coverage: { checks: { imageSizes: { ...local, scope: 'same_host', omittedTargets: 'secret' } } } }), /counter/);
});

test('drops arbitrary and unknown fields without retaining raw content', () => {
  const p = projectCheckCoverage({
    target: 'https://private.example/path?email=a@example.test',
    coverage: { raw: 'private contact a@example.test', checks: { securityHeaders: {
      status: 'partial', discovered: 1, checked: 1, findings: 0, failed: 0, skipped: 0, unattempted: 0,
      url: 'https://private.example/contact', detail: 'a@example.test',
    } } },
  });
  const serialized = JSON.stringify(p);
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('example'), false);
  assert.deepEqual(Object.keys(p.checks.securityHeaders), ['status', 'counts', 'omissions']);
});
