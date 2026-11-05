import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, fork } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PDF_REQUEST, PDF_GRANTED, PDF_SCHEDULER_ENV } from '../dist/compat/cli/pdf-slots.js';
const exec = promisify(execFile);
for (const stage of ['reuse', 'disconnect', 'render-failure', 'layout', 'callback-failure', 'callback-falsy', 'cli']) {
  test(`PDF sessions isolate contexts and preserve cleanup: ${stage}`, async () => {
    await exec(process.execPath, [fileURLToPath(new URL('./fixtures/pdf-session.mjs', import.meta.url)), stage], { timeout: 10_000 });
  });
}
test('managed CLI releases its lifetime watch after both PDF phases and exits normally', async () => {
  const child = fork(fileURLToPath(new URL('./fixtures/pdf-session.mjs', import.meta.url)), ['managed-cli'], { silent: true, env: { ...process.env, [PDF_SCHEDULER_ENV]: '1' } });
  let permits = 0, stderr = '';
  child.stdout.resume();
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.on('message', message => {
    if (message.type === PDF_REQUEST) { permits++; child.send({ type: PDF_GRANTED, id: message.id }); }
  });
  const exited = once(child, 'exit');
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(permits, 2);
  } finally { clearTimeout(watchdog); child.kill('SIGKILL'); await exited; }
});
test('shared PDF lifecycle bounds setup, rendering, cancellation and shutdown', async () => {
  for (const stage of ['preabort', 'launch', 'context', 'page', 'route', 'content', 'pdf', 'context-close', 'close', 'late-launch', 'late-context', 'abort-content', 'success']) {
    const { stdout } = await exec(process.execPath, [fileURLToPath(new URL('./fixtures/pdf-lifecycle.mjs', import.meta.url)), stage, 'session'], { timeout: 5_000 });
    const result = JSON.parse(stdout);
    assert.deepEqual(result.unhandled, [], stage);
    assert.equal(result.listeners, 0, stage);
    if (stage === 'success') { assert.equal(result.bytes, 4); assert.equal(result.contextCloses, 1); assert.equal(result.browserCloses, 1); }
    else assert.match(result.error, /pdf_.*(?:timeout|aborted)/, stage);
    if (stage === 'preabort') assert.equal(result.launches, 0);
    if (stage === 'late-launch') assert.equal(result.browserCloses, 1);
    if (stage === 'late-context') assert.equal(result.contextCloses, 1);
  }
});
