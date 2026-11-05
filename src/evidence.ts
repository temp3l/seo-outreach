import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { projectCheckCoverage, type ProjectedCheckCoverage } from './check-coverage.js';
import { projectContactEvidence, type ContactEvidence, type ContactCandidateEvidence } from './contact-evidence.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FINDINGS = 100_000;
const MAX_EVIDENCE = 100_000;
const SHA = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function pageUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 4096) return;
  try { const u = new URL(v); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return; u.search = ''; u.hash = ''; return u.href; } catch { return; }
}
export type ContactCandidate = ContactCandidateEvidence;
export type Contacts = ContactEvidence;
export type EvidenceGroup = { id: string; code: string; category: string; page: string; pageIdentity: string; referenceRedacted: boolean; source: string; observations: number; sourceIds: string[]; sourceIdsOmitted: number; capture: 'CAPTURED_2XX' | 'UNKNOWN_OR_UNSUCCESSFUL'; pageId: string | null; referenceScope: string | null; representative: { observed: string; observedAt: string | null; value: string | number | boolean | null; excerpt: string | null; truncated: boolean } };
export type ExportCoverage = { status: 'PARTIAL' | 'COMPLETE'; provenance: string; exported: number; omitted: number; truncatedPages: number; truncationCounts: Record<string,number>; omissionCounts: Record<string,number> };
export type Normalized = { checkCoverage?: ProjectedCheckCoverage; exportCoverage?: ExportCoverage; contract: 'seo-outreach-evidence-v2'; format: 'webcrawl-audit-json-1' | 'webcrawl-evidence-zip-1'; inputSha256: string; target: string; targetIdentity: string; targetRedacted: boolean; hostname: string; startedAt: string; completedAt: string; crawl: { discovered: number; attempted: number; captured: number; failed: number; skipped: number; unattempted: number; limitations: string[] }; robots: string; contacts: Contacts; groups: EvidenceGroup[]; counts: { findings: number; occurrences: number; grouped: number; excluded: number }; exclusions: Record<string, number>; status: 'INTERNAL_UNVERIFIED' };
export function normalizeAudit(input: unknown, fingerprint: string): Normalized {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('invalid_fingerprint');
  if (!object(input) || input.schemaVersion !== '1' || !object(input.crawl) || !object(input.coverage) || !object(input.capabilities) || !object(input.crawlSettings) || !Array.isArray(input.findings)) throw new Error('unsupported_or_invalid_webcrawl_audit');
  const target = pageUrl(input.target);
  if (!target || typeof input.startedAt !== 'string' || typeof input.completedAt !== 'string' || !Number.isFinite(Date.parse(input.startedAt)) || !Number.isFinite(Date.parse(input.completedAt)) || Date.parse(input.startedAt) > Date.parse(input.completedAt)) throw new Error('invalid_audit_identity_or_times');
  const settingsPolicy=object(input.crawlSettings.policy)?input.crawlSettings.policy:undefined;
  const robotsPolicy=settingsPolicy?.robots;
  if(object(input.robotsObservation)) {
    const expected=robotsPolicy==='respect'?'respect':'observation-only';
    if(input.robotsObservation.policy!==expected || expected==='respect' && input.robotsObservation.capturedDisallowedCount!==0)throw new Error('inconsistent_robots_policy');
  }
  const c = input.crawl;
  for (const k of ['discovered','attempted','captured','failed','skipped','unattempted']) if (!integer(c[k])) throw new Error('invalid_crawl_counts');
  const terminal=(c.captured as number)+(c.failed as number)+(c.skipped as number);
  if (terminal+(c.unattempted as number)!==c.discovered || (c.attempted as number)>(terminal) || (c.attempted as number)<(c.captured as number)+(c.failed as number)) throw new Error('inconsistent_crawl_counts');
  if (!Array.isArray(c.limitations) || c.limitations.some(x => typeof x !== 'string') || c.limitations.length > 1000 || input.findings.length > MAX_FINDINGS) throw new Error('invalid_or_oversized_audit');
  const findings = input.findings;
  const captureIndex = new Map<string, boolean>();
  if (Array.isArray(input.coverage.urls)) {
    if (input.coverage.urls.length > 100_000) throw new Error('too_many_crawl_outcomes');
    const counts={captured:0,failed:0,skipped:0,unattempted:0}; let robotsBlocked=0;
    for (const row of input.coverage.urls) {
      if(!object(row) || typeof row.outcome!=='string' || !['captured','failed','skipped','robots_blocked','unattempted'].includes(row.outcome)) throw new Error('invalid_crawl_outcome');
      if(row.outcome==='robots_blocked'){
        const retrieval=object(input.robotsObservation)?input.robotsObservation.retrieval:undefined;
        if(robotsPolicy!=='respect' || row.statusCode!==undefined || row.finalUrl!==undefined || row.redirectChain!==undefined || !['robots_disallowed','robots_unavailable','robots_policy_unknown_origin'].includes(String(row.reason)) || row.reason==='robots_unavailable' && retrieval!=='unavailable' || row.reason==='robots_disallowed' && retrieval==='unavailable')throw new Error('invalid_robots_blocked_outcome');
      }
      const kind=row.outcome==='robots_blocked'?'skipped':row.outcome as keyof typeof counts; counts[kind]++; if(row.outcome==='robots_blocked')robotsBlocked++;
    }
    if(robotsBlocked>0 && robotsPolicy!=='respect')throw new Error('robots_blocked_without_enforcement');
    if(input.coverage.urls.length!==c.discovered || counts.captured!==c.captured || counts.failed!==c.failed || counts.skipped!==c.skipped || counts.unattempted!==c.unattempted || counts.captured+counts.failed+counts.skipped-robotsBlocked!==c.attempted) throw new Error('inconsistent_url_outcomes');
    for (const row of input.coverage.urls) if (object(row)) {
      const successful = row.outcome === 'captured' && integer(row.statusCode) && row.statusCode >= 200 && row.statusCode < 300;
      for (const value of [row.url,row.finalUrl]) {
        if (typeof value !== 'string' || !pageUrl(value)) continue;
        const u = new URL(value); u.hash = ''; const id=SHA(u.href);
        // Contradictory records cannot establish a successful capture.
        captureIndex.set(id, captureIndex.has(id) ? captureIndex.get(id)! && successful : successful);
      }
    }
  }
  const groups = new Map<string, EvidenceGroup>(); const exclusions: Record<string, number> = {};
  let occurrences = 0; let excluded = 0;
  const omit = (why: string) => { excluded++; exclusions[why] = (exclusions[why] ?? 0) + 1; };
  for (const [fi, f] of findings.entries()) {
    if (!object(f) || typeof f.code !== 'string' || !/^[a-z0-9_]{1,100}$/.test(f.code) || typeof f.category !== 'string' || !['indexability','metadata','content','performance','accessibility','security','contacts'].includes(f.category) || !Array.isArray(f.evidence)) throw new Error('invalid_finding');
    for (const [ei, e] of f.evidence.entries()) {
      if (++occurrences > MAX_EVIDENCE) throw new Error('too_many_evidence_occurrences');
      if (!object(e)) throw new Error('invalid_evidence');
      const page = pageUrl(e.pageUrl);
      if (!page || new URL(page).hostname !== new URL(target).hostname) { omit('invalid_or_other_host'); continue; }
      if (typeof e.source !== 'string' || !['http','rendered-dom','robots','sitemap','pagespeed','derived'].includes(e.source)) { omit('invalid_source'); continue; }
      // Preserve page distinctions: grouping page/code/source avoids collapsing branch or template evidence.
      const original = new URL(e.pageUrl as string); original.hash = '';
      const pageIdentity = SHA(original.href);
      const referenceRedacted = original.search.length > 0;
      const observation = typeof f.observed === 'string' ? f.observed : '';
      const value = ['string','number','boolean'].includes(typeof e.value) ? e.value as string | number | boolean : null;
      const excerpt = typeof e.excerpt === 'string' ? e.excerpt : null;
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('invalid_evidence_value');
      const identity = SHA(JSON.stringify([value,excerpt,observation,e.pageId ?? null,e.referenceScope ?? null]));
      const key = `${f.code}\0${f.category}\0${pageIdentity}\0${e.source}\0${identity}`; const id = SHA(key).slice(0, 24);
      const representative = { observed:observation.slice(0,1024), observedAt:typeof e.observedAt === 'string' && Number.isFinite(Date.parse(e.observedAt)) ? e.observedAt : null, value:typeof value === 'string' ? value.slice(0,1024) : value, excerpt:excerpt?.slice(0,1024) ?? null, truncated:observation.length>1024 || (typeof value === 'string' && value.length>1024) || (excerpt !== null && excerpt.length>1024) || e.excerptTruncated === true || e.valueTruncated === true };
      const existing = groups.get(key); const sourceId = `f${fi}:e${ei}`;
      if (existing) {
        existing.observations++; if (existing.sourceIds.length < 100) existing.sourceIds.push(sourceId); else existing.sourceIdsOmitted++;
        const validTime=(x:string|null)=>x!==null && Date.parse(x)>=Date.parse(input.startedAt as string)-600000 && Date.parse(x)<=Date.parse(input.completedAt as string)+600000;
        if (validTime(representative.observedAt) && (!validTime(existing.representative.observedAt) || representative.observedAt! < existing.representative.observedAt!)) existing.representative=representative;
      }
      else groups.set(key, { id, code: f.code, category: f.category, page, pageIdentity, referenceRedacted, source: e.source, observations: 1, sourceIds: [sourceId], sourceIdsOmitted: 0, capture:captureIndex.get(pageIdentity) === true ? 'CAPTURED_2XX' : 'UNKNOWN_OR_UNSUCCESSFUL', pageId:typeof e.pageId === 'string' && /^page_[a-f0-9]{64}$/.test(e.pageId) ? e.pageId : null, referenceScope:typeof e.referenceScope === 'string' && ['captured','known_not_exported','unknown_uncaptured','external','invalid_or_unknown','sanitization_collision','redaction_unverified'].includes(e.referenceScope) ? e.referenceScope : null, representative });
    }
  }
  const result = [...groups.values()].sort((a,b) => a.id.localeCompare(b.id));
  const retrieval = object(input.robotsObservation) ? input.robotsObservation.retrieval : undefined;
  const robots = typeof retrieval === 'string' && ['available','missing','unavailable'].includes(retrieval) ? retrieval : 'unknown';
  const originalTarget = new URL(input.target as string); originalTarget.hash = '';
  const targetRedacted = originalTarget.search.length > 0;
  for(const key of [...originalTarget.searchParams.keys()]) if (/^(?:utm_.+|gclid|dclid|fbclid|msclkid)$/i.test(key)) originalTarget.searchParams.delete(key);
  originalTarget.searchParams.sort();
  const targetIdentity = SHA(originalTarget.href);
  let checkCoverage:ProjectedCheckCoverage;try{checkCoverage=projectCheckCoverage(input);}catch{throw new Error('invalid_checker_coverage');}
  return { contract:'seo-outreach-evidence-v2', format:'webcrawl-audit-json-1', inputSha256:fingerprint, target, targetIdentity, targetRedacted, hostname:new URL(target).hostname, startedAt:input.startedAt, completedAt:input.completedAt,
    crawl:{ discovered:c.discovered as number, attempted:c.attempted as number, captured:c.captured as number, failed:c.failed as number, skipped:c.skipped as number, unattempted:c.unattempted as number, limitations:(c.limitations as string[]).slice() }, robots, checkCoverage, contacts:projectContactEvidence(input.contacts), groups:result,
    counts:{findings:findings.length, occurrences, grouped:result.length, excluded}, exclusions, status:'INTERNAL_UNVERIFIED' };
}
export async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await handle.stat(); if (!s.isFile() || s.size > MAX_BYTES || s.size === 0) throw new Error('input_not_regular_or_size_invalid');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let offset = 0;
    while (offset < buffer.length) { const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > MAX_BYTES) throw new Error('input_too_large');
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function loadAudit(path: string): Promise<Normalized> {
  const bytes = await readBounded(path);
  let input: unknown; try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid_json'); }
  return normalizeAudit(input, SHA(bytes));
}
