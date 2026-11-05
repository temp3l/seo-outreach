import { ProgressReporter, safeFailureCategory } from './progress.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { auditWebsite } from '@spora/webcrawl/core/audit';
import { ROBOTS_POLICY_REVISION, type CrawlPolicy } from '@spora/webcrawl/core/contracts';
import type { CrawlConfig } from '@spora/webcrawl/crawler/crawl';
import { DEFAULT_CRAWL_LIMITS, DEFAULT_USER_AGENT } from '@spora/webcrawl/core/defaults';
import { TECHNOLOGY_PROFILE } from '@spora/webcrawl/enrichments/technology';
import { CONTACT_PROFILE } from '@spora/webcrawl/enrichments/contacts';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { validateWebUrl } from '@spora/webcrawl/core/network-policy';
import { renderWhatsAppDraft } from '../../reports/whatsapp-draft.js';

function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
// Recovery files are untrusted local artifacts, including after concurrent replacement.
// Read at most the producer-compatible byte ceiling, even if the file grows.
async function readRecoveryFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('unsafe_batch_recovery_file');
    if (info.size > maxBytes) throw new Error('batch_recovery_file_too_large');
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, length);
      length += bytesRead;
      if (length > maxBytes) throw new Error('batch_recovery_file_too_large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    throw new Error('batch_recovery_file_too_large');
  } finally { await handle.close(); }
}
const MAX_BATCH_STATE_BYTES = 5_000_000;
const MAX_BATCH_OUTPUT_BYTES = 200_000_000;
async function ensureWhatsAppDraft(path: string, result: Parameters<typeof renderWhatsAppDraft>[0]): Promise<void> {
  try { await writeFile(path, renderWhatsAppDraft(result), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
type BatchIdentityCheck = Readonly<{ target: string; checkSecurityTxt: boolean; policy: CrawlPolicy; userAgent: string; enrichments: readonly string[] }>;
export function batchResultMatchesContactProfile(result: unknown, recordedProfile: string | undefined, contactsEnabled: boolean, recordedRobotsRevision?: string, expected?: BatchIdentityCheck): boolean {
  if (!isAuditResultRecord(result)) return false;
  const candidate = result;
  const expectedProfile = contactsEnabled ? CONTACT_PROFILE : 'contacts-disabled-v1';
  const outputMatches = contactsEnabled ? candidate.contacts?.profile === expectedProfile && candidate.capabilities?.contacts !== 'disabled' : candidate.contacts === undefined && candidate.capabilities?.contacts === 'disabled';
  const observation = candidate.robotsObservation;
  const counts = [observation?.knownDiscoveredUrls, observation?.advisoryAllowed, observation?.advisoryDisallowed, observation?.advisoryUnknown, observation?.capturedDisallowedCount, observation?.omittedCapturedDisallowedSamples];
  const verifiable = observation?.policy === 'observation-only' && observation.revision === ROBOTS_POLICY_REVISION && ['available', 'missing', 'unavailable'].includes(observation.retrieval ?? '') && observation.googlebotEvaluation === 'NOT_VERIFIED' && counts.every((value) => Number.isSafeInteger(value) && (value ?? -1) >= 0) && observation.knownDiscoveredUrls === observation.advisoryAllowed! + observation.advisoryDisallowed! + observation.advisoryUnknown! && Array.isArray(observation.capturedDisallowedSamples) && observation.capturedDisallowedSamples.length <= 100 && new Set(observation.capturedDisallowedSamples).size === observation.capturedDisallowedSamples.length && observation.capturedDisallowedSamples.length + observation.omittedCapturedDisallowedSamples! === observation.capturedDisallowedCount && result.crawlSettings?.policy?.robots === 'observation-only';
  const identityMatches = !expected || (candidate.target === expected.target
    && JSON.stringify(candidate.crawlSettings.policy) === JSON.stringify(expected.policy)
    && candidate.crawlSettings.userAgent === expected.userAgent
    && candidate.crawlSettings.renderBrowser === false && candidate.crawlSettings.renderMode === undefined
    && candidate.crawlSettings.retainHtml === false
    && JSON.stringify(candidate.crawlSettings.enrichments) === JSON.stringify(expected.enrichments)
    && (expected.checkSecurityTxt ? ['complete', 'partial', 'unavailable'].includes(candidate.coverage?.checks?.securityTxt?.status ?? '') : candidate.coverage?.checks?.securityTxt?.status === 'disabled'));
  return recordedProfile === expectedProfile && outputMatches && recordedRobotsRevision === ROBOTS_POLICY_REVISION && verifiable && identityMatches;
}
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/u, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('unterminated_csv_quote');
  if (field || row.length) { row.push(field.replace(/\r$/u, '')); rows.push(row); }
  return rows.filter((item) => item.some((value) => value.trim()));
}

export async function runBatch(inputFile: string, outputDirectory: string, resume: boolean, checkSecurityTxt = false, contactsEnabled = true, transport: Pick<CrawlConfig, 'request' | 'resolveAddresses'> = {}, pagespeedEnabled = true, pagespeedIncludeQuery = false, consoleProgress = true): Promise<void> {
  const inputPath = resolve(inputFile), root = resolve(outputDirectory);
  const input = await readFile(inputPath);
  if (input.byteLength > 5_000_000) throw new Error('batch_csv_too_large');
  const rows = csvRows(input.toString('utf8'));
  if (rows.length > 501) throw new Error('batch_site_limit_exceeded');
  const headers = rows.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  const urlIndex = headers.indexOf('website') >= 0 ? headers.indexOf('website') : headers.indexOf('url');
  if (urlIndex < 0) throw new Error('csv_requires_website_or_url_header');
  const sites = rows.flatMap((row) => {
    const value = row[urlIndex]?.trim();
    if (!value) return [];
    let url: URL;
    try { url = validateWebUrl(value); } catch { throw new Error('invalid_batch_url'); }
    return [{ url, key: sha256(url.href).slice(0, 20) }];
  });
  const inputHash = sha256(input);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, '.batch.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('batch_directory_locked'); throw error; }
  const batchReporter = new ProgressReporter(line => { if (consoleProgress) process.stderr.write(line); });
  try {
  batchReporter.attachFile(join(root, 'batch.run.log'), true);
  batchReporter.begin('fetch');
  let completedRows = 0;
  batchReporter.update({completed: completedRows, total: sites.length}, true);
  await lock.writeFile(JSON.stringify({ pid: process.pid, inputHash, startedAt: new Date().toISOString() }));
  await lock.sync();
  const statePath = join(root, 'batch-state.json');
  type State = { inputHash: string; completed: Record<string, { file: string; sha256: string; identity?: string; extractionProfile?: string; robotsPolicyRevision?: string }> };
  let state: State = { inputHash, completed: {} };
  if (resume) {
    try {
      const saved: unknown = JSON.parse((await readRecoveryFile(statePath, MAX_BATCH_STATE_BYTES)).toString('utf8'));
      if (!saved || typeof saved !== 'object' || (saved as { inputHash?: unknown }).inputHash !== inputHash) throw new Error('batch_input_changed');
      const completed = (saved as { completed?: unknown }).completed;
      if (!completed || typeof completed !== 'object') throw new Error('invalid_batch_state');
      state = { inputHash, completed: completed as State['completed'] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const saveState = async () => {
    const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, statePath);
  };
  await saveState();
  for (const { url, key } of sites) {
    const policy: CrawlPolicy = { ...DEFAULT_CRAWL_LIMITS, allowedHosts: [url.hostname], robots: 'observation-only' };
    const extractionProfile = contactsEnabled ? CONTACT_PROFILE : 'contacts-disabled-v1';
    const enrichments = [...(contactsEnabled ? ['contacts'] : []), 'technology', ...(pagespeedEnabled ? ['pagespeed'] : [])];
    const expected = { target: url.href, checkSecurityTxt, policy, userAgent: DEFAULT_USER_AGENT, enrichments } satisfies BatchIdentityCheck;
    const identity = sha256(JSON.stringify({ ...expected, contactsEnabled, pagespeed: pagespeedEnabled, pagespeedIncludeQuery: pagespeedEnabled && pagespeedIncludeQuery, pageSpeedApiKeyConfigured: pagespeedEnabled && Boolean(process.env.PAGESPEED_API_KEY), extractionProfile, technologyProfile: TECHNOLOGY_PROFILE, robotsPolicyRevision: ROBOTS_POLICY_REVISION, renderBrowser: false, retainHtml: false }));
    const baseName = `${basename(inputPath).replace(/[^a-zA-Z0-9._-]/gu, '_')}-${key}-${identity.slice(0, 12)}`;
    const siteReporter = new ProgressReporter(line => {
      batchReporter.recordSite(line);
      if (consoleProgress) process.stderr.write(line);
    });
    siteReporter.setHost(url.hostname);
    let siteCompleted = false;
    try {
    siteReporter.attachFile(join(root, `${baseName}.run.log`), true);
    siteReporter.begin('preflight');
    const previous = state.completed[key];
    if (previous) {
      const safeEntry = typeof previous.file === 'string' && basename(previous.file) === previous.file && /^[a-zA-Z0-9._-]+\.json$/u.test(previous.file) && typeof previous.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(previous.sha256);
      if (previous.identity === identity) {
        if (!safeEntry) throw new Error('batch_output_conflict');
        let saved: Buffer | undefined;
        try { saved = await readRecoveryFile(join(root, previous.file), MAX_BATCH_OUTPUT_BYTES); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (saved) {
          if (sha256(saved) !== previous.sha256) throw new Error('batch_output_conflict');
          let result: Parameters<typeof batchResultMatchesContactProfile>[0];
          try { result = JSON.parse(saved.toString('utf8')); } catch { throw new Error('batch_output_conflict'); }
          if (!batchResultMatchesContactProfile(result, previous.extractionProfile, contactsEnabled, previous.robotsPolicyRevision, expected)) throw new Error('batch_output_conflict');
          await ensureWhatsAppDraft(join(root, previous.file.replace(/\.json$/u, '.whatsapp-draft.md')), result as Parameters<typeof renderWhatsAppDraft>[0]);
          state.completed[key] = { file: previous.file, sha256: previous.sha256, identity, extractionProfile, robotsPolicyRevision: ROBOTS_POLICY_REVISION };
          await saveState();
          siteReporter.result(result as Parameters<typeof renderWhatsAppDraft>[0]);
          siteReporter.reused(); siteCompleted = true; siteReporter.succeed();
          continue;
        }
      } else if (previous.identity === undefined && safeEntry) {
        try {
          const saved = await readRecoveryFile(join(root, previous.file), MAX_BATCH_OUTPUT_BYTES);
          if (sha256(saved) === previous.sha256) {
            const result = JSON.parse(saved.toString('utf8')) as Parameters<typeof batchResultMatchesContactProfile>[0];
            if (batchResultMatchesContactProfile(result, previous.extractionProfile, contactsEnabled, previous.robotsPolicyRevision, expected)) {
              await ensureWhatsAppDraft(join(root, previous.file.replace(/\.json$/u, '.whatsapp-draft.md')), result as Parameters<typeof renderWhatsAppDraft>[0]);
              state.completed[key] = { file: previous.file, sha256: previous.sha256, identity, extractionProfile, robotsPolicyRevision: ROBOTS_POLICY_REVISION };
              await saveState();
              siteReporter.result(result as Parameters<typeof renderWhatsAppDraft>[0]);
              siteReporter.reused(); siteCompleted = true; siteReporter.succeed();
              continue;
            }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { /* legacy state is verified below by deterministic output recovery */ } }
      }
      delete state.completed[key];
    }

    const outputName = `${baseName}.json`;
    const outputPath = join(root, outputName);
    try {
      const existing = await readRecoveryFile(outputPath, MAX_BATCH_OUTPUT_BYTES);
      let result: Parameters<typeof batchResultMatchesContactProfile>[0];
      try { result = JSON.parse(existing.toString('utf8')); } catch { throw new Error('batch_output_conflict'); }
      if (!batchResultMatchesContactProfile(result, extractionProfile, contactsEnabled, ROBOTS_POLICY_REVISION, expected)) throw new Error('batch_output_conflict');
      await ensureWhatsAppDraft(join(root, outputName.replace(/\.json$/u, '.whatsapp-draft.md')), result as Parameters<typeof renderWhatsAppDraft>[0]);
      state.completed[key] = { file: outputName, sha256: sha256(existing), identity, extractionProfile, robotsPolicyRevision: ROBOTS_POLICY_REVISION };
      await saveState();
      siteReporter.result(result as Parameters<typeof renderWhatsAppDraft>[0]);
      siteReporter.reused(); siteCompleted = true; siteReporter.succeed();
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await auditWebsite({ onProgress: event => siteReporter.progress(event), onRequestEvent: event => { siteReporter.request(event); if (event.kind === 'request') batchReporter.request(event); }, startUrl: url.href, policy, checkSecurityTxt, contacts: contactsEnabled, pagespeed: pagespeedEnabled, pagespeedIncludeQuery, ...transport });
    siteReporter.result(result);
    siteReporter.begin('publication');
    const bytes = `${JSON.stringify(result, null, 2)}\n`;
    await writeFile(outputPath, bytes, { mode: 0o600, flag: 'wx' });
    await ensureWhatsAppDraft(join(root, outputName.replace(/\.json$/u, '.whatsapp-draft.md')), result);
    state.completed[key] = { file: outputName, sha256: sha256(bytes), identity, extractionProfile, robotsPolicyRevision: ROBOTS_POLICY_REVISION };
    await saveState();
    siteCompleted = true;
    siteReporter.succeed();
    } catch (error) { siteReporter.fail(safeFailureCategory(error)); throw error; }
    finally { siteReporter.close(); if (siteCompleted) completedRows++; batchReporter.update({completed: completedRows, total: sites.length}, true); }
  }
  batchReporter.succeed();
  } catch (error) { batchReporter.fail(safeFailureCategory(error)); throw error; }
  finally { batchReporter.close(); await lock.close(); await unlink(lockPath); }
}
