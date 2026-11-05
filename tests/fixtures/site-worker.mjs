import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withPdfSlot } from '../../dist/compat/cli/pdf-slots.js';
const args = process.argv.slice(2);
const path = join(dirname(dirname(args[args.indexOf('--out') + 1])), 'events.jsonl');
const mode = new URL(args[0]).searchParams.get('mode') ?? 'normal';
const write = event => appendFileSync(path, JSON.stringify({ event, pid: process.pid, mode }) + '\n');
write('site-start');
if (mode === 'cap') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(path, 'utf8').split('\n').filter(line => line && JSON.parse(line).event === 'site-start').length >= 3) break;
    } catch { /* The launcher may still be creating the shared event file. */ }
    await delay(5);
  }
}
try { for (let index = 0; index < 2; index++) {
  await withPdfSlot(async signal => {
    write('pdf-start');
    if (mode === 'crash') process.exit(7);
    if (mode === 'disconnect' || mode === 'stubborn-disconnect') process.disconnect();
    if (mode.startsWith('stubborn-')) await delay(30_000);
    else await delay(mode === 'slow' || mode === 'disconnect' ? 30_000 : 40, undefined, { signal });
    write('pdf-end');
  });
  await delay(30);
} write('site-end'); }
catch (error) {
  if (['slow', 'disconnect'].includes(mode) && error.name === 'AbortError') process.exitCode = 8;
  else throw error;
}
