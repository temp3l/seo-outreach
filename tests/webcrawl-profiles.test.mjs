import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { bundledProfilesPath, loadProfiles, resolveProfileOptions } from '../dist/compat/cli/profiles.js';
const exec = promisify(execFile);
const cli = new URL('../dist/compat/cli.js', import.meta.url);
async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'webcrawl-profiles-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function config(dir, profiles, rest = {}) {
  const path = join(dir, 'profiles.json');
  await writeFile(path, JSON.stringify({ version: 1, profiles, ...rest }));
  return path;
}

test('bundled configuration is loaded live and fast inherits its editable defaults', async () => {
  const file = JSON.parse(await readFile(bundledProfilesPath, 'utf8'));
  const catalog = await loadProfiles();
  assert.equal(catalog.defaultProfile, file.defaultProfile);
  assert.equal(catalog.profiles.default.options['pdf-locale'], 'en');
  const { description: _description, extends: _extends, ...expected } = file.profiles.default;
  assert.deepEqual(catalog.profiles.default.options, expected);
  const { description: _fastDescription, extends: parent, ...fastOverrides } = file.profiles.fast;
  assert.equal(parent, 'default');
  assert.deepEqual(catalog.profiles.fast.options, { ...expected, ...fastOverrides });
});

test('custom profiles inherit bundled and custom profiles and select a custom default', async () => temporary(async dir => {
  const path = await config(dir, { default: { pages: 123 }, quick: { extends: 'fast', requests: 100 }, child: { extends: 'quick', pdf: false } }, { defaultProfile: 'child' });
  const catalog = await loadProfiles(path);
  assert.equal(catalog.defaultProfile, 'child');
  assert.deepEqual([catalog.profiles.child.options.pages, catalog.profiles.child.options.requests, catalog.profiles.child.options['interval-ms'], catalog.profiles.child.options.pdf], [123, 100, (await loadProfiles()).profiles.fast.options['interval-ms'], false]);
}));

test('CLI overrides inherited settings and can turn off inherited features', async () => {
  const base = (await loadProfiles()).profiles.fast.options;
  const options = resolveProfileOptions({ ...base, browser: 'auto', images: true, 'security-txt': true, 'page-data-html': true }, ['--pages', '20', '--interval-ms', '0', '--locale', 'de', '--pdf-locale', 'de', '--no-pdf', '--no-evidence-pack', '--no-browser', '--no-images', '--no-security-txt', '--no-progress', '--no-page-data']);
  assert.deepEqual([options.pages, options['interval-ms'], options.locale, options['pdf-locale']], [20, 0, 'de', 'de']);
  for (const key of ['pdf', 'evidence-pack', 'browser', 'images', 'security-txt', 'progress', 'page-data', 'page-data-html']) assert.equal(options[key], false, key);
  assert.throws(() => resolveProfileOptions(base, ['--pdf', '--no-pdf']), /mutually exclusive/);
  assert.throws(() => resolveProfileOptions(base, ['--browser', '--browser=auto']), /conflicting_browser/);
  assert.throws(() => resolveProfileOptions(base, ['--no-page-data', '--page-data-html']), /cannot be combined/);
});

test('PSI enabled in a profile does not implicitly opt in to sending query parameters', async () => {
  const base = (await loadProfiles()).profiles.default.options;
  assert.equal(resolveProfileOptions(base, [])['pagespeed-include-query'], false);
  assert.equal(resolveProfileOptions(base, ['--pagespeed-include-query'])['pagespeed-include-query'], true);
  assert.equal(resolveProfileOptions(base, ['--pagespeed'])['pagespeed-include-query'], false);
  assert.equal(resolveProfileOptions(base, ['--pagespeed', '--no-pagespeed-include-query'])['pagespeed-include-query'], false);
});

test('invalid configuration, unknown parents and cycles fail before crawling', async () => temporary(async dir => {
  for (const [profiles, expected] of [
    [{ typo: { concurrencyy: 3 } }, /unknown_profile_option/],
    [{ bad: { pages: 0 } }, /invalid_profile_option/],
    [{ bad: { pdf: 'yes' } }, /invalid_profile_option/],
    [{ bad: { 'pdf-locale': 'fr' } }, /invalid_profile_option/],
    [{ bad: { extends: 'absent' } }, /unknown_profile/],
    [{ a: { extends: 'b' }, b: { extends: 'a' } }, /inheritance_cycle/],
  ]) await assert.rejects(loadProfiles(await config(dir, profiles)), expected);
  const path = await config(dir, { broken: { concurrency: 0 } });
  const script = `import { runCli } from ${JSON.stringify(cli.href)};
    let calls = 0;
    try { await runCli(['https://fixture.invalid/', '--profiles-file', process.argv[1]], { resolveAddresses: async () => { calls++; throw Error('unexpected_network'); } }); }
    catch (e) { console.log(JSON.stringify({calls, message:e.message})); }`;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script, path]);
  assert.deepEqual(JSON.parse(stdout).calls, 0);
  assert.match(JSON.parse(stdout).message, /invalid_profile_option/);
}));

test('list and show config work without a target, outputs or browser from another working directory', async () => temporary(async dir => {
  const { stdout: names } = await exec(process.execPath, [cli.pathname, '--list-profiles'], { cwd: dir });
  assert.match(names, /default \(default\)/); assert.match(names, /fast/);
  const { stdout } = await exec(process.execPath, [cli.pathname, '--profile', 'fast', '--pages', '17', '--no-pdf', '--show-config'], { cwd: dir });
  const config = JSON.parse(stdout);
  assert.equal(config.profile, 'fast'); assert.equal(config.options.pages, 17);
  assert.equal(config.options['interval-ms'], (await loadProfiles()).profiles.fast.options['interval-ms']); assert.equal(config.options.pdf, false);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(exec(process.execPath, [cli.pathname, '--profile', 'unknown', '--show-config']), /unknown_profile/);
  await assert.rejects(exec(process.execPath, [cli.pathname, '--batch', 'sites.csv', '--profile', 'fast']), /unsupported_batch_option/);
}));

test('offline CLI crawl writes evidence ZIP only when enabled by profile; explicit page data works', async () => temporary(async dir => {
  const path = await config(dir, { offline: { extends: 'fast', pdf: false, pagespeed: false, progress: false, 'evidence-pack': true, 'interval-ms': 0, pages: 1, requests: 3, contacts: false, 'page-data': true } });
  const output = join(dir, 'school');
  const script = `import { runCli } from ${JSON.stringify(cli.href)};
    await runCli(['--profiles-file', process.argv[1], '--profile', 'offline', 'https://fixture.invalid/', '--out', process.argv[2]], {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async url => ({status:url.pathname==='/robots.txt'?404:200,headers:{'content-type':'text/html'},body:Buffer.from('<html lang="en"><head><title>School</title></head><body><main><h1>School</h1></main></body></html>')})
    });`;
  await exec(process.execPath, ['--input-type=module', '-e', script, path, output]);
  const audit = JSON.parse(await readFile(`${output}.json`, 'utf8'));
  assert.equal(audit.target, 'https://fixture.invalid/');
  assert.equal(audit.crawlSettings.policy.maxPages, 1);
  assert.equal(audit.crawlSettings.policy.maxRequests, 3);
  assert.equal(audit.crawlSettings.policy.maxConcurrency, 3);
  assert.equal(audit.crawlSettings.policy.minRequestIntervalMs, 0);
  assert.equal(audit.capabilities.pagespeed, 'disabled');
  const files = await readdir(dir);
  for (const name of ['profiles.json', 'school.evidence.zip', 'school.html', 'school.json', 'school.page-data.json']) assert.ok(files.includes(name), name);
  assert.ok(files.every(name => !name.endsWith('.pdf')));
}));


test('omitting --profile uses the configured default, including UA and retry policy, in an actual offline crawl', async () => temporary(async dir => {
  const catalog = await loadProfiles();
  const expected = catalog.profiles[catalog.defaultProfile].options;
  const script = `import { runCli } from ${JSON.stringify(cli.href)};
    import { writeFile } from 'node:fs/promises';
    const agents=[]; let pageRequests=0;
    await runCli(['https://fixture.invalid/', '--out', process.argv[1], '--pages', '1', '--interval-ms', '0', '--image-checks', '0', '--no-images', '--no-browser', '--no-security-txt', '--no-pagespeed', '--no-pdf', '--no-progress', ...JSON.parse(process.argv[2])], {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async (url, addresses, options) => {
        agents.push(options.userAgent);
        if (url.pathname === '/robots.txt') return { status:404, headers:{}, body:Buffer.alloc(0) };
        pageRequests++;
        if (pageRequests === 1 && Number(process.argv[3]) > 0) return { status:503, headers:{'retry-after':'0'}, body:Buffer.alloc(0) };
        return { status:200, headers:{'content-type':'text/html'}, body:Buffer.from('<html lang="en"><head><title>School</title></head><body><h1>School</h1></body></html>') };
      }
    });
    await writeFile(process.argv[1] + '.requests.json', JSON.stringify({agents,pageRequests}));`;
  const audits=[];
  for (const [name, flags] of [['implicit', []], ['explicit', ['--profile', catalog.defaultProfile]]]) {
    const out=join(dir,name);
    await exec(process.execPath, ['--input-type=module', '-e', script, out, JSON.stringify(flags), String(expected.retries)]);
    const audit=JSON.parse(await readFile(`${out}.json`, 'utf8'));
    const trace=JSON.parse(await readFile(`${out}.requests.json`, 'utf8'));
    assert.equal(audit.crawlSettings.policy.maxRequests, expected.requests);
    assert.equal(audit.crawlSettings.policy.maxConcurrency, expected.concurrency);
    assert.equal(audit.crawlSettings.policy.maxRetries, expected.retries);
    assert.equal(audit.crawlSettings.policy.maxRuntimeMs, expected['runtime-ms']);
    assert.equal(audit.crawlSettings.policy.maxResponseBytes, expected['response-bytes']);
    assert.equal(audit.crawlSettings.policy.maxTotalResponseBytes, expected['total-bytes']);
    assert.equal(audit.crawlSettings.userAgent, expected['user-agent']);
    assert.ok(trace.agents.every(agent => agent === expected['user-agent']));
    assert.equal(trace.pageRequests, expected.retries > 0 ? 2 : 1);
    assert.equal(audit.crawl.captured, 1);
    assert.equal((await readdir(dir)).includes(`${name}.evidence.zip`), false);
    audits.push(audit);
  }
  assert.deepEqual(audits[0].crawlSettings, audits[1].crawlSettings);
}));
