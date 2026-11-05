import { setTimeout as delay } from 'node:timers/promises';
import { runCli } from '../../dist/compat/cli.js';
const mode = process.argv[2];
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
await runCli(['https://fixture.example/', '--out', process.argv[3], '--no-pdf', '--no-pagespeed', '--no-images', '--no-contacts', '--no-technology', '--no-progress', '--interval-ms', '0', '--retries', '0', '--pages', '1', '--requests', '2', '--runtime-ms', '10000'], {
  resolveAddresses: async () => ['93.184.216.34'],
  request: async url => {
    process.send?.({ type: 'fixture:crawl-start' });
    if (mode !== 'normal') await delay(30_000);
    return { status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': url.pathname === '/' ? 'text/html' : 'text/plain' }, body: Buffer.from(url.pathname === '/' ? '<html lang="en"><title>Fixture</title><h1>Fixture</h1></html>' : 'missing') };
  },
});
