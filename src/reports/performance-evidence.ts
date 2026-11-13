import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { AuditResult } from '@spora/webcrawl';
import { readMobileLabLcp, type MobileLabLcp } from '@spora/webcrawl/enrichments/pagespeed-lab';
import { isReportableEvidenceAdmissible } from './qualification.js';

type LabEvidence = MobileLabLcp & Readonly<{ source: 'saved_psi_response' | 'audit_finding'; sha256?: string; path?: string }>;
const saved = new WeakMap<AuditResult, LabEvidence>();
const exactUrl = (a: string, b: string): boolean => { try { return new URL(a).href === new URL(b).href; } catch { return false; } };
/** Attach bounded corroborating lab evidence without rewriting the source audit or its identity. */
export function withSavedMobileLabEvidence(result: AuditResult, bytes: Uint8Array, path?: string): AuditResult {
  saved.delete(result);
  if (bytes.byteLength > 16_000_000) throw Error('saved_psi_too_large');
  const lab = readMobileLabLcp(JSON.parse(Buffer.from(bytes).toString('utf8')));
  const measured = lab && Date.parse(lab.fetchTime);
  const score = lab && result.findings.find(f => f.code === 'pagespeed_category_score' && /^performance score:/iu.test(f.observed) && f.evidence[0]?.value === lab.performanceScore && isReportableEvidenceAdmissible(result, f));
  if (!lab || !score || !exactUrl(lab.requestedUrl, result.target) || !exactUrl(lab.finalUrl, result.target) || !Number.isFinite(measured) || measured! < Date.parse(result.startedAt) - 300_000 || measured! > Date.parse(result.completedAt) + 300_000 || Math.abs(measured! - Date.parse(score.evidence[0]!.observedAt)) > 300_000) throw Error('saved_psi_audit_mismatch');
  saved.set(result, Object.freeze({ ...lab, source: 'saved_psi_response', sha256: createHash('sha256').update(bytes).digest('hex'), ...(path ? { path } : {}) }));
  return result;
}
export function mobileLcpEvidence(result: AuditResult): LabEvidence | undefined {
  const external = saved.get(result);
  if (external) return external;
  const findings = result.findings.filter(f => f.code === 'pagespeed_lab_lcp');
  const evidence = findings.flatMap(f => f.category === 'performance' ? f.evidence.filter(e => e.source === 'pagespeed' && typeof e.value === 'number' && Number.isFinite(e.value) && e.value >= 0 && e.value <= 600_000 && exactUrl(e.pageUrl, result.target) && Date.parse(e.observedAt) >= Date.parse(result.startedAt) - 300_000 && Date.parse(e.observedAt) <= Date.parse(result.completedAt) + 300_000) : []);
  if (!evidence.length || evidence.length !== findings.reduce((sum, f) => sum + f.evidence.length, 0)) return;
  const first = evidence[0]!;
  if (evidence.some(e => e.value !== first.value || e.observedAt !== first.observedAt)) return;
  const score = result.findings.find(f => f.code === 'pagespeed_category_score' && /^performance score:/iu.test(f.observed) && f.evidence[0]?.observedAt === first.observedAt && isReportableEvidenceAdmissible(result, f));
  if (!score || typeof score.evidence[0]?.value !== 'number') return;
  const fetched = /^mobile-lab fetchTime: (.+)$/u.exec(first.excerpt ?? '')?.[1];
  const fetchTime = fetched ?? first.observedAt;
  if (!Number.isFinite(Date.parse(fetchTime)) || Math.abs(Date.parse(fetchTime)-Date.parse(first.observedAt)) > 300_000) return;
  return { milliseconds: first.value as number, fetchTime, requestedUrl: result.target, finalUrl: result.target, performanceScore: score.evidence[0].value, source: 'audit_finding' };
}

/** Reproduce optional saved-response context during reviewed readback; no provider request. */
export async function restoreSavedMobileLabEvidence(result: AuditResult, value: unknown): Promise<void> {
  if (value === undefined || value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('review_mobile_lab_evidence_invalid');
  const evidence = value as Record<string, unknown>;
  if (evidence.source === 'audit_finding') {
    if (JSON.stringify(mobileLcpEvidence(result)) !== JSON.stringify(evidence)) throw Error('review_mobile_lab_evidence_mismatch');
    return;
  }
  if (evidence.source !== 'saved_psi_response' || typeof evidence.path !== 'string' || !isAbsolute(evidence.path) || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.sha256)) throw Error('review_mobile_lab_evidence_invalid');
  const file = await open(evidence.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > 16_000_000) throw Error('review_mobile_lab_evidence_invalid'); bytes = await file.readFile(); } finally { await file.close(); }
  if (createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) throw Error('review_mobile_lab_evidence_changed');
  withSavedMobileLabEvidence(result, bytes, evidence.path);
  if (JSON.stringify(mobileLcpEvidence(result)) !== JSON.stringify(evidence)) { saved.delete(result); throw Error('review_mobile_lab_evidence_mismatch'); }
}
