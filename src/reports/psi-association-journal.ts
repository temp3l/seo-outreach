import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ExpectedPsiAssociation, PsiAssociation } from './performance-evidence.js';
import { CUSTOMER_REPORT_FRESHNESS_MS } from './freshness.js';

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;
const MAX_BYTES = 2_000_000;
const MAX_RESPONSE_BYTES = 16_000_000;
export type PsiAttemptState = 'reserved' | 'dispatched' | 'completed' | 'failed' | 'unknown';
export type PsiJournalEvent = Readonly<{
  eventId: string; runId: string; siteId: string; dispatchId: string; state: PsiAttemptState; result: PsiAttemptState; at: string;
  captureManifestSha256: string; sourceCaptureSha256: string; captureCompletedAt: string; auditSha256: string;
  requestedUrl: string; finalUrl?: string; strategy: 'mobile'; categories: typeof CATEGORIES;
  requestedAt?: string; completedAt?: string;
  requestUrl: string; httpStatus?: number; responseSha256?: string; responseBytes?: number;
  errorCode?: string; association?: PsiAssociation;
}>;
export type PsiJournalInput = Readonly<{
  runId: string; siteId: string; captureManifestSha256: string; sourceCaptureSha256: string;
  auditSha256: string; requestedUrl: string; captureStartedAt: string; captureCompletedAt: string;
}>;
export type PsiJournalResponse = Readonly<{
  state: 'completed' | 'failed' | 'unknown'; dispatchId: string; events: readonly PsiJournalEvent[];
  association?: PsiAssociation; responseBytes?: Buffer; responsePath?: string; httpStatus?: number; errorCode?: string;
}>;
export type PsiAssociationJournalOptions = Readonly<{ path: string; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }>;

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function fail(code: string): never { throw new Error(code); }
function isDigest(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
function validateInput(input: PsiJournalInput): URL {
  if (!input.runId || !/^[A-Za-z0-9._-]{1,120}$/u.test(input.runId) || !input.siteId || !/^[A-Za-z0-9._-]{1,120}$/u.test(input.siteId)
    || !isDigest(input.captureManifestSha256) || !isDigest(input.sourceCaptureSha256) || !isDigest(input.auditSha256)
    || !Number.isFinite(Date.parse(input.captureStartedAt)) || Date.parse(input.captureStartedAt) > Date.parse(input.captureCompletedAt) || Date.now() - Date.parse(input.captureStartedAt) >= CUSTOMER_REPORT_FRESHNESS_MS
    || !Number.isFinite(Date.parse(input.captureCompletedAt)) || Date.parse(input.captureCompletedAt) > Date.now() || Date.now() - Date.parse(input.captureCompletedAt) >= CUSTOMER_REPORT_FRESHNESS_MS) fail('psi_association_input_invalid');
  let url: URL;
  try { url = new URL(input.requestedUrl); } catch { return fail('psi_association_input_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('psi_association_input_invalid');
  return url;
}
async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await stat(parent);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) fail('psi_journal_directory_not_private');
}
async function readBoundedResponse(response: Response): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) { try { await response.body?.cancel(); } catch {} throw new Error('psi_response_too_large'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      const chunk = Buffer.from(part.value); total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) { try { await reader.cancel(); } catch {} throw new Error('psi_response_too_large'); }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

/** Durable one-attempt PSI writer. A stale lock or uncertain outcome fails closed. */
export function createPsiAssociationJournal(options: PsiAssociationJournalOptions) {
  if (!options || !isAbsolute(options.path)) fail('psi_journal_path_invalid');
  const path = resolve(options.path); const lockPath = `${path}.lock`; const fetcher = options.fetch ?? fetch; const timeoutMs=options.timeoutMs??120_000; if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300_000)fail('psi_journal_timeout_invalid');
  async function transact<T>(operation: (events: PsiJournalEvent[]) => T): Promise<T> {
    await ensurePrivateParent(path);
    let lock;
    try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
    catch { fail('psi_journal_lock_unavailable'); }
    try {
      const events: PsiJournalEvent[] = [];
      try {
        const info = await stat(path);
        if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) fail('psi_journal_invalid');
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || (parsed as { schema?: string }).schema !== 'psi-attempt-journal-v1' || !Array.isArray((parsed as { attempts?: unknown }).attempts)) fail('psi_journal_invalid');
        events.push(...(parsed as { attempts: PsiJournalEvent[] }).attempts);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const value = operation(events);
      const bytes = Buffer.from(`${JSON.stringify({ schema: 'psi-attempt-journal-v1', attempts: events })}\n`);
      if (bytes.byteLength > MAX_BYTES) fail('psi_journal_full');
      const temp = `${path}.${randomUUID()}.tmp`;
      const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      const dir = await open(dirname(path), constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      return value;
    } finally { await lock!.close(); await rm(lockPath, { force: true }); }
  }
  async function finishFailure(input: PsiJournalInput, dispatchId: string, requestUrl: string, state: 'failed'|'unknown', errorCode: string): Promise<PsiJournalResponse> {
      const event = await transact(events => {
        if (events.some(row => row.dispatchId === dispatchId && ['failed','unknown','completed'].includes(row.state))) fail('psi_journal_outcome_already_final');
        const prior = [...events].reverse().find(row => row.dispatchId === dispatchId);
        if (!prior || prior.runId !== input.runId || prior.siteId !== input.siteId) fail('psi_journal_dispatch_missing');
        const row: PsiJournalEvent = { ...prior, eventId: randomUUID(), state, result: state, at: new Date().toISOString(), errorCode, requestUrl };
        events.push(row); return row;
      });
      return { state, dispatchId, events: [event], errorCode };
    }
  return {
    async initialize(): Promise<void> { await transact(() => undefined); },
    async dispatch(input: PsiJournalInput): Promise<PsiJournalResponse> {
      const target = validateInput(input); target.hash = '';
      const dispatchId = randomUUID();
      const request = new URL('https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed');
      request.searchParams.set('url', target.href); request.searchParams.set('strategy', 'mobile');
      for (const category of CATEGORIES) request.searchParams.append('category', category);
      const requestUrl = request.href;
      const prior = await transact(events => {
        if (new Set(events.map(event => event.dispatchId)).size >= 10) fail('psi_journal_attempt_limit');
        if (events.some(event => event.runId === input.runId && event.siteId === input.siteId && ['reserved','dispatched','completed','failed','unknown'].includes(event.state))) fail('psi_association_site_already_reserved');
        const at = new Date().toISOString();
        events.push({ eventId: randomUUID(), runId: input.runId, siteId: input.siteId, dispatchId, state: 'reserved', result: 'reserved', at,
          captureManifestSha256: input.captureManifestSha256, sourceCaptureSha256: input.sourceCaptureSha256, captureCompletedAt: input.captureCompletedAt, auditSha256: input.auditSha256,
          requestedUrl: target.href, strategy: 'mobile', categories: CATEGORIES, requestUrl });
        return events.slice(-1)[0]!;
      });
      if (Date.now() - Date.parse(input.captureStartedAt) >= CUSTOMER_REPORT_FRESHNESS_MS) return finishFailure(input, dispatchId, requestUrl, 'failed', 'capture_freshness_expired_before_dispatch');
      const dispatchedAt = new Date().toISOString();
      await transact(events => { if (events.some(row => row.dispatchId === dispatchId && ['failed','unknown','completed'].includes(row.state))) fail('psi_journal_outcome_already_final'); events.push({ ...prior, eventId: randomUUID(), state: 'dispatched', result: 'dispatched', at: dispatchedAt, requestedAt: dispatchedAt }); });
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.apiKey) headers['x-goog-api-key'] = options.apiKey;
      let response: Response;
      try { response = await fetcher(request, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
      catch { return finishFailure(input, dispatchId, requestUrl, 'unknown', 'transport_outcome_unknown'); }
      let bytes: Buffer;
      try { bytes = await readBoundedResponse(response); }
      catch (error) {
        return finishFailure(input, dispatchId, requestUrl, error instanceof Error && error.message === 'psi_response_too_large' ? 'failed' : 'unknown', error instanceof Error && error.message === 'psi_response_too_large' ? 'response_too_large' : 'response_read_outcome_unknown');
      }
      // Commit provider bytes before writing any terminal event. A failed or
      // interrupted commit leaves the dispatch reserved and cannot be replayed.
      const responsePath = `${path}.${dispatchId}.response`;
      const responseTemp = `${responsePath}.${randomUUID()}.tmp`;
      try {
        const file = await open(responseTemp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await rename(responseTemp, responsePath);
        const dir = await open(dirname(path), constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
        const stored = await readFile(responsePath);
        if (!stored.equals(bytes)) throw new Error('psi_response_readback_failed');
      } catch {
        await rm(responseTemp, { force: true }).catch(() => undefined);
        return finishFailure(input, dispatchId, requestUrl, 'unknown', 'response_persistence_unknown');
      }
      const completedAt = new Date().toISOString(); const responseSha256 = sha(bytes);
      let validJson = true;
      let finalUrl = target.href;
      if (response.ok) { try { const parsed = JSON.parse(bytes.toString('utf8')); finalUrl = typeof parsed?.lighthouseResult?.finalUrl === 'string' ? new URL(parsed.lighthouseResult.finalUrl).href : target.href; } catch { validJson = false; } }
      const state: 'completed'|'failed' = response.ok && validJson && finalUrl === target.href ? 'completed' : 'failed';
      let association: PsiAssociation | undefined;
      if (state === 'completed') association = { schema: 'psi-run-association-v1', runId: input.runId, siteId: input.siteId,
        captureManifestSha256: input.captureManifestSha256, sourceCaptureSha256: input.sourceCaptureSha256, captureCompletedAt: input.captureCompletedAt, auditSha256: input.auditSha256,
        requestedUrl: target.href, finalUrl, strategy: 'mobile', categories: CATEGORIES, dispatchId,
        requestedAt: dispatchedAt, completedAt, responseSha256, result: 'completed' };
      const finalEvent: PsiJournalEvent = { ...prior, eventId: randomUUID(), state, result: state, at: completedAt, completedAt, finalUrl,
        requestedAt: dispatchedAt, httpStatus: response.status, responseSha256, responseBytes: bytes.byteLength,
        ...(state === 'failed' ? { errorCode: response.ok ? validJson ? 'final_url_mismatch' : 'invalid_json' : `http_${response.status}` } : {}), ...(association ? { association } : {}) };
      // A sidecar records the observed status and times before journal completion.
      // If this write fails, retain an unknown outcome and never replay.
      const metadataPath = `${responsePath}.metadata.json`;
      const metadataTemp = `${metadataPath}.${randomUUID()}.tmp`;
      try {
        const metadata = Buffer.from(JSON.stringify({ schema: 'psi-response-commit-v1', dispatchId, runId: input.runId, siteId: input.siteId, requestedAt: dispatchedAt, completedAt, httpStatus: response.status, responseSha256, responseBytes: bytes.byteLength, finalUrl, state }));
        const file = await open(metadataTemp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try { await file.writeFile(metadata); await file.sync(); } finally { await file.close(); }
        await rename(metadataTemp, metadataPath);
        const dir = await open(dirname(path), constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
        if (!(await readFile(metadataPath)).equals(metadata)) throw new Error('psi_metadata_readback_failed');
      } catch {
        await rm(metadataTemp, { force: true }).catch(() => undefined);
        return finishFailure(input, dispatchId, requestUrl, 'unknown', 'response_metadata_persistence_unknown');
      }
      const events = await transact(rows => { if (rows.some(row => row.dispatchId === dispatchId && ['completed','failed','unknown'].includes(row.state))) fail('psi_journal_outcome_already_final'); rows.push(finalEvent); return rows.filter(row => row.dispatchId === dispatchId); });
      return { state, dispatchId, events, ...(association ? { association } : {}), responseBytes: bytes, responsePath, httpStatus: response.status, ...(finalEvent.errorCode ? { errorCode: finalEvent.errorCode } : {}) };
    },
    async unresolved(): Promise<readonly string[]> {
      const events = await this.read();
      return [...new Set(events.map(event => event.dispatchId))].filter(id => !events.some(event => event.dispatchId === id && ['completed','failed','unknown'].includes(event.state)));
    },
    async read(): Promise<readonly PsiJournalEvent[]> {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as { schema?: string; attempts?: PsiJournalEvent[] };
        if (parsed.schema !== 'psi-attempt-journal-v1' || !Array.isArray(parsed.attempts)) fail('psi_journal_invalid');
        return parsed.attempts;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
  };
}
