#!/usr/bin/env node
// Offline presentation only: saved audit -> clean private PDFs + HOLD manifest.
import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { renderCustomerSummaryHtml } from '../../dist/reports/summary.js';
import { renderMobileCustomerPdf } from '../../dist/reports/mobile.js';
import { withPlaywrightPdfSession } from '../../dist/reports/pdf-playwright.js';
import { readReportContactFile } from '../../dist/reports/report-contact.js';
import { createCustomerReviewManifest } from '../../dist/reports/review.js';
import { observationScope } from '../../dist/reports/observation-scope.js';
import { customerPriorityProjection } from '../../dist/reports/customer.js';
import { withSavedMobileLabEvidence, mobileLcpEvidence } from '../../dist/reports/performance-evidence.js';
import { withCustomerEvidence } from '../../dist/reports/customer-evidence.js';
import { auditResultSha256 } from '../../dist/reports/qualification.js';
import { sanitizeEvidenceUrl } from '@spora/webcrawl/analysis/page-data';
import { verifyReportDesign } from '../check-report-design.mjs';
import { CUSTOMER_REPORT_FRESHNESS_MS } from '../../dist/reports/freshness.js';

function validatePsiChain(journal, terminal, manifestHash, manifest, site, audit) {
  const chain = journal.attempts.filter(e => e && e.dispatchId === terminal.dispatchId);
  const keys = ['runId','siteId','dispatchId','captureManifestSha256','sourceCaptureSha256','auditSha256','requestedUrl','strategy'];
  const siteAttempts = new Set(journal.attempts.filter(e => e?.runId === terminal.runId && e.siteId === terminal.siteId).map(e => e.dispatchId));
  if (siteAttempts.size !== 1 || chain.length !== 3 || chain.map(e => e.state).join(',') !== `reserved,dispatched,${terminal.state}`
    || chain.some(e => keys.some(k => e[k] !== terminal[k]) || e.result !== e.state || JSON.stringify(e.categories) !== JSON.stringify(terminal.categories))
    || JSON.stringify(terminal.categories) !== JSON.stringify(['performance','accessibility','best-practices','seo'])
    || terminal.captureCompletedAt !== undefined && terminal.captureCompletedAt !== audit.completedAt
    || terminal.runId !== manifest.runId || terminal.siteId !== site.siteId || terminal.captureManifestSha256 !== manifestHash
    || terminal.sourceCaptureSha256 !== site.sourceCaptureSha256 || terminal.auditSha256 !== auditResultSha256(audit)
    || terminal.requestedUrl !== audit.target || terminal.strategy !== 'mobile'
    || site.captureStartedAt !== audit.startedAt || site.captureCompletedAt !== audit.completedAt
    || !Number.isFinite(Date.parse(chain[0].at)) || !Number.isFinite(Date.parse(chain[1].at)) || !Number.isFinite(Date.parse(chain[2].at))
    || Date.parse(chain[0].at) > Date.parse(chain[1].at) || Date.parse(chain[1].at) > Date.parse(chain[2].at)
    || chain[1].requestedAt !== chain[1].at || terminal.requestedAt !== chain[1].requestedAt || (terminal.state === 'completed' && terminal.completedAt !== terminal.at) || (terminal.state !== 'completed' && terminal.completedAt !== undefined && terminal.completedAt !== terminal.at)
    || Date.parse(terminal.requestedAt) < Date.parse(audit.completedAt) || Date.parse(terminal.requestedAt)-Date.parse(audit.startedAt) >= CUSTOMER_REPORT_FRESHNESS_MS)
    throw Error('psi_attempt_journal_ambiguous');
}


async function prepare(args) {
  await verifyReportDesign();
  const values = new Map(); const allowed = ['--audit','--report-contact-file','--out','--pdf-locale','--page-data'];
  allowed.push('--psi-response','--psi-association','--psi-journal','--capture-manifest');
  for (let i=0;i<args.length;i++) {
    const key=args[i]; if (!allowed.includes(key)||values.has(key)||!args[i+1]||args[i+1].startsWith('--')) throw Error('invalid_options');
    values.set(key,args[++i]);
  }
  for (const key of allowed.slice(0,3)) if (!values.has(key)||!isAbsolute(values.get(key))) throw Error('absolute_paths_required');
  const locale=values.get('--pdf-locale')??'en'; if(!['en','de'].includes(locale))throw Error('invalid_pdf_locale');
  const auditPath=resolve(values.get('--audit')),prefix=resolve(values.get('--out'));
  const parent=dirname(prefix);if(await realpath(parent)!==parent)throw Error('unsafe_output_parent');
  const dir=await lstat(parent);if(!dir.isDirectory()||dir.uid!==process.getuid()||(dir.mode&0o077))throw Error('unsafe_private_output_directory');
  const paths=[`${prefix}.pdf`,`${prefix}.mobile.pdf`,`${prefix}.html`,`${prefix}.review.json`];
  for(const path of paths){try{await lstat(path);throw Error('output_collision');}catch(e){if(e.code!=='ENOENT')throw e;}}
  const file=await open(auditPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes;
  try{const s=await file.stat();if(!s.isFile()||s.size>200_000_000)throw Error('unsafe_audit_input');bytes=await file.readFile();}finally{await file.close();}
  let audit=JSON.parse(bytes);if(!isAuditResultRecord(audit))throw Error('audit_schema_invalid');
  if (values.has('--page-data')) {
    const input = values.get('--page-data'); if (!isAbsolute(input)) throw Error('absolute_paths_required');
    const file = await open(resolve(input),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let source; try { const s=await file.stat(); if (!s.isFile() || s.size>200_000_000) throw Error('unsafe_page_data_input'); source=await file.readFile(); } finally { await file.close(); }
    const raw=source[0]===0x1f && source[1]===0x8b ? gunzipSync(source,{maxOutputLength:200_000_000}) : source;
    const data=JSON.parse(raw);
    if (!data || data.schemaVersion!=='1' || !Array.isArray(data.pages) || data.pages.length>10000 || data.target!==sanitizeEvidenceUrl(audit.target) || data.auditSha256!==auditResultSha256(audit) || data.auditStartedAt!==audit.startedAt || data.auditCompletedAt!==audit.completedAt) throw Error('page_data_audit_mismatch');
    audit=withCustomerEvidence(audit,data,{path:resolve(input),sha256:createHash('sha256').update(source).digest('hex')});
  }
  if (values.has('--psi-journal') && !values.has('--psi-response') && !values.has('--psi-association')) {
    if (!values.has('--capture-manifest')) throw Error('psi_provenance_inputs_required_together');
    const safeRead=async key=>{const input=values.get(key);if(!isAbsolute(input))throw Error('absolute_paths_required');const file=await open(resolve(input),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const st=await file.stat();if(!st.isFile()||st.size>4_000_000)throw Error('unsafe_psi_provenance_input');return await file.readFile();}finally{await file.close();}};
    const [journalBytes,manifestBytes]=await Promise.all([safeRead('--psi-journal'),safeRead('--capture-manifest')]);
    const journal=JSON.parse(journalBytes),manifest=JSON.parse(manifestBytes),manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
    if(journal?.schema!=='psi-attempt-journal-v1'||!Array.isArray(journal.attempts)||!Array.isArray(manifest?.sites))throw Error('psi_attempt_journal_invalid');
    const sites=manifest.sites.filter(row=>row?.homepageUrl===audit.target && row.auditSha256===auditResultSha256(audit));
    if(sites.length!==1)throw Error('psi_capture_site_mismatch');
    const failed=journal.attempts.filter(event=>event?.runId===manifest.runId&&event.siteId===sites[0].siteId&&['failed','unknown'].includes(event.state));
    if(failed.length!==1)throw Error('psi_attempt_journal_ambiguous');
    validatePsiChain(journal,failed[0],manifestHash,manifest,sites[0],audit);
    // The journal remains operator evidence. Do not mutate the saved audit:
    // its original digest and the neutral unmeasured customer copy must survive readback.
  }
  if (values.has('--psi-response') || values.has('--psi-association') || values.has('--psi-journal') && (values.has('--psi-response') || values.has('--psi-association'))) {
    if (!values.has('--psi-response') || !values.has('--psi-association') || !values.has('--psi-journal') || !values.has('--capture-manifest')) throw Error('psi_provenance_inputs_required_together');
    const readPrivateJson = async (key, maxBytes) => { const input=values.get(key); if (!isAbsolute(input)) throw Error('absolute_paths_required'); const file=await open(resolve(input),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); try { const st=await file.stat(); if (!st.isFile()||st.size>maxBytes) throw Error('unsafe_psi_provenance_input'); const bytes=await file.readFile(); return {value:JSON.parse(bytes.toString('utf8')),bytes}; } finally { await file.close(); } };
    const input=values.get('--psi-response'); if (!isAbsolute(input)) throw Error('absolute_paths_required');
    const file=await open(resolve(input),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    let source; try { const st=await file.stat(); if (!st.isFile() || st.size>16_000_000) throw Error('unsafe_saved_psi_input'); source=await file.readFile(); } finally { await file.close(); }
    const associationFile=await readPrivateJson('--psi-association',64_000),journalFile=await readPrivateJson('--psi-journal',4_000_000),captureManifestFile=await readPrivateJson('--capture-manifest',4_000_000);
    const association=associationFile.value,journal=journalFile.value,captureManifest=captureManifestFile.value;
    if(!journal||journal.schema!=='psi-attempt-journal-v1'||!Array.isArray(journal.attempts))throw Error('psi_attempt_journal_invalid');
    const manifestBytes=captureManifestFile.bytes;
    const manifestHash=createHash('sha256').update(manifestBytes).digest('hex');
    if(!captureManifest||captureManifest.runId!==association.runId||manifestHash!==association.captureManifestSha256||!Array.isArray(captureManifest.sites))throw Error('psi_capture_manifest_mismatch');
    const site=captureManifest.sites.filter(row=>row&&row.siteId===association.siteId);
    if(site.length!==1||site[0].auditSha256!==association.auditSha256||site[0].sourceCaptureSha256!==association.sourceCaptureSha256||site[0].homepageUrl!==association.requestedUrl||site[0].captureCompletedAt!==association.captureCompletedAt||site[0].captureStartedAt!==audit.startedAt||site[0].captureCompletedAt!==audit.completedAt||!Number.isFinite(Date.parse(site[0].captureCompletedAt))||Date.parse(association.requestedAt)<Date.parse(site[0].captureCompletedAt)||association.auditSha256!==auditResultSha256(audit))throw Error('psi_capture_site_mismatch');
    const matches=journal.attempts.filter(event=>event&&event.dispatchId===association.dispatchId&&event.result==='completed'&&event.association);
    if(matches.length!==1||JSON.stringify(matches[0].association)!==JSON.stringify(association))throw Error('psi_attempt_journal_ambiguous');
    validatePsiChain(journal,matches[0],manifestHash,captureManifest,site[0],audit);
    if(matches[0].httpStatus!==200 || matches[0].finalUrl!==association.finalUrl || matches[0].responseSha256!==association.responseSha256 || matches[0].responseBytes!==source.length || matches[0].requestedAt!==association.requestedAt || matches[0].completedAt!==association.completedAt)throw Error('psi_attempt_journal_ambiguous');
    audit=withSavedMobileLabEvidence(audit,source,resolve(input),association,matches[0].association);
  }
  const issuer=await readReportContactFile(resolve(values.get('--report-contact-file')));
  const html=renderCustomerSummaryHtml(audit,locale,{issuer});
  const pdfs=await withPlaywrightPdfSession(async renderer=>({
    a4:await renderer(html),
    mobile:await renderMobileCustomerPdf(audit,renderer,issuer,locale,'HOLD'),
  }));
  const manifest={...createCustomerReviewManifest(audit,locale,[{role:'a4',path:paths[0],content:pdfs.a4},{role:'mobile',path:paths[1],content:pdfs.mobile}]),
    sourceAuditFileSha256:createHash('sha256').update(bytes).digest('hex'),sourceAuditPath:auditPath,
    mobileLabEvidence: mobileLcpEvidence(audit) ?? null,
    observationAccounting: { raw: observationScope(audit,audit.findings), admitted: observationScope(audit,customerPriorityProjection(audit,locale).countedFindings) },
    reviewRequired:['factual claims','layout','business identity','coverage','security'],
  };
  const payloads=[pdfs.a4,pdfs.mobile,Buffer.from(html),Buffer.from(`${JSON.stringify(manifest,null,2)}\n`)];
  // Manifest is last. A failed preparation never creates approval or send state.
  for(let i=0;i<paths.length;i++){
    await writeFile(paths[i],payloads[i],{mode:0o600,flag:'wx'});
    if(!(await readFile(paths[i])).equals(Buffer.from(payloads[i])))throw Error('review_readback_mismatch');
  }
  process.stdout.write(`${JSON.stringify({reportStatus:'HOLD',outboundApproval:false,manifest:paths[3],artifacts:manifest.artifacts})}\n`);
}
prepare(process.argv.slice(2)).catch(e=>{process.stderr.write(`prepare_review_failed: ${e.code??e.message}\n`);process.exitCode=1;});
