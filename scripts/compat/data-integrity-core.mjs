import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { auditResultSha256, isCustomerReleaseQualified, isReportableEvidenceAdmissible, reportableCodes } from '../../dist/reports/qualification.js';
import { verifyEvidencePack, projectCapturedAuditForEvidence } from '@spora/webcrawl/reports/evidence-pack';
import { TECHNOLOGY_PROFILE } from '@spora/webcrawl/enrichments/technology';
import { reviewRow, HANDOFF_SCHEMA } from './no-send-handoff-core.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function readBounded(path, limit = 200_000_000, privateFile = false) {
 if (typeof path !== 'string' || !isAbsolute(path)) throw Error('absolute_file_path_required');
 if(privateFile&&(resolve(path)!==path||await realpath(dirname(path))!==dirname(path)))throw Error('unsafe_or_oversized_file');
 const f=await open(path, constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try { const s=await f.stat(); if(!s.isFile()||s.size>limit||privateFile&&(s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600))throw Error('unsafe_or_oversized_file');
  const chunks=[];let total=0;
  while(total<=limit){const b=Buffer.alloc(Math.min(65536,limit+1-total));const {bytesRead}=await f.read(b);if(!bytesRead)break;total+=bytesRead;if(total>limit)throw Error('unsafe_or_oversized_file');chunks.push(b.subarray(0,bytesRead));}
  return Buffer.concat(chunks,total);
 }finally{await f.close();}
}
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
export async function checkEntry(entry, now=Date.now()) {
 const checks=[],files=[];const check=(code,status)=>checks.push({code,status});
 const load=async (path,limit,privateFile)=>{const bytes=await readBounded(path,limit,privateFile);files.push({path,sha256:digest(bytes)});return bytes;};
 const json=async path=>JSON.parse((await load(path)).toString('utf8'));
 try {
  if(!entry || typeof entry!=='object' || typeof entry.audit!=='string' || !isAbsolute(entry.audit)) throw Error('entry_shape_invalid');
  for(const key of ['qualification','reviewManifest','release','evidencePack','handoff']) if(Object.hasOwn(entry,key) && (typeof entry[key]!=='string' || !isAbsolute(entry[key]))) throw Error('entry_shape_invalid');
  if(Object.hasOwn(entry,'reports') && (!Array.isArray(entry.reports) || entry.reports.length>10 || entry.reports.some(r=>!r || typeof r!=='object' || typeof r.path!=='string' || !isAbsolute(r.path) || Object.keys(r).some(k=>!['path','sha256'].includes(k)) || Object.hasOwn(r,'sha256') && (typeof r.sha256!=='string' || !/^[a-f0-9]{64}$/.test(r.sha256))))) throw Error('entry_shape_invalid');
  const audit=await json(entry.audit);if(!isAuditResultRecord(audit))throw Error('audit_schema_invalid');check('audit_schema','PASS');
  const auditSha256=auditResultSha256(audit), expected=reviewRow(audit);
  check('detector_profile',audit.crawlSettings.technologyProfile===TECHNOLOGY_PROFILE||audit.capabilities.technology==='disabled'?'PASS':'HOLD');
  check('selected_customer_evidence',expected.selectedEvidence.length?'PASS':'HOLD');
  check('raw_reportable_evidence',audit.findings.every(f=>!reportableCodes.has(f.code)||isReportableEvidenceAdmissible(audit,f))?'PASS':'HOLD');
  check('private_security',audit.findings.some(f=>['sensitive_form_over_http','sensitive_form_to_external_origin','password_form_on_http'].includes(f.code))?'HOLD':'PASS');
  let qualification,qualificationBytes,reviewed=null;
  if(entry.qualification){qualificationBytes=await load(entry.qualification);qualification=JSON.parse(qualificationBytes.toString());
   if(!qualification||qualification.auditSha256!==auditSha256||qualification.target!==audit.target)throw Error('qualification_audit_mismatch');
   const keys=['decision','target','auditSha256','qualifiedAt','qualifiedBy','businessIdentity','coverage','security'];
   const reviewedMode=Object.hasOwn(qualification,'reviewedManifestSha256');
   if(reviewedMode)keys.push('reviewedManifestSha256');
   if(JSON.stringify(Object.keys(qualification).sort())!==JSON.stringify(keys.sort()))throw Error('qualification_shape_invalid');
   if(reviewedMode){
    if(!entry.reviewManifest)throw Error('review_manifest_required');
    const bytes=await load(entry.reviewManifest,16384,true),hash=digest(bytes);
    if(!/^[a-f0-9]{64}$/.test(qualification.reviewedManifestSha256)||hash!==qualification.reviewedManifestSha256)throw Error('review_manifest_hash_mismatch');
    const m=JSON.parse(bytes);
    if(!m||m.schema!=='webcrawl-customer-review-v1'||m.target!==audit.target||m.auditSha256!==auditSha256||m.reportStatus!=='HOLD'||m.outboundApproval!==false||!Array.isArray(m.artifacts)||m.artifacts.length!==2)throw Error('review_manifest_invalid');
    const roles=new Set(),paths=new Set(),locale=m.artifacts[0]?.locale;
    if(!['en','de'].includes(locale))throw Error('review_manifest_invalid');
    for(const a of m.artifacts){
     if(!a||!['a4','mobile'].includes(a.role)||a.locale!==locale||typeof a.path!=='string'||!isAbsolute(a.path)||!Number.isSafeInteger(a.bytes)||a.bytes<8||a.bytes>50000000||typeof a.sha256!=='string'||!/^[a-f0-9]{64}$/.test(a.sha256)||roles.has(a.role)||paths.has(a.path))throw Error('review_manifest_invalid');
     roles.add(a.role);paths.add(a.path);
    }
    reviewed={hash,artifacts:m.artifacts.map(({role,locale,path,bytes,sha256})=>({role,locale,path,bytes,sha256}))};
    check('review_manifest_binding','PASS');
   }
  }
  if(entry.reviewManifest&&!reviewed)throw Error('review_manifest_required');
  const qualified=isCustomerReleaseQualified(audit,qualification,now);
  check('current_customer_qualification',qualified?'PASS':'HOLD');
  if(entry.evidencePack){const pack=verifyEvidencePack(await load(entry.evidencePack));
   const bound=pack.manifest.originalAuditSha256;
   if(bound!==null&&bound!==undefined&&bound!==auditSha256)throw Error('evidence_pack_audit_mismatch');
   const embedded=JSON.parse(pack.members.find(m=>m.name==='audit.json').content.toString());
   const pages=pack.members.find(m=>m.name==='pages.jsonl').content.toString().split('\n').filter(Boolean).map(line=>JSON.parse(line));
   if(canonical(embedded)!==canonical(projectCapturedAuditForEvidence(audit,pages))) throw Error('evidence_pack_projection_mismatch');
   check('evidence_pack_binding',bound===auditSha256?'PASS':'HOLD');
  }else check('evidence_pack_not_supplied','HOLD');
  let release=null;
  if(entry.release){
   if(!entry.release.endsWith('.release.json'))throw Error('release_filename_invalid');
   const m=await json(entry.release);
   if(m.schema!=='webcrawl-customer-release-v1'||m.target!==audit.target||m.auditSha256!==auditSha256||m.reportStatus!=='CLIENT_READY'||m.outboundApproval!==false||!Array.isArray(m.artifacts))throw Error('release_manifest_invalid');
   if(!qualificationBytes)check('release_qualification_not_supplied','HOLD');
   else if(m.qualificationSha256!==digest(qualificationBytes)||m.reviewer!==qualification.qualifiedBy||m.qualifiedAt!==qualification.qualifiedAt)throw Error('release_qualification_mismatch');
   if(Object.hasOwn(m,'reviewedManifestSha256')){
    // Paths are admitted only from the exact review document bound by the supplied qualification.
    if(!reviewed||m.reviewedManifestSha256!==reviewed.hash)throw Error('review_manifest_hash_mismatch');
    if(Object.hasOwn(m,'mobileLocale')||canonical(m.artifacts)!==canonical(reviewed.artifacts))throw Error('release_artifact_path_invalid');
    for(const a of reviewed.artifacts){
     const bytes=await load(a.path,50000000,true);
     if(bytes.length!==a.bytes||digest(bytes)!==a.sha256)throw Error('release_artifact_hash_mismatch');
     if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('release_pdf_signature_invalid');
    }
   }else{
    if(reviewed||!['en','de'].includes(m.mobileLocale)||m.artifacts.length!==4)throw Error('release_manifest_invalid');
    const prefix=entry.release.slice(0,-'.release.json'.length),paths=[`${prefix}.en.pdf`,`${prefix}.de.pdf`,`${prefix}.mobile-${m.mobileLocale}.pdf`,`${prefix}.whatsapp-draft.md`];
    // Preserve the legacy four-artifact path contract.
    for(let i=0;i<4;i++){
     const a=m.artifacts[i];if(!a||a.path!==paths[i]||!/^[a-f0-9]{64}$/.test(a.sha256))throw Error('release_artifact_path_invalid');
     const bytes=await load(paths[i]);if(digest(bytes)!==a.sha256)throw Error('release_artifact_hash_mismatch');
     if(i<3&&bytes.subarray(0,5).toString()!=='%PDF-')throw Error('release_pdf_signature_invalid');
    }
   }
   release={manifestSha256:files.find(f=>f.path===entry.release).sha256,artifacts:m.artifacts,status:qualified?'CURRENT_QUALIFICATION_VERIFIED':'ARCHIVED_OR_UNQUALIFIED'};
   check('release_hash_binding','PASS');
  }else check('release_not_supplied','HOLD');
  // Historical PDF hashes can be inventoried, but cannot establish audit binding.
  if(entry.reports){if(!Array.isArray(entry.reports)||entry.reports.length>10)throw Error('reports_input_invalid');
   for(const report of entry.reports){const bytes=await load(report.path);if(report.sha256!==undefined&&digest(bytes)!==report.sha256)throw Error('historical_report_hash_mismatch');if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('historical_report_signature_invalid');}
   check('historical_reports_unbound','HOLD');
  }
  if(entry.handoff){const queue=await json(entry.handoff);
   if(queue.schema!==HANDOFF_SCHEMA){check('handoff_profile_unsupported','HOLD');}
   else{
    if(!Array.isArray(queue.rows)||queue.rows.length>1000||new Set(queue.rows.map(r=>r?.id)).size!==queue.rows.length)throw Error('handoff_rows_invalid');
    const row=queue.rows.find(r=>r?.id===expected.id);
    if(!row||canonical(row)!==canonical(expected))throw Error('handoff_projection_mismatch');
    check('handoff_exact_projection','PASS');
   }
  }else check('handoff_not_supplied','HOLD');
  return {id:entry.id,auditSha256,targetIdentitySha256:expected.targetIdentitySha256,canonicalUrl:expected.canonicalUrl,detectorProfile:audit.crawlSettings.technologyProfile??null,observedAt:audit.completedAt,selectedEvidence:expected.selectedEvidence,release,integrity:checks.some(c=>c.status==='HOLD')?'PARTIAL':'PASS',decision:checks.some(c=>c.status==='HOLD')?'HOLD':'PASS',checks,files};
 }catch(error){
  const known=new Set(['review_manifest_required','review_manifest_hash_mismatch','review_manifest_invalid','entry_shape_invalid','evidence_pack_projection_mismatch','absolute_file_path_required','unsafe_or_oversized_file','audit_schema_invalid','qualification_audit_mismatch','qualification_shape_invalid','evidence_pack_audit_mismatch','release_filename_invalid','release_manifest_invalid','release_qualification_mismatch','release_artifact_path_invalid','release_artifact_hash_mismatch','release_pdf_signature_invalid','reports_input_invalid','historical_report_hash_mismatch','historical_report_signature_invalid','handoff_rows_invalid','handoff_projection_mismatch']);
  const code=known.has(error.message)?error.message:['ENOENT','ELOOP','EACCES','EPERM'].includes(error.code)?`input_${error.code.toLowerCase()}`:'invalid_or_unverifiable_input';
  return {id:entry?.id,integrity:'ERROR',decision:'ERROR',checks:[...checks,{code,status:'ERROR'}],files};
 }
}
