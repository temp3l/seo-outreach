import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDF_SCHEDULER_ENV } from '../dist/compat/cli/pdf-slots.js';
for (const mode of ['normal', 'crawl', 'ignore-term']) {
  test(`managed CLI owns its launcher connection throughout HTTP work: ${mode}`, async () => {
    const root = await mkdtemp('/tmp/webcrawl-worker-lifetime-');
    const child = fork(fileURLToPath(new URL('./fixtures/managed-cli-worker.mjs', import.meta.url)), [mode, `${root}/audit`], { silent: true, env: { ...process.env, [PDF_SCHEDULER_ENV]: '1' } });
    let forcedByTest = false, stderr = '';
    child.stdout.resume();
    child.stderr.on('data', bytes => { stderr += bytes; });
    const exited = once(child, 'exit');
    const watchdog = setTimeout(() => { forcedByTest = true; child.kill('SIGKILL'); }, 10_000);
    try {
      if (mode !== 'normal') {
        const [message] = await once(child, 'message');
        assert.equal(message.type, 'fixture:crawl-start');
        child.disconnect();
      }
      const [code, signal] = await exited;
      assert.equal(forcedByTest, false, stderr);
      if (mode === 'normal') {
        assert.equal(code, 0, stderr);
        assert.ok(JSON.parse(await readFile(`${root}/audit.json`, 'utf8')).crawl.captured > 0);
      } else {
        assert.equal(signal, mode === 'crawl' ? 'SIGTERM' : 'SIGKILL', stderr);
        await assert.rejects(readFile(`${root}/audit.json`), { code: 'ENOENT' });
      }
    } finally {
      clearTimeout(watchdog);
      child.kill('SIGKILL');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}
