import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AuditResult } from '@spora/webcrawl';
import { auditResultSha256 } from './qualification.js';

export const CUSTOMER_REVIEW_PROFILE = 'customer-review-v3-edge-aligned-footer';

/** Private review state; clean PDF content never establishes release approval. */
export function createCustomerReviewManifest(result: AuditResult, locale: 'en' | 'de', artifacts: readonly { role: 'a4' | 'mobile'; path: string; content: Uint8Array }[]) {
  if (artifacts.length !== 2 || new Set(artifacts.map(a => a.role)).size !== 2 || new Set(artifacts.map(a => a.path)).size !== 2
    || artifacts.some(a => !isAbsolute(a.path) || !['a4', 'mobile'].includes(a.role) || Buffer.from(a.content).subarray(0, 5).toString('ascii') !== '%PDF-')) throw new Error('review_artifacts_invalid');
  return {
    schema: 'webcrawl-customer-review-v1', rendererProfile: CUSTOMER_REVIEW_PROFILE,
    target: result.target, auditSha256: auditResultSha256(result), auditCompletedAt: result.completedAt,
    reportStatus: 'HOLD', outboundApproval: false,
    artifacts: artifacts.map(a => ({ role: a.role, locale, path: a.path, bytes: a.content.byteLength, sha256: createHash('sha256').update(a.content).digest('hex') })),
  } as const;
}
