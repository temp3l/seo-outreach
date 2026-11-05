import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { batchResultMatchesContactProfile, runBatch } from '../dist/compat/cli/batch.js';
import { CONTACT_PROFILE } from '@spora/webcrawl/enrichments/contacts';
import { ROBOTS_POLICY_REVISION } from '@spora/webcrawl/core/contracts';

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

test('batch contact profiles invalidate legacy and opposite opt-out states in both transition directions', () => {
  const observation = { policy: 'observation-only', revision: ROBOTS_POLICY_REVISION, retrieval: 'missing', googlebotEvaluation: 'NOT_VERIFIED', knownDiscoveredUrls: 0, advisoryAllowed: 0, advisoryDisallowed: 0, advisoryUnknown: 0, capturedDisallowedCount: 0, capturedDisallowedSamples: [], omittedCapturedDisallowedSamples: 0 };
  const crawlSettings = { policy: { robots: 'observation-only' } };
  const enabled = { contacts: { profile: CONTACT_PROFILE }, capabilities: { contacts: 'partial' }, robotsObservation: observation, crawlSettings };
  const disabled = { capabilities: { contacts: 'disabled' }, robotsObservation: observation, crawlSettings };
  assert.equal(batchResultMatchesContactProfile(enabled, CONTACT_PROFILE, true, ROBOTS_POLICY_REVISION), false);
  assert.equal(batchResultMatchesContactProfile(enabled, CONTACT_PROFILE, false, ROBOTS_POLICY_REVISION), false);
  assert.equal(batchResultMatchesContactProfile({ contacts: { profile: 'contacts-v5-whatsapp-widget' }, capabilities: { contacts: 'partial' } }, CONTACT_PROFILE, true), false);
  assert.equal(batchResultMatchesContactProfile(disabled, 'contacts-disabled-v1', false, ROBOTS_POLICY_REVISION), false);
  assert.equal(batchResultMatchesContactProfile(disabled, 'contacts-disabled-v1', true, ROBOTS_POLICY_REVISION), false);
  assert.equal(batchResultMatchesContactProfile({ ...enabled, robotsObservation: { policy: 'observation-only', revision: ROBOTS_POLICY_REVISION } }, CONTACT_PROFILE, true, ROBOTS_POLICY_REVISION), false);
  assert.equal(batchResultMatchesContactProfile(enabled, CONTACT_PROFILE, true, 'robots-respect-v1'), false);
  assert.equal(batchResultMatchesContactProfile(disabled, undefined, true), false);
  assert.equal(batchResultMatchesContactProfile(enabled, undefined, false), false);
});

test('batch PageSpeed is enabled by default and opt-out has a distinct resumable identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-pagespeed-'));
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.PAGESPEED_API_KEY;
  let pageSpeedCalls = 0;
  globalThis.fetch = async () => { pageSpeedCalls++; return Response.json({ lighthouseResult: { categories: Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map((key) => [key, { score: .8 }])) } }); };
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async () => { requests++; return { status: 404, headers: {}, body: Buffer.alloc(0) }; } };
  try {
    delete process.env.PAGESPEED_API_KEY;
    const inputPath = join(root, 'sites.csv'), output = join(root, 'out');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await runBatch(inputPath, output, true, false, false, transport);
    assert.equal(pageSpeedCalls, 1);
    const saved = await readdir(output);
    const defaultResult = JSON.parse(await readFile(join(output, saved.find((name) => name.endsWith('.json') && name !== 'batch-state.json')), 'utf8'));
    assert.ok(defaultResult.crawlSettings.enrichments.includes('pagespeed'));
    assert.equal(defaultResult.capabilities.pagespeed, 'complete');
    const afterDefault = requests;
    await runBatch(inputPath, output, true, false, false, transport);
    assert.equal(pageSpeedCalls, 1);
    assert.equal(requests, afterDefault);
    process.env.PAGESPEED_API_KEY = 'fixture-api-key';
    await runBatch(inputPath, output, true, false, false, transport);
    assert.equal(pageSpeedCalls, 2);
    await runBatch(inputPath, output, true, false, false, transport, false);
    assert.equal(pageSpeedCalls, 2);
    const results = (await readdir(output)).filter((name) => name.endsWith('.json') && name !== 'batch-state.json').map(async (name) => JSON.parse(await readFile(join(output, name), 'utf8')));
    const parsed = await Promise.all(results);
    const disabled = parsed.find((result) => result.capabilities.pagespeed === 'disabled');
    assert.ok(disabled);
    assert.ok(!disabled.crawlSettings.enrichments.includes('pagespeed'));
  } finally { globalThis.fetch = originalFetch; if (originalApiKey === undefined) delete process.env.PAGESPEED_API_KEY; else process.env.PAGESPEED_API_KEY = originalApiKey; await rm(root, { recursive: true, force: true }); }
});

test('resume verifies target and full batch identity before reusing a completed row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-contacts-'));
  let requests = 0;
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      requests++;
      return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': url.pathname === '/' ? 'text/html' : 'text/plain' }, body: Buffer.from(url.pathname === '/' ? '<main><h1>Fixture</h1></main>' : 'missing') };
    },
  };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    const input = Buffer.from('website\nhttps://fixture.example/\n');
    await writeFile(inputPath, input);
    await runBatch(inputPath, output, true, false, true, transport, false);
    const firstRequestCount = requests;
    const filesAfterFirstRun = (await readdir(output)).sort();
    assert.equal(filesAfterFirstRun.length, 5);
    assert.ok(filesAfterFirstRun.includes('batch.run.log'));
    assert.equal(filesAfterFirstRun.filter(name=>name.endsWith('.run.log')).length,2);
    assert.ok(filesAfterFirstRun.some(name => name.endsWith('.whatsapp-draft.md')));
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal((await stat(join(output, 'batch-state.json'))).mode & 0o777, 0o600);
    const state = JSON.parse(await readFile(join(output, 'batch-state.json'), 'utf8'));
    const completed = Object.values(state.completed)[0];
    assert.equal((await stat(join(output, completed.file))).mode & 0o777, 0o600);
    const savedResult = JSON.parse(await readFile(join(output, completed.file), 'utf8'));
    assert.equal(savedResult.target, 'https://fixture.example/');
    assert.equal(savedResult.capabilities.technology, 'complete');
    assert.equal(savedResult.crawlSettings.enrichments.includes('technology'), true);
    assert.equal(savedResult.crawlSettings.retainHtml, false);
    assert.equal(savedResult.crawlSettings.policy.robots, 'observation-only');
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.equal(requests, firstRequestCount);
    assert.deepEqual((await readdir(output)).sort(), filesAfterFirstRun);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkSecurityTxt and contacts profile changes invalidate reuse while matching identity stays request-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-options-'));
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async (url) => { requests++; return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main><h1>Fixture</h1></main>') }; } };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await runBatch(inputPath, output, true, false, true, transport, false);
    const afterEnabled = requests;
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.equal(requests, afterEnabled);
    await runBatch(inputPath, output, true, false, false, transport, false);
    assert.ok(requests > afterEnabled);
    const afterContactsDisabled = requests;
    await runBatch(inputPath, output, true, false, false, transport, false);
    assert.equal(requests, afterContactsDisabled);
    await runBatch(inputPath, output, true, true, false, transport, false);
    assert.ok(requests > afterContactsDisabled);
    const afterSecurityTxtEnabled = requests;
    await runBatch(inputPath, output, true, true, false, transport, false);
    assert.equal(requests, afterSecurityTxtEnabled);
    const outputs = (await readdir(output)).filter((name) => name.endsWith('.json') && name !== 'batch-state.json');
    assert.equal(new Set(outputs).size, outputs.length);
    assert.equal(outputs.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resume recovers a verified result written before its state checkpoint without requesting the site', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-recovery-'));
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async (url) => { requests++; return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Recovered</main>') }; } };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await runBatch(inputPath, output, false, false, true, transport, false);
    const before = requests;
    await import('node:fs/promises').then(({ unlink }) => unlink(join(output, 'batch-state.json')));
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.equal(requests, before);
    const state = JSON.parse(await readFile(join(output, 'batch-state.json'), 'utf8'));
    assert.equal(Object.values(state.completed)[0].extractionProfile, CONTACT_PROFILE);
    assert.equal(Object.values(state.completed)[0].identity.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('batch canonicalizes fragment-bearing URLs before identity and resumes without dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-fragment-'));
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async (url) => { requests++; return { status: url.pathname === '/robots.txt' ? 404 : 200, headers: { 'content-type': url.pathname === '/robots.txt' ? 'text/plain' : 'text/html' }, body: Buffer.from('<html><head><title>Fixture</title></head><body><h1>Fixture</h1></body></html>') }; } };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    await writeFile(inputPath, 'website\nhttps://fixture.example/#section\nhttps://fixture.example/\n');
    const csvHash = hash(await readFile(inputPath));
    await runBatch(inputPath, output, false, false, false, transport, false);
    const before = requests;
    const files = await readdir(output);
    assert.equal(files.filter((name) => name.endsWith('.json') && name !== 'batch-state.json').length, 1);
    const result = JSON.parse(await readFile(join(output, files.find((name) => name.endsWith('.json') && name !== 'batch-state.json')), 'utf8'));
    assert.equal(result.target, 'https://fixture.example/');
    await runBatch(inputPath, output, true, false, false, transport, false);
    assert.equal(requests, before);
    assert.equal(hash(await readFile(inputPath)), csvHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint write failure after result publication is recovered without another request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-checkpoint-failure-'));
  const inputPath = join(root, 'sites.csv');
  const output = join(root, 'out');
  const statePath = join(output, 'batch-state.json');
  let requests = 0;
  let failCheckpoint = true;
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      requests++;
      if (failCheckpoint) {
        failCheckpoint = false;
        await import('node:fs/promises').then(({ unlink }) => unlink(statePath));
        await mkdir(statePath);
      }
      return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Checkpoint fixture</main>') };
    },
  };
  try {
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await assert.rejects(runBatch(inputPath, output, false, false, true, transport, false));
    const published = (await readdir(output)).filter((name) => name.endsWith('.json') && name !== 'batch-state.json');
    assert.equal(published.length, 1);
    const beforeRecovery = requests;
    await rm(statePath, { recursive: true, force: true });
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.equal(requests, beforeRecovery);
    const recoveredState = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.keys(recoveredState.completed).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint-absent recovery rejects malformed audits without replacing the result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-malformed-recovery-'));
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async (url) => { requests++; return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Valid checkpoint fixture</main>') }; } };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    const statePath = join(output, 'batch-state.json');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await runBatch(inputPath, output, false, false, true, transport, false);
    const initialState = JSON.parse(await readFile(statePath, 'utf8'));
    const outputPath = join(output, Object.values(initialState.completed)[0].file);
    const validBytes = await readFile(outputPath);
    const before = requests;
    const malformedVariants = [
      (result) => { result.findings = [42]; },
      (result) => { delete result.startedAt; },
      (result) => { result.contacts.candidates = [42]; },
      (result) => { result.crawl.captured++; },
    ];
    for (const mutate of malformedVariants) {
      const result = JSON.parse(validBytes.toString('utf8'));
      mutate(result);
      const malformedBytes = Buffer.from(JSON.stringify(result, null, 2));
      await writeFile(outputPath, malformedBytes);
      await import('node:fs/promises').then(({ unlink }) => unlink(statePath));
      await assert.rejects(runBatch(inputPath, output, true, false, true, transport, false), /batch_output_conflict/u);
      assert.equal(requests, before);
      assert.deepEqual(await readFile(outputPath), malformedBytes);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy state without identity is reused only after full result identity verification, then migrated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-legacy-state-'));
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async (url) => { requests++; return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Legacy</main>') }; } };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await runBatch(inputPath, output, false, false, true, transport, false);
    const before = requests;
    const statePath = join(output, 'batch-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const entry = Object.values(state.completed)[0];
    delete entry.identity;
    await writeFile(statePath, JSON.stringify(state));
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.equal(requests, before);
    const migrated = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.values(migrated.completed)[0].identity.length, 64);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mismatched deterministic output conflicts without overwrite or suffix proliferation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-conflict-'));
  let requests = 0;
  const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async () => { requests++; return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<main>Fixture</main>') }; } };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\n');
    await runBatch(inputPath, output, false, false, true, transport, false);
    const state = JSON.parse(await readFile(join(output, 'batch-state.json'), 'utf8'));
    const outputPath = join(output, Object.values(state.completed)[0].file);
    await writeFile(outputPath, '{ invalid result');
    const before = requests;
    await assert.rejects(runBatch(inputPath, output, true, false, true, transport, false), /batch_output_conflict/u);
    assert.equal(requests, before);
    assert.equal(await readFile(outputPath, 'utf8'), '{ invalid result');
    assert.equal((await readdir(output)).filter((name) => name.endsWith('.json')).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resume recomputes a current contact profile with legacy robots provenance, preserves it, then reuses current policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-stale-contacts-'));
  let requests = 0;
  const transport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      requests++;
      const html = '<main><address><a href="mailto:office@fixture.test">Email</a><a href="tel:+34603518875">Phone</a></address></main>';
      return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': url.pathname === '/' ? 'text/html' : 'text/plain' }, body: Buffer.from(url.pathname === '/' ? html : 'not found') };
    },
  };
  try {
    const inputPath = join(root, 'sites.csv');
    const output = join(root, 'out');
    const input = Buffer.from('website\nhttps://fixture.test/\n');
    await writeFile(inputPath, input);
    const key = hash('https://fixture.test/').slice(0, 20);
    const oldFile = `sites.csv-${key}.json`;
    const oldBytes = Buffer.from(JSON.stringify({ contacts: { profile: CONTACT_PROFILE }, capabilities: { contacts: 'partial' }, robotsObservation: { policy: 'observation-only', revision: 'robots-legacy-unverified' } }));
    await import('node:fs/promises').then(({ mkdir }) => mkdir(output, { recursive: true }));
    await writeFile(join(output, oldFile), oldBytes);
    await writeFile(join(output, 'batch-state.json'), JSON.stringify({ inputHash: hash(input), completed: { [key]: { file: oldFile, sha256: hash(oldBytes), extractionProfile: CONTACT_PROFILE } } }));
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.ok(requests > 0);
    const state = JSON.parse(await readFile(join(output, 'batch-state.json'), 'utf8'));
    assert.equal(state.completed[key].extractionProfile, CONTACT_PROFILE);
    assert.equal(state.completed[key].robotsPolicyRevision, ROBOTS_POLICY_REVISION);
    const outputResult = JSON.parse(await readFile(join(output, state.completed[key].file), 'utf8'));
    assert.equal(outputResult.contacts.candidates.some((candidate) => candidate.normalizedValue === 'office@fixture.test'), true);
    const beforeReuse = requests;
    await runBatch(inputPath, output, true, false, true, transport, false);
    assert.equal(requests, beforeReuse);
    assert.ok((await readdir(output)).includes(oldFile));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('batch validates every row before the first network request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'webcrawl-batch-preflight-'));
  let requests = 0;
  try {
    const inputPath = join(root, 'sites.csv');
    await writeFile(inputPath, 'website\nhttps://fixture.example/\nfile:///etc/passwd\n');
    await assert.rejects(runBatch(inputPath, join(root, 'out'), false, false, true, { request: async () => { requests++; return { status: 200, headers: {}, body: Buffer.alloc(0) }; } }), /invalid_batch_url/u);
    assert.equal(requests, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
