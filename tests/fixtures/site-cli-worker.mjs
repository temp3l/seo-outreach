import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { runCli } from '../../dist/compat/cli.js';

const record = event => appendFileSync(process.env.WEBCRAWL_SITE_FIXTURE_EVENTS, `${JSON.stringify({ event, pid: process.pid })}\n`);
record('worker-start');
// Exercise the production CLI/PDF pipeline without launching Chromium or making
// network requests. Shared permit ownership remains in the production code.
registerHooks({
  resolve(specifier, context, next) { return specifier === 'playwright' ? { url: 'fixture:site-playwright', shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === 'fixture:site-playwright' ? { format: 'module', source: 'export const chromium=globalThis.__siteChromium;', shortCircuit: true } : next(url, context); },
});
globalThis.__siteChromium = { launch: async () => {
  record('browser-start');
  return {
    isConnected: () => true,
    close: async () => record('browser-end'),
    newContext: async () => ({ route: async () => {}, close: async () => {}, newPage: async () => ({
      setContent: async () => {}, emulateMedia: async () => {}, evaluate: async () => true, pdf: async () => Buffer.from('%PDF-1.4\n'),
    }) }),
  };
} };
await runCli(process.argv.slice(2), {
  resolveAddresses: async () => ['93.184.216.34'],
  request: async url => {
    record('request');
    return { status: url.pathname === '/robots.txt' ? 404 : 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html lang="en"><title>Fixture</title><main><h1>Fixture</h1></main></html>') };
  },
});
record('worker-end');
