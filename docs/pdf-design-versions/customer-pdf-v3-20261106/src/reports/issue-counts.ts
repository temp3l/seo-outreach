import type { AuditFinding } from '@spora/webcrawl';
import { reportPageReference } from './references.js';

const canonicalCode = (code: string): string => ['images_missing_alt', 'missing_image_alt'].includes(code) ? 'image_alt_missing_or_empty' : code;
/** Count admitted individual issues, independent of record order, source and timestamp.
 * Aggregated per-page image findings count once; absent asset identities cannot be invented. */
export function countDeduplicatedIssues(findings: readonly AuditFinding[]): number {
  const issues = new Set<string>();
  const linkedTargets = new Set(findings.filter(f => f.code === 'broken_internal_link').flatMap(f => f.evidence.flatMap(e => {
    if (!e.anchorHref) return [];
    try { const identity = reportPageReference(new URL(e.anchorHref, e.pageUrl).href)?.identity; return identity ? [identity] : []; } catch { return []; }
  })));
  for (const finding of findings) {
    const code = canonicalCode(finding.code);
    if (['image_file_too_large', 'broken_image_asset'].includes(code)) {
      const asset = finding.evidence[0] && reportPageReference(finding.evidence[0].pageUrl)?.identity;
      if (asset) issues.add(JSON.stringify([code, asset]));
      continue;
    }
    const evidence = code === 'broken_internal_link' && finding.evidence.some(e => e.anchorHref)
      ? finding.evidence.filter(e => e.anchorHref) : finding.evidence;
    for (const item of evidence) {
      const page = reportPageReference(item.pageUrl)?.identity;
      if (!page || code === 'broken_internal_link' && !item.anchorHref && linkedTargets.has(page)) continue;
      let destination: string | undefined;
      if (code === 'broken_internal_link') {
        try { destination = reportPageReference(new URL(item.anchorHref ?? item.requestedUrl ?? item.finalUrl ?? item.pageUrl, item.pageUrl).href)?.identity; } catch { continue; }
      }
      issues.add(JSON.stringify([code, page, destination ?? null]));
    }
  }
  return issues.size;
}
