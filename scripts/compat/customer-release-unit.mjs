// The five-file local release unit. A verified manifest is the commit marker.
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, realpath, unlink, rename } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function privateStat(path, directory = false) {
  const s = await lstat(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid() || (s.mode & 0o077)) throw Error('unsafe_release_stage');
  return s;
}
async function read(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await fd.stat(); if (!s.isFile() || s.size > 200_000_000) throw Error('unsafe_release_stage'); return await fd.readFile(); } finally { await fd.close(); }
}
async function write(path, bytes) {
  const fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  if (!(await read(path)).equals(bytes)) throw Error('output_readback_mismatch');
}
async function exists(path) { try { return await lstat(path); } catch(e) { if (e.code !== 'ENOENT') throw e; } }
async function sameFile(a,b) { const x = await lstat(a), y = await lstat(b); return !y.isSymbolicLink() && x.dev === y.dev && x.ino === y.ino; }

export async function withReleaseUnit(prefix, paths, identity, action, phase = async () => {}) {
  const parent = dirname(prefix);
  if (await realpath(parent) !== parent) throw Error('unsafe_output_parent');
  const parentStat = await lstat(parent);
  if (parentStat.uid !== process.getuid() || parentStat.mode & 0o022) throw Error('unsafe_output_parent');
  const stage = `${parent}/.${basename(prefix)}.release-stage`;
  try { await mkdir(stage, { mode: 0o700 }); } catch(e) { if (e.code !== 'EEXIST') throw e; }
  await privateStat(stage, true);
  const lockPath = `${stage}/lock`;
  try { await write(lockPath, Buffer.alloc(0)); } catch(e) { if (e.code !== 'EEXIST') throw e; }
  await privateStat(lockPath);
  const lockFd = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  // In command mode flock treats a bare "3" as a filename, not an FD.
  // Reopen the inherited FD through procfs to lock this prefix only.
  // flock is process-owned: SIGKILL releases it, so retries need no stale-lock deletion.
  const holder = spawn('flock', ['-n', '/proc/self/fd/3', process.execPath, '-e', "process.stdout.write('LOCKED\\n');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe', lockFd.fd] });
  const stopped = new Promise(resolve => holder.once('close', resolve));
  try {
    await new Promise((resolve,reject) => {
      holder.once('error',reject); holder.once('exit', () => reject(Error('release_busy')));
      holder.stdout.once('data', bytes => bytes.toString() === 'LOCKED\n' ? resolve() : reject(Error('release_lock_failed')));
    });
    const atomicWrite = async (path, bytes) => {
      const temporary = `${path}.tmp`;
      if (await exists(temporary)) { const s = await privateStat(temporary); if (s.nlink !== 1) throw Error('unsafe_release_stage'); await unlink(temporary); }
      await write(temporary, bytes);
      if (await exists(path)) throw Error('output_collision');
      await rename(temporary, path);
    };
    const identityPath = `${stage}/identity.json`;
    const expected = Buffer.from(JSON.stringify({ identity, paths }));
    if (await exists(identityPath)) { if (!(await read(identityPath)).equals(expected)) throw Error('output_collision'); }
    else {
      for (const path of paths) if (await exists(path)) throw Error('output_collision');
      await atomicWrite(identityPath, expected);
    }
    const planPath = `${stage}/plan.json`;
    const verify = async () => {
      const plan = JSON.parse((await read(planPath)).toString());
      if (!Array.isArray(plan) || plan.length !== 5 || plan.some((r,i) => r.path !== paths[i] || !/^[a-f0-9]{64}$/.test(r.sha256))) throw Error('manifest_validation_failed');
      for (let i=0;i<5;i++) {
        await privateStat(`${stage}/${i}`);
        if (digest(await read(`${stage}/${i}`)) !== plan[i].sha256) throw Error('artifact_hash_readback_mismatch');
        if (await exists(paths[i])) {
          if (!await sameFile(`${stage}/${i}`, paths[i]) || digest(await read(paths[i])) !== plan[i].sha256) throw Error('output_collision');
        }
      }
      const m = JSON.parse((await read(`${stage}/4`)).toString());
      if (m.schema !== 'webcrawl-customer-release-v1' || m.reportStatus !== 'CLIENT_READY' || m.outboundApproval !== false || m.artifacts?.length !== 4 || m.artifacts.some((r,i) => r.path !== paths[i] || r.sha256 !== plan[i].sha256)) throw Error('manifest_validation_failed');
      return plan;
    };
    const publish = async () => {
      const plan = await verify();
      for (let i=0;i<5;i++) {
        await phase('before', i);
        if (!await exists(paths[i])) await link(`${stage}/${i}`, paths[i]);
        if (!await sameFile(`${stage}/${i}`, paths[i]) || digest(await read(paths[i])) !== plan[i].sha256) throw Error('artifact_hash_readback_mismatch');
        await phase('after', i);
        // Commit marker (index 4) is linked only after all four verified artifacts.
      }
      await verify();
      const dir = await open(parent, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      const m = JSON.parse((await read(paths[4])).toString());
      return { manifestPath: paths[4], reportStatus: m.reportStatus, artifacts: m.artifacts };
    };
    if (await exists(planPath)) return await publish();
    // No plan means no final links were published. Remove only private scratch
    // files owned by this exact unit; never remove any destination.
    for (let i=0;i<5;i++) if (await exists(`${stage}/${i}`)) { await privateStat(`${stage}/${i}`); if ((await lstat(`${stage}/${i}`)).nlink !== 1) throw Error('output_collision'); await unlink(`${stage}/${i}`); }
    return await action({ stagePath: i => `${stage}/${i}`, commit: async () => {
      const plan = [];
      for(let i=0;i<5;i++) plan.push({path:paths[i],sha256:digest(await read(`${stage}/${i}`))});
      await atomicWrite(planPath, Buffer.from(JSON.stringify(plan)));
      const dir = await open(stage,constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      return publish();
    } });
  } finally { holder.stdin.end(); await stopped; await lockFd.close(); }
}
