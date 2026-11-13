import { createHash } from 'node:crypto';
import { sharedFooterHeadingGroups } from '@spora/webcrawl/analysis/shared-footer';
import { attachedCustomerEvidence } from './customer-evidence.js';
import { auditResultSha256 } from './qualification.js';
import type { AuditFinding, AuditResult } from '@spora/webcrawl';
import { reportEvidenceCounts, reportPageReference } from './references.js';
import { countDeduplicatedIssues } from './issue-counts.js';

/** Explicit units; repeated asset identities are review groups, never inferred root causes. */
export function observationScope(result: AuditResult, findings: readonly AuditFinding[]) {
  const counts = reportEvidenceCounts(result, findings);
  const data = attachedCustomerEvidence(result);
  const bound = data?.auditSha256 === auditResultSha256(result) && data.auditStartedAt === result.startedAt && data.auditCompletedAt === result.completedAt;
  const headingUrls = new Set(findings.filter(f => f.code === 'multiple_h1').flatMap(f => f.evidence.map(e => e.pageUrl)));
  const footer = bound ? sharedFooterHeadingGroups(data!.pages, headingUrls) : { groups: [], uninspectedPages: headingUrls.size };
  const assets = new Map<string, { asset: string; assetIdentitySha256: string; codes: Set<string>; pages: Map<string, {url: string; identitySha256: string; redacted: boolean}>; observations: number }>();
  findings.forEach(f => f.evidence.forEach(e => (e.imageObservations ?? []).forEach(image => {
    const ref = image.src && reportPageReference(image.src), page = reportPageReference(e.pageUrl);
    if (!ref || !page) return;
    let group = assets.get(ref.identity);
    if (!group) assets.set(ref.identity, group = { asset: ref.url, assetIdentitySha256: createHash('sha256').update(ref.identity).digest('hex'), codes: new Set(), pages: new Map(), observations: 0 });
    group.codes.add(f.code); group.pages.set(page.identity, {url:page.url, identitySha256:createHash('sha256').update(page.identity).digest('hex'), redacted:page.redacted}); group.observations++;
  })));
  return {
    rawFindingRecords: findings.length,
    evidenceInstances: counts.occurrences,
    deduplicatedUrlOrAssetCheckObservations: countDeduplicatedIssues(findings),
    affectedCapturedUrls: counts.affectedCapturedUrls,
    observedImageAssets: assets.size,
    assetReviewGroups: [...assets.values()].filter(g => g.pages.size > 1).map(g => ({ asset: g.asset, assetIdentitySha256: g.assetIdentitySha256, checkCodes: [...g.codes].sort(), affectedPages: [...g.pages.values()].sort((a,b)=>a.identitySha256.localeCompare(b.identitySha256)), observationInstances: g.observations, classification: 'shared asset observation; component/root cause unproven' })),
    sharedFooterHeadingReviewGroups: footer.groups,
    footerHeadingPagesWithoutCompleteSource: footer.uninspectedPages,
    substantiatedRemediationGroups: null,
    remediationGroupStatus: 'not established by URL/check counts or asset identity',
  } as const;
}
