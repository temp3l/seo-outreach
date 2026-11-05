#!/usr/bin/env node
// Offline-only, review-gated Cumbuco publication with verified backups.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, writeFile, readdir, realpath, lstat, open, unlink, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderCustomerSummaryHtml } from '../../dist/reports/summary.js';
import { renderMobileCustomerPdf } from '../../dist/reports/mobile.js';
import { playwrightPdfRenderer } from '../../dist/reports/pdf-playwright.js';
import { readReportContactFile } from '../../dist/reports/report-contact.js';
import { renderPortugueseWhatsAppDraft } from '../../dist/reports/whatsapp-draft.js';
import { publishCumbucoReplacements } from './cumbuco-publication-io.mjs';
import { buildCumbucoPreflight } from './cumbuco-preflight-core.mjs';

const execFile = promisify(execFileCallback);

/** Shared publication workflow. The production CLI below pins both roots. */
export async function runCumbucoPublisher({ root, source, mode, issuer: issuerOverride, filesystemOperations, onRender } = {}) {
if (!root || !source || !['--dry-run','--apply'].includes(mode)) throw Error('invalid_publication_workflow_arguments');
if (await realpath(root) !== root || await realpath(source) !== source) throw Error('unexpected_workspace');
const hash = data => createHash('sha256').update(data).digest('hex');
const noLink = async p => { const s=await lstat(p); if(s.isSymbolicLink())throw Error('symlink_not_allowed'); return s; };
const inside = (base,p) => {const r=relative(base,p);return !!r && r!=='..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep);};
const abs = rel => {const p=join(root,rel);if(!inside(root,p))throw Error('unsafe_output_path');return p;};
const checkParent = async p => {const dir=dirname(p);if(!inside(root,dir))throw Error('unsafe_output_parent');const pieces=relative(root,dir).split(sep);let here=root;for(const part of pieces){here=join(here,part);const s=await noLink(here);if(!s.isDirectory()||await realpath(here)!==here)throw Error('unsafe_output_parent');}};
const missing = async p => {try{await lstat(p);return false}catch(e){if(e.code==='ENOENT')return true;throw e;}};
const readSafe = async p => {const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1)throw Error('unsafe_input_file');return await f.readFile()}finally{await f.close()}};
const preflight = async () => JSON.stringify(await buildCumbucoPreflight(root), null, 2);
const preflightText = await preflight();
const inventory=JSON.parse(preflightText);
if(inventory.schema!=='cumbuco-preflight-v1'||!Array.isArray(inventory.businesses)||inventory.businesses.length===0)throw Error('invalid_preflight');
const issuer=issuerOverride??await readReportContactFile(join(source,'.report-contact.json'));
if(!issuer.email||!issuer.phone)throw Error('report_contact_email_and_phone_required');
// Source-input fingerprint for provenance; rendering environment inputs are validated on every artifact publication.
const jsFiles = async dir => (await Promise.all((await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).map(x=>x.isDirectory()?jsFiles(join(dir,x.name)):x.isFile()&&x.name.endsWith('.js')?[join(dir,x.name)]:[]))).flat();
const inputFiles=[...(await jsFiles(join(source,'dist'))),join(source,'scripts/compat/cumbuco-preflight.mjs'),join(source,'scripts/compat/cumbuco-preflight-core.mjs'),join(source,'scripts/compat/cumbuco-publish.mjs'),join(source,'scripts/compat/cumbuco-publication-io.mjs'),join(source,'scripts/compat/cumbuco-run-selection.mjs')];
const fingerprint=hash(JSON.stringify({inventory:hash(preflightText),issuer:hash(JSON.stringify(issuer)),modules:await Promise.all(inputFiles.map(async p=>[relative(source,p),hash(await readFile(p))]))}));
const manifestRel='scraped/qualification.current.json',csvRel='scraped/qualification.current.csv', manifestPath=abs(manifestRel);
const businessIdPattern=/^CB-(?:EXT-)?[A-F0-9]{10}$/u;
const artifactBelongsTo=(path,id)=>{
 if(typeof path!=='string')return false;
 const match=/^scraped\/([^/\\]+)\/report\.(?:pt-review\.pdf|mobile-pt-review\.pdf|whatsapp-pt-review\.md)$/u.exec(path);
 return !!match&&businessIdPattern.test(id)&&match[1].endsWith(id);
};
const existing = async () => {
 if(await missing(manifestPath))return null;
 await checkParent(manifestPath);const raw=await readSafe(manifestPath);let m;try{m=JSON.parse(raw)}catch{throw Error('existing_manifest_invalid')}
 if(m.schema!=='cumbuco-qualification-v1'||m.publication_status!=='HOLD'||!['PROVISIONAL','SELECTED','PARTIAL'].includes(m.selection_status)||!Array.isArray(m.files)||!Array.isArray(m.businesses))throw Error('existing_manifest_invalid');
 const priorIds=new Set();
 for(const b of m.businesses){
  if(!b||typeof b.id!=='string'||!businessIdPattern.test(b.id)||priorIds.has(b.id)||b.report_disposition!=='HOLD'||b.recipient_disposition!=='HOLD'||b.recipient_review_required!==true||b.selected_send_target!==null||!Array.isArray(b.artifact_paths)||b.artifact_paths.some(path=>!artifactBelongsTo(path,b.id)))throw Error('existing_manifest_invalid');
  priorIds.add(b.id);
 }
 const expected=[...m.businesses.flatMap(b=>b.artifact_paths),csvRel].sort();
 if(new Set(expected).size!==expected.length)throw Error('existing_manifest_invalid');
 if(m.files.length!==expected.length||m.files.map(f=>f.path).sort().some((p,i)=>p!==expected[i]))throw Error('existing_manifest_invalid');
 for(const f of m.files){if(typeof f.path!=='string'||typeof f.sha256!=='string')throw Error('existing_manifest_invalid');const p=abs(f.path);await checkParent(p);if(hash(await readSafe(p))!==f.sha256)throw Error('existing_artifact_changed');}
 return {manifest:m,manifestHash:hash(raw),hashes:new Map(m.files.map(f=>[f.path,f.sha256]))};
};
const plans=[];
for(const b of inventory.businesses){
 const row={id:b.id,business:b.business,advertised_site:b.advertised_site,report_disposition:'HOLD',recipient_disposition:'HOLD',recipient_review_required:true,selected_send_target:null,selected_run:b.selection?.run??null,source_sha256:b.selection?.sha256??null,audit_path:b.selection?.audit??null,selection_score:b.selection?.score??null,alternatives:(b.alternatives??[]).map(x=>({run:x.run,audit_path:x.audit,source_sha256:x.sha256,inspection:x.inspection.status,technical_seo:x.technical_seo,images:x.images,limitations:x.limitations,score:x.score})),inspection:b.selection?.inspection??null,http_capability:b.selection?.http??'unknown',technical_seo_capability:b.selection?.technical_seo??'unknown',images_capability:b.selection?.images??'unknown',limitations:b.selection?.limitations??[],evidence_urls:[...new Set((b.selection?.opportunities??[]).flatMap(x=>[x.url,...(x.target?[x.target]:[])]))],next_manual_action:b.selection?.opportunities?.length?`Review the selected evidence and its relevance to ${b.advertised_site} before customer distribution.`:`Review ${b.advertised_site} and its lesson/contact pages; if the archive is insufficient, request a targeted future inspection.`,artifact_paths:[],reason:b.reason};
 if(b.selection){const p=b.selection.audit.split('/');if(p.length<3||p[0]!=='scraped'||!p[1].endsWith(b.id))throw Error('unsafe_business_identity');const base=`scraped/${p[1]}`;const logPath=abs(`${base}/report.run.log`);await checkParent(logPath);try{const log=(await readSafe(logPath)).toString('utf8');row.previous_disposition=[...log.matchAll(/\[publication\] status=(CLIENT_READY|HOLD)/gu)].at(-1)?.[1]??'UNKNOWN';}catch(e){if(e.code!=='ENOENT')throw e;row.previous_disposition='UNKNOWN';}if(b.selection.opportunities?.length)row.artifact_paths=[`${base}/report.pt-review.pdf`,`${base}/report.mobile-pt-review.pdf`,`${base}/report.whatsapp-pt-review.md`];}
 plans.push(row);
}
const outputPaths=[...plans.flatMap(x=>x.artifact_paths),csvRel,manifestRel];
if(new Set(outputPaths).size!==outputPaths.length)throw Error('duplicate_output_path');
const prior=await existing();
if(!plans.some(r=>r.artifact_paths.length)&&prior?.manifest.fingerprint===fingerprint&&prior.manifest.selection_status===(plans.every(r=>r.selected_run)?'SELECTED':'PARTIAL')&&JSON.stringify(prior.manifest.businesses)===JSON.stringify(plans)&&JSON.stringify(prior.manifest.files.map(f=>f.path).sort())===JSON.stringify(outputPaths.filter(p=>p!==manifestRel).sort()))return {mode,changed_paths:[],retired_paths:[],result:'NO_OP',businesses:inventory.businesses.length};
const plannedArtifacts=new Set(plans.flatMap(r=>r.artifact_paths));
const retiredPaths=[];
if(prior)for(const oldRow of prior.manifest.businesses)for(const rel of oldRow.artifact_paths){if(plannedArtifacts.has(rel))continue;if(!artifactBelongsTo(rel,oldRow.id))throw Error(`unsafe_retirement_ownership:${rel}`);retiredPaths.push(rel);}
for(const rel of outputPaths){const p=abs(rel);await checkParent(p);if(!await missing(p)&&rel!==manifestRel&&!prior?.hashes.has(rel)&&!retiredPaths.includes(rel))throw Error(`output_already_exists:${rel}`);if(rel===manifestRel&&!await missing(p)&&!prior)throw Error('output_already_exists:manifest');}
const temp=await mkdtemp(join(tmpdir(),'cumbuco-publish-'));
const pending=[];let workflowFailure;
try{
 for(const row of plans){
  if(!row.artifact_paths.length)continue;
  const auditBytes=await readSafe(abs(row.audit_path));if(hash(auditBytes)!==row.source_sha256)throw Error('audit_changed_after_preflight');
  const audit=JSON.parse(auditBytes);
  onRender?.({businessId:row.id,run:row.selected_run});
  const html=renderCustomerSummaryHtml(audit,'pt-BR',{issuer}).replace('data-publication-status="PREVIEW"','data-publication-status="HOLD"');
  if(!/<body\b[^>]*data-publication-status="HOLD"/u.test(html))throw Error('report_hold_marker_missing');
  const a4=await playwrightPdfRenderer(html);
  const mobile=await renderMobileCustomerPdf(audit,playwrightPdfRenderer,issuer,'pt-BR','HOLD');
  const draft=renderPortugueseWhatsAppDraft(audit,issuer);
  if(!draft||!draft.includes('recipient_review_required:** true')||!draft.includes('selected_send_target:** null'))throw Error('draft_recipient_gate_invalid');
  const pdfs=[Buffer.from(a4),Buffer.from(mobile)];
  for(const [ix,bytes] of pdfs.entries()){
   const p=join(temp,`${row.id}-${ix}.pdf`);await writeFile(p,bytes,{mode:0o600,flag:'wx'});
   const text=(await execFile('pdftotext',['-layout',p,'-'],{maxBuffer:4*1024*1024})).stdout;
   const info=(await execFile('pdfinfo',[p],{maxBuffer:1024*1024})).stdout;
   const urlInfo=(await execFile('pdfinfo',['-url',p],{maxBuffer:1024*1024})).stdout;
   const annotations=[...urlInfo.matchAll(/https?:\/\/[^\s)<>"']+/giu)].flatMap(match=>{try{return[new URL(match[0]).href]}catch{return[]}});
   const pages=Number(/^Pages:\s*(\d+)/mu.exec(info)?.[1]);
   const collapse=s=>s.replace(/\s+/gu,'');
   if(!Number.isInteger(pages)||pages<1||ix===0&&pages!==1||/\bHOLD\b/u.test(text)||!text.includes('REVISÃO DO SITE')||!text.includes(issuer.name)||!text.includes(issuer.email)||!collapse(text).includes(collapse(issuer.phone))||row.evidence_urls.some(u=>!annotations.includes(u)))throw Error(`pdf_validation_failed:${row.id}:${ix}`);
   const oldPath=abs(row.artifact_paths[ix]);
   if(prior?.hashes.has(row.artifact_paths[ix])){
    const oldText=(await execFile('pdftotext',['-layout',oldPath,'-'],{maxBuffer:4*1024*1024})).stdout;
    if(oldText===text){
     const oldStem=join(temp,`old-${row.id}-${ix}`),newStem=join(temp,`new-${row.id}-${ix}`);
     await execFile('pdftoppm',['-r','72','-png',oldPath,oldStem],{maxBuffer:1024*1024});
     await execFile('pdftoppm',['-r','72','-png',p,newStem],{maxBuffer:1024*1024});
     const names=await readdir(temp);
     const oldImages=names.filter(n=>n.startsWith(`old-${row.id}-${ix}-`)&&n.endsWith('.png')).sort();
     const newImages=names.filter(n=>n.startsWith(`new-${row.id}-${ix}-`)&&n.endsWith('.png')).sort();
     if(oldImages.length===pages&&newImages.length===pages&&(await Promise.all(oldImages.map(async (name,i)=>hash(await readFile(join(temp,name)))===hash(await readFile(join(temp,newImages[i])))))).every(Boolean))pdfs[ix]=await readSafe(oldPath);
    }
   }
  }
  pending.push([row.artifact_paths[0],pdfs[0]],[row.artifact_paths[1],pdfs[1]],[row.artifact_paths[2],Buffer.from(draft)]);
 }
 if(await preflight()!==preflightText)throw Error('campaign_changed_after_preflight');
 const csvCell=x=>{let s=String(x??'');if(/^[=+\-@\t\r]/u.test(s))s=`'${s}`;return `"${s.replaceAll('"','""')}"`;};
 const csvColumns=['id','business','advertised_site','selected_run','source_sha256','audit_path','selection_score','alternatives','previous_disposition','report_disposition','recipient_disposition','recipient_review_required','selected_send_target','evidence_urls','http_capability','technical_seo_capability','images_capability','limitations','next_manual_action','artifact_paths'];
 const csv=Buffer.from(csvColumns.join(',')+'\n'+plans.map(row=>csvColumns.map(k=>csvCell(Array.isArray(row[k])?(k==='alternatives'?JSON.stringify(row[k]):row[k].join(' | ')):row[k])).join(',')).join('\n')+'\n');
 pending.push([csvRel,csv]);
 const files=pending.map(([path,data])=>({path,sha256:hash(data)}));
 const selectionStatus=plans.every(r=>r.selected_run)?'SELECTED':'PARTIAL';
 const sameBusiness=!!prior&&prior.manifest.selection_status===selectionStatus&&JSON.stringify(prior.manifest.businesses)===JSON.stringify(plans);
 const sameFiles=!!prior&&files.length===prior.hashes.size&&files.every(f=>prior.hashes.get(f.path)===f.sha256);
 if(sameBusiness&&sameFiles)return {mode,result:'NO_OP',businesses:plans.length,changed_paths:[]};
 else {
 const manifest=Buffer.from(JSON.stringify({schema:'cumbuco-qualification-v1',fingerprint,selection_status:selectionStatus,publication_status:'HOLD',businesses:plans,files},null,2)+'\n');
 pending.push([manifestRel,manifest]);
 const oldHashes=new Map(prior?.hashes??[]);if(prior)oldHashes.set(manifestRel,prior.manifestHash);
 const replacements=pending.filter(([path,data])=>oldHashes.get(path)!==hash(data));
 const changed=plans.map(r=>({business_id:r.id,selected_run:r.selected_run,source_sha256:r.source_sha256,previous_disposition:r.previous_disposition??'UNKNOWN',current_disposition:r.report_disposition,changed_paths:r.artifact_paths.filter(p=>replacements.some(([path])=>path===p)),reason:r.reason}));
 const plan={mode,result:mode==='--dry-run'?'PLAN':'APPLY',businesses:plans.length,changed_paths:replacements.map(([p])=>p),retired_paths:retiredPaths,per_business:changed};
 if(mode==='--apply'){
  const lockPath=abs('scraped/.cumbuco-publish.lock');await checkParent(lockPath);
  const lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  let result,primary;try {
   if(await preflight()!==preflightText)throw Error('campaign_changed_before_publication');
   const current=await existing();
   if((current?.manifestHash??null)!==(prior?.manifestHash??null))throw Error('manifest_changed_before_publication');
   // Manifest readback inside publishCumbucoReplacements is the commit boundary. A crash can leave this exclusive lock and a partial fixed-path publication; manual recovery must compare current files with manifest hashes and verified backups.
   const backupFiles=await publishCumbucoReplacements(root,replacements,oldHashes,manifestPath,{retirePaths:retiredPaths,operations:filesystemOperations});const backups=backupFiles.map(p=>relative(root,p));
   const published=JSON.parse(await readSafe(manifestPath));if(published.publication_status!=='HOLD'||published.businesses.length!==plans.length)throw Error('manifest_readback_failed');
   result={result:'PUBLISHED_HOLD',files:replacements.length,backups,retired_paths:retiredPaths};
  }catch(e){primary=e;}const cleanup=[];try{await lock.close();}catch(e){cleanup.push(e);}try{await unlink(lockPath);}catch(e){if(e.code!=='ENOENT')cleanup.push(e);}if(primary&&cleanup.length)throw new AggregateError([primary,...cleanup],`publication_and_lock_cleanup_failed: ${primary.message}; ${cleanup.map(e=>e.message).join('; ')}`);if(primary)throw primary;if(cleanup.length)throw new AggregateError(cleanup,`lock_cleanup_failed: ${cleanup.map(e=>e.message).join('; ')}`);return result;
 }
 return plan;
 }
} catch(error) {workflowFailure=error;throw error;} finally {try{await rm(temp,{recursive:true,force:true});}catch(cleanup){if(workflowFailure)throw new AggregateError([workflowFailure,cleanup],`publication_and_temp_cleanup_failed: ${workflowFailure.message}; ${cleanup.message}`);throw cleanup;}}
}

const root = '/home/box/spora-worktrees/brazil-cumbuco';
const source = '/home/box/spora-worktrees/packages/seo-outreach';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!['--dry-run','--apply'].includes(process.argv[2]) || process.argv.length !== 3) throw Error('usage: node scripts/cumbuco-publish.mjs --dry-run|--apply');
  const mode = process.argv[2];
  if (await realpath(root) !== root || await realpath(source) !== source) throw Error('unexpected_workspace');
  console.log(JSON.stringify(await runCumbucoPublisher({ root, source, mode })));
}
