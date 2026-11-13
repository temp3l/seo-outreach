import { CUSTOMER_REPORT_FRESHNESS_MS } from './freshness.js';
import { createHash } from 'node:crypto';
import type { AuditFinding, AuditResult, CrawlUrlOutcome, FindingEvidence } from '@spora/webcrawl';
import { isAuditResultRecord } from '@spora/webcrawl/evidence';
import { hasIncompleteCrawl } from '@spora/webcrawl/evidence';
import { reportPageReference } from './references.js';
import { customerPriorityProjection } from './customer.js';

/** Explicit operator/workflow qualification for releasing one exact audit. */
export type CustomerReleaseQualification = Readonly<{
  decision: 'RELEASE'; target: string; auditSha256: string; qualifiedAt: string; qualifiedBy: string;
  businessIdentity: 'VERIFIED'; coverage: 'ACCEPTED'; security: 'CLEARED';
}>;

export function auditResultSha256(result: AuditResult): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}

export const reportableCodes = new Set([
  'broken_internal_link', 'http_status_error', 'noindex', 'missing_canonical', 'robots_policy_unavailable',
  'missing_meta_description', 'meta_description_length', 'duplicate_meta_description_across_pages',
  'duplicate_title_across_pages', 'title_long', 'image_file_too_large', 'images_missing_alt',
  'missing_image_alt', 'image_alt_missing_or_empty', 'images_missing_dimensions', 'missing_h1',
  'heading_hierarchy_skip', 'pagespeed_category_score', 'invalid_canonical', 'conflicting_canonicals',
]);
const skew = 5 * 60_000;

function time(value: string): number { return Date.parse(value); }
function identity(raw: string): string | undefined { return reportPageReference(raw)?.identity; }
function host(raw: string): string | undefined { try { return new URL(raw).hostname.toLowerCase(); } catch { return; } }
function capturedIndex(result: AuditResult): Map<string, CrawlUrlOutcome> {
  const map = new Map<string, CrawlUrlOutcome>();
  for (const row of result.coverage?.urls ?? []) {
    const key = identity(row.url);
    if (key) map.set(key, row);
  }
  // Requested outcomes are authoritative. Add aliases only from actual captures;
  // duplicate-final skips must never erase the capture they refer to. A capture
  // may also supply the representation for a separately recorded duplicate.
  for (const row of result.coverage?.urls ?? []) {
    if (row.outcome !== 'captured') continue;
    for (const raw of [row.finalUrl, ...(row.redirectChain ?? [])]) {
      const key = raw && identity(raw); if (!key) continue;
      const existing = map.get(key);
      if (!existing || existing.outcome === 'skipped' && existing.reason === 'duplicate_final_url') map.set(key, row);
    }
  }
  return map;
}

function seedCapture(result: AuditResult): CrawlUrlOutcome | undefined {
  return result.coverage?.urls.find(row => identity(row.url) === identity(result.target)
    && row.outcome === 'captured' && row.statusCode !== undefined && row.statusCode >= 200 && row.statusCode < 400);
}

function inScope(raw: string, result: AuditResult, captures: ReturnType<typeof capturedIndex>): boolean {
  const key = identity(raw); if (!key) return false;
  const targetHost = host(result.target); if (!targetHost) return false;
  if (host(raw) === targetHost) return true;
  if (!result.crawlSettings.policy.allowedHosts.some(allowed => allowed.toLowerCase() === host(raw))) return false;
  // The crawler follows the explicitly allowed seed's final host for discovery.
  // That recorded redirect establishes scope; arbitrary allowed subdomains do not.
  const seed = seedCapture(result);
  if (seed?.finalUrl && host(seed.finalUrl) === host(raw)) return true;
  // Other redirects admit only their exact recorded final URL alias.
  const row = captures.get(key);
  return !!row && row.outcome === 'captured' && host(row.url) === targetHost && row.finalUrl !== undefined && identity(row.finalUrl) === key;
}

function matchesDestinationOutcome(result: AuditResult, evidence: FindingEvidence): boolean {
  const requested = evidence.requestedUrl && identity(evidence.requestedUrl);
  if (!requested) return false;
  // Use the actual requested outcome, never an alias borrowed from another row.
  const row = result.coverage?.urls.find(item => identity(item.url) === requested);
  if (!row || row.outcome !== 'captured' || row.statusCode !== evidence.value
    || identity(evidence.pageUrl) !== identity(row.finalUrl ?? row.url)
    || evidence.finalUrl !== undefined && identity(evidence.finalUrl) !== identity(row.finalUrl ?? row.url)) return false;
  const chain = row.redirectChain ?? [];
  const observedChain = evidence.redirectChain ?? [];
  return observedChain.length === chain.length
    && chain.every((hop, index) => identity(hop) === identity(observedChain[index]!));
}

function excludedCustomerPage(raw: string): boolean {
  try { return /\/(?:wp-login\.php|wp-admin|wp-signup\.php|wp-register\.php|cdn-cgi\/l\/email-protection)(?:\/|$)/iu.test(new URL(raw).pathname); } catch { return true; }
}

function timed(evidence: FindingEvidence, start: number, end: number): boolean {
  const observed = time(evidence.observedAt);
  return Number.isFinite(observed) && observed >= start - skew && observed <= end + skew;
}

/** Shared conservative admission for customer cards, PSI context and draft copy. */
export function isReportableEvidenceAdmissible(result: AuditResult, finding: AuditFinding, start = time(result.startedAt), end = time(result.completedAt)): boolean {
  if (!reportableCodes.has(finding.code) || !finding.evidence.length || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  const captures = capturedIndex(result);
  const at = (e: FindingEvidence) => timed(e, start, end) && inScope(e.pageUrl, result, captures) && !excludedCustomerPage(e.pageUrl);
  if (finding.code === 'pagespeed_category_score') {
    const scoreMatch = /^(performance|accessibility|best-practices|seo) score: (\d+(?:\.\d+)?)\/100\.?$/iu.exec(finding.observed);
    if (!scoreMatch || finding.evidence.length !== 1) return false;
    const e = finding.evidence[0]!; const score = Number(scoreMatch[2]);
    return finding.category === 'performance' && e.source === 'pagespeed' && e.value === score && Number.isFinite(score) && score >= 0 && score <= 100 && identity(e.pageUrl) === identity(result.target) && at(e);
  }
  if (finding.code === 'robots_policy_unavailable') {
    let targetOrigin = '';
    const seed = seedCapture(result);
    try { targetOrigin = new URL(seed?.finalUrl && inScope(seed.finalUrl, result, captures) ? seed.finalUrl : result.target).origin; } catch { return false; }
    return finding.evidence.every(e => { let evidenceOrigin = ''; try { evidenceOrigin = new URL(e.pageUrl).origin; } catch { return false; } return e.source === 'robots' && evidenceOrigin === targetOrigin && e.value === 'unavailable' && at(e); });
  }
  if (finding.code === 'broken_internal_link') {
    const destinations = finding.evidence.filter(e => !e.anchorHref && (e.value === 404 || e.value === 410));
    const sources = finding.evidence.filter(e => typeof e.anchorHref === 'string' && e.anchorHref.length > 0);
    if (!destinations.length || !sources.length || finding.evidence.length !== destinations.length + sources.length) return false;
    return destinations.every(dest => dest.source === 'http' && at(dest) && dest.requestedUrl !== undefined && inScope(dest.requestedUrl, result, captures)
      && matchesDestinationOutcome(result, dest)
      && sources.some(source => source.requestedUrl !== undefined && identity(source.requestedUrl) === identity(dest.requestedUrl!)))
      && sources.every(source => source.source === 'http' && at(source) && successfulCaptured(source.pageUrl, result, captures)
        && (() => { try {
          const href = new URL(source.anchorHref!, source.pageUrl).href;
          return source.requestedUrl !== undefined && identity(source.requestedUrl) === identity(href) && inScope(href, result, captures)
            && destinations.some(dest => identity(dest.requestedUrl!) === identity(href) && dest.value === source.value);
        } catch { return false; } })());
  }
  if (finding.code === 'http_status_error') {
    return finding.evidence.every(e => {
      if (e.source !== 'http' || !at(e) || typeof e.value !== 'number' || !(e.value === 404 || e.value === 410 || e.value >= 500 && e.value <= 599)) return false;
      const row = captures.get(identity(e.pageUrl)!);
      return row?.outcome === 'captured' && row.statusCode === e.value;
    });
  }
  if (finding.code === 'image_file_too_large') {
    const asset = finding.evidence[0]; const refs = finding.evidence.slice(1);
    return !!asset && asset.source === 'http' && at(asset) && Number.isFinite(asset.value) && typeof asset.value === 'number' && asset.value > 0
      && inScope(asset.pageUrl, result, captures) && refs.length > 0 && refs.every(e => e.source === 'http' && at(e) && successfulCaptured(e.pageUrl, result, captures) && e.value === asset.value && e.excerpt === asset.pageUrl.slice(0, 2_000));
  }
  return finding.evidence.every(e => ['http', 'rendered-dom'].includes(e.source) && at(e) && successfulCaptured(e.pageUrl, result, captures));
}

function successfulCaptured(raw: string, result: AuditResult, captures = capturedIndex(result)): boolean {
  const key = identity(raw); if (!key) return false;
  const row = captures.get(key);
  return !!row && row.outcome === 'captured' && row.statusCode !== undefined && row.statusCode >= 200 && row.statusCode < 400;
}

export type CustomerReportReadiness = Readonly<{
  status: 'READY_FOR_REVIEW' | 'BLOCKED';
  blockers: readonly string[]; warnings: readonly string[]; selectedTopics: number;
}>;

/** Report quality is scoped to the claims selected for the customer briefing.
 * A crawl or optional check gap is disclosed, not a whole-report veto. This
 * assessment never grants release, business identity or sending approval. */
export function assessCustomerReportReadiness(result: AuditResult): CustomerReportReadiness {
  if (!isAuditResultRecord(result)) return { status: 'BLOCKED', blockers: ['invalid_audit'], warnings: [], selectedTopics: 0 };
  const selectedTopics = customerPriorityProjection(result).selected.length;
  const blockers = selectedTopics ? [] : ['no_supported_customer_findings'];
  const warnings: string[] = [];
  if (hasIncompleteCrawl(result.crawl, result.findings, result.coverage?.urls) || result.crawl.limitations.includes('content_inspection_incomplete')) warnings.push('captured_scope_only');
  if (Object.values(result.coverage?.checks ?? {}).some(check => check.status !== 'complete' && check.status !== 'disabled')) warnings.push('check_coverage_gaps');
  if (result.findings.some(finding => reportableCodes.has(finding.code) && !isReportableEvidenceAdmissible(result, finding))) warnings.push('unsupported_findings_omitted');
  return { status: blockers.length ? 'BLOCKED' : 'READY_FOR_REVIEW', blockers, warnings, selectedTopics };
}

/** Release requires an exact, fresh audit and explicit operator review.
 * coverage ACCEPTED acknowledges disclosed scope; security CLEARED means the
 * selected report is safe to share, not that every site check completed. */
export function isCustomerReleaseQualified(result: AuditResult, value: unknown, now = Date.now()): value is CustomerReleaseQualification {
  if (!isAuditResultRecord(result) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const q = value as Partial<CustomerReleaseQualification>;
  if (q.decision !== 'RELEASE' || q.target !== result.target || q.auditSha256 !== auditResultSha256(result)
    || q.businessIdentity !== 'VERIFIED' || q.coverage !== 'ACCEPTED' || q.security !== 'CLEARED'
    || typeof q.qualifiedBy !== 'string' || q.qualifiedBy.trim().length < 2 || q.qualifiedBy.length > 120 || typeof q.qualifiedAt !== 'string') return false;
  const started = time(result.startedAt), completed = time(result.completedAt), qualified = time(q.qualifiedAt);
  if (![started, completed, qualified].every(Number.isFinite) || completed < started || completed > now + skew
    || qualified < completed - skew || qualified > now + skew || now - started >= CUSTOMER_REPORT_FRESHNESS_MS || qualified - started >= CUSTOMER_REPORT_FRESHNESS_MS) return false;
  return assessCustomerReportReadiness(result).status === 'READY_FOR_REVIEW';
}
