import { createHash } from 'node:crypto';
import type { EvidenceGroup, Normalized } from './evidence.js';
import {CHECK_KEYS, projectCheckCoverage, type ProjectedCheckCoverage} from './check-coverage.js';
const sha=(s: string)=>createHash('sha256').update(s).digest('hex');
const CAP=16_000, GROUP_LIMIT=40, EXAMPLE_LIMIT=3;
// Explicit allowlist: unknown and sensitive observations remain in the internal evidence, not the provider input.
const priorities: Record<string,number> = { noindex:0, invalid_canonical:1, missing_title:2, duplicate_title_across_pages:3, missing_meta_description:4, duplicate_meta_description_across_pages:5, missing_h1:6, broken_internal_link:7, broken_image_asset:8, image_alt_missing_or_empty:9, images_missing_alt:9, images_missing_dimensions:10, missing_canonical:11, malformed_json_ld:12 };
export type DigestIssue={id:string; code:string; language:string; pages:{id:string; url:string}[]; affectedDistinctPages:number};
export type DigestLimits={exportStatus:'PARTIAL'|'COMPLETE'|'UNKNOWN';exported:number|null;omitted:number|null;truncatedPages:number|null;truncatedFields:Record<string,number|null>;checks:ProjectedCheckCoverage;corroboratedGroups:number|null;uncorroboratedGroups:number|null};
export type Digest={version:'digest-v2';limits:DigestLimits; targetHost:string; issues:DigestIssue[]; coverage:{captured:number;failed:number;skipped:number;unattempted:number;robots:string}; overflow:{sourceGroups:number;eligibleGroups:number;selectedGroups:number;omittedGroups:number;omittedExamples:number;omittedByByteCap:number;omittedByGroupCap:number;excluded:Record<string,number>}; materialFingerprint:string; bytes:number; readiness:'INSUFFICIENT_EVIDENCE'|'REVIEW_REQUIRED'};
function lang(path:string):string { const p=path.split('/')[1]?.toLowerCase(); return p && ['en','es','de','pt','fr','it','nl'].includes(p)?p:'unknown'; }
function safePage(g:EvidenceGroup): boolean {
 if (g.referenceRedacted || g.representative.truncated || g.capture!=='CAPTURED_2XX' || !['http','rendered-dom'].includes(g.source)) return false;
 const u=new URL(g.page);
 // Provider receives no query strings, raw text, credentials, or obvious contact-like paths.
 return u.pathname.length<=2048 && !/[\x00-\x1f]/.test(decodeURIComponent(u.pathname));
}
function providerReference(page:string):string {
 const u=new URL(page); const permitted=new Set(['en','es','de','pt','fr','it','nl','course','courses','lesson','lessons','aulas','curso','cursos','dive','diving','kite','kitesurf','kiteboarding','booking','book','contact','contacto','contato','about','services','service','schools','school','activities','activity']);
 const segments=decodeURIComponent(u.pathname).toLowerCase().split('/').filter(Boolean);
 return segments.every(part=>part.split(/[-_]/).every(token=>permitted.has(token))) ? u.href : `${u.origin}/[path-redacted]`;
}
function rank(page:string):number { return /\b(course|courses|lesson|lessons|aulas|curso|cursos|dive|diving|kite|booking|book)\b/i.test(new URL(page).pathname.replace(/[-_]/g,' '))?0:1; }
function limitsFor(evidence:Normalized):DigestLimits {
 const c=evidence.exportCoverage;
 const n=(v:unknown):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('invalid_digest_limits');return v;};
 if(c&&!['PARTIAL','COMPLETE'].includes(c.status))throw new Error('invalid_digest_limits');
 const truncatedFields=Object.fromEntries(['sourceLimit','text','title','description','headings','links','images','structuredData'].map(k=>[k,c&&Object.hasOwn(c.truncationCounts,k)?n(c.truncationCounts[k]):null]));
 const rawChecks:Record<string,unknown>={};
 for(const k of CHECK_KEYS){const row=evidence.checkCoverage?.checks[k];if(row&&row.status!=='unknown'){if(!row.counts)throw new Error('invalid_digest_limits');rawChecks[k]={...row.counts,status:row.status,...Object.fromEntries(['outOfScope','omittedTargets','omittedRelations','untrackedCandidates'].filter(f=>Object.hasOwn(row,f)).map(f=>[f,(row as unknown as Record<string,unknown>)[f]]))};}}
 return {exportStatus:c?.status??'UNKNOWN',exported:c?n(c.exported):null,omitted:c?n(c.omitted):null,truncatedPages:c?n(c.truncatedPages):null,truncatedFields,checks:projectCheckCoverage({coverage:{checks:rawChecks}}),corroboratedGroups:null,uncorroboratedGroups:null};
}
export function buildDigest(evidence:Normalized):Digest {
 const excluded:Record<string,number>={}; const buckets=new Map<string,EvidenceGroup[]>();
 for (const g of evidence.groups) {
  let reason:string|undefined;
  if (!Object.hasOwn(priorities,g.code)) reason='not_in_provider_allowlist';
  else { try { const at=g.representative.observedAt ? Date.parse(g.representative.observedAt) : NaN; if (!safePage(g) || !Number.isFinite(at) || at<Date.parse(evidence.startedAt)-600000 || at>Date.parse(evidence.completedAt)+600000) reason='unsafe_unverified_or_untimed_reference'; } catch { reason='invalid_reference'; } }
  if(reason){excluded[reason]=(excluded[reason]??0)+1;continue;}
  const key=`${evidence.targetIdentity}\0${g.code}\0${lang(new URL(g.page).pathname)}\0${g.source}`;
  const current=buckets.get(key); if(current)current.push(g);else buckets.set(key,[g]);
 }
 const all=[...buckets.entries()].map(([key,groups])=>{
   groups.sort((a,b)=>rank(a.page)-rank(b.page)||a.page.localeCompare(b.page)||a.id.localeCompare(b.id));
   const distinct=new Map<string,EvidenceGroup>(); for(const g of groups)if(!distinct.has(g.pageIdentity))distinct.set(g.pageIdentity,g);
   const values=[...distinct.values()];
   return {pagePriority:rank(values[0]!.page),id:sha(key).slice(0,24),code:groups[0]!.code,language:lang(new URL(groups[0]!.page).pathname),pages:values.slice(0,EXAMPLE_LIMIT).map(g=>({id:g.id,url:providerReference(g.page)})),affectedDistinctPages:values.length};
 }).sort((a,b)=>a.pagePriority-b.pagePriority||(priorities[a.code]??99)-(priorities[b.code]??99)||a.language.localeCompare(b.language)||a.id.localeCompare(b.id)).map(({pagePriority,...issue})=>issue);
 const limits=limitsFor(evidence);
 const coverage={captured:evidence.crawl.captured,failed:evidence.crawl.failed,skipped:evidence.crawl.skipped,unattempted:evidence.crawl.unattempted,robots:evidence.robots};
 // Timestamps and input ordering do not change the identity; observations and crawl limits do.
 const materialFingerprint=sha(JSON.stringify({digestVersion:'digest-v2',targetIdentity:evidence.targetIdentity,coverage,limits,limitations:[...evidence.crawl.limitations].sort(),groups:[...new Set(evidence.groups.map(g=>g.id))].sort()}));
 const selected:DigestIssue[]=[]; let omittedExamples=0,omittedByByteCap=0,omittedByGroupCap=0;
 for(const item of all){
  if(selected.length>=GROUP_LIMIT){omittedByGroupCap++;continue;}
  const trial=[...selected,item];
  // Reserve space for envelope, coverage, and overflow; final size is checked below.
  if(Buffer.byteLength(JSON.stringify(trial))>CAP-4096){omittedByByteCap++;continue;}
  selected.push(item);omittedExamples+=Math.max(0,item.affectedDistinctPages-item.pages.length);
 }
 const result:Digest={version:'digest-v2',limits,targetHost:evidence.hostname,issues:selected,coverage,overflow:{sourceGroups:evidence.groups.length,eligibleGroups:all.length,selectedGroups:selected.length,omittedGroups:all.length-selected.length,omittedExamples,omittedByByteCap,omittedByGroupCap,excluded},materialFingerprint,bytes:0,readiness:evidence.crawl.captured>0&&selected.length?'REVIEW_REQUIRED':'INSUFFICIENT_EVIDENCE'};
 for(let i=0;i<4;i++){const size=Buffer.byteLength(JSON.stringify(result));if(result.bytes===size)break;result.bytes=size;} if(result.bytes>CAP)throw new Error('digest_cap_exceeded'); return result;
}
