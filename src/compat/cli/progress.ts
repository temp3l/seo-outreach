import { openSync, closeSync, writeSync, constants, fstatSync } from 'node:fs';
import type { CrawlProgress } from '@spora/webcrawl/core/contracts';
import type { RequestEvent } from '@spora/webcrawl/crawler/safe-transport';
import type { AuditResult } from '@spora/webcrawl/core/contracts';
import type { PageDataExport } from '@spora/webcrawl/analysis/page-data';
import { classifyScanCompletion, type ScanCompletion } from '@spora/webcrawl/core/scan-completion';
import { hasIncompleteCrawl } from '@spora/webcrawl/core/crawl-completion';
import { performance } from 'node:perf_hooks';

export type ProgressPhase = 'preflight' | 'discovery' | 'fetch' | 'analysis' | 'enrichment' | 'report' | 'pdf' | 'evidence-zip' | 'evidence-zip-write' | 'publication';
export type ProgressCounts = Readonly<{ completed?: number; total?: number; captured?: number; failed?: number; discovered?: number; physicalRequests?: number }>;

type Clock = Readonly<{ now: () => number; timestamp: () => string }>;
const systemClock: Clock = { now: () => performance.now(), timestamp: () => new Date().toISOString() };

/** Bounded progress events mirrored to console and a private, incremental run log. */
export class ProgressReporter {
  private readonly started: number;
  private host?: string;
  private fd: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private physicalRequests = 0;
  private partial = false;
  private completion: ScanCompletion['status'] = 'UNKNOWN';
  private crawlCounts: ProgressCounts = {};

  attachFile(path: string, append = false, heartbeatMs = 10_000): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (append ? constants.O_APPEND : constants.O_EXCL), 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) { closeSync(fd); throw new Error('unsafe_run_log'); }
    this.fd = fd;
    this.output('run start');
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.timer.unref();
  }

  recordSite(line: string): void {
    if (line.includes('crawl status=incomplete')) this.partial = true;
    this.persist(line);
  }

  heartbeat(): void { this.output(`${this.active?.phase ?? 'preflight'} heartbeat${this.countLabel({...this.active?.counts, ...this.crawlCounts})} physicalRequests=${this.physicalRequests}`); }
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch { /* already closed */ } this.fd = undefined; }
  }
  progress(event: CrawlProgress): void {
    if (this.active?.phase !== event.phase) this.begin(event.phase);
    if (event.task && event.taskEvent) this.output(`enrichment task=${event.task} ${event.taskEvent}`);
    this.update({completed: event.completed, ...(event.total === undefined ? {} : {total: event.total}), ...(event.captured === undefined ? {} : {captured: event.captured}), ...(event.failed === undefined ? {} : {failed: event.failed}), ...(event.discovered === undefined ? {} : {discovered: event.discovered})});
  }
  request(event: RequestEvent): void {
    if (event.kind === 'request') { this.physicalRequests++; return; }
    this.output(`request ${event.kind}${event.status === undefined ? '' : ` status=${event.status}`}${event.attempt === undefined ? '' : ` attempt=${event.attempt}`}${event.delayMs === undefined ? '' : ` delay_ms=${Math.round(event.delayMs)} ${event.kind === 'cooldown' ? 'cooldown_until' : 'next_retry_at'}=${new Date(Math.min(8_640_000_000_000_000, Date.now() + event.delayMs)).toISOString()}`}`);
  }
  result(result: AuditResult, pageData?: PageDataExport): void {
    this.finish({captured: result.crawl.captured, discovered: result.crawl.discovered, failed: result.crawl.failed, physicalRequests: result.crawl.physicalRequests ?? this.physicalRequests});
    const partial = hasIncompleteCrawl(result.crawl, result.findings, result.coverage?.urls);
    this.partial ||= partial;
    this.output(`crawl status=${partial ? 'incomplete' : 'complete'} unattempted=${result.crawl.unattempted}`);
    const completion = classifyScanCompletion(result, pageData);
    this.completion = completion.status;
    this.output(`scan status=${completion.status.toLowerCase()} missing=${completion.missingUrls} blocked=${completion.blockedUrls} robots_blocked=${completion.robotsBlockedUrls} authentication_required=${completion.authenticationRequiredUrls} unattempted=${completion.unattemptedUrls}`);
  }
  reused(): void { this.output('site reused verified_saved_result'); }

  private active: { phase: ProgressPhase; started: number; cpu: NodeJS.CpuUsage; lastUpdate: number; counts?: ProgressCounts } | undefined;

  constructor(private readonly write: (line: string) => void, private readonly clock: Clock = systemClock, private readonly intervalMs = 10_000) { this.started = clock.now(); }

  setHost(host: string): void { this.host = host.replace(/[^a-zA-Z0-9.:[\]-]/gu, '').slice(0, 253); }

  begin(phase: ProgressPhase): void {
    const now = this.clock.now();
    if (this.active) this.finish(this.active.counts);
    this.active = { phase, started: now, cpu: process.cpuUsage(), lastUpdate: now };
    this.output(`${phase} start`);
  }

  update(counts: ProgressCounts, important = false): void {
    const active = this.active;
    if (!active) return;
    active.counts = counts;
    this.rememberCounts(counts);
    const now = this.clock.now();
    if (!important && now - active.lastUpdate < this.intervalMs) return;
    active.lastUpdate = now;
    this.output(`${active.phase} progress${this.countLabel(counts)}`);
  }

  finish(counts?: ProgressCounts): void {
    const active = this.active;
    if (!active) return;
    if (counts) { active.counts = counts; this.rememberCounts(counts); }
    this.output(`${active.phase} complete${this.countLabel(active.counts)} phase_ms=${Math.max(0, Math.round(this.clock.now() - active.started))}${this.resourceLabel(active.cpu)}`);
    this.active = undefined;
  }

  private resourceLabel(start: NodeJS.CpuUsage): string {
    const cpu = process.cpuUsage(start);
    return ` process_cpu_user_ms=${(cpu.user / 1000).toFixed(3)} process_cpu_system_ms=${(cpu.system / 1000).toFixed(3)} process_peak_rss_kib=${process.resourceUsage().maxRSS}`;
  }

  fail(category: string): void {
    const active = this.active;
    if (active) {
      this.output(`${active.phase} failed${this.countLabel(active.counts)} phase_ms=${Math.max(0, Math.round(this.clock.now() - active.started))}${this.resourceLabel(active.cpu)}`);
      this.active = undefined;
    }
    const action = ({missing_dependency: 'install_package_dependencies', browser_runtime_missing: 'install_chromium_with_pnpm_exec_playwright_install_chromium', permission_denied: 'check_output_directory_permissions', storage_full: 'free_disk_space_or_check_quota', readonly_filesystem: 'choose_a_writable_output_directory', file_not_found: 'check_input_files_and_output_directory', resource_limit: 'close_other_processes_or_raise_file_limit', operation_timeout: 'check_runtime_limits_and_retry', operation_aborted: 'retry_when_ready', batch_input_changed: 'use_original_csv_or_a_new_output_directory', batch_locked: 'wait_for_the_running_batch', unsafe_log_file: 'use_a_new_output_directory', output_conflict: 'use_a_new_output_prefix', output_directory_missing: 'create_output_directory', invalid_options: 'check_cli_options', client_report_not_ready: 'review_evidence_and_issuer', operation_failed: 'inspect_audit_and_retry_if_appropriate'} as Record<string,string>)[category] ?? 'inspect_audit_and_run_log';
    this.output(`failure category=${category} action=${action}`);
  }

  succeed(): void {
    this.finish();
    const status = this.completion === 'COMPLETED' ? 'complete' : this.completion === 'FAILED' ? 'failed' : this.completion === 'INCOMPLETE' ? 'partial' : this.partial ? 'partial' : 'complete';
    this.output(`success status=${status}`);
  }

  private rememberCounts(counts: ProgressCounts): void {
    for (const key of ['captured','failed','discovered'] as const) if (counts[key] !== undefined) this.crawlCounts = {...this.crawlCounts, [key]: counts[key]};
  }

  private countLabel(counts?: ProgressCounts): string {
    if (!counts) return '';
    const entries = Object.entries(counts).filter(([, value]) => Number.isSafeInteger(value) && value! >= 0);
    return entries.map(([key, value]) => ` ${key}=${value}`).join('');
  }

  private output(message: string): void {
    const rendered = message.replace(/^(discovery|fetch|analysis|enrichment|report|pdf|evidence-zip-write|evidence-zip|publication|preflight)(?=\s)/u, (phase) => ({ discovery: 'robots-sitemap-discovery', fetch: 'fetching', report: 'html-summary-preparation', pdf: 'optional-pdfs', 'evidence-zip': 'evidence-zip-assembly', 'evidence-zip-write': 'evidence-zip-verification-and-publication' } as Record<string, string>)[phase] ?? phase);
    const line = `[${this.clock.timestamp()}]${this.host ? ` host=${this.host}` : ''} elapsed_ms=${Math.max(0, Math.round(this.clock.now() - this.started))} ${rendered}\n`;
    try { this.write(line); } catch { /* Console progress is best effort. */ }
    this.persist(line);
  }

  private persist(line: string): void {
    if (this.fd === undefined) return;
    try { writeSync(this.fd, line); } catch {
      try { closeSync(this.fd); } catch { /* best effort */ }
      this.fd = undefined;
      try { process.stderr.write('run_log_write_failed; console progress continues\n'); } catch { /* best effort */ }
    }
  }
}

export function safeFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const codes: Record<string, string> = {
    ERR_MODULE_NOT_FOUND: 'missing_dependency', MODULE_NOT_FOUND: 'missing_dependency',
    EACCES: 'permission_denied', EPERM: 'permission_denied', ENOSPC: 'storage_full', EDQUOT: 'storage_full',
    EROFS: 'readonly_filesystem', ENOENT: 'file_not_found', EEXIST: 'output_conflict',
    EMFILE: 'resource_limit', ENFILE: 'resource_limit', ETIMEDOUT: 'operation_timeout', ABORT_ERR: 'operation_aborted',
  };
  if (typeof code === 'string' && Object.hasOwn(codes, code)) return codes[code]!;
  if (message.includes("Executable doesn't exist")) return 'browser_runtime_missing';
  if (error instanceof Error && error.name === 'TimeoutError') return 'operation_timeout';
  if (error instanceof Error && error.name === 'AbortError') return 'operation_aborted';
  if (message === 'batch_input_changed') return 'batch_input_changed';
  if (message === 'batch_directory_locked') return 'batch_locked';
  if (message === 'unsafe_run_log') return 'unsafe_log_file';
  if (/output_file_already_exists|output_paths_must_be_distinct/u.test(message)) return 'output_conflict';
  if (/output_directory_not_found/u.test(message)) return 'output_directory_missing';
  if (/invalid_|_cli_|unsupported_batch_option|requires_|mutually_exclusive|not_supported_in_batch|progress_not_supported|sensitive_|start_url/u.test(message)) return 'invalid_options';
  if (/client_report_not_ready/u.test(message)) return 'client_report_not_ready';
  if (/evidence_/u.test(message)) return 'evidence_processing_failed';
  return 'operation_failed';
}
