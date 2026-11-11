#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWebUrl } from '@spora/webcrawl/core/network-policy';
import { PDF_GRANTED, PDF_RELEASE, PDF_REQUEST, PDF_SCHEDULER_ENV, WORKER_STOP_GRACE_MS } from './pdf-slots.js';
import { isMainModule } from './entrypoint.js';
import { validateArguments } from './arguments.js';
import { loadProfiles, selectProfileOptions } from './profiles.js';
import { planSingleSiteOutputs, validateOutputPaths } from './output-paths.js';

export type SiteJob = readonly string[];
export type SiteJobResult = Readonly<{ index: number; code: number | null; signal: NodeJS.Signals | null }>;
export type SiteJobTarget = Readonly<{ url: string; siteFolder: string }>;
type RunnerOptions = Readonly<{ siteConcurrency?: number; pdfConcurrency?: number; signal?: AbortSignal; workerPath?: string }>;
type WorkerState = {
  index: number; requested: number | undefined; held: boolean; spawnFailed: boolean;
  stopTimer: ReturnType<typeof setTimeout> | undefined;
};

function concurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new Error('concurrency_must_be_1_to_32');
  return value;
}

/** Create a new run directory and one private directory per explicit site identity.
 * Use the campaign index's site_folder value rather than a positional filename. */
export async function createSiteJobs(targets: readonly SiteJobTarget[], options: Readonly<{
  outputRoot: string; args?: readonly string[]; pageData?: boolean; evidencePack?: boolean;
}>): Promise<readonly SiteJob[]> {
  if (!targets.length || targets.length > 10_000) throw new Error('invalid_site_targets');
  const names = new Set<string>();
  for (const target of targets) {
    validateWebUrl(target.url);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(target.siteFolder) || names.has(target.siteFolder)) throw new Error('invalid_or_duplicate_site_folder');
    names.add(target.siteFolder);
  }
  const args = options.args ?? [];
  if (args.some(arg => ['--out', '--page-data', '--evidence-pack', '--batch', '--resume', '--help', '--show-config', '--list-profiles'].includes(arg))) throw new Error('site_job_builder_owns_output_paths');
  const root = resolve(options.outputRoot);
  const jobs = targets.map(target => {
    const out = join(root, target.siteFolder, 'crawl');
    return [target.url, ...args, '--out', out,
      ...(options.pageData ? ['--page-data', out + '.page-data.json'] : []),
      ...(options.evidencePack ? ['--evidence-pack', out + '.evidence.zip'] : [])];
  });
  validateSiteJobs(jobs);
  for (const job of jobs) validateArguments(job);
  const fileIndex = args.indexOf('--profiles-file');
  const catalog = await loadProfiles(fileIndex < 0 ? undefined : resolve(args[fileIndex + 1]!));
  for (const job of jobs) planSingleSiteOutputs(job, selectProfileOptions(catalog, job).options);
  // Exclusive creation prevents accidentally mixing distinct scans in one run.
  await mkdir(root, { mode: 0o700 });
  for (const target of targets) await mkdir(join(root, target.siteFolder), { mode: 0o700 });
  return jobs;
}

/** Each row contains the ordinary single-site CLI arguments, starting with its
 * URL and including an explicit, distinct --out prefix. Artifact preflight is
 * performed asynchronously by runSiteJobs, before any workers start. */
export function validateSiteJobs(value: unknown): readonly SiteJob[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) throw new Error('invalid_site_jobs');
  const outputs = new Set<string>();
  for (const args of value) {
    if (!Array.isArray(args) || args.length < 3 || args.length > 100 || args.some(arg => typeof arg !== 'string' || !arg || arg.length > 4_096 || arg.includes('\0'))) throw new Error('invalid_site_job');
    validateWebUrl(args[0]);
    if (args.some(arg => ['--batch', '--resume', '--help', '--show-config', '--list-profiles'].includes(arg))) throw new Error('site_job_requires_single_site_run');
    const index = args.indexOf('--out');
    if (index < 1 || args.lastIndexOf('--out') !== index || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('site_job_requires_output');
    const output = resolve(args[index + 1]);
    if (outputs.has(output)) throw new Error('duplicate_site_job_output');
    outputs.add(output);
  }
  return value as string[][];
}

/** Owns independent CLI processes and a FIFO browser-permit queue. The PDF
 * limit covers runtime preflight and entire PDF groups, including cleanup.
 * Permits from failed workers are reclaimed when their process exits. */
export async function runSiteJobs(jobs: readonly SiteJob[], options: RunnerOptions = {}): Promise<readonly SiteJobResult[]> {
  validateSiteJobs(jobs);
  const siteConcurrency = concurrency(options.siteConcurrency ?? 4);
  const pdfConcurrency = concurrency(options.pdfConcurrency ?? 1);
  options.signal?.throwIfAborted();
  const catalogs = new Map<string | undefined, Awaited<ReturnType<typeof loadProfiles>>>();
  const plans = [];
  for (const args of jobs) {
    options.signal?.throwIfAborted();
    validateArguments(args);
    const fileIndex = args.indexOf('--profiles-file');
    const file = fileIndex >= 0 ? resolve(args[fileIndex + 1]!) : undefined;
    let catalog = catalogs.get(file);
    if (!catalog) { catalog = await loadProfiles(file); catalogs.set(file, catalog); }
    plans.push(planSingleSiteOutputs(args, selectProfileOptions(catalog, args).options));
  }
  await validateOutputPaths(plans.flatMap(plan => plan.outputPaths), plans.flatMap(plan => plan.privatePaths));
  if (jobs.length > 1) {
    const directories = new Set<string>();
    for (let index = 0; index < jobs.length; index++) {
      const args = jobs[index]!;
      const directory = await realpath(dirname(resolve(args[args.indexOf('--out') + 1]!)));
      if ([...directories].some(other => directory === other || directory.startsWith(other + sep) || other.startsWith(directory + sep))) throw new Error('site_jobs_require_distinct_directories');
      directories.add(directory);
      for (const path of plans[index]!.outputPaths) {
        if (await realpath(dirname(path)) !== directory) throw new Error('site_job_output_outside_site_directory');
      }
    }
  }
  options.signal?.throwIfAborted();
  const workerPath = options.workerPath ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  return new Promise((resolveJobs, rejectJobs) => {
    const workers = new Map<ChildProcess, WorkerState>();
    const waiting: ChildProcess[] = [];
    const results: SiteJobResult[] = [];
    let next = 0;
    let permits = 0;
    let stopped = false;

    const finish = () => {
      if (workers.size || !stopped && next < jobs.length) return;
      options.signal?.removeEventListener('abort', abort);
      if (stopped) rejectJobs(options.signal?.reason ?? new Error('site_jobs_aborted'));
      else resolveJobs(results.sort((a, b) => a.index - b.index));
    };
    const stopWorker = (child: ChildProcess) => {
      const state = workers.get(child);
      if (!state || state.stopTimer) return;
      // Every termination path needs escalation: a disconnected worker may
      // ignore SIGTERM while holding the only PDF permit. Repeated failures
      // must not restart its grace period or free the permit before exit.
      state.stopTimer = setTimeout(() => { if (workers.has(child)) child.kill('SIGKILL'); }, WORKER_STOP_GRACE_MS);
      state.stopTimer.unref();
      child.kill('SIGTERM');
    };
    const grant = () => {
      while (!stopped && permits < pdfConcurrency && waiting.length) {
        const child = waiting.shift()!;
        const state = workers.get(child);
        if (!state || state.stopTimer || !child.connected) continue;
        state.held = true;
        permits++;
        try { child.send({ type: PDF_GRANTED, id: state.requested }, error => { if (error) stopWorker(child); }); }
        catch { stopWorker(child); }
      }
    };
    const start = () => {
      while (!stopped && workers.size < siteConcurrency && next < jobs.length) {
        const index = next++;
        let child: ChildProcess;
        try {
          child = spawn(process.execPath, [workerPath, ...jobs[index]!], {
            env: { ...process.env, [PDF_SCHEDULER_ENV]: '1' },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          });
        } catch {
          // Synchronous spawn errors are job failures too. Rejecting the outer
          // promise here would leave earlier workers running without an owner.
          results.push({ index, code: 1, signal: null });
          continue;
        }
        const state: WorkerState = { index, requested: undefined, held: false, spawnFailed: false, stopTimer: undefined };
        workers.set(child, state);
        child.on('message', (message: unknown) => {
          if (stopped || state.stopTimer || !workers.has(child) || !message || typeof message !== 'object' || !('type' in message) || !('id' in message)) return;
          if (!Number.isSafeInteger(message.id) || Number(message.id) < 1) { stopWorker(child); return; }
          if (message.type === PDF_REQUEST) {
            if (state.requested !== undefined) { stopWorker(child); return; }
            state.requested = Number(message.id);
            waiting.push(child);
            grant();
          } else if (message.type === PDF_RELEASE) {
            if (!state.held || state.requested !== message.id) { stopWorker(child); return; }
            state.held = false;
            state.requested = undefined;
            permits--;
            grant();
          }
        });
        child.once('error', () => { state.spawnFailed = true; });
        // A disconnected worker can no longer be coordinated. Terminate it;
        // keep its permit until exit so another browser cannot overlap it.
        child.once('disconnect', () => { if (state.requested !== undefined) stopWorker(child); });
        let settled = false;
        const completed = (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          if (state.stopTimer) clearTimeout(state.stopTimer);
          state.stopTimer = undefined;
          workers.delete(child);
          if (state.held) permits--;
          state.held = false;
          state.requested = undefined;
          const queued = waiting.indexOf(child);
          if (queued >= 0) waiting.splice(queued, 1);
          results.push({ index, code: state.spawnFailed ? 1 : code, signal });
          grant();
          start();
          finish();
        };
        // Explicit IPC disconnect can leave close pending after exit on some
        // Node runtimes. Inherited stdio needs no draining; exit is sufficient.
        // Failed spawns may emit close without exit, so handle both once.
        child.once('exit', completed);
        child.once('close', completed);
      }
      // All jobs may have failed synchronously, leaving no child to emit exit.
      finish();
    };
    const abort = () => {
      stopped = true;
      waiting.length = 0;
      for (const child of workers.keys()) stopWorker(child);
      finish();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else start();
  });
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write('Usage: webcrawl-sites <jobs.json> [--site-concurrency <1..32>] [--pdf-concurrency <1..32>]\nThe JSON file is an array of single-site CLI argument arrays, each starting with a URL and including --out. Defaults: 4 sites, 1 PDF worker. Customer PDFs remain enabled by default; operator status PDFs require --operator-pdf in a job. Existing profiles and checks apply to each site. Create a separate output parent per site; all enabled exports must stay in that site directory.\n');
    return;
  }
  let file: string | undefined;
  const settings: { siteConcurrency: number; pdfConcurrency: number } = { siteConcurrency: 4, pdfConcurrency: 1 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--site-concurrency' || arg === '--pdf-concurrency') {
      if (seen.has(arg)) throw new Error('duplicate_launcher_option');
      seen.add(arg);
      const count = concurrency(Number(args[++i]));
      settings[arg === '--site-concurrency' ? 'siteConcurrency' : 'pdfConcurrency'] = count;
    } else if (arg.startsWith('-') || file) throw new Error('invalid_launcher_arguments');
    else file = arg;
  }
  if (!file) throw new Error('site_jobs_file_required');
  const bytes = await readFile(file);
  if (bytes.length > 2_000_000) throw new Error('site_jobs_file_too_large');
  const jobs = validateSiteJobs(JSON.parse(bytes.toString('utf8')));
  const controller = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => { interrupted = signal; controller.abort(new Error('site_jobs_aborted')); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    process.stderr.write(`[sites] jobs=${jobs.length} site_concurrency=${settings.siteConcurrency} pdf_concurrency=${settings.pdfConcurrency}\n`);
    const results = await runSiteJobs(jobs, { ...settings, signal: controller.signal });
    const failed = results.filter(result => result.code !== 0).length;
    process.stderr.write(`[sites] completed=${results.length} failed=${failed}\n`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    if (!interrupted) throw error;
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('webcrawl-sites failed: check the jobs file, concurrency options and per-site run logs\n');
    process.exitCode = 1;
  });
}
