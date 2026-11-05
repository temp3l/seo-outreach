import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, readdir, symlink, chmod, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { runSiteJobs, validateSiteJobs } from '../dist/compat/cli/sites.js';
import { PDF_GRANTED, PDF_RELEASE, PDF_REQUEST, PDF_SCHEDULER_ENV } from '../dist/compat/cli/pdf-slots.js';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
const workerPath = fileURLToPath(new URL('./fixtures/site-worker.mjs', import.meta.url));
const eventsAt = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const job = (root, index, mode = 'normal') => {
  mkdirSync(`${root}/site-${index}`, { recursive: true, mode: 0o700 });
  return [`https://fixture.example/${index}?mode=${mode}`, '--out', `${root}/site-${index}/crawl`];
};
const cliWorkerPath = fileURLToPath(new URL('./fixtures/site-cli-worker.mjs', import.meta.url));

test('all artifact conflicts fail before custom or production CLI workers, requests, browsers or publications', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-conflicts-');
  try {
    await symlink(root, `${root}/alias`);
    const profilesFile = `${root}/profiles.json`;
    await writeFile(profilesFile, JSON.stringify({ version: 1, defaultProfile: 'exports', profiles: { exports: { extends: 'default', pdf: false, 'page-data': true, 'evidence-pack': true } } }));
    const base = index => [...job(root, index), '--no-pdf'];
    const profiled = index => [...job(root, index), '--profiles-file', profilesFile];
    const conflicts = [
      [[...base(0), '--page-data', `${root}/shared.json`], [...base(1), '--page-data', `${root}/shared.json`]],
      [[...base(0), '--evidence-pack', `${root}/shared.zip`], [...base(1), '--evidence-pack', `${root}/shared.zip`]],
      [base(0), ['https://fixture.example/', '--out', `${root}/site-0/crawl.scan-status`, '--no-pdf']],
      [[...base(0), '--page-data', `${root}/site-1/crawl.json`], base(1)],
      [[...base(0), '--page-data', `${root}/shared.json`], [...base(1), '--page-data', `${root}/alias/shared.json`]],
      [base(0), ['https://fixture.example/', '--out', `${root}/alias/site-0/crawl`, '--no-pdf']],
      [[...job(root, 0), '--pdf-locale', 'de'], [...base(1), '--page-data', `${root}/site-0/crawl.mobile-de.pdf`]],
      [profiled(0), ['https://fixture.example/', '--out', `${root}/site-0/crawl.page-data`, '--profiles-file', profilesFile]],
      [profiled(0), [...profiled(1), '--evidence-pack', `${root}/site-0/crawl.evidence.zip`]],
    ];
    for (const worker of [workerPath, cliWorkerPath]) for (const jobs of conflicts) {
      await assert.rejects(runSiteJobs(jobs, { workerPath: worker }), /output_paths_must_be_distinct/);
      assert.deepEqual((await readdir(root)).sort(), ['alias', 'profiles.json', 'site-0', 'site-1']);
    }
    await writeFile(`${root}/site-0/crawl.run.log`, 'existing');
    await assert.rejects(runSiteJobs([base(0)], { workerPath }), /output_file_already_exists/);
    await mkdir(`${root}/public`, { mode: 0o755 });
    await chmod(`${root}/public`, 0o755);
    await assert.rejects(runSiteJobs([[...base(1), '--page-data', `${root}/public/data.json`]], { workerPath }), /unsafe_private_output_directory/);
    await assert.rejects(readFile(`${root}/events.jsonl`), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('multi-site flat output prefixes fail before worker execution', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-flat-');
  try {
    const jobs = [0, 1].map(index => [`https://fixture.example/${index}`, '--out', `${root}/flat-${index}`]);
    await assert.rejects(runSiteJobs(jobs, { workerPath }), /site_jobs_require_distinct_directories|site_job_output_outside_site_directory/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const flag of ['--page-data', '--evidence-pack']) {
  test(`multi-site ${flag} must remain in its own site directory`, async () => {
    const root = await mkdtemp('/tmp/webcrawl-site-export-');
    try {
      await assert.rejects(runSiteJobs([[...job(root, 0), flag, `${root}/escaped${flag === '--page-data' ? '.json' : '.zip'}`], job(root, 1)], { workerPath }), /site_jobs_require_distinct_directories|site_job_output_outside_site_directory/);
      await assert.rejects(readFile(`${root}/events.jsonl`), { code: 'ENOENT' });
      assert.deepEqual((await readdir(root)).sort(), ['site-0', 'site-1']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('canonical site directories cannot alias the same folder or contain another site', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-canonical-');
  try {
    const first = job(root, 0);
    await symlink(`${root}/site-0`, `${root}/alias`);
    await assert.rejects(runSiteJobs([first, ['https://fixture.example/alias', '--out', `${root}/alias/other`]], { workerPath }), /site_jobs_require_distinct_directories|site_job_output_outside_site_directory/);
    await mkdir(`${root}/site-0/nested`, { mode: 0o700 });
    await assert.rejects(runSiteJobs([first, ['https://fixture.example/nested', '--out', `${root}/site-0/nested/crawl`]], { workerPath }), /site_jobs_require_distinct_directories|site_job_output_outside_site_directory/);
    await assert.rejects(readFile(`${root}/events.jsonl`), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launcher runs real CLI output/profile/locale variations with the shared PDF cap', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-cli-');
  const previous = process.env.WEBCRAWL_SITE_FIXTURE_EVENTS;
  process.env.WEBCRAWL_SITE_FIXTURE_EVENTS = `${root}/events.jsonl`;
  try {
    await writeFile(`${root}/issuer.json`, JSON.stringify({ name: 'Synthetic Reviewer', email: 'reviewer@example.test' }), { mode: 0o600 });
    await writeFile(`${root}/profiles.json`, JSON.stringify({ version: 1, defaultProfile: 'offline', profiles: {
      offline: { extends: 'default', pdf: false, pagespeed: false, images: false, progress: false, pages: 1, requests: 3, retries: 0, 'interval-ms': 0, 'evidence-pack': true, 'page-data': true },
      german: { extends: 'offline', pdf: true, 'pdf-locale': 'de', 'page-data-html': true },
    } }));
    const base = index => [...job(root, index), '--profiles-file', `${root}/profiles.json`];
    const results = await runSiteJobs([
      base(0),
      [...base(1), '--profile', 'german', '--report-contact-file', `${root}/issuer.json`],
      [...base(2), '--no-evidence-pack', '--no-page-data', '--pdf-locale', 'de'],
      [...base(3), '--pdf', '--pdf-locale', 'en', '--report-contact-file', `${root}/issuer.json`, '--page-data', `${root}/site-3/explicit.json`, '--evidence-pack', `${root}/site-3/explicit.zip`],
      // Disabled and other-locale PDF names are available as explicit exports.
      [...base(4), '--no-evidence-pack', '--page-data', `${root}/site-4/crawl.pdf`],
      [...base(5), '--no-evidence-pack', '--page-data', `${root}/site-5/crawl.pdf`],
    ], { workerPath: cliWorkerPath, siteConcurrency: 2, pdfConcurrency: 1 });
    assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 6; i++) assert.ok(isAuditResultRecord(JSON.parse(await readFile(`${root}/site-${i}/crawl.json`, 'utf8'))));
    const files = (await Promise.all(Array.from({ length: 6 }, async (_, i) => (await readdir(`${root}/site-${i}`)).map(name => `site-${i}/${name}`)))).flat();
    for (const name of ['site-0/crawl.page-data.json', 'site-0/crawl.evidence.zip', 'site-1/crawl.report-de.pdf', 'site-1/crawl.mobile-de.pdf', 'site-1/crawl.operator-status.pdf', 'site-1/crawl.page-data.json', 'site-3/crawl.pdf', 'site-3/crawl.mobile.pdf', 'site-3/explicit.json', 'site-3/explicit.zip']) assert.ok(files.includes(name), name);
    for (const name of ['site-2/crawl.pdf', 'site-2/crawl.evidence.zip', 'site-2/crawl.page-data.json', 'site-3/crawl.page-data.json']) assert.ok(!files.includes(name), name);
    for (const index of [4, 5]) assert.equal(JSON.parse(await readFile(`${root}/site-${index}/crawl.pdf`, 'utf8')).contentTrust, 'untrusted_web_content');
    assert.ok(JSON.parse(await readFile(`${root}/site-1/crawl.page-data.json`, 'utf8')).pages[0].rawHtml);
    let browsers = 0, peak = 0;
    for (const { event } of await eventsAt(`${root}/events.jsonl`)) {
      if (event === 'browser-start') peak = Math.max(peak, ++browsers);
      if (event === 'browser-end') browsers--;
      assert.ok(browsers >= 0 && browsers <= 1);
    }
    assert.equal(peak, 1); assert.equal(browsers, 0);
  } finally {
    if (previous === undefined) delete process.env.WEBCRAWL_SITE_FIXTURE_EVENTS;
    else process.env.WEBCRAWL_SITE_FIXTURE_EVENTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('site processes share a PDF cap across preflight/report phases and release every permit', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-runner-');
  try {
    const results = await runSiteJobs(Array.from({ length: 6 }, (_, index) => job(root, index, 'cap')), { siteConcurrency: 3, pdfConcurrency: 2, workerPath });
    assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0, 0]);
    let sites = 0, pdfs = 0, maxSites = 0, maxPdfs = 0;
    for (const { event } of await eventsAt(`${root}/events.jsonl`)) {
      if (event === 'site-start') sites++;
      if (event === 'site-end') sites--;
      if (event === 'pdf-start') pdfs++;
      if (event === 'pdf-end') pdfs--;
      assert.ok(sites <= 3 && pdfs <= 2 && sites >= 0 && pdfs >= 0);
      maxSites = Math.max(maxSites, sites); maxPdfs = Math.max(maxPdfs, pdfs);
    }
    assert.equal(maxSites, 3); assert.equal(maxPdfs, 2);
    assert.equal(sites, 0); assert.equal(pdfs, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a worker exiting with a browser permit cannot deadlock the remaining sites', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-crash-');
  try {
    const results = await runSiteJobs([job(root, 0, 'crash'), job(root, 1), job(root, 2)], { siteConcurrency: 2, pdfConcurrency: 1, workerPath });
    assert.equal(results[0].code, 7);
    assert.deepEqual(results.slice(1).map(result => result.code), [0, 0]);
    assert.equal((await eventsAt(`${root}/events.jsonl`)).filter(row => row.event === 'site-end').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a worker disconnecting during a PDF releases its slot on exit', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-disconnect-');
  try {
    const results = await runSiteJobs([job(root, 0, 'disconnect'), job(root, 1)], { siteConcurrency: 2, pdfConcurrency: 1, workerPath, signal: AbortSignal.timeout(10_000) });
    assert.notEqual(results[0].code, 0);
    assert.equal(results[1].code, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an uncooperative disconnected worker is killed before its PDF slot is reassigned', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-stubborn-disconnect-');
  try {
    const results = await runSiteJobs([job(root, 0, 'stubborn-disconnect'), job(root, 1)], { siteConcurrency: 2, pdfConcurrency: 1, workerPath, signal: AbortSignal.timeout(12_000) });
    assert.equal(results[0].signal, 'SIGKILL');
    assert.equal(results[1].code, 0);
    const events = await eventsAt(`${root}/events.jsonl`);
    const abandoned = events.find(row => row.event === 'pdf-start' && row.mode === 'stubborn-disconnect').pid;
    assert.equal(events.filter(row => row.pid === abandoned && row.event === 'pdf-start').length, 1);
    assert.equal(events.filter(row => row.pid !== abandoned && row.event === 'pdf-end').length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['slow', 'stubborn-abort']) {
test(`cancellation stops ${mode} children and does not start queued sites`, async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-abort-');
  const controller = new AbortController();
  try {
    const promise = runSiteJobs([job(root, 0, mode), job(root, 1), job(root, 2)], { siteConcurrency: 1, workerPath, signal: controller.signal });
    const rejected = assert.rejects(promise, /cancelled_by_test/);
    for (let tries = 0; tries < 100; tries++) {
      try { if ((await eventsAt(`${root}/events.jsonl`)).some(row => row.event === 'pdf-start')) break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(10);
    }
    controller.abort(new Error('cancelled_by_test'));
    await rejected;
    assert.equal((await eventsAt(`${root}/events.jsonl`)).filter(row => row.event === 'site-start').length, 1);
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});
}

test('manifest and concurrency errors fail before starting a worker', async () => {
  for (const input of [[], [['https://fixture.example/']], [['https://fixture.example/', '--out', 'same'], ['https://fixture.example/next', '--out', './same']], [['https://fixture.example/', '--out', 'a', '--batch', 'sites.csv']]]) {
    assert.throws(() => validateSiteJobs(input));
  }
  for (const value of [0, -1, 1.5, 33, NaN]) {
    await assert.rejects(runSiteJobs([['https://fixture.example/', '--out', 'unused']], { siteConcurrency: value }));
    await assert.rejects(runSiteJobs([['https://fixture.example/', '--out', 'unused']], { pdfConcurrency: value }));
  }
});

test('a NUL in any job is rejected before any workers start', async () => {
  const root = await mkdtemp('/tmp/webcrawl-site-invalid-');
  try {
    await assert.rejects(runSiteJobs([job(root, 0), [...job(root, 1), '--user-agent', 'invalid\0argument'], job(root, 2)], { workerPath }), /invalid_site_job/);
    await assert.rejects(readFile(`${root}/events.jsonl`), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['late-release', 'stop-release', 'spawn-throw', 'spawn-all-fail']) {
  test(`worker events preserve ownership and PDF limits: ${mode}`, async () => {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/site-runner-events.mjs', import.meta.url)), mode], { timeout: 5_000 });
  });
}

for (const mode of ['waiting', 'active', 'release', 'terminate']) {
  test(`PDF permit client handles scheduler lifecycle: ${mode}`, async () => {
    const child = fork(fileURLToPath(new URL('./fixtures/pdf-slot-client.mjs', import.meta.url)), [mode], { silent: true, env: { ...process.env, [PDF_SCHEDULER_ENV]: '1' } });
    let released = false, stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdout.resume();
    child.on('message', message => {
      if (message.type === PDF_RELEASE) released = true;
      if (message.type !== PDF_REQUEST) return;
      if (mode === 'waiting') child.disconnect();
      else {
        child.send({ type: PDF_GRANTED, id: message.id });
        if (mode === 'active') setTimeout(() => child.disconnect(), 30);
        if (mode === 'terminate') setTimeout(() => child.kill('SIGTERM'), 30);
      }
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, stderr);
      if (mode === 'release' || mode === 'terminate') assert.equal(released, true);
    } finally { clearTimeout(killTimer); child.kill(); }
  });
}
