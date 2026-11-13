import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
const stage = process.argv[2];
let launches = 0, closes = 0, contexts = 0, contextCloses = 0, active = 0, peak = 0, pdfs = 0;
let connected = true;
globalThis.__fixtureChromium = { launch: async () => {
  launches++;
  connected = true;
  return {
    isConnected: () => connected,
    close: async () => { closes++; if (stage === 'callback-falsy') throw Error('browser_cleanup_failed'); },
    newContext: async options => {
      assert.deepEqual(options, { serviceWorkers: 'block', javaScriptEnabled: false });
      contexts++; active++; peak = Math.max(peak, active);
      return {
        route: async (pattern, handle) => {
          assert.equal(pattern, '**/*');
          await handle({ abort: async reason => assert.equal(reason, 'blockedbyclient') });
        },
        newPage: async () => ({
          setContent: async () => {},
          emulateMedia: async () => {},
          evaluate: async () => stage !== 'layout' || pdfs > 0,
          pdf: async () => { pdfs++; if (stage === 'render-failure' && pdfs === 1) throw Error('browser_crashed'); return Buffer.from('%PDF-1.4\n'); },
        }),
        close: async () => { contextCloses++; active--; },
      };
    },
  };
} };
registerHooks({
  resolve(specifier, context, next) { return specifier === 'playwright' ? { url: 'fixture:playwright', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'fixture:playwright' ? { format: 'module', source: 'export const chromium=globalThis.__fixtureChromium;', shortCircuit: true } : next(url, context); },
});
const { withPlaywrightPdfSession } = await import('../../dist/reports/pdf-playwright.js');
if (stage === 'cli' || stage === 'managed-cli') {
  const { runCli } = await import('../../dist/compat/cli.js');
  const root = await mkdtemp('/tmp/webcrawl-pdf-session-cli-');
  try {
    await writeFile(`${root}/issuer.json`, JSON.stringify({ name: 'Synthetic Reviewer', email: 'reviewer@example.test' }), { mode: 0o600 });
    const html = '<html lang="en"><head><title>' + 'A useful lesson offer '.repeat(6) + '</title></head><body><main><h2>Lessons</h2><h4>Booking details</h4><img src="/lesson.jpg"></main></body></html>';
    await runCli(['https://fixture.example/', '--out', `${root}/audit`, '--report-contact-file', `${root}/issuer.json`, '--no-progress', '--no-pagespeed', '--image-checks', '0', '--retries', '0', '--interval-ms', '0'], {
      resolveAddresses: async () => ['93.184.216.34'],
      request: async url => ({ status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': url.pathname === '/' ? 'text/html' : 'text/plain' }, body: Buffer.from(url.pathname === '/' ? html : 'missing') }),
    });
    assert.equal((await readdir(root)).filter(name => name.endsWith('.pdf')).length, 2);
    assert.match(await readFile(`${root}/audit.run.log`, 'utf8'), /status=HOLD locale=en/);
    assert.equal(launches, 2); assert.equal(contexts, 2); assert.equal(closes, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  let retained;
  const operation = () => withPlaywrightPdfSession(async renderer => {
    retained = renderer;
    if (stage === 'layout') {
      await assert.rejects(renderer('<body data-client-ready="true"></body>'), /client_report_not_ready/);
    } else if (stage === 'render-failure') {
      await assert.rejects(renderer('<title>Broken</title>'), /browser_crashed/);
    } else {
      await renderer('<title>First</title>');
      if (stage === 'disconnect') connected = false;
    }
    if (stage === 'callback-failure') throw Error('callback_failed');
    if (stage === 'callback-falsy') throw 0;
    await Promise.all(Array.from({ length: 3 }, () => renderer('<title>Next</title>')));
  });
  if (stage === 'callback-failure') await assert.rejects(operation(), /callback_failed/);
  else if (stage === 'callback-falsy') await assert.rejects(operation(), error => error === 0);
  else await operation();
  await assert.rejects(retained('<title>After close</title>'), /pdf_session_closed/);
  const expected = ['disconnect', 'render-failure'].includes(stage) ? 2 : 1;
  assert.equal(launches, expected); assert.equal(closes, expected);
}
assert.equal(contexts, contextCloses);
assert.equal(active, 0); assert.equal(peak, 1);
