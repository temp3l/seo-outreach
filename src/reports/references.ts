import type { AuditFinding, AuditResult } from '@spora/webcrawl';

export type ReportPageReference = Readonly<{ url: string; identity: string; redacted: boolean }>;

/** Keep exact identities for counts while withholding all query values from reports. */
export function reportPageReference(raw: string): ReportPageReference | undefined {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = '';
    const identity = url.href;
    const redacted = Boolean(url.search);
    url.search = '';
    return { url: url.href, identity, redacted };
  } catch { return undefined; }
}

export function reportPageReferences(findings: readonly AuditFinding[]): ReportPageReference[] {
  const refs = new Map<string, ReportPageReference>();
  for (const finding of findings) {
    // Image probes put the image URL first, followed by referring page URLs.
    const evidence = ['image_file_too_large', 'broken_image_asset'].includes(finding.code) ? finding.evidence.slice(1) : finding.evidence;
    for (const item of evidence) {
      const ref = reportPageReference(item.pageUrl);
      if (ref) refs.set(ref.identity, ref);
    }
  }
  return [...refs.values()];
}

/** Report-only accounting; persisted affectedPages keeps its historical meaning. */
export function reportEvidenceCounts(result: AuditResult, findings = result.findings): Readonly<{
  capturedUrls: number | null; affectedCapturedUrls: number | null; affectedAssets: number;
  records: number; occurrences: number; successfulResponses: number | null;
  analyzedHtmlPages: number | null; rateLimitedResponses: number | null; nonHtmlSkips: number | null; duplicateFinalUrls: number | null;
}> {
  const outcomes = result.coverage?.urls;
  const captured = outcomes?.filter(item => item.outcome === 'captured');
  const successful = captured?.filter(item => item.statusCode !== undefined && item.statusCode >= 200 && item.statusCode < 400);
  const capturedKeys = new Set(captured?.map(item => reportPageReference(item.finalUrl ?? item.url)?.identity).filter(Boolean));
  const assetKeys = new Set(findings.filter(f => ['image_file_too_large', 'broken_image_asset'].includes(f.code)).flatMap(f => f.evidence[0] ? [reportPageReference(f.evidence[0].pageUrl)?.identity] : []).filter(Boolean));
  const affected = reportPageReferences(findings).filter(ref => capturedKeys.has(ref.identity) && !assetKeys.has(ref.identity));
  return {
    capturedUrls: captured ? new Set(captured.map(item => reportPageReference(item.finalUrl ?? item.url)?.identity).filter(Boolean)).size : null,
    affectedCapturedUrls: outcomes ? affected.length : null, affectedAssets: assetKeys.size,
    records: findings.length, occurrences: findings.reduce((sum, f) => sum + f.evidence.length, 0),
    successfulResponses: successful?.length ?? null,
    // Coverage contains response outcomes, not per-page content type or
    // completed extraction records. A successful response and a complete
    // capability do not establish how many HTML pages were analyzed.
    analyzedHtmlPages: null,
    // Coverage records final URL outcomes, not all physical retry responses.
    rateLimitedResponses: outcomes?.filter(item => item.statusCode === 429).length ?? null,
    nonHtmlSkips: outcomes?.filter(item => item.reason === 'non_html').length ?? null,
    duplicateFinalUrls: outcomes?.filter(item => item.reason === 'duplicate_final_url').length ?? null,
  };
}

/** Intersect topic evidence with the original captured HTML identities. */
export function reportCapturedUrlCount(result: AuditResult, refs: readonly ReportPageReference[]): number | null {
  if (!result.coverage) return null;
  const captured = new Set(result.coverage.urls.filter(item => item.outcome === 'captured').map(item => reportPageReference(item.finalUrl ?? item.url)?.identity).filter(Boolean));
  return new Set(refs.filter(ref => captured.has(ref.identity)).map(ref => ref.identity)).size;
}
