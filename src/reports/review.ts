import { classifyScanCompletion } from '@spora/webcrawl/core/scan-completion';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AuditFinding, AuditResult } from '@spora/webcrawl';
import { auditResultSha256 } from './qualification.js';
import { customerPriorityProjection } from './customer.js';
import { attachedCustomerEvidence, customerEvidenceReference, prepareCustomerEvidenceTriage } from './customer-evidence.js';
import { CUSTOMER_PDF_DESIGN } from './design-contract.js';
import { reportEvidenceCounts } from './references.js';

export const CUSTOMER_REVIEW_PROFILE = 'customer-review-v3-edge-aligned-footer';

/** Private review state; clean PDF content never establishes release approval. */
export function createCustomerReviewManifest(result: AuditResult, locale: 'en' | 'de', artifacts: readonly { role: 'a4' | 'mobile'; path: string; content: Uint8Array }[]) {
  if (artifacts.length !== 2 || new Set(artifacts.map(a => a.role)).size !== 2 || new Set(artifacts.map(a => a.path)).size !== 2
    || artifacts.some(a => !isAbsolute(a.path) || !['a4', 'mobile'].includes(a.role) || Buffer.from(a.content).subarray(0, 5).toString('ascii') !== '%PDF-')) throw new Error('review_artifacts_invalid');
  const data = attachedCustomerEvidence(result);
  const reference = customerEvidenceReference(result);
  const triageEvidence = prepareCustomerEvidenceTriage(result, data);
  const projection = customerPriorityProjection(result, locale);
  const identity = (code: string, e: AuditFinding['evidence'][number]) => JSON.stringify([code, e.pageUrl, e.source, e.observedAt]);
  const counted = new Set(projection.countedFindings.flatMap(f => f.evidence.map(e => identity(f.code, e))));
  const sourceEvidence = new Map<AuditFinding['evidence'][number], { findingIndex: number; evidenceIndex: number; code: string }[]>();
  result.findings.forEach((finding, findingIndex) => finding.evidence.forEach((item, evidenceIndex) => { const refs = sourceEvidence.get(item) ?? []; refs.push({ findingIndex, evidenceIndex, code: finding.code }); sourceEvidence.set(item, refs); }));
  const admittedReferences = projection.countedFindings.flatMap(finding => finding.evidence.map(item => { const ref = sourceEvidence.get(item)?.find(value => value.code === finding.code); if (!ref) throw new Error('customer_admitted_reference_missing'); return { findingIndex: ref.findingIndex, evidenceIndex: ref.evidenceIndex }; }));
  const evidenceClass = (finding: AuditFinding) => { const status = triageEvidence(finding); return status === 'admitted' ? 'eligible' : status; };
  const eligibleCodes = new Set(['image_alt_missing_or_empty','images_missing_alt','missing_image_alt','duplicate_title_across_pages','duplicate_meta_description_across_pages']);
  const candidates = result.findings.flatMap((finding, index) => eligibleCodes.has(finding.code) ? [{ index, finding }] : []);
  const decisions = candidates.slice(0, 1_000).map(({ index, finding }) => ({
    findingIndex: index,
    evidenceClassification: evidenceClass(finding),
    inCount: finding.evidence.some(e => counted.has(identity(finding.code, e))),
    ...(finding.code.includes('alt') ? { evidence: finding.evidence.slice(0, 100).map((item, evidenceIndex) => ({ evidenceIndex, evidenceClassification: evidenceClass({ ...finding, evidence: [item] }), inCount: counted.has(identity(finding.code, item)) })), evidenceOmitted: Math.max(0, finding.evidence.length - 100) } : {}),
  }));
  return {
    schema: 'webcrawl-customer-review-v1', rendererProfile: CUSTOMER_REVIEW_PROFILE, design: CUSTOMER_PDF_DESIGN,
    target: result.target, auditSha256: auditResultSha256(result), auditCompletedAt: result.completedAt,
    reportStatus: 'HOLD', outboundApproval: false,
    scanExecutionStatus: classifyScanCompletion(result, data).executionStatus,
    scanCoverageStatus: classifyScanCompletion(result, data).coverageStatus,
    customerObservationCount: projection.deduplicatedIssues,
    admittedEvidenceReferences: admittedReferences.slice(0, 100_000),
    admittedEvidenceReferencesOmitted: Math.max(0, admittedReferences.length - 100_000),
    customerObservationUnit: 'deduplicated admitted checks by page, link destination or asset',
    customerAffectedCapturedUrls: reportEvidenceCounts(result, projection.countedFindings).affectedCapturedUrls,
    rawFindingRecords: result.findings.length,
    pageEvidenceSha256: data ? createHash('sha256').update(JSON.stringify(data)).digest('hex') : null,
    ...(reference ? { pageEvidencePath: reference.path, pageEvidenceFileSha256: reference.sha256 } : {}),
    evidenceTriage: decisions,
    evidenceTriageOmitted: Math.max(0, candidates.length - decisions.length),
    evidenceTriageLegend: 'consolidated means repeated metadata with declared intended canonical consolidation; it does not establish Google-selected canonical or index status.',
    artifacts: artifacts.map(a => ({ role: a.role, locale, path: a.path, bytes: a.content.byteLength, sha256: createHash('sha256').update(a.content).digest('hex') })),
  } as const;
}
