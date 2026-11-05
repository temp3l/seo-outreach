import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { PDF_REQUEST, PDF_GRANTED, PDF_RELEASE } from '../../dist/compat/cli/pdf-slots.js';
const mode = process.argv[2];
let spawned = 0, active = 0, peak = 0;
childProcess.spawn = () => {
  const index = spawned++;
  if (mode === 'spawn-all-fail' || mode === 'spawn-throw' && index === 1) throw Error('synthetic_spawn_failure');
  const child = new EventEmitter();
  child.connected = true;
  let exited = false;
  const exit = (code = 0, signal = null) => {
    if (exited) return;
    exited = true;
    child.connected = false;
    child.emit('exit', code, signal);
    child.emit('close', code, signal);
  };
  child.kill = signal => {
    if (mode === 'stop-release' && index === 0 && signal === 'SIGTERM') {
      // A terminating worker must not free its permit until it really exits.
      setImmediate(() => child.emit('message', { type: PDF_RELEASE, id: 1 }));
      setTimeout(() => { active--; exit(null, 'SIGTERM'); }, 30);
    } else exit();
    return true;
  };
  child.send = (message, callback) => {
    assert.equal(message.type, PDF_GRANTED);
    active++; peak = Math.max(peak, active);
    callback?.(null);
    if (mode === 'stop-release' && index === 0) setImmediate(() => child.emit('message', { type: PDF_REQUEST, id: 0 }));
    else if (mode === 'late-release' && index === 0) setImmediate(() => {
      active--;
      exit();
      // Exit can precede delivery of a buffered IPC message. It must not free
      // a second permit after the worker has already been reclaimed.
      setImmediate(() => child.emit('message', { type: PDF_RELEASE, id: 1 }));
    });
    else setTimeout(() => {
      active--;
      child.emit('message', { type: PDF_RELEASE, id: 1 });
      exit();
    }, 30);
    return true;
  };
  setImmediate(() => child.emit('message', { type: PDF_REQUEST, id: 1 }));
  return child;
};
syncBuiltinESMExports();
const { runSiteJobs } = await import('../../dist/compat/cli/sites.js');
const root = mkdtempSync(join(tmpdir(), 'webcrawl-synthetic-events-'));
try {
  const jobs = [0, 1, 2].map(index => {
    const directory = join(root, `site-${index}`);
    mkdirSync(directory, { mode: 0o700 });
    return [`https://fixture.example/${index}`, '--out', join(directory, 'crawl')];
  });
  const results = await runSiteJobs(jobs, { siteConcurrency: 2, pdfConcurrency: 1 });
  assert.equal(active, 0, 'runner must own all workers until they finish');
  assert.ok(peak <= 1, 'late messages must not exceed the shared PDF limit');
  assert.deepEqual(results.map(row => row.code), mode === 'spawn-all-fail' ? [1, 1, 1] : mode === 'spawn-throw' ? [0, 1, 0] : mode === 'stop-release' ? [null, 0, 0] : [0, 0, 0]);
} finally { rmSync(root, { recursive: true, force: true }); }
