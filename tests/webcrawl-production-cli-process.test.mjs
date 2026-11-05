import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function runNode(args, { cwd = packageRoot, timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child_timeout_${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function startNode(args, { cwd = packageRoot, timeoutMs = 5_000 } = {}) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  let timeout;
  const closed = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child_timeout_${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, closed, get output() { return { stdout, stderr }; } };
}

async function waitForFile(file, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(file); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error('child_barrier_not_reached');
}

test('built image enrichment bounds malformed repeated image input and leaves the event loop live in a child', async () => {
  const script = `
    import { imageEnrichment } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.resolve('@spora/webcrawl/enrichments/images'))).href)};
    let live = false;
    const tick = new Promise(resolve => setImmediate(() => { live = true; resolve(); }));
    const result = await imageEnrichment.run({ target: 'https://fixture.example/', capturedAt: new Date().toISOString(), pages: [{ url: 'https://fixture.example/', html: '<img '.repeat(20000) }] });
    await tick;
    process.stdout.write(JSON.stringify({ status: result.status, findings: result.findings.length, live }));
  `;
  const child = await runNode(['--input-type=module', '-e', script], { timeoutMs: 5_000 });
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { status: 'complete', findings: 0, live: true });
});

test('built CLI rejects unknown flags with no stdout and no outputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webcrawl-cli-process-'));
  try {
    const output = path.join(directory, 'audit');
    const child = await runNode([path.join(packageRoot, 'dist/compat/cli.js'), 'https://fixture.example/', '--out', output, '--definitely-unknown'], { timeoutMs: 5_000 });
    assert.notEqual(child.code, 0);
    assert.equal(child.stdout, '');
    assert.match(child.stderr, /unknown_cli_option/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing optional browser runtime fails before an injected HTTP request', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'webcrawl-no-browser-'));
  try {
    const isolated = path.join(temporaryRoot, 'package');
    const modules = path.join(isolated, 'node_modules');
    const outputDir = path.join(temporaryRoot, 'output');
    await Promise.all([mkdir(path.join(isolated, 'dist'), { recursive: true }), mkdir(modules, { recursive: true }), mkdir(outputDir)]);
    await Promise.all([
      cp(path.join(packageRoot, 'dist'), path.join(isolated, 'dist'), { recursive: true }),
      cp(path.join(packageRoot, 'package.json'), path.join(isolated, 'package.json')),
      cp(path.join(packageRoot, 'compat-profiles.json'), path.join(isolated, 'compat-profiles.json')),
    ]);
    const crawl = path.join(temporaryRoot, 'crawl');
    await mkdir(path.join(crawl, 'node_modules'), {recursive:true});
    const crawlRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@spora/webcrawl'))));
    await cp(path.join(crawlRoot,'dist'),path.join(crawl,'dist'),{recursive:true});
    await cp(path.join(crawlRoot,'package.json'),path.join(crawl,'package.json'));
    await mkdir(path.join(modules,'@spora'),{recursive:true});
    await symlink(crawl,path.join(modules,'@spora/webcrawl'),'dir');
    const parse5Entry = require.resolve('parse5');
    await symlink(path.resolve(path.dirname(parse5Entry), '..'), path.join(crawl, 'node_modules/parse5'), 'dir');
    const runner = path.join(temporaryRoot, 'runner.mjs');
    await writeFile(runner, `
      import { runCli } from ${JSON.stringify(pathToFileURL(path.join(isolated, 'dist/compat/cli.js')).href)};
      let requests = 0;
      try {
        await runCli(['https://fixture.example/', '--browser', '--out', ${JSON.stringify(path.join(outputDir, 'audit'))}, '--no-pdf', '--no-pagespeed', '--no-contacts', '--no-page-data'], {
          resolveAddresses: async () => ['93.184.216.34'],
          request: async () => { requests++; return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>fixture</title>') }; },
        });
        process.stdout.write(JSON.stringify({ requests, error: null }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ requests, error: error?.code ?? error?.message ?? 'unknown' }));
      }
    `);
    const child = await runNode([runner], { cwd: temporaryRoot, timeoutMs: 5_000 });
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { requests: 0, error: 'ERR_MODULE_NOT_FOUND' });
    assert.deepEqual(await readdir(outputDir), ['audit.run.log']);
    const log = await readFile(path.join(outputDir, 'audit.run.log'), 'utf8');
    assert.match(log, /preflight failed/);
    assert.match(log, /failure category=missing_dependency action=install_package_dependencies/);
    assert.doesNotMatch(log, /ERR_MODULE_NOT_FOUND|Cannot find package|node_modules/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('batch lock excludes same and different processes and leaves recoverable state after owner death', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'webcrawl-batch-process-'));
  let owner;
  try {
    const output = path.join(temporaryRoot, 'out');
    const sameInput = path.join(temporaryRoot, 'same.csv');
    const otherInput = path.join(temporaryRoot, 'other.csv');
    const started = path.join(temporaryRoot, 'owner-request-started');
    const runner = path.join(temporaryRoot, 'batch-worker.mjs');
    await Promise.all([
      mkdir(output),
      writeFile(sameInput, 'website\nhttps://same.fixture.example/\n'),
      writeFile(otherInput, 'website\nhttps://other.fixture.example/\n'),
    ]);
    await writeFile(runner, `
      import { writeFile } from 'node:fs/promises';
      import { runBatch } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist/compat/cli/batch.js')).href)};
      const [mode, input, output, started] = process.argv.slice(2);
      let requests = 0;
      const transport = {
        resolveAddresses: async () => ['93.184.216.34'],
        request: async () => {
          requests++;
          if (mode === 'owner') { await writeFile(started, 'entered'); await new Promise(() => {}); }
          return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><title>fixture</title><h1>fixture</h1></html>') };
        },
      };
      if (mode === 'owner') {
        setInterval(() => {}, 1000);
        await runBatch(input, output, false, false, false, transport, false);
      } else {
        try { await runBatch(input, output, false, false, false, transport, false); process.stdout.write(JSON.stringify({ error: null, requests })); }
        catch (error) { process.stdout.write(JSON.stringify({ error: error.message, requests })); }
      }
    `);

    owner = startNode([runner, 'owner', sameInput, output, started], { cwd: temporaryRoot, timeoutMs: 5_000 });
    await waitForFile(started);
    for (const input of [sameInput, otherInput]) {
      const contender = await runNode([runner, 'contender', input, output, started], { cwd: temporaryRoot, timeoutMs: 5_000 });
      assert.equal(contender.code, 0, contender.stderr);
      assert.deepEqual(JSON.parse(contender.stdout), { error: 'batch_directory_locked', requests: 0 });
    }

    owner.child.kill('SIGKILL');
    const ownerResult = await owner.closed;
    assert.equal(ownerResult.signal, 'SIGKILL');
    const staleLockPath = path.join(output, '.batch.lock');
    assert.match(await readFile(staleLockPath, 'utf8'), /"pid"/);
    await unlink(staleLockPath); // Operator recovery after confirming the owner process has exited.

    const { runBatch } = await import('../dist/compat/cli/batch.js');
    let resumedRequests = 0;
    const transport = {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async () => { resumedRequests++; return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><title>fixture</title><h1>fixture</h1></html>') }; },
    };
    await runBatch(sameInput, output, true, false, false, transport, false);
    assert.ok(resumedRequests > 0);
    let extraRequests = 0;
    await runBatch(sameInput, output, true, false, false, { ...transport, request: async () => { extraRequests++; throw new Error('completed resume should not request'); } }, false);
    assert.equal(extraRequests, 0);
  } finally {
    if (owner?.child.exitCode === null && owner.child.signalCode === null) owner.child.kill('SIGKILL');
    if (owner) await owner.closed.catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
