import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, unlink, symlink, truncate, access, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { runBatch } from '../dist/compat/cli/batch.js';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { createEvidencePack, writeEvidencePackExclusive, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';

const guard = new URL('./fixtures/offline-guard.cjs', import.meta.url).pathname;
function child(args) {
  const result = spawnSync(process.execPath, ['--require', guard, ...args], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(result.error, undefined, `${result.error}\n${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_DISPATCH|REVIEW_GUARD_BLOCKED_UNMOCKED_NETWORK/);
  return result;
}

test('WC-022 all batch recovery paths reject FIFO, symlink and oversized artifacts and release locks', async () => {
  const root = await mkdtemp('/tmp/webcrawl-recovery-');
  try {
    const input = `${root}/sites.csv`, original = `${root}/original`;
    await writeFile(input, 'website\nhttps://fixture.test/\n');
    let calls = 0;
    const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async url => {
      calls++; return { status: url.pathname === '/robots.txt' ? 404 : 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Fixture</main>') };
    } };
    await runBatch(input, original, false, false, false, transport, false, false, false);
    const after = calls;
    await runBatch(input, original, true, false, false, { request: async () => { throw Error('UNEXPECTED_DISPATCH'); } }, false, false, false);
    assert.equal(calls, after);
    const state = JSON.parse(await readFile(`${original}/batch-state.json`, 'utf8'));
    const [key] = Object.keys(state.completed), file = state.completed[key].file;
    for (const variant of ['state', 'indexed', 'legacy', 'checkpoint-absent']) {
      for (const artifact of ['fifo', 'symlink', 'oversized']) {
        const out = `${root}/${variant}-${artifact}`;
        await mkdir(out, { mode: 0o700 });
        for (const name of await readdir(original)) await copyFile(`${original}/${name}`, `${out}/${name}`);
        if (variant === 'legacy') {
          const next = structuredClone(state); delete next.completed[key].identity;
          await writeFile(`${out}/batch-state.json`, JSON.stringify(next));
        } else if (variant === 'checkpoint-absent') await unlink(`${out}/batch-state.json`);
        const path = `${out}/${variant === 'state' ? 'batch-state.json' : file}`;
        await unlink(path);
        if (artifact === 'fifo') execFileSync('mkfifo', ['-m', '600', path]);
        else if (artifact === 'symlink') await symlink(`${original}/${variant === 'state' ? 'batch-state.json' : file}`, path);
        else { await writeFile(path, ''); await truncate(path, variant === 'state' ? 5_000_001 : 200_000_001); }
        const code = `
          import assert from 'node:assert/strict';
          import {runBatch} from './dist/compat/cli/batch.js';
          await assert.rejects(runBatch(process.argv[1],process.argv[2],true,false,false,{request:async()=>{process.stderr.write('UNEXPECTED_DISPATCH');throw Error('UNEXPECTED_DISPATCH')}},false,false,false), /unsafe_batch_recovery_file|batch_recovery_file_too_large|ELOOP/);
        `;
        child(['--input-type=module', '-e', code, input, out]);
        await assert.rejects(access(`${out}/.batch.lock`), { code: 'ENOENT' });
        assert.ok(await readdir(out));
      }
    }
    // Regular legacy and checkpoint-absent recovery also avoid redispatch.
    for (const variant of ['legacy', 'checkpoint-absent']) {
      const out = `${root}/${variant}-positive`; await mkdir(out, { mode: 0o700 });
      for (const name of await readdir(original)) await copyFile(`${original}/${name}`, `${out}/${name}`);
      if (variant === 'legacy') { const next = structuredClone(state); delete next.completed[key].identity; await writeFile(`${out}/batch-state.json`, JSON.stringify(next)); }
      else await unlink(`${out}/batch-state.json`);
      await runBatch(input, out, true, false, false, { request: async () => { throw Error('UNEXPECTED_DISPATCH'); } }, false, false, false);
      await assert.rejects(access(`${out}/.batch.lock`), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ['open-collision', 'temporary-replaced', 'success-replaced', 'success-symlink', 'success-removed', 'final-fifo', 'final-symlink', 'final-regular']) test(`WC-024/WC-025 ZIP publication: ${scenario}`, async () => {
  const root = await mkdtemp('/tmp/webcrawl-publication-');
  try {
    const { audit, pageData } = createEvidenceFixture(1);
    const archive = createEvidencePack(audit, pageData), source = `${root}/source.zip`;
    await writeFile(source, archive, { mode: 0o600 });
    child([new URL('./fixtures/zip-publication-race.mjs', import.meta.url).pathname, scenario, `${root}/final.zip`, source]);
    assert.deepEqual(await readFile(source), archive);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WC-024/WC-025 ordinary and concurrent ZIP publication verifies without overwrite or leaked temporaries', async () => {
  const root = await mkdtemp('/tmp/webcrawl-publication-positive-');
  try {
    const { audit, pageData } = createEvidenceFixture(1), archive = createEvidencePack(audit, pageData), path = `${root}/evidence.zip`;
    const results = await Promise.allSettled([writeEvidencePackExclusive(path, archive), writeEvidencePackExclusive(path, archive)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'EEXIST');
    verifyEvidencePack(await readFile(path));
    assert.deepEqual(await readFile(path), archive);
    assert.deepEqual(await readdir(root), ['evidence.zip']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
