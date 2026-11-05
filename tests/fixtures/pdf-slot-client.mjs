import assert from 'node:assert/strict';
import { withPdfSlot } from '../../dist/compat/cli/pdf-slots.js';
const mode = process.argv[2];
const before = ['message', 'disconnect', 'SIGTERM'].map(name => process.listenerCount(name));
await assert.rejects(withPdfSlot(async signal => {
  if (mode === 'release') throw Error('render_failed');
  await new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}), mode === 'release' ? /render_failed/ : mode === 'terminate' ? /pdf_scheduler_aborted/ : /pdf_scheduler_disconnected/);
assert.deepEqual(['message', 'disconnect', 'SIGTERM'].map(name => process.listenerCount(name)), before);
