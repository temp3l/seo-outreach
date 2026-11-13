import { imageNamingEvidence } from '@spora/webcrawl/analysis/image-naming';
import type { PageDataImage } from '@spora/webcrawl/analysis/page-data';
import { createHash } from 'node:crypto';
import type { AuditFinding, AuditResult } from '@spora/webcrawl';
import type { PageDataExport, PageDataRecord } from '@spora/webcrawl/analysis/page-data';
import { sanitizeEvidenceUrl } from '@spora/webcrawl/analysis/page-data';
import { auditResultSha256 } from './qualification.js';
import { hasNoindexDirective } from '@spora/webcrawl/core/robots-directives';

const hashUrl = (raw: string): string | undefined => {
  try { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return; u.hash=''; return createHash('sha256').update(u.href).digest('hex'); } catch { return; }
};
export type Triage = 'admitted' | 'consolidated' | 'review';
const context = Symbol('customer-page-evidence');
type PageEvidenceContext = Readonly<{ data: PageDataExport; reference?: Readonly<{ path: string; sha256: string }> }>;
type ContextAudit = AuditResult & { [context]?: PageEvidenceContext };
/** Private, non-serialized context keeps the audit bytes and approval identity unchanged. */
export function withCustomerEvidence(result: AuditResult, data: PageDataExport, reference?: PageEvidenceContext['reference']): AuditResult {
  const copy = { ...result } as ContextAudit;
  Object.defineProperty(copy, context, { value: { data, ...(reference ? { reference } : {}) } });
  return copy;
}
export function attachedCustomerEvidence(result: AuditResult): PageDataExport | undefined { return (result as ContextAudit)[context]?.data; }
export function customerEvidenceReference(result: AuditResult): PageEvidenceContext['reference'] { return (result as ContextAudit)[context]?.reference; }
/** Page evidence must belong to this audit; missing or ambiguous rows remain unknown. */
export function prepareCustomerEvidenceTriage(result: AuditResult, data?: PageDataExport): (finding: AuditFinding) => Triage {
  if (!data || data.auditSha256 !== auditResultSha256(result) || data.target !== sanitizeEvidenceUrl(result.target) || data.auditStartedAt !== result.startedAt || data.auditCompletedAt !== result.completedAt || !Array.isArray(data.pages) || data.targetPages !== result.crawl.captured || data.exportedPages !== data.pages.length || data.omittedPages !== Math.max(0, data.targetPages-data.exportedPages)) return () => 'review';
  const byId = new Map<string, PageDataRecord[]>();
  for (const page of data.pages) {
    if (!page || typeof page !== 'object' || !page.finalUrlIdentity) continue;
    const rows=byId.get(page.finalUrlIdentity) ?? []; rows.push(page); byId.set(page.finalUrlIdentity,rows);
  }
  const captured = new Map<string, number>();
  for (const row of result.coverage?.urls ?? []) {
    const id=hashUrl(row.finalUrl ?? row.url);
    if (row.outcome==='captured' && id && Number.isSafeInteger(row.statusCode)) captured.set(id, row.statusCode!);
  }
  const imageContexts = new Map<PageDataRecord, readonly PageDataImage[]>();
  const imagesFor = (page: PageDataRecord): readonly PageDataImage[] => { let images = imageContexts.get(page); if (!images) { images = imageNamingEvidence(page); imageContexts.set(page, images); } return images; };
  const start=Date.parse(result.startedAt), end=Date.parse(result.completedAt);
  return (finding: AuditFinding): Triage => {
  if (!finding.evidence.length) return 'review';
  const pages = finding.evidence.map(e => { const id=hashUrl(e.pageUrl); const rows=id ? byId.get(id) : undefined; return rows?.length===1 ? rows[0] : undefined; });
  if (pages.some(p=>!p || !Number.isSafeInteger(p.statusCode) || p.statusCode < 200 || p.statusCode >= 300 || !['captured','content_limit'].includes(p.contentStatus) || !p.finalUrlIdentity || captured.get(p.finalUrlIdentity)!==p.statusCode || !Number.isFinite(Date.parse(p.fetchedAt)) || Date.parse(p.fetchedAt)<start || Date.parse(p.fetchedAt)>end)) return 'review';
  if (finding.evidence.some((e,i) => !pages[i]?.finalUrl || pages[i]!.finalUrl !== sanitizeEvidenceUrl(e.pageUrl))) return 'review';
  // Rendered DOM completeness is not retained in legacy or current page data.
  if (finding.evidence.some((e,i) => e.source !== 'http' || pages[i]?.source !== 'http_html' || !Number.isFinite(Date.parse(e.observedAt)) || Date.parse(e.observedAt)<Date.parse(pages[i]!.fetchedAt) || Date.parse(e.observedAt)>end || finding.code.startsWith('duplicate_') && e.observedAt!==pages[i]!.fetchedAt)) return 'review';
  if (['image_alt_missing_or_empty','images_missing_alt','missing_image_alt'].includes(finding.code)) {
    return pages.every((page, index) => imagesFor(page!).some(image => {
      if (image.controlContext?.nameEvidence !== 'none' || !['link','button'].includes(image.controlContext.kind)) return false;
      if (finding.code === 'image_alt_missing_or_empty' ? !['missing','empty'].includes(image.altStatus) : image.altStatus !== 'missing') return false;
      const observed = finding.evidence[index]!.imageObservations;
      // Retained per-image observations must match this occurrence and state;
      // a different empty-alt control cannot corroborate a missing-alt record.
      return !observed || observed.some(item => item.occurrence === image.occurrence && item.altStatus === image.altStatus && (!item.src || item.src === image.src));
    })) ? 'admitted' : 'review';
  }
  if (!['duplicate_title_across_pages','duplicate_meta_description_across_pages'].includes(finding.code)) return 'review';
  const rows=pages as PageDataRecord[];
  const ids=rows.map(p=>p.finalUrlIdentity);
  if (new Set(ids).size<2) return 'review';
  if (rows.some(p => p.xRobotsTagStatus !== undefined && !['ABSENT','OBSERVED','TRUNCATED'].includes(p.xRobotsTagStatus) || p.xRobotsTag !== undefined && typeof p.xRobotsTag !== 'string' || p.xRobotsTagStatus === 'TRUNCATED' || p.xRobotsTagStatus === 'ABSENT' && p.xRobotsTag !== undefined || p.xRobotsTagStatus === 'OBSERVED' && (typeof p.xRobotsTag !== 'string' || p.xRobotsTag.length > 1_000) || p.xRobotsTagStatus === undefined && typeof p.xRobotsTag === 'string' && p.xRobotsTag.length >= 1_000)) return 'review';
  const metadata = rows.map(p => finding.code === 'duplicate_title_across_pages' ? (p.titleStatus === 'OBSERVED' ? p.title : undefined) : (p.descriptionStatus === 'OBSERVED' ? p.description : undefined));
  if (metadata.some(value => typeof value !== 'string' || !value.trim()) || new Set(metadata.map(value => value!.toLowerCase())).size !== 1) return 'review';
  if (rows.some(p=>p.canonicalStatus!=='OBSERVED' || !Array.isArray(p.canonicalCandidates) || p.canonicalCandidates.length!==1 || p.canonicalCandidatesOmitted!==0 || p.canonicalCandidates[0]?.status!=='observed' || !p.canonicalCandidates[0]?.identity || !p.canonicalCandidates[0]?.value || hashUrl(p.canonicalCandidates[0].value)!==p.canonicalCandidates[0].identity || !['ABSENT','OBSERVED'].includes(p.metaRobotsStatus) || !Array.isArray(p.metaRobotsDeclarations) || p.metaRobotsDeclarationsOmitted!==0 || p.metaRobotsStatus==='ABSENT' && (p.metaRobotsDeclarations.length!==0 || p.metaRobots!==undefined) || p.metaRobotsStatus==='OBSERVED' && p.metaRobotsDeclarations.length===0 || p.metaRobots !== undefined && typeof p.metaRobots !== 'string' || p.metaRobotsDeclarations.some(d=>!d || typeof d !== 'object' || d.status!=='observed' || typeof d.content !== 'string') || hasNoindexDirective([p.metaRobots, p.xRobotsTag, ...p.metaRobotsDeclarations.map(d=>d.content)]))) return 'review';
  const canonical=rows.map(p=>p.canonicalCandidates[0]!.identity!);
  // A shared valid declaration is provisional remediation scope, independent
  // of unretained historical indexing headers. It never proves Google selection.
  if (new Set(canonical).size===1) {
    const targetRows = byId.get(canonical[0]!);
    const target = targetRows?.length===1 ? targetRows[0] : undefined;
    if (target && captured.get(canonical[0]!)===target.statusCode && target.statusCode>=200 && target.statusCode<300 && ['captured','content_limit'].includes(target.contentStatus) && target.canonicalStatus==='OBSERVED' && Array.isArray(target.canonicalCandidates) && target.canonicalCandidates.length===1 && typeof target.finalUrl==='string' && hashUrl(target.finalUrl)===canonical[0] && target.canonicalCandidatesOmitted===0 && target.canonicalCandidates[0]?.status==='observed' && target.canonicalCandidates[0]?.identity===canonical[0] && hashUrl(target.canonicalCandidates[0]?.value ?? '')===canonical[0]) return 'consolidated';
    return 'review';
  }
  // Independent indexable-page advice still requires captured indexing context.
  if (!rows.every(p=>p.xRobotsTagStatus==='ABSENT' && p.xRobotsTag===undefined || p.xRobotsTagStatus==='OBSERVED' && typeof p.xRobotsTag==='string' && p.xRobotsTag.length<=1_000 && (p.xRobotsTag.trim().toLowerCase()==='index' || p.xRobotsTag.trim()===''))) return 'review';
  if (rows.every((p,i)=>canonical[i]===p.finalUrlIdentity)) return 'admitted';
  return 'review';
  };
}
export function customerEvidenceTriage(result: AuditResult, finding: AuditFinding, data?: PageDataExport): Triage { return prepareCustomerEvidenceTriage(result, data)(finding); }
