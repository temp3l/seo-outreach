import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
for (const [name, path] of [['webcrawl', '../dist/compat/cli.js'], ['webcrawl-sites', '../dist/compat/cli/sites.js']]) {
  const moduleUrl = new URL(path, import.meta.url);
  test(`${name} runs through a package-manager-style bin symlink`, async () => {
    const root = await mkdtemp('/tmp/webcrawl-bin-entry-');
    try {
      const executable = `${root}/${name}`;
      await symlink(moduleUrl, executable);
      const { stdout } = await exec(process.execPath, [executable, '--help']);
      assert.ok(stdout.startsWith(`Usage: ${name} `));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test(`${name} remains importable when argv points to stdin`, async () => {
    const code = `await import(${JSON.stringify(moduleUrl.href)}); process.stdout.write('import-only');`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code, '-']);
    assert.equal(stdout, 'import-only');
  });
}
