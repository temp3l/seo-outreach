// Owned filesystem fault injection, isolated from other tests by a child process.
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
const fs = createRequire(import.meta.url)('node:fs/promises');
const originalOpen = fs.open, originalLink = fs.link;
const [scenario, target, archivePath] = process.argv.slice(2);
let temporary;
const marker = 'COMPETING_OPERATION_SYNTHETIC';
fs.open = async (path, ...args) => {
  if (String(path).endsWith('.tmp')) {
    temporary = String(path);
    if (scenario === 'open-collision') await fs.writeFile(path, marker, { flag: 'wx', mode: 0o600 });
  }
  const file = await originalOpen(path, ...args);
  if (String(path).endsWith('.tmp') && scenario === 'temporary-replaced') {
    file.writeFile = async () => {
      await fs.unlink(path); await fs.writeFile(path, marker, { flag: 'wx', mode: 0o600 });
      throw new Error('owned_write_fault');
    };
  }
  return file;
};
fs.link = async (source, destination) => {
  await originalLink(source, destination);
  if (destination === target && scenario.startsWith('success-')) {
    await fs.unlink(source);
    if (scenario === 'success-replaced') await fs.writeFile(source, marker, { flag: 'wx', mode: 0o600 });
    else if (scenario === 'success-symlink') await fs.symlink(archivePath, source);
    return;
  }
  if (destination !== target || !scenario.startsWith('final-')) return;
  await fs.unlink(target);
  if (scenario === 'final-fifo') execFileSync('mkfifo', ['-m', '600', target]);
  else if (scenario === 'final-symlink') await fs.symlink(archivePath, target);
  else await fs.writeFile(target, marker, { flag: 'wx', mode: 0o600 });
};
syncBuiltinESMExports();
const { writeEvidencePackExclusive, verifyEvidencePack } = await import('@spora/webcrawl/reports/evidence-pack');
const bytes = await fs.readFile(archivePath);
if (scenario.startsWith('success-')) {
  await writeEvidencePackExclusive(target, bytes);
  assert.deepEqual(await fs.readFile(target), bytes);
  verifyEvidencePack(await fs.readFile(target));
  if (scenario === 'success-replaced') assert.equal(await fs.readFile(temporary, 'utf8'), marker);
  else if (scenario === 'success-symlink') assert.equal((await fs.lstat(temporary)).isSymbolicLink(), true);
  else await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
  console.log(`${scenario}: publication verified; replacement or absence preserved`);
} else {
  await assert.rejects(writeEvidencePackExclusive(target, bytes), error => {
    if (scenario === 'open-collision') return error.code === 'EEXIST';
    if (scenario === 'temporary-replaced') return error.message === 'owned_write_fault';
    if (scenario === 'final-symlink') return error.code === 'ELOOP';
    return error.message === 'evidence_output_changed_during_readback';
  });
  if (scenario === 'open-collision' || scenario === 'temporary-replaced') {
    assert.equal(await fs.readFile(temporary, 'utf8'), marker);
    await assert.rejects(fs.access(target), { code: 'ENOENT' });
  } else {
    const info = await fs.lstat(target);
    if (scenario === 'final-fifo') assert.equal(info.isFIFO(), true);
    else if (scenario === 'final-symlink') assert.equal(info.isSymbolicLink(), true);
    else assert.equal(await fs.readFile(target, 'utf8'), marker);
  }
  console.log(`${scenario}: rejected promptly; competing entry preserved`);
}
