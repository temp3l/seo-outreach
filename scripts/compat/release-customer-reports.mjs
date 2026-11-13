#!/usr/bin/env node
import { restoreSavedMobileLabEvidence } from '../../dist/reports/performance-evidence.js';
import { cardLinksMatch } from './pdf-card-links.mjs';
import { observationScope } from '../../dist/reports/observation-scope.js';
import { withReleaseUnit } from './customer-release-unit.mjs';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { auditResultSha256, isCustomerReleaseQualified } from '../../dist/reports/qualification.js';
import { renderCustomerPdfPair } from '../../dist/reports/publication.js';
import { renderMobileCustomerPdf } from '../../dist/reports/mobile.js';
import { renderCustomerSummaryHtml } from '../../dist/reports/summary.js';
import { renderWhatsAppDraft } from '../../dist/reports/whatsapp-draft.js';
import { withPlaywrightPdfSession } from '../../dist/reports/pdf-playwright.js';
import { readReportContactFile } from '../../dist/reports/report-contact.js';
import { reportPageReference } from '../../dist/reports/references.js';
import { withCustomerEvidence } from '../../dist/reports/customer-evidence.js';
import { customerPriorityProjection, customerPageLabel } from '../../dist/reports/customer.js';
import { sanitizeEvidenceUrl } from '@spora/webcrawl/analysis/page-data';
import { CUSTOMER_PDF_DESIGN } from '../../dist/reports/design-contract.js';
import { createCustomerReviewManifest } from '../../dist/reports/review.js';
import { verifyReportDesign } from '../check-report-design.mjs';

const execFile = promisify(execFileCb);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const AUDIT_LIMIT = 200_000_000;
const QUALIFICATION_LIMIT = 8_192;

const errorCategories = new Set([
  'invalid_options', 'missing_required_option', 'invalid_pdf_locale', 'absolute_paths_required',
  'unsafe_or_oversized_input', 'input_too_large', 'duplicate_output_path', 'unsafe_output_parent', 'output_collision',
  'review_manifest_invalid', 'review_manifest_mismatch', 'review_artifact_invalid', 'review_pdf_invalid', 'review_pdf_content_invalid',
  'audit_json_invalid', 'qualification_json_invalid', 'audit_schema_invalid', 'qualification_invalid', 'release_qualification_expired',
  'a4_release_layout_failed', 'mobile_release_not_ready', 'draft_send_controls_invalid', 'draft_release_not_ready',
  'output_readback_mismatch', 'pdf_signature_invalid', 'pdf_content_extraction_failed', 'pdf_content_validation_failed',
  'artifact_readback_mismatch', 'artifact_hash_readback_mismatch', 'manifest_readback_invalid', 'manifest_validation_failed',
  'unsafe_report_contact_file', 'report_contact_file_too_large', 'invalid_report_contact_json', 'invalid_report_contact',
  'report_contact_identity_required', 'invalid_report_contact_email', 'invalid_report_contact_phone', 'invalid_report_contact_website',
  'report_contact_reply_channel_required', 'report_contact_identity_url_not_allowed',
  'pdf_render_timeout', 'pdf_render_aborted', 'pdf_close_timeout', 'client_report_not_ready', 'pdf_session_closed',
  'reviewed_manifest_required',
]);
function errorCategory(error) {
  const category = error instanceof Error ? error.message.split(':', 1)[0] : '';
  if (errorCategories.has(category)) return category;
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ELOOP', 'EISDIR', 'EEXIST', 'EMFILE', 'ENFILE', 'EIO'].includes(code)) return `filesystem_${code.toLowerCase()}`;
  return 'release_failed';
}

function parseInputJson(bytes, category) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(category); }
}

function isReadyHtml(html) {
  const body = /<body\b[^>]*>/u.exec(html)?.[0] ?? '';
  return body.includes('data-publication-status="CLIENT_READY"') && body.includes('data-client-ready="true"');
}

function parseArgs(args) {
  const values = new Map();
  const allowed = new Set(['--audit', '--qualification', '--report-contact-file', '--out', '--pdf-locale', '--review-manifest']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag) || values.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid_options');
    values.set(flag, args[++i]);
  }
  const reviewMode = values.has('--review-manifest');
  if (!reviewMode) throw new Error('reviewed_manifest_required');
  for (const key of ['--audit', '--qualification', '--out', ...(reviewMode ? [] : ['--report-contact-file'])]) if (!values.has(key)) throw new Error('missing_required_option');
  if (reviewMode && (values.has('--report-contact-file') || values.has('--pdf-locale'))) throw new Error('invalid_options');
  const locale = values.get('--pdf-locale') ?? 'en';
  if (!['en', 'de'].includes(locale)) throw new Error('invalid_pdf_locale');
  const paths = ['--audit', '--qualification', ...(reviewMode ? ['--review-manifest'] : ['--report-contact-file']), '--out'].map(key => values.get(key));
  if (paths.some(path => !isAbsolute(path))) throw new Error('absolute_paths_required');
  return { audit: resolve(paths[0]), qualification: resolve(paths[1]), ...(reviewMode ? { reviewManifest: resolve(paths[2]), out: resolve(paths[3]), reviewMode } : { contact: resolve(paths[2]), out: resolve(paths[3]), locale, reviewMode }) };
}

async function readBounded(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('unsafe_or_oversized_input');
    const chunks = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error('input_too_large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await file.close(); }
}

async function readPrivate(path, limit) {
  if (resolve(path) !== path || await realpath(dirname(path)) !== dirname(path)) throw new Error('unsafe_or_oversized_input');
  const parent = await lstat(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('unsafe_or_oversized_input');
  const bytes = await readBounded(path, limit);
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw new Error('unsafe_or_oversized_input');
  return bytes;
}

async function runReviewed(options) {
  await verifyReportDesign();
  const [auditBytes, qualificationBytes, reviewBytes] = await Promise.all([
    readPrivate(options.audit, AUDIT_LIMIT), readPrivate(options.qualification, QUALIFICATION_LIMIT), readPrivate(options.reviewManifest, 16_000_000),
  ]);
  let audit = parseInputJson(auditBytes, 'audit_json_invalid');
  const qualification = parseInputJson(qualificationBytes, 'qualification_json_invalid');
  const review = parseInputJson(reviewBytes, 'review_manifest_invalid');
  if (!isAuditResultRecord(audit)) throw new Error('audit_schema_invalid');
  const qKeys = ['auditSha256', 'businessIdentity', 'coverage', 'decision', 'qualifiedAt', 'qualifiedBy', 'reviewedManifestSha256', 'security', 'target'].sort();
  if (!qualification || typeof qualification !== 'object' || Array.isArray(qualification)
    || JSON.stringify(Object.keys(qualification).sort()) !== JSON.stringify(qKeys)
    || qualification.reviewedManifestSha256 !== sha256(reviewBytes)) throw new Error('review_manifest_mismatch');
  const { reviewedManifestSha256, ...baseQualification } = qualification;
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || review.schema !== 'webcrawl-customer-review-v1' || review.design !== CUSTOMER_PDF_DESIGN || review.target !== audit.target
    || review.auditSha256 !== auditResultSha256(audit) || review.sourceAuditFileSha256 !== sha256(auditBytes) || review.reportStatus !== 'HOLD' || review.outboundApproval !== false
    || !Array.isArray(review.artifacts) || review.artifacts.length !== 2) throw new Error('review_manifest_invalid');
  let pageEvidenceBytes;
  if (review.pageEvidenceSha256 !== null) {
    if (typeof review.pageEvidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(review.pageEvidenceSha256) || typeof review.pageEvidencePath !== 'string' || !isAbsolute(review.pageEvidencePath) || typeof review.pageEvidenceFileSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(review.pageEvidenceFileSha256)) throw new Error('review_manifest_invalid');
    pageEvidenceBytes = await readPrivate(review.pageEvidencePath, AUDIT_LIMIT);
    if (sha256(pageEvidenceBytes) !== review.pageEvidenceFileSha256) throw new Error('review_manifest_mismatch');
    let raw; try { raw = pageEvidenceBytes[0]===0x1f && pageEvidenceBytes[1]===0x8b ? gunzipSync(pageEvidenceBytes,{maxOutputLength:AUDIT_LIMIT}) : pageEvidenceBytes; } catch { throw new Error('review_manifest_invalid'); }
    const data = parseInputJson(raw, 'review_manifest_invalid');
    if (!data || data.schemaVersion !== '1' || !Array.isArray(data.pages) || data.pages.length > 10_000 || sha256(Buffer.from(JSON.stringify(data))) !== review.pageEvidenceSha256 || data.auditSha256 !== auditResultSha256(audit) || data.target !== sanitizeEvidenceUrl(audit.target) || data.auditStartedAt !== audit.startedAt || data.auditCompletedAt !== audit.completedAt) throw new Error('review_manifest_mismatch');
    audit = withCustomerEvidence(audit, data, { path: review.pageEvidencePath, sha256: review.pageEvidenceFileSha256 });
  } else if (review.pageEvidencePath !== undefined || review.pageEvidenceFileSha256 !== undefined) throw new Error('review_manifest_invalid');
  await restoreSavedMobileLabEvidence(audit, review.mobileLabEvidence, review.mobileLabEvidence?.association ?? undefined);
  if (!Number.isSafeInteger(review.customerObservationCount) || review.customerObservationCount < 0 || review.customerObservationUnit !== 'deduplicated admitted checks by page, link destination or asset' || review.customerObservationCount !== customerPriorityProjection(audit).deduplicatedIssues) throw new Error('review_manifest_mismatch');
  if (!isCustomerReleaseQualified(audit, baseQualification)) throw new Error('qualification_invalid');
  const roles = new Set(); const paths = new Set(); const locale = review.artifacts[0]?.locale;
  if (!['en', 'de'].includes(locale)) throw new Error('review_manifest_invalid');
  for (const artifact of review.artifacts) {
    if (!artifact || typeof artifact !== 'object' || !['a4', 'mobile'].includes(artifact.role) || artifact.locale !== locale
      || !isAbsolute(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 8 || artifact.bytes > 50_000_000
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || roles.has(artifact.role) || paths.has(artifact.path)) throw new Error('review_manifest_invalid');
    roles.add(artifact.role); paths.add(artifact.path);
  }
  if (roles.size !== 2) throw new Error('review_manifest_invalid');
  const host = new URL(audit.target).hostname;
  const reviewedBytes = new Map();
  for (const artifact of review.artifacts) {
    const bytes = await readPrivate(artifact.path, 50_000_000);
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error('review_artifact_invalid');
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('review_pdf_invalid');
    const { stdout } = await execFile('pdftotext', ['-layout', artifact.path, '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }).catch(() => { throw new Error('review_pdf_invalid'); });
    const countPattern = new RegExp(`\\b${review.customerObservationCount}\\s+${locale === 'de' ? 'Prüfbeobachtung(?:en)?' : 'check observations?'}\\b`, 'u');
    const headingIndex = stdout.search(locale === 'de' ? /Wichtige Beobachtungen|Keine ausgewählten Schwerpunkte/u : /Key observations|No selected priorities/u);
    if (headingIndex < 0 || !countPattern.test(stdout.slice(0, headingIndex))) throw new Error('review_pdf_content_invalid');
    // The raw extraction follows the renderer's card order, avoiding A4
    // column interleaving in layout extraction. Each field must be in its card.
    const { stdout: rawText } = await execFile('pdftotext', ['-raw', artifact.path, '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }).catch(() => { throw new Error('review_pdf_invalid'); });
    const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
    const normalized = normalize(rawText);
    if (!Array.isArray(review.selectedTopics)) throw new Error('review_manifest_invalid');
    const cardHeading = locale === 'de' ? 'Wichtige Beobachtungen' : 'Key observations';
    const cardsStart = normalized.indexOf(cardHeading);
    const footerStart = normalized.indexOf(locale === 'de' ? 'Lassen Sie uns sprechen' : 'Let’s get in touch', cardsStart + cardHeading.length);
    if (review.selectedTopics.length && (cardsStart < 0 || footerStart < 0)) throw new Error('review_pdf_content_invalid');
    let from = cardsStart + cardHeading.length; let priorTitleStart = from;
    for (let index = 0; index < review.selectedTopics.length; index++) {
      const topic = review.selectedTopics[index];
      const title = normalize(topic.title), why = normalize(topic.explanation), action = normalize(topic.nextStep);
      if (!title || !why || !action) throw new Error('review_pdf_content_invalid');
      const start = normalized.indexOf(title, from);
      const nextTitle = normalize(review.selectedTopics[index + 1]?.title);
      const end = nextTitle ? normalized.indexOf(nextTitle, start + title.length) : footerStart;
      if (start < 0 || end < 0 || end <= start || !normalize(topic.pageLabel) || !normalized.slice(priorTitleStart, start).trimEnd().endsWith(normalize(topic.pageLabel))) throw new Error('review_pdf_content_invalid');
      priorTitleStart = start;
      const card = normalized.slice(start, end);
      if (![why, action, ...(topic.observed ? [normalize(topic.observed)] : [])].every(value => value && card.includes(value))) throw new Error('review_pdf_content_invalid');
      const example = topic.urls?.[0];
      if (example && !card.includes(normalize(`${locale === 'de' ? 'Beispielseite' : 'Example page'}: ${customerPageLabel(example.url, locale)}`))) throw new Error('review_pdf_content_invalid');
      from = end;
    }

    const { stdout: xml } = await execFile('pdftohtml', ['-xml', '-stdout', '-hidden', artifact.path], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }).catch(() => { throw new Error('review_pdf_invalid'); });
    if (!cardLinksMatch(xml, review.selectedTopics, locale, customerPageLabel)) throw new Error('review_pdf_content_invalid');
    const { stdout: urls } = await execFile('pdfinfo', ['-url', artifact.path], { maxBuffer: 1 * 1024 * 1024, timeout: 30_000 }).catch(() => { throw new Error('review_pdf_invalid'); });
    const annotatedHosts = [...urls.matchAll(/https?:\/\/[^\s)<>"']+/giu)].flatMap(match => {
      try { return [new URL(match[0]).hostname.toLowerCase()]; } catch { return []; }
    });
    if (!stdout.trim() || /\bHOLD\b/u.test(stdout) || !annotatedHosts.includes(host.toLowerCase())) throw new Error('review_pdf_content_invalid');
    const annotationUrls = [...urls.matchAll(/https?:\/\/[^\s)<>"']+/giu)].flatMap(match => { try { return [new URL(match[0]).href]; } catch { return []; } });
    for (const topic of review.selectedTopics) { const example = topic.urls?.[0]; if (example && !example.redacted && !annotationUrls.includes(new URL(example.url).href)) throw new Error('review_pdf_content_invalid'); }
    reviewedBytes.set(artifact.path, bytes);
  }
  const expectedReview = createCustomerReviewManifest(audit, locale, review.artifacts.map(artifact => ({ role: artifact.role, path: artifact.path, content: reviewedBytes.get(artifact.path) })));
  if (review.rawFindingRecords !== expectedReview.rawFindingRecords || review.customerAffectedCapturedUrls !== expectedReview.customerAffectedCapturedUrls || review.evidenceTriageOmitted !== expectedReview.evidenceTriageOmitted || review.evidenceTriageLegend !== expectedReview.evidenceTriageLegend || JSON.stringify(review.evidenceTriage) !== JSON.stringify(expectedReview.evidenceTriage) || JSON.stringify(review.selectedTopics) !== JSON.stringify(expectedReview.selectedTopics)) throw new Error('review_manifest_mismatch');
  if (review.observationAccounting !== undefined && JSON.stringify(review.observationAccounting) !== JSON.stringify({raw:observationScope(audit,audit.findings),admitted:observationScope(audit,customerPriorityProjection(audit,locale).countedFindings)})) throw new Error('review_manifest_mismatch');
  if (review.admittedEvidenceReferences !== undefined && (JSON.stringify(review.admittedEvidenceReferences) !== JSON.stringify(expectedReview.admittedEvidenceReferences) || review.admittedEvidenceReferencesOmitted !== expectedReview.admittedEvidenceReferencesOmitted)) throw new Error('review_manifest_mismatch');
  if ((review.scanCoverageStatus !== undefined || review.scanExecutionStatus !== undefined) && (review.scanCoverageStatus !== expectedReview.scanCoverageStatus || review.scanExecutionStatus !== expectedReview.scanExecutionStatus)) throw new Error('review_manifest_mismatch');
  // Extraction helpers may take time. Recheck all inputs and qualification
  // freshness immediately before recording release state.
  const [auditNow, qualificationNow, reviewNow] = await Promise.all([
    readPrivate(options.audit, AUDIT_LIMIT), readPrivate(options.qualification, QUALIFICATION_LIMIT), readPrivate(options.reviewManifest, 16_000_000),
  ]);
  if (!auditNow.equals(auditBytes) || !qualificationNow.equals(qualificationBytes) || !reviewNow.equals(reviewBytes)
    || !isCustomerReleaseQualified(audit, baseQualification)) throw new Error('review_manifest_mismatch');
  await restoreSavedMobileLabEvidence(audit, review.mobileLabEvidence, review.mobileLabEvidence?.association ?? undefined);
  if (pageEvidenceBytes && !(await readPrivate(review.pageEvidencePath, AUDIT_LIMIT)).equals(pageEvidenceBytes)) throw new Error('review_manifest_mismatch');
  for (const artifact of review.artifacts) {
    const current = await readPrivate(artifact.path, 50_000_000);
    if (!current.equals(reviewedBytes.get(artifact.path))) throw new Error('review_artifact_invalid');
  }
  const out = `${options.out}.release.json`;
  const parent = dirname(out);
  if (await realpath(parent) !== parent) throw new Error('unsafe_output_parent');
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o777) !== 0o700) throw new Error('unsafe_output_parent');
  const manifest = {
    schema: 'webcrawl-customer-release-v1', target: audit.target, auditSha256: auditResultSha256(audit),
    qualificationSha256: sha256(qualificationBytes), reviewedManifestSha256: sha256(reviewBytes),
    reviewer: baseQualification.qualifiedBy, qualifiedAt: baseQualification.qualifiedAt,
    reportStatus: 'CLIENT_READY', artifacts: review.artifacts.map(({ role, locale: artifactLocale, path, bytes, sha256: hash }) => ({ role, locale: artifactLocale, path, bytes, sha256: hash })),
    outboundApproval: false,
  };
  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  try {
    const existing = await readPrivate(out, 65_536);
    if (!existing.equals(outputBytes)) throw new Error('output_collision');
  } catch (error) {
    if (error.message === 'output_collision') throw error;
    if (error.code !== 'ENOENT') throw error;
    try { await exclusiveWrite(out, outputBytes); }
    catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      const raced = await readPrivate(out, 65_536);
      if (!raced.equals(outputBytes)) throw new Error('output_collision');
    }
  }
  return { manifestPath: out, reportStatus: 'CLIENT_READY', artifacts: manifest.artifacts };
}

async function preflight(paths) {
  if (new Set(paths).size !== paths.length) throw new Error('duplicate_output_path');
  for (const path of paths) {
    const parent = dirname(path);
    const parentReal = await realpath(parent);
    if (parentReal !== parent) throw new Error('unsafe_output_parent');
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe_output_parent');
    try { await lstat(path); throw new Error('output_collision'); }
    catch (error) { if (error.message === 'output_collision') throw error; if (error.code !== 'ENOENT') throw error; }
  }
}

async function exclusiveWrite(path, bytes, onCreate = () => {}) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  onCreate(path);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const readback = await readBounded(path, Math.max(bytes.length, 1));
  if (!readback.equals(bytes)) throw new Error('output_readback_mismatch');
}

function exactQualificationShape(value) {
  const keys = ['auditSha256', 'businessIdentity', 'coverage', 'decision', 'qualifiedAt', 'qualifiedBy', 'security', 'target'].sort();
  return value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

async function run(options) {
  const paths = [`${options.out}.en.pdf`, `${options.out}.de.pdf`, `${options.out}.mobile-${options.locale}.pdf`, `${options.out}.whatsapp-draft.md`, `${options.out}.release.json`];

  const [auditBytes, qualificationBytes] = await Promise.all([readBounded(options.audit, AUDIT_LIMIT), readBounded(options.qualification, QUALIFICATION_LIMIT)]);
  const audit = parseInputJson(auditBytes, 'audit_json_invalid');
  const qualification = parseInputJson(qualificationBytes, 'qualification_json_invalid');
  if (!isAuditResultRecord(audit)) throw new Error('audit_schema_invalid');
  if (!exactQualificationShape(qualification) || !isCustomerReleaseQualified(audit, qualification)) throw new Error('qualification_invalid');
  // readReportContactFile owns the package's no-symlink, owner, size, mode,
  // schema and reply-channel policy for this private input.
  const issuer = await readReportContactFile(options.contact);
  const unitIdentity = sha256(Buffer.concat([Buffer.from('customer-release-v3:clean-review-layout\0'), auditBytes, qualificationBytes, Buffer.from(JSON.stringify(issuer)), Buffer.from(options.locale)]));
  return withReleaseUnit(options.out, paths, unitIdentity, async unit => {
  const rendered = await withPlaywrightPdfSession(async renderer => {
    const enHtml = renderCustomerSummaryHtml(audit, 'en', { issuer, qualification });
    const deHtml = renderCustomerSummaryHtml(audit, 'de', { issuer, qualification });
    const pair = await renderCustomerPdfPair(audit, renderer, issuer, qualification);
    if (pair.status !== 'CLIENT_READY') throw new Error('a4_release_layout_failed');
    let mobileHtml;
    const mobile = await renderMobileCustomerPdf(audit, (html, renderOptions) => {
      if (!isReadyHtml(html)) throw new Error('mobile_release_not_ready');
      mobileHtml = html;
      return renderer(html, renderOptions);
    }, issuer, options.locale, pair.status, qualification);
    const draft = renderWhatsAppDraft(audit, paths[0], pair.status, qualification);
    if (!draft.includes('recipient_review_required:** true') || !draft.includes('selected_send_target:** null') || !draft.includes('Outbound approval:** false')) throw new Error('draft_send_controls_invalid');
    if (!draft.includes('Report release:** CLIENT_READY')) throw new Error('draft_release_not_ready');
    return { pair, mobile, draft, enHtml, deHtml, mobileHtml };
  });
  // Freshness can change while Chromium renders or closes. Recheck before the
  // first artifact is created; every render must have retained its own readiness.
  if (!isCustomerReleaseQualified(audit, qualification)) throw new Error('release_qualification_expired');
  const payloads = [[paths[0], Buffer.from(rendered.pair.en), rendered.enHtml], [paths[1], Buffer.from(rendered.pair.de), rendered.deHtml], [paths[2], Buffer.from(rendered.mobile), rendered.mobileHtml], [paths[3], Buffer.from(rendered.draft)]];
  const written = [];
  try {
    const artifacts = [];
    for (const [index, [finalPath, bytes, html]] of payloads.entries()) {
      const path = unit.stagePath(index);
      if (finalPath.endsWith('.pdf')) {
        if (bytes.length < 8 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('pdf_signature_invalid');
        await exclusiveWrite(path, bytes, created => written.push(created));
        const { stdout } = await execFile('pdftotext', ['-layout', path, '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })
          .catch(() => { throw new Error('pdf_content_extraction_failed'); });
        const globalDate = /<time\s+datetime="[^"]+"[^>]*>([^<]+)<\/time>/u.exec(html)?.[1];
        const visibleEvidence = [...html.matchAll(/data-example-finding="(\d+)" data-example-evidence="(\d+)"/gu)].flatMap(match => {
          const item = audit.findings[Number(match[1])]?.evidence[Number(match[2])];
          return item ? [reportPageReference(item.pageUrl)?.url].filter(Boolean) : [];
        });
        const { stdout: urlInfo } = await execFile('pdfinfo', ['-url', path], { maxBuffer: 1 * 1024 * 1024, timeout: 30_000 })
          .catch(() => { throw new Error('pdf_content_extraction_failed'); });
        const annotations = [...urlInfo.matchAll(/https?:\/\/[^\s)<>"']+/giu)].flatMap(match => {
          try { return [new URL(match[0]).href]; } catch { return []; }
        });
        const escapedHost = new URL(audit.target).hostname;
        const compact = value => value.replace(/\s+/gu, '');
        const compactText = compact(stdout);
        const annotationHosts = annotations.flatMap(value => { try { return [new URL(value).hostname.toLowerCase()]; } catch { return []; } });
        if (!stdout.trim() || !globalDate || !compactText.includes(compact(globalDate)) || !compactText.includes(compact(issuer.name))
          || !compactText.includes(compact(escapedHost))
          || !annotationHosts.includes(escapedHost.toLowerCase()) || !visibleEvidence.some(value => annotations.includes(value))) throw new Error('pdf_content_validation_failed');
      } else {
        await exclusiveWrite(path, bytes, created => written.push(created));
        if (! (await readBounded(path, Math.max(bytes.length, 1))).equals(bytes)) throw new Error('artifact_readback_mismatch');
      }
      const readback = await readBounded(path, Math.max(bytes.length, 1));
      if (!readback.equals(bytes)) throw new Error('artifact_hash_readback_mismatch');
      artifacts.push({ path: finalPath, sha256: sha256(readback) });
    }
    const manifestPath = unit.stagePath(4);
    if (!isCustomerReleaseQualified(audit, qualification)) throw new Error('release_qualification_expired');
    const manifest = {
      schema: 'webcrawl-customer-release-v1', target: audit.target, auditSha256: auditResultSha256(audit),
      qualificationSha256: sha256(qualificationBytes), reviewer: qualification.qualifiedBy, qualifiedAt: qualification.qualifiedAt,
      reportStatus: 'CLIENT_READY', mobileLocale: options.locale, artifacts, outboundApproval: false,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await exclusiveWrite(manifestPath, manifestBytes, created => written.push(created));
    const persisted = await readBounded(manifestPath, 64 * 1024);
    if (!persisted.equals(manifestBytes) || sha256(persisted) !== sha256(manifestBytes)) throw new Error('manifest_readback_invalid');
    const parsed = JSON.parse(persisted.toString('utf8'));
    if (parsed.reportStatus !== 'CLIENT_READY' || parsed.outboundApproval !== false || parsed.artifacts.length !== 4) throw new Error('manifest_validation_failed');
    return await unit.commit();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: errorCategory(error), alreadyWritten: written })}\n`);
    throw error;
  }
  });
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await runReviewed(options);
  process.stdout.write(`${JSON.stringify({ result: 'LOCAL_REPORT_RELEASE_COMPLETE', manifest: result.manifestPath, reportStatus: result.reportStatus, artifacts: result.artifacts })}\n`);
} catch (error) {
  process.stderr.write(`release_failed: ${errorCategory(error)}\n`);
  process.exitCode = 1;
}
