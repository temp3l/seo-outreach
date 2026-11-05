import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createSiteJobs, runSiteJobs } from '../dist/compat/index.js';
import { fileURLToPath } from 'node:url';

const targets = [
  { url: 'https://fixture.example/one', siteFolder: 'ambergris-divers-home-INT-D3E7D174298C' },
  { url: 'https://fixture.example/two', siteFolder: 'amigos-del-mar-tour-center-INT-7A98EFDE2642' },
];
test('shared builder creates private site directories and keeps every real CLI artifact inside them', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-layout-');
  const previous = process.env.WEBCRAWL_SITE_FIXTURE_EVENTS;
  process.env.WEBCRAWL_SITE_FIXTURE_EVENTS = root + '/events.jsonl';
  try {
    const run = root + '/run';
    const jobs = await createSiteJobs(targets, {
      outputRoot: run, args: ['--no-pdf', '--no-pagespeed', '--no-progress', '--no-images', '--pages', '1', '--requests', '3', '--retries', '0'],
      pageData: true, evidencePack: true,
    });
    assert.deepEqual((await readdir(run)).sort(), targets.map(t => t.siteFolder).sort());
    for (const target of targets) assert.equal((await stat(run + '/' + target.siteFolder)).mode & 0o777, 0o700);
    const results = await runSiteJobs(jobs, { workerPath: fileURLToPath(new URL('./fixtures/site-cli-worker.mjs', import.meta.url)), siteConcurrency: 2 });
    assert.ok(results.every(result => result.code === 0));
    for (const target of targets) {
      const dir = run + '/' + target.siteFolder;
      assert.deepEqual((await readdir(dir)).sort(), ['crawl.evidence.zip', 'crawl.html', 'crawl.json', 'crawl.page-data.json', 'crawl.run.log', 'crawl.scan-status.json', 'crawl.whatsapp-draft.md'].sort());
      assert.equal(JSON.parse(await readFile(dir + '/crawl.json', 'utf8')).target, target.url);
    }
    await assert.rejects(createSiteJobs(targets, { outputRoot: run }), { code: 'EEXIST' });
  } finally {
    if (previous === undefined) delete process.env.WEBCRAWL_SITE_FIXTURE_EVENTS;
    else process.env.WEBCRAWL_SITE_FIXTURE_EVENTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid folder identities and overridden export paths fail before creating any run directories', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-layout-invalid-');
  try {
    for (const name of ['../escape', '/absolute', 'nested/site', '.', '']) {
      await assert.rejects(createSiteJobs([{ ...targets[0], siteFolder: name }], { outputRoot: root + '/run' }), /invalid_or_duplicate_site_folder/);
    }
    await assert.rejects(createSiteJobs([targets[0], targets[0]], { outputRoot: root + '/run' }), /invalid_or_duplicate_site_folder/);
    for (const args of [['--out', '/tmp/flat'], ['--page-data', '/tmp/shared.json'], ['--evidence-pack', '/tmp/shared.zip']]) {
      await assert.rejects(createSiteJobs(targets, { outputRoot: root + '/run', args }), /site_job_builder_owns_output_paths/);
    }
    await assert.rejects(createSiteJobs(targets, { outputRoot: root + '/run', args: ['--concurrency', 'invalid'] }));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
