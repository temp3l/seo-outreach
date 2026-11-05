import {createHash} from 'node:crypto';
import type {EvidenceGroup,Normalized} from './evidence.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
type Obj=Record<string,unknown>;
const obj=(x:unknown):x is Obj=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export type Corroboration={groupId:string; pageId:string; status:'CORROBORATED_OBSERVATION'; check:string};
const absent=(v:unknown)=>v===undefined||v==='';
function imageWitnesses(p:Obj):Obj[] {
 if(!['OBSERVED','TRUNCATED'].includes(String(p.documentImagesStatus))||!Array.isArray(p.documentImages)||p.documentImages.length>1000)return [];
 const seen=new Set<number>();const images:Obj[]=[];
 for(const i of p.documentImages){
  if(!obj(i)||!Number.isSafeInteger(i.occurrence)||(i.occurrence as number)<0||seen.has(i.occurrence as number)||!['main','document'].includes(String(i.scope))||!['src','data-src','data-lazy-src'].includes(String(i.srcAttribute))||typeof i.src!=='string')return [];
  try{const u=new URL(i.src);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return [];}catch{return [];}
  seen.add(i.occurrence as number);images.push(i);
 }
 return images;
}
function missingDimension(i:Obj,key:'width'|'height'):boolean {
 return ['missing','invalid'].includes(String(i[key+'Status']))&&i[key]===undefined;
}
function noindex(value:string):boolean {
 return value.split(',').some(part=>{const scoped=part.includes(':')?part.slice(part.indexOf(':')+1):part;return scoped.trim().toLowerCase().split(/\s+/).some(t=>t==='none'||t==='noindex');});
}
function findingsMatch(g:EvidenceGroup,p:Obj):boolean {
 switch(g.code){
  case 'missing_title': return p.titleStatus==='ABSENT' && absent(p.title) && absent(p.titleRaw) && p.titleTruncated!==true;
  case 'missing_meta_description': return p.descriptionStatus==='ABSENT' && absent(p.description) && absent(p.descriptionRaw) && p.descriptionTruncated!==true;
  case 'missing_h1': return ['OBSERVED','ABSENT'].includes(String(p.headingsStatus)) && p.headingsTruncated===false && Array.isArray(p.headings) && p.headings.length<=500 && (p.headingsStatus==='ABSENT'?p.headings.length===0:p.headings.length>0) && p.headings.every(h=>obj(h)&&Number.isSafeInteger(h.level)&&(h.level as number)>=2&&(h.level as number)<=6&&typeof h.text==='string'&&typeof h.rawText==='string');
  case 'missing_canonical': return p.canonicalStatus==='ABSENT' && absent(p.canonical) && p.canonicalCandidatesOmitted===0 && Array.isArray(p.canonicalCandidates) && p.canonicalCandidates.length===0;
  case 'malformed_json_ld': return p.structuredDataStatus==='invalid';
  case 'image_alt_missing_or_empty': return imageWitnesses(p).some(i=>i.altTruncated!==true && (i.altStatus==='missing'?i.alt===undefined&&i.altRaw===undefined:i.altStatus==='empty'&&typeof i.alt==='string'&&i.alt.trim()===''&&(i.altRaw===undefined||typeof i.altRaw==='string'&&i.altRaw.trim()==='')));
  case 'images_missing_dimensions': return imageWitnesses(p).some(i=>missingDimension(i,'width')||missingDimension(i,'height'));
  case 'slow_response_headers': case 'very_slow_response_headers': return obj(p.responseHeaderTiming) && p.responseHeaderTiming.status==='MEASURED' && typeof p.responseHeaderTiming.elapsedMs==='number' && Number.isFinite(p.responseHeaderTiming.elapsedMs) && typeof g.representative.value==='number' && Math.abs(p.responseHeaderTiming.elapsedMs-g.representative.value)<0.001 && (g.code==='very_slow_response_headers'?p.responseHeaderTiming.elapsedMs>1800:p.responseHeaderTiming.elapsedMs>800&&p.responseHeaderTiming.elapsedMs<=1800);
  case 'noindex': {
   if(p.metaRobotsStatus!=='OBSERVED' || p.metaRobotsDeclarationsOmitted!==0 || !Array.isArray(p.metaRobotsDeclarations))return false;
   return p.metaRobotsDeclarations.some(d=>obj(d)&&d.status==='observed'&&typeof d.name==='string'&&['robots','googlebot','bingbot'].includes(d.name.trim().toLowerCase())&&typeof d.content==='string'&&noindex(d.content));
  }
  default:return false;
 }
}
/** Corroborates selected facts against captured page projections, not the producer's full archive semantics. */
export function corroborateArchive(evidence:Normalized,pages:unknown[]):Corroboration[] {
 if(pages.length>10_000)throw new Error('too_many_pages');
 const byId=new Map<string,Obj>();
 for(const p of pages){
  if(!obj(p)||typeof p.id!=='string'||!/^page_[a-f0-9]{64}$/.test(p.id)||byId.has(p.id))throw new Error('invalid_or_duplicate_page_id');
  byId.set(p.id,p);
 }
 const out:Corroboration[]=[];
 for(const g of evidence.groups){
  if(!g.pageId||g.referenceScope!=='captured'||g.referenceRedacted||g.capture!=='CAPTURED_2XX'||g.representative.truncated||!['http','rendered-dom'].includes(g.source))continue;
  const p=byId.get(g.pageId);if(!p||typeof p.requestedUrl!=='string'||typeof p.finalUrl!=='string'||typeof p.finalUrlIdentity!=='string'||typeof p.requestedUrlIdentity!=='string')continue;
  let req:URL,fin:URL;try{req=new URL(p.requestedUrl);fin=new URL(p.finalUrl);}catch{continue;}
  if(req.search||fin.search||req.hash||fin.hash||req.username||fin.username||req.password||fin.password||!['http:','https:'].includes(req.protocol)||!['http:','https:'].includes(fin.protocol)||fin.hostname!==evidence.hostname)continue;
  const targetPath=new URL(evidence.target).pathname;
  if(targetPath!=='/' && !(fin.pathname===targetPath || fin.pathname.startsWith(targetPath.endsWith('/')?targetPath:targetPath+'/')))continue;
  if(p.id!==`page_${sha(`${req.href}\n${fin.href}`)}` || p.requestedUrlIdentity!==sha(req.href) || p.finalUrlIdentity!==sha(fin.href) || g.pageIdentity!==p.finalUrlIdentity || g.page!==fin.href)continue;
  if(typeof p.statusCode!=='number'||p.statusCode<200||p.statusCode>=300||!['captured','content_limit'].includes(String(p.contentStatus)))continue;
  if(typeof p.contentType!=='string'||!['text/html','application/xhtml+xml'].includes(p.contentType.split(';')[0]!.trim().toLowerCase())||!obj(p.extractionQuality)||!['adequate','limited'].includes(String(p.extractionQuality.status))||!['main','article','body'].includes(String(p.contentScope)))continue;
  if((g.source==='http'&&p.source!=='http_html')||(g.source==='rendered-dom'&&p.source!=='rendered_dom'))continue;
  const observed=Date.parse(g.representative.observedAt??''),fetched=Date.parse(typeof p.fetchedAt==='string'?p.fetchedAt:'');
  if(!Number.isFinite(observed)||!Number.isFinite(fetched)||observed<Date.parse(evidence.startedAt)-600000||observed>Date.parse(evidence.completedAt)+600000||fetched<Date.parse(evidence.startedAt)-600000||fetched>Date.parse(evidence.completedAt)+600000)continue;
  // Technical checks refer to the fetch; image enrichment is observed later over the retained capture.
  if(g.code==='image_alt_missing_or_empty' ? observed<fetched : observed!==fetched)continue;
  if(findingsMatch(g,p))out.push({groupId:g.id,pageId:g.pageId,status:'CORROBORATED_OBSERVATION',check:g.code});
 }
 return out.sort((a,b)=>a.groupId.localeCompare(b.groupId));
}
