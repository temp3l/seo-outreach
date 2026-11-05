import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
test('review queue export parses deterministically and deduplicates retries without granting authority', () => {
  const root = mkdtempSync('/tmp/webcrawl-no-send-');
  try {
    const a = createEvidenceFixture(1).audit;
    const b = structuredClone(a); b.target = 'https://second.example/';
    const paths = [a,b].map((audit,index) => { const path = `${root}/${index}.json`; writeFileSync(path,JSON.stringify(audit)); return path; });
    const run = args => execFileSync(process.execPath,['scripts/compat/export-no-send-handoff.mjs',...args],{encoding:'utf8'});
    const first = run(paths);
    assert.equal(run([...paths].reverse().concat(paths)),first);
    const queue = JSON.parse(first);
    assert.equal(queue.rows.length,2);
    for (const row of queue.rows) {
      assert.equal(row.customerPublication,'HOLD');
      assert.equal(row.sendEligible,false);
      assert.equal(row.recipientVerification,'UNKNOWN');
      assert.equal(row.reportSha256,null);
      assert.equal(row.sendingAuthorization,'UNKNOWN');
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
