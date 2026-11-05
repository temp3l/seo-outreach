import { createHash } from 'node:crypto';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { customerPriorityProjection } from '../../dist/reports/customer.js';
import { auditResultSha256 } from '../../dist/reports/qualification.js';
import { renderWhatsAppDraft } from '../../dist/reports/whatsapp-draft.js';
import { reportPageReference } from '../../dist/reports/references.js';
const hash = value => createHash('sha256').update(value).digest('hex');
export const HANDOFF_SCHEMA = 'webcrawl-no-send-review-queue-v2';
export function reviewRow(audit) {
  if (!isAuditResultRecord(audit)) throw Error('audit_schema_invalid');
  const canonicalUrl = reportPageReference(audit.target)?.url;
  if (!canonicalUrl) throw Error('invalid_target');
  const auditSha256 = auditResultSha256(audit);
  const candidateId = hash(canonicalUrl);
  const id = hash(`${candidateId}:${auditSha256}`);
  const projection = customerPriorityProjection(audit);
  return { id, candidateId, canonicalUrl, targetIdentitySha256: hash(reportPageReference(audit.target).identity), auditSha256, detectorProfile: audit.crawlSettings.technologyProfile ?? null, observedAt: audit.completedAt,
    selectedEvidence: projection.selected.map(topic => ({ code: topic.code, ...(topic.measurement ? { measurement: topic.measurement } : {}), urls: topic.urls.map(ref => ref.url), observations: projection.customerFindings.filter(f => f.code === topic.code && (!topic.measurement || f.observed.toLowerCase().startsWith(`${topic.measurement} score:`))).flatMap(f => f.evidence).filter(e => topic.urls.some(ref => ref.identity === reportPageReference(e.pageUrl)?.identity)).map(e => ({ url: reportPageReference(e.pageUrl).url, observedAt: e.observedAt, evidenceSha256: hash(JSON.stringify(e)) })).sort((a,b) => a.evidenceSha256.localeCompare(b.evidenceSha256)) })),
    reportReview: 'REVIEW_REQUIRED', customerPublication: 'HOLD', reportSha256: null,
    recipientVerification: 'UNKNOWN', permittedChannel: null, consentEvidenceRef: null,
    suppression: 'UNKNOWN', sendingAuthorization: 'UNKNOWN', sendEligible: false,
    reviewActions: ['Review frozen evidence and private security holds', 'Obtain hash-bound human report qualification', 'Verify recipient and channel permission independently', 'Revalidate present-state claims before any separately authorized send'],
    internalDraft: renderWhatsAppDraft(audit),
  };
}
