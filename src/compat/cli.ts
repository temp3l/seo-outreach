#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditWebsite, auditWebsiteWithPageData } from '@spora/webcrawl/core/audit';
import { renderAuditHtml } from '../reports/html.js';
import { renderOperatorStatusPdf } from '../reports/summary.js';
import { renderCustomerPdfPair } from '../reports/publication.js';
import { renderMobileCustomerPdf } from '../reports/mobile.js';
import { withPlaywrightPdfSession } from '../reports/pdf-playwright.js';
import { withPdfSlot, watchSchedulerLifetime } from './cli/pdf-slots.js';
import { OperationDeadline, closeWithin } from '../reports/operation-deadline.js';
import { isMainModule } from './cli/entrypoint.js';
import { imageEnrichment } from '@spora/webcrawl/enrichments/images';
import { createPageSpeedEnrichment } from '@spora/webcrawl/enrichments/pagespeed';
import type { CrawlPolicy } from '@spora/webcrawl/core/contracts';
import type { AuditResult } from '@spora/webcrawl/core/contracts';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { createCustomerReviewManifest } from '../reports/review.js';
import { classifyScanCompletion } from '@spora/webcrawl/core/scan-completion';
import { projectPageDataForEvidencePack, sanitizeEvidenceUrl, type PageDataExport } from '@spora/webcrawl/analysis/page-data';
import { DEFAULT_CRAWL_LIMITS } from '@spora/webcrawl/core/defaults';
import { runBatch } from './cli/batch.js';
import { createEvidencePack, writeEvidencePackExclusive } from '@spora/webcrawl/reports/evidence-pack';
import { validateWebUrl } from '@spora/webcrawl/core/network-policy';
import { planSingleSiteOutputs, validateOutputPaths } from './cli/output-paths.js';
import { validateArguments } from './cli/arguments.js';
import { ProgressReporter, safeFailureCategory } from './cli/progress.js';
import type { CrawlConfig } from '@spora/webcrawl/crawler/crawl';
import { resolveReportContact } from '../reports/report-contact.js';
import { bundledProfilesPath, loadProfiles, selectProfileOptions, type ProfileOptions } from './cli/profiles.js';
import { renderWhatsAppDraft } from '../reports/whatsapp-draft.js';

const publishedOutputs: string[] = [];
let progressReporter: ProgressReporter | undefined;

function sha256Json(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function assertPageDataReadback(value: unknown, audit: AuditResult, expected: PageDataExport): asserts value is PageDataExport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('page_data_readback_invalid');
  const data = value as Partial<PageDataExport>;
  if (data.schemaVersion !== '1' || data.contentTrust !== 'untrusted_web_content' || data.sensitivity !== 'REVIEW_BEFORE_UPLOAD'
    || data.target !== sanitizeEvidenceUrl(audit.target) || data.auditStartedAt !== audit.startedAt || data.auditCompletedAt !== audit.completedAt
    || data.auditSha256 !== sha256Json(audit) || !Array.isArray(data.pages)
    || data.targetPages !== audit.crawl.captured || data.exportedPages !== data.pages.length
    || data.omittedPages !== Math.max(0, data.targetPages - data.exportedPages)
    || typeof data.truncatedPages !== 'number' || !Number.isSafeInteger(data.truncatedPages) || data.truncatedPages < 0 || data.truncatedPages > data.exportedPages) throw new Error('page_data_readback_invalid');
  if (sha256Json(data) !== sha256Json(expected)) throw new Error('page_data_readback_digest_mismatch');
}

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}


export async function runCli(args: string[], transport: Pick<CrawlConfig, 'request' | 'resolveAddresses'> = {}): Promise<void> {
  const stopWatching = watchSchedulerLifetime();
  try { await runCliInner(args, transport); }
  catch (error) { progressReporter?.fail(safeFailureCategory(error)); throw error; }
  finally { try { progressReporter?.close(); } finally { stopWatching(); } }
}

async function runCliInner(args: string[], transport: Pick<CrawlConfig, 'request' | 'resolveAddresses'>): Promise<void> {
  progressReporter = undefined;
  const inspecting = args.some(arg => ['--help', '--show-config', '--list-profiles'].includes(arg));
  if (args.includes('--progress') && !inspecting) {
    progressReporter = new ProgressReporter((line) => process.stderr.write(line));
    progressReporter.begin('preflight');
  }
  const target = validateArguments(args);
  if (progressReporter && target) progressReporter.setHost(validateWebUrl(target).hostname);
  let settings: ProfileOptions | undefined;
  if (!args.includes('--batch') && !args.includes('--help') && (target || args.includes('--list-profiles') || args.includes('--show-config'))) {
    const fileIndex = args.indexOf('--profiles-file');
    const file = fileIndex >= 0 ? resolve(args[fileIndex + 1]!) : undefined;
    const catalog = await loadProfiles(file);
    if (args.includes('--list-profiles')) {
      for (const [name, entry] of Object.entries(catalog.profiles)) process.stdout.write(`${name}${name === catalog.defaultProfile ? ' (default)' : ''}${entry.description ? ` — ${entry.description}` : ''}\n`);
      return;
    }
    const { name, options: selectedOptions } = selectProfileOptions(catalog, args);
    settings = selectedOptions;
    if (args.includes('--show-config')) {
      process.stdout.write(`${JSON.stringify({ profile: name, profilesFile: file ?? bundledProfilesPath, ...(target ? { target } : {}), options: settings }, null, 2)}\n`);
      return;
    }
  }
  const progressEnabled = settings?.progress ?? args.includes('--progress');
  if (progressEnabled && !inspecting && !progressReporter) {
    progressReporter = new ProgressReporter((line) => process.stderr.write(line));
    progressReporter.begin('preflight');
  }
  const batchIndex = args.indexOf('--batch');
  if (batchIndex >= 0) {
    if (args.includes('--page-data') || args.includes('--page-data-html') || args.includes('--evidence-pack')) throw new Error('page_data_not_supported_in_batch');
    const input = args[batchIndex + 1];
    if (!input) throw new Error('--batch requires a CSV path');
    const outIndex = args.indexOf('--out');
    const output = outIndex >= 0 ? args[outIndex + 1] ?? 'webcrawl-batch' : 'webcrawl-batch';
    if (args.includes('--contacts') && args.includes('--no-contacts')) throw new Error('--contacts and --no-contacts are mutually exclusive');
    if (args.includes('--pagespeed') && args.includes('--no-pagespeed')) throw new Error('--pagespeed and --no-pagespeed are mutually exclusive');
    if (args.includes('--pagespeed-include-query') && args.includes('--no-pagespeed-include-query')) throw new Error('conflicting_pagespeed_query_options');
    await runBatch(input, output, args.includes('--resume'), args.includes('--security-txt'), !args.includes('--no-contacts'), transport, !args.includes('--no-pagespeed'), args.includes('--pagespeed-include-query'), !args.includes('--no-progress'));
    process.stdout.write(`${resolve(output)}\n`);
    return;
  }
  if (!target || args.includes('--help')) {
    process.stdout.write('Usage: webcrawl <https://site.example> [--profile <name>] [--profiles-file <json>] [--out <path>] [--page-data <path>|--no-page-data] [--page-data-html] [--evidence-pack <path.zip>] [--security-txt] [--pages <count>] [--requests <count>] [--runtime-ms <ms>] [--response-bytes <bytes>] [--total-bytes <bytes>] [--concurrency <count>] [--interval-ms <ms>] [--retries <count>] [--image-checks <count>] [--large-image-bytes <bytes>] [--user-agent <value>] [--browser|--browser=auto] [--locale en|de] [--pdf-locale en|de] [--pdf|--no-pdf] [--operator-pdf|--no-operator-pdf] [--report-contact-file <private-json>] [--no-contacts] [--no-technology] [--images] [--pagespeed|--no-pagespeed] [--pagespeed-include-query] [--progress]\nRun logs are saved beside outputs as <out>.run.log, including with --no-progress. Batch runs write batch.run.log and per-site logs; --no-progress suppresses console progress.\nProfiles: --list-profiles lists available names; --show-config prints effective options without crawling. Explicit CLI flags override profiles. The locale option controls crawl/report localization; pdf-locale selects one customer PDF language (default en) and the operator PDF language. Profiles can enable <out>.evidence.zip; --evidence-pack <path.zip> enables it explicitly and --no-evidence-pack disables it. Profiles support --no-browser, --no-images, --no-security-txt, --no-progress and --no-page-data-html.\nCustomer A4/mobile PDFs are generated by default; use --no-pdf to disable them. The operator status PDF is opt-in with --operator-pdf and can be generated alone with --no-pdf --operator-pdf; use --no-operator-pdf to disable it. Publisher contact is required only for customer PDFs via --report-contact-file or the private package-local .report-contact.json default. An evidence pack may be combined with --page-data; --page-data-html keeps bounded raw HTML only in the separate private page-data JSON and creates its default path when needed. Robots.txt retrieval is attempted within request, byte, and time budgets and reported as observation-only; rules gate requests only with --respect-robots. Scan only targets you are authorized to audit. --respect-robots enables fail-closed admission and requires browser rendering OFF.\n       webcrawl --batch <sites.csv> [--out <directory>] [--resume] [--security-txt] [--no-contacts] [--no-pagespeed] [--pagespeed-include-query]\n');
    return;
  }
  const options = settings!;
  const validatedTarget = validateWebUrl(target);
  if (args.includes('--contacts') && args.includes('--no-contacts')) throw new Error('--contacts and --no-contacts are mutually exclusive');
  const host = validatedTarget.hostname;
  progressReporter?.setHost(host);
  const { runLogPath, auditJsonPath, auditHtmlPath, scanStatusPath, operatorPdfPath, resolvedEvidencePackPath, resolvedPageDataPath, includeRawPageData, writePdf, writeOperatorPdf, customerPdfPath, mobilePdfPath, whatsappDraftPath, outputPaths, privatePaths } = planSingleSiteOutputs(args, options);
  const pages = options.pages;
  const policy: CrawlPolicy = {
    ...DEFAULT_CRAWL_LIMITS, allowedHosts: [host], robots: options['respect-robots'] ? 'respect' : 'observation-only',
    maxPages: pages, maxRequests: options.requests, maxRuntimeMs: options['runtime-ms'],
    maxResponseBytes: options['response-bytes'], maxTotalResponseBytes: options['total-bytes'],
    maxConcurrency: options.concurrency, minRequestIntervalMs: options['interval-ms'],
    maxRetries: options.retries, maxImageChecks: options['image-checks'],
    largeImageThresholdBytes: options['large-image-bytes'],
  };
  const userAgentIndex = args.indexOf('--user-agent');
  const userAgent = userAgentIndex < 0 ? options['user-agent'] : args[userAgentIndex + 1]?.trim();
  if (!userAgent || userAgent.length > 200 || /[\r\n\u0000]/u.test(userAgent)) throw new Error('invalid_user_agent');
  const contactIndex = args.indexOf('--report-contact-file');
  if (contactIndex >= 0 && !writePdf) throw new Error('report_contact_file_requires_pdf');
  const issuer = writePdf ? await resolveReportContact(contactIndex >= 0 ? args[contactIndex + 1]! : undefined, resolve(dirname(fileURLToPath(import.meta.url)), '../../.report-contact.json')) : undefined;
  await validateOutputPaths(outputPaths, privatePaths);
  if (!progressReporter) {
    progressReporter = new ProgressReporter(() => {});
    progressReporter.setHost(host);
  }
  progressReporter.attachFile(runLogPath);
  progressReporter.begin('preflight');
  if (writePdf || writeOperatorPdf || options.browser) {
    await withPdfSlot(async signal => {
      const deadline = new OperationDeadline(10_000, signal);
      let runtime: import('playwright').Browser | undefined;
      let failure: unknown;
      try {
        const { chromium } = await deadline.run(() => import('playwright'));
        runtime = await deadline.run(() => chromium.launch({ headless: true, timeout: Math.max(1, deadline.remainingMs()) }), late => late.close());
      } catch (error) { failure = error; throw error; }
      finally {
        try { if (runtime) await closeWithin(() => runtime!.close(), deadline.remainingMs(), 'browser_close_timeout'); }
        catch (error) { if (!failure) throw error; }
        finally { deadline.dispose(); }
      }
    });
  }
  const enrichments = [];
  if (args.includes('--technology') && args.includes('--no-technology')) throw new Error('--technology and --no-technology are mutually exclusive');
  if (options.images) enrichments.push(imageEnrichment);
  if (args.includes('--pagespeed') && args.includes('--no-pagespeed')) throw new Error('--pagespeed and --no-pagespeed are mutually exclusive');
  if (options.pagespeed) {
    const apiKey = process.env.PAGESPEED_API_KEY;
    enrichments.push(createPageSpeedEnrichment({ ...(apiKey ? { apiKey } : {}), includeQuery: options['pagespeed-include-query'] }));
  }
  progressReporter?.finish();
  const onProgressOption = { onProgress: (event: Parameters<NonNullable<CrawlConfig['onProgress']>>[0]) => progressReporter?.progress(event), onRequestEvent: (event: Parameters<NonNullable<CrawlConfig['onRequestEvent']>>[0]) => progressReporter?.request(event) };
  const config = { startUrl: target, policy, userAgent, contacts: options.contacts, technology: options.technology, pagespeed: options.pagespeed, pagespeedIncludeQuery: options['pagespeed-include-query'], renderBrowser: options.browser, checkSecurityTxt: options['security-txt'], ...transport, ...(resolvedEvidencePackPath !== undefined ? { includeSitemapEvidence: true } : {}) };
  const auditOutput = resolvedEvidencePackPath !== undefined
    ? await auditWebsiteWithPageData({ ...config, ...onProgressOption }, { maxPages: Math.min(pages, 1_000), maxTextCharsPerPage: 20_000, maxTotalTextChars: 15_000_000, maxSourceBytesPerPage: 20_000_000, maxTotalSourceBytes: 1_000_000_000, includeSourceEvidenceSamples: true, includeRawHtml: includeRawPageData }, enrichments)
    : resolvedPageDataPath === undefined
    ? { audit: await auditWebsite({ ...config, ...onProgressOption }, enrichments) }
    : await auditWebsiteWithPageData({ ...config, ...onProgressOption }, { includeRawHtml: includeRawPageData }, enrichments);
  const result = auditOutput.audit;
  progressReporter?.result(result, 'pageData' in auditOutput ? auditOutput.pageData : undefined);
  progressReporter?.begin('report');
  const locale = options.locale;
  const auditJson = `${JSON.stringify(result, null, 2)}\n`;
  const auditHtml = renderAuditHtml(result, { locale });
  let archive: Buffer | undefined;
  if (resolvedEvidencePackPath !== undefined && 'pageData' in auditOutput) {
    progressReporter?.begin('evidence-zip');
    archive = createEvidencePack(result, projectPageDataForEvidencePack(auditOutput.pageData));
    progressReporter?.finish();
  }
  progressReporter?.finish();
  let customerPublication: 'CLIENT_READY' | 'HOLD' | undefined;
  const pdfReports = writePdf || writeOperatorPdf ? await (async () => {
    progressReporter?.begin('pdf');
    const reports = await withPdfSlot(signal => withPlaywrightPdfSession(async renderer => {
      const output: Array<readonly [string, Uint8Array]> = [];
      if (writePdf) {
        if (!issuer) throw new Error('client_report_contact_required');
        const pair = await renderCustomerPdfPair(result, renderer, issuer);
        customerPublication = pair.status;
        output.push(
          [customerPdfPath, pair[options['pdf-locale']]],
          [mobilePdfPath, await renderMobileCustomerPdf(result, renderer, issuer, options['pdf-locale'], pair.status)],
        );
      }
      if (writeOperatorPdf) output.push([operatorPdfPath, await renderOperatorStatusPdf(result, renderer, { locale: options['pdf-locale'] })]);
      return output;
    }, { signal }));
    progressReporter?.finish();
    return reports;
  })() : [];
  const outputs: string[] = [];
  if (archive && resolvedEvidencePackPath) {
    progressReporter?.begin('evidence-zip-write');
    const digest = await writeEvidencePackExclusive(resolvedEvidencePackPath, archive);
    progressReporter?.finish();
    outputs.push(`${resolvedEvidencePackPath} sha256=${digest}`);
    publishedOutputs.push(resolvedEvidencePackPath);
  }
  progressReporter?.begin('publication');
  await writeFile(auditJsonPath, auditJson, { mode: 0o600, flag: 'wx' });
  outputs.push(auditJsonPath); publishedOutputs.push(auditJsonPath);
  const publishedAudit: unknown = JSON.parse(await readFile(auditJsonPath, 'utf8'));
  if (!isAuditResultRecord(publishedAudit) || sha256Json(publishedAudit) !== sha256Json(result)) throw new Error('audit_json_readback_invalid');
  await writeFile(auditHtmlPath, auditHtml, { mode: 0o600, flag: 'wx' });
  outputs.push(auditHtmlPath); publishedOutputs.push(auditHtmlPath);
  await writeFile(whatsappDraftPath, renderWhatsAppDraft(result, writePdf ? basename(customerPdfPath) : undefined, customerPublication ?? 'HOLD'), { mode: 0o600, flag: 'wx' });
  outputs.push(whatsappDraftPath); publishedOutputs.push(whatsappDraftPath);
  if ('pageData' in auditOutput && resolvedPageDataPath !== undefined) {
    await writeFile(resolvedPageDataPath, `${JSON.stringify(auditOutput.pageData, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    outputs.push(resolvedPageDataPath); publishedOutputs.push(resolvedPageDataPath);
    const publishedPageData: unknown = JSON.parse(await readFile(resolvedPageDataPath, 'utf8'));
    assertPageDataReadback(publishedPageData, result, auditOutput.pageData);
  }
  await writeFile(scanStatusPath, `${JSON.stringify(classifyScanCompletion(result, 'pageData' in auditOutput ? auditOutput.pageData : undefined), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  outputs.push(scanStatusPath); publishedOutputs.push(scanStatusPath);
  if (pdfReports.length) {
    for (const [path, pdf] of pdfReports) {
      await writeFile(path, pdf, { mode: 0o600, flag: 'wx' });
      const persisted = await readFile(path);
      if (persisted.byteLength < 8 || persisted.subarray(0, 5).toString('ascii') !== '%PDF-' || !persisted.equals(Buffer.from(pdf))) throw new Error('pdf_publication_readback_invalid');
      outputs.push(path);
      publishedOutputs.push(path);
    }
    if (writePdf) {
      const reviewPath = `${auditJsonPath.slice(0, -5)}.review.json`;
      const review = createCustomerReviewManifest(result, options['pdf-locale'], [
        { role: 'a4', path: customerPdfPath, content: await readFile(customerPdfPath) },
        { role: 'mobile', path: mobilePdfPath, content: await readFile(mobilePdfPath) },
      ]);
      const reviewJson = `${JSON.stringify(review, null, 2)}\n`;
      await writeFile(reviewPath, reviewJson, { mode: 0o600, flag: 'wx' });
      publishedOutputs.push(reviewPath); outputs.push(reviewPath);
      if (await readFile(reviewPath, 'utf8') !== reviewJson) throw new Error('review_manifest_readback_invalid');
    }
  }
  if (customerPublication) {
    const status = `[publication] status=${customerPublication} locale=${options['pdf-locale']}\n`;
    progressReporter?.recordSite(status);
    if (customerPublication === 'HOLD') process.stderr.write(status);
  }
  outputs.push(runLogPath);
  process.stdout.write(`${outputs.join('\n')}\n`);
  progressReporter?.succeed();
}

export function reportPartialPublication(paths: readonly string[], write: (line: string) => void = (line) => process.stderr.write(line)): void {
  if (paths.length === 0) return;
  try { write(`[publication] status=partial outputs_already_written=${JSON.stringify(paths)}\n`); } catch { /* Failure reporting must not mask the original error. */ }
}

if (isMainModule(import.meta.url)) runCli(process.argv.slice(2)).catch((error: unknown) => {
  if (progressReporter) {
    reportPartialPublication(publishedOutputs);
    process.stderr.write(`webcrawl failed: category=${safeFailureCategory(error)}; inspect the run log if created\n`);
    process.exitCode = 1;
    return;
  }
  const state = publishedOutputs.length ? `; outputs already written: ${publishedOutputs.join(', ')}` : '';
  process.stderr.write(`webcrawl failed: ${error instanceof Error ? error.message : 'unknown error'}${state}\n`);
  process.exitCode = 1;
});
