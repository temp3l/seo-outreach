import {resolve,join,dirname,basename,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeAudit,readBounded,type Normalized} from './evidence.js';
import {unpackEvidenceArchive,attachArchiveCoverage} from './archive.js';
import {qualifiedDigest,validateSelection,auditReviewFindings,type Decision,type Finding,type Locale} from './decision.js';
import {buildDigest} from './digest.js';
import {validateRecordedOutput,estimateRequest,type ProviderConfig} from './provider.js';
import {dispatchAuthorized,liveSettingsFingerprint,LIVE_PROMPT_VERSION,LIVE_SCHEMA_VERSION} from './live.js';
import {buildDrafts,validateSellerIdentity} from './drafts.js';
import {renderCustomerPdf,type CustomerPdfInput} from './pdf.js';
import {verifyRenderedPdf} from './pdf-verification.js';
import {buildReportPdfInput,buildCustomerReportPdfInput} from './report.js';
import {customerReviewTemplate,validateCustomerReview} from './customer-review.js';
import {loadCrmSnapshot,buildCrmSnapshotFromState} from './crm-session.js';
import type {ProspectInput,CRMState} from './crm.js';
import {publishArtifacts,readPublishedArtifact,assertSafeOutputTarget} from './files.js';

export type LiveOptions={paidCallOptIn:true;configPath:string;statePath:string;batchId:string};
export type AnalyzeOptions={input:string;out:string;locale:Locale;recorded?:string;sellerName?:string;sellerLocation?:string;crmExisting?:string;crmPublishedDir?:string;expectedInputSha256?:string;providerPreview?:string;live?:LiveOptions;dryRun:boolean};
export type RenderOptions={analysis:string;out:string;dryRun:boolean;customerReview?:string};
export type BatchOptions={manifest:string;out:string;locale:Locale;crmExisting?:string;providerPreview?:string;live?:LiveOptions;dryRun:boolean};
type Source={bytes:Buffer;evidence:Normalized;pages:unknown[];format:'JSON'|'ZIP';verification:string};
type Replay={schema:'seo-outreach-analysis-v1'|'seo-outreach-analysis-v2';inputPath:string;inputSha256:string;locale:Locale;selectedIssueIds:string[];seller:{name:string;location:string}|null;source:'OFFLINE_TEMPLATE'|'RECORDED'|'LIVE'|'CACHE';status:'INTERNAL_HOLD'};
const names=['source.json','source.zip','analysis.json','manifest.json','report.pdf','customer-report.pdf','customer-review.json','whatsapp-opener.txt','whatsapp-after-interest.txt','sales-brief.md','prospects.json','prospects.csv'];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
type ReviewedReport=ReturnType<typeof validateCustomerReview>&{analysisSha256:string;reportPdfSha256:string};
const encode=(v:string)=>Buffer.from(v,'utf8');
const json=(v:unknown)=>encode(JSON.stringify(v,null,2)+'\n');
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
async function parseJson(path:string):Promise<unknown>{const bytes=await readBounded(path);try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Error('invalid_json');}}
async function source(path:string):Promise<Source>{
 const bytes=await readBounded(path);
 if(bytes.length>=4 && bytes.readUInt32LE(0)===0x04034b50){const a=unpackEvidenceArchive(bytes);const evidence=normalizeAudit(a.audit,a.fingerprint);evidence.format='webcrawl-evidence-zip-1';if(!isObject(a.audit)||a.manifest.target!==a.audit.target)throw new Error('archive_target_mismatch');attachArchiveCoverage(evidence,a.manifest,a.pages.length);return {bytes,evidence,pages:a.pages,format:'ZIP',verification:'STRUCTURAL_ONLY'};}
 let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('invalid_json');}
 return {bytes,evidence:normalizeAudit(value,createHash('sha256').update(bytes).digest('hex')),pages:[],format:'JSON',verification:'AUDIT_ONLY'};
}
function pickIds(d:ReturnType<typeof qualifiedDigest>):string[]{
 const seen=new Set<string>();const ids:string[]=[];
 const preferred=['missing_meta_description','missing_title','missing_h1','images_missing_dimensions','image_alt_missing_or_empty','missing_canonical','noindex','malformed_json_ld'];
 const ordered=[...d.issues].sort((a,b)=>(preferred.indexOf(a.code)<0?99:preferred.indexOf(a.code))-(preferred.indexOf(b.code)<0?99:preferred.indexOf(b.code)));
 for(const issue of ordered){if(seen.has(issue.code))continue;seen.add(issue.code);ids.push(issue.id);if(ids.length===6)break;}
 return ids;
}
function summary(x:Source,findings:Finding[],pdf:boolean,providerStatus:string){
 return {SOFTWARE_READY:{status:'READY',reason:'supported_local_generation_route'},CRAWL_READY:{status:x.evidence.crawl.captured?'PARTIAL':'HOLD',reason:'captured_scope_only'},EVIDENCE_READY:{status:findings.length?'PARTIAL':'HOLD',reason:x.verification},CUSTOMER_READY:{status:'HOLD',reason:pdf?'internal_review_pdf_only':'six_distinct_verified_findings_required'},OUTREACH_READY:{status:'HOLD',reason:'recipient_channel_consent_suppression_and_operator_approval_not_established'},LIVE:{status:['COMPLETED','CACHED'].includes(providerStatus)?'READY':'HOLD',reason:providerStatus==='COMPLETED'?'provider_response_completed_and_validated':providerStatus==='CACHED'?'validated_completed_receipt_zero_new_dispatches':'no_completed_provider_receipt_in_this_run'}};
}
async function liveConfig(path:string,preview=false):Promise<{config:ProviderConfig;retry:{maxAttempts:number;overallDeadlineMs:number;maxRetryAfterMs:number}}> {
 const v=await parseJson(path);const fields=['model','timeoutMs','maxInputTokens','maxOutputTokens','inputUsdPerMillionTokens','outputUsdPerMillionTokens','companyRequestCap','companyTokenCap','companyUsdCap','batchRequestCap','batchTokenCap','batchUsdCap','pricingConfirmedAt','pricingSource','maxAttempts','overallDeadlineMs','maxRetryAfterMs'];
 if(!isObject(v)||Object.keys(v).length!==fields.length||fields.some(k=>!Object.hasOwn(v,k)))throw new Error('invalid_provider_configuration');
 const confirmed=typeof v.pricingConfirmedAt==='string'?Date.parse(v.pricingConfirmedAt):NaN;
 if(!Number.isFinite(confirmed)||confirmed>Date.now()||Date.now()-confirmed>7*86400000||v.pricingSource!=='https://developers.openai.com/api/docs/pricing')throw new Error('current_operator_pricing_confirmation_required');
 const apiKey=preview?'PREVIEW_ONLY':process.env.OPENAI_API_KEY;if(!apiKey)throw new Error('provider_credential_missing');
 if(typeof v.model!=='string'||!v.model.trim())throw new Error('invalid_provider_model');
 for(const k of ['timeoutMs','maxInputTokens','maxOutputTokens','inputUsdPerMillionTokens','outputUsdPerMillionTokens','companyRequestCap','companyTokenCap','companyUsdCap','batchRequestCap','batchTokenCap','batchUsdCap','maxAttempts','overallDeadlineMs','maxRetryAfterMs'])if(typeof v[k]!=='number'||!Number.isFinite(v[k]))throw new Error('invalid_provider_number');
 const config:ProviderConfig={apiKey,endpoint:'https://api.openai.com/v1/responses',model:v.model,timeoutMs:v.timeoutMs as number,maxInputTokens:v.maxInputTokens as number,maxOutputTokens:v.maxOutputTokens as number,inputUsdPerMillionTokens:v.inputUsdPerMillionTokens as number,outputUsdPerMillionTokens:v.outputUsdPerMillionTokens as number,companyRequestCap:v.companyRequestCap as number,companyTokenCap:v.companyTokenCap as number,companyUsdCap:v.companyUsdCap as number,batchRequestCap:v.batchRequestCap as number,batchTokenCap:v.batchTokenCap as number,batchUsdCap:v.batchUsdCap as number};
 const retry={maxAttempts:v.maxAttempts as number,overallDeadlineMs:v.overallDeadlineMs as number,maxRetryAfterMs:v.maxRetryAfterMs as number};
 if(!Number.isSafeInteger(retry.overallDeadlineMs)||retry.overallDeadlineMs<1||retry.overallDeadlineMs>300000)throw new Error('invalid_overall_deadline');
 return {config,retry};
}
function prospectInput(e:Normalized,fingerprint:string,issueCount:number,issueCodes:string[]):ProspectInput{
 return {companyKey:e.hostname,branchKey:e.targetIdentity,companyName:e.hostname,website:new URL(e.target).origin+'/',status:'HOLD',evidenceFingerprint:fingerprint,issueCount,issueCodes};
}
function preflightProspectCapacity(base:CRMState,incoming:ProspectInput[]):void{
 try{buildCrmSnapshotFromState(base,incoming);}catch{throw new Error('prospect_capacity_exceeded');}
}
async function prepare(options:AnalyzeOptions,replay?:Replay,existingCrm?:CRMState){
 const seller=validateSellerIdentity(options.sellerName,options.sellerLocation);
 let crmBase:CRMState;try{crmBase=existingCrm??await loadCrmSnapshot(options.crmPublishedDir,{existingJsonPath:options.crmExisting});}catch{throw new Error('invalid_crm_snapshot');}
 const inputPath=resolve(options.input);const x=await source(inputPath);const evidence=x.evidence;
 if((replay && replay.inputSha256!==evidence.inputSha256)||(options.expectedInputSha256 && options.expectedInputSha256!==evidence.inputSha256))throw new Error('source_fingerprint_changed');
 const d=x.format==='ZIP'?qualifiedDigest(evidence,x.pages):buildDigest(evidence);
 // Reserve enough local snapshot capacity for any allowed six-issue selection.
 const crmPreview=prospectInput(evidence,d.materialFingerprint,6,[...new Set(d.issues.map(i=>i.code))]);
 preflightProspectCapacity(crmBase,[crmPreview]);
 let ids:string[]=[];let sourceType:'OFFLINE_TEMPLATE'|'RECORDED'|'LIVE'|'CACHE'='OFFLINE_TEMPLATE';
 let provider:{status:string;dispatches:number;cost:unknown;costBasis?:string;reason?:string;predicted?:unknown}={status:'NOT_SENT',dispatches:0,cost:'UNKNOWN',reason:'offline_no_paid_dispatch'};
 if(options.dryRun&&options.providerPreview){try{const c=(await liveConfig(options.providerPreview,true)).config;const estimate=estimateRequest(d,c,options.locale);provider={status:'NOT_SENT',dispatches:0,cost:'UNKNOWN',reason:'dry_run_no_dispatch',predicted:{requestTokens:estimate.requestTokens,maxCostUsd:estimate.maxCostUsd,company:{requests:c.companyRequestCap,tokens:c.companyTokenCap,usd:c.companyUsdCap},batch:{requests:c.batchRequestCap,tokens:c.batchTokenCap,usd:c.batchUsdCap}}};}catch{provider.reason='invalid_preview_configuration_or_insufficient_evidence';}}
 if(replay){ids=replay.selectedIssueIds;sourceType=replay.source;}
 else if(options.recorded){
  const record=await parseJson(options.recorded);
  const checked=validateRecordedOutput(record,d,options.locale);if(!checked.ok)throw new Error('recorded_output_invalid');
  // Independent selection validation below is authoritative. Unchecked model prose is never rendered.
  ids=checked.output.selectedIssueIds;sourceType='RECORDED';
 }else if(options.live && !options.dryRun){
  if(x.format!=='ZIP'||d.readiness!=='REVIEW_REQUIRED')provider.reason='insufficient_corroborated_evidence';
  else {
   await assertSafeOutputTarget(options.out);
   const statePath=resolve(options.live.statePath),outPath=resolve(options.out);
   if(statePath===inputPath || statePath===resolve(options.live.configPath) || statePath===outPath || statePath.startsWith(outPath+sep))throw new Error('unsafe_state_path');
   let cfg:Awaited<ReturnType<typeof liveConfig>>|undefined;try{cfg=await liveConfig(options.live.configPath);}catch{provider.reason='missing_or_invalid_provider_authority_or_pricing';}
   if(cfg){
    const c=cfg.config;const caps={currency:'USD',company:{requests:c.companyRequestCap,tokens:c.companyTokenCap,money:c.companyUsdCap},batch:{requests:c.batchRequestCap,tokens:c.batchTokenCap,money:c.batchUsdCap}};
    const identity={company:evidence.hostname,branch:evidence.targetIdentity,evidenceFingerprint:d.materialFingerprint,locale:options.locale,model:c.model,settingsFingerprint:liveSettingsFingerprint(c),promptVersion:LIVE_PROMPT_VERSION,schemaVersion:LIVE_SCHEMA_VERSION};
    const outcome=await dispatchAuthorized({digest:d,locale:options.locale,config:c,identity,batchId:options.live.batchId,caps,statePath:options.live.statePath,paidCallOptIn:options.live.paidCallOptIn,retry:{maxAttempts:cfg.retry.maxAttempts,deadlineAtMs:Date.now()+cfg.retry.overallDeadlineMs,maxRetryAfterMs:cfg.retry.maxRetryAfterMs}});
    provider={status:outcome.status,dispatches:outcome.attempts??0,cost:outcome.status==='COMPLETED'||outcome.status==='CACHED'?outcome.cost:'UNKNOWN',costBasis:outcome.status==='COMPLETED'||outcome.status==='CACHED' ? ('amount' in outcome.cost ? 'ESTIMATED_STANDARD_TOKEN_RATES_NOT_INVOICE' : 'UNKNOWN') : 'UNKNOWN',...('reason' in outcome?{reason:outcome.reason}:{})};
    if(outcome.status==='COMPLETED'||outcome.status==='CACHED'){ids=outcome.output.selectedIssueIds;sourceType=outcome.status==='CACHED'?'CACHE':'LIVE';}
   }
  }
 }else if(x.format==='ZIP')ids=pickIds(d);
 if(x.format==='ZIP' && ids.length===0 && !replay && !options.recorded && provider.status!=='COMPLETED' && provider.status!=='CACHED')ids=pickIds(d);
 let decision:Decision|undefined;let findings:Finding[]=[];
 if(x.format==='ZIP'){decision=validateSelection(evidence,x.pages,ids,options.locale);findings=decision.findings;}
 else {if(ids.length)throw new Error('audit_json_has_no_page_corroboration');findings=auditReviewFindings(evidence,options.locale);}
 const reportPossible=!!decision&&findings.length===6;
 const gates=summary(x,findings,reportPossible,provider.status);
 const dry={inputFormat:x.format,inputSha256:evidence.inputSha256,hostname:evidence.hostname,digest:d,findings:findings.length,provider,gates};
 return {inputPath,x,d,ids,sourceType,seller,crmBase,crmPreview,decision,findings,reportPossible,gates,dry,provider};
}
async function publish(options:AnalyzeOptions,prepared:Awaited<ReturnType<typeof prepare>>,review?:ReviewedReport){
 const p=prepared;const {evidence}=p.x;
 const inputSnapshot=p.x.format==='ZIP'?'source.zip':'source.json';
 const replay:Replay={schema:'seo-outreach-analysis-v2',inputPath:inputSnapshot,inputSha256:evidence.inputSha256,locale:options.locale,selectedIssueIds:p.ids,seller:p.seller,source:p.sourceType,status:'INTERNAL_HOLD'};
 const artifacts:Record<string,Uint8Array>={'analysis.json':json(replay),[inputSnapshot]:p.x.bytes};
 let pdfInput:CustomerPdfInput|undefined;let pdfVerification:ReturnType<typeof verifyRenderedPdf>|undefined;
 if(p.reportPossible&&p.decision){pdfInput=buildReportPdfInput(p.decision);artifacts['report.pdf']=renderCustomerPdf(pdfInput);pdfVerification=verifyRenderedPdf(pdfInput,artifacts['report.pdf']);}
 let customerPdfInput:CustomerPdfInput|undefined;let customerPdfVerification:ReturnType<typeof verifyRenderedPdf>|undefined;
 if(pdfVerification){
  const context={company:evidence.hostname,analysisSha256:hash(artifacts['analysis.json']!),reportPdfSha256:pdfVerification.sha256,findings:p.findings};
  // A review template is private and unapproved. Opaque references cannot be approved for customer use.
  if(p.findings.every(f=>/^https?:\/\//.test(f.reference)))artifacts['customer-review.json']=json(customerReviewTemplate(context));
  if(review){
   if(context.analysisSha256!==review.analysisSha256||context.reportPdfSha256!==review.reportPdfSha256||!p.decision)throw new Error('customer_review_mismatch');
   customerPdfInput=buildCustomerReportPdfInput(p.decision);artifacts['customer-report.pdf']=renderCustomerPdf(customerPdfInput);customerPdfVerification=verifyRenderedPdf(customerPdfInput,artifacts['customer-report.pdf']);
  }
 }else if(review)throw new Error('customer_review_invalid');
 const gates={...p.gates,CUSTOMER_READY:customerPdfVerification&&review?{status:'READY',reason:'six_corroborated_findings_explicitly_reviewed_and_customer_artifact_verified'}:p.gates.CUSTOMER_READY};
 const status=customerPdfVerification?'CUSTOMER_REPORT_READY_OUTREACH_HOLD':'INTERNAL_HOLD';
 const draftFinding=p.findings.find(f=>f.code!=='noindex' && /^https?:\/\//.test(f.reference));
 if(draftFinding){const f=draftFinding;const draft=buildDrafts({company:evidence.hostname,locale:options.locale,seller:p.seller,reportAvailable:!!customerPdfVerification,finding:{code:f.code,observed:f.observed,reference:f.reference,implication:f.implication,fix:f.fix}});
  artifacts['whatsapp-opener.txt']=encode('INTERNAL / HOLD — DO NOT SEND WITHOUT RECIPIENT AND CHANNEL REVIEW\n\n'+draft.opener+'\n');
  artifacts['whatsapp-after-interest.txt']=encode('INTERNAL / HOLD — DO NOT SEND WITHOUT RECIPIENT AND CHANNEL REVIEW\n\n'+draft.afterInterest+'\n');
 }
 const reviewCodes=[...new Set(evidence.groups.filter(g=>g.category==='indexability'||g.category==='security').map(g=>g.code))].sort();
 const brief=['# Internal sales brief — HOLD',`Site: ${evidence.hostname}`,`Captured pages: ${evidence.crawl.captured}; failed: ${evidence.crawl.failed}; skipped: ${evidence.crawl.skipped}; unattempted: ${evidence.crawl.unattempted}; robots retrieval: ${evidence.robots}.`,`Evidence source: ${p.x.verification}. Site-wide coverage and recipient eligibility are not established.`,`Additional indexability/security check codes for review: ${reviewCodes.slice(0,30).join(', ')||'none retained'}${reviewCodes.length>30?` (and ${reviewCodes.length-30} more)`:''}. These are observations, not confirmed vulnerabilities.`,`Contact inventory: ${evidence.contacts.status}; ${evidence.contacts.candidates.length} candidate(s) retained; ${evidence.contacts.candidatesOmitted+(evidence.contacts.coverage.omittedCandidates??0)} known omissions or invalid candidates; additional omissions may be unknown. Ownership and outreach eligibility remain unverified.`,...p.findings.map(f=>`- ${f.code}: ${f.observed} Source: ${f.reference}`),p.provider.dispatches===0?'No provider call or message was sent.':'No message was sent; provider usage is recorded separately.'].join('\n\n');
 artifacts['sales-brief.md']=encode(brief+'\n');
 const crm=buildCrmSnapshotFromState(p.crmBase,[prospectInput(evidence,p.d.materialFingerprint,p.findings.length,p.findings.map(f=>f.code))]);
 artifacts['prospects.json']=crm.json;artifacts['prospects.csv']=crm.csv;
 artifacts['manifest.json']=json({schema:'seo-outreach-manifest-v1',status,source:p.x.format,sourceSha256:evidence.inputSha256,exportCoverage:evidence.exportCoverage??{status:'UNKNOWN',reason:'audit_only_no_page_export'},checkCoverage:evidence.checkCoverage,decisionSource:p.sourceType,readiness:gates,pdfVerification:pdfVerification??null,customerPdfVerification:customerPdfVerification??null,customerReview:review??null,artifacts:[...Object.keys(artifacts),'manifest.json'].sort(),spend:p.provider});
 const publication=await publishArtifacts(resolve(options.out),artifacts,{allowedNames:names,maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
 // Verify the exact published bytes of each report before reporting success.
 if(artifacts['report.pdf']){const actual=await readPublishedArtifact(publication.directory,'report.pdf',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});const expected=Buffer.from(artifacts['report.pdf']);if(!actual.equals(expected)||!pdfInput)throw new Error('report_readback_failed');const verified=verifyRenderedPdf(pdfInput,actual);if(verified.sha256!==pdfVerification?.sha256)throw new Error('report_readback_failed');}
 if(artifacts['customer-report.pdf']){const actual=await readPublishedArtifact(publication.directory,'customer-report.pdf',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});if(!customerPdfInput||!actual.equals(Buffer.from(artifacts['customer-report.pdf'])))throw new Error('report_readback_failed');const verified=verifyRenderedPdf(customerPdfInput,actual);if(verified.sha256!==customerPdfVerification?.sha256)throw new Error('report_readback_failed');}
 return {status,directory:publication.directory,files:publication.files,gates,provider:p.provider};
}
export async function analyze(options:AnalyzeOptions):Promise<unknown>{
 if(options.live&&options.recorded)throw new Error('live_and_recorded_mutually_exclusive');
 const p=await prepare(options);return options.dryRun?p.dry:publish(options,p);
}
export async function render(options:RenderOptions):Promise<unknown>{
 if(basename(options.analysis)!=='analysis.json')throw new Error('unpublished_or_corrupt_analysis');
 const analysisBytes=await readPublishedArtifact(dirname(resolve(options.analysis)),'analysis.json',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
 let raw:unknown;try{raw=JSON.parse(analysisBytes.toString('utf8'));}catch{throw new Error('invalid_analysis');}
 if(!isObject(raw)||!['seo-outreach-analysis-v1','seo-outreach-analysis-v2'].includes(String(raw.schema))||typeof raw.inputPath!=='string'||typeof raw.inputSha256!=='string'||!Array.isArray(raw.selectedIssueIds)||!['en','es','de','pt-BR'].includes(String(raw.locale))||!['OFFLINE_TEMPLATE','RECORDED','LIVE','CACHE'].includes(String(raw.source))||raw.status!=='INTERNAL_HOLD'||!(raw.seller===null||isObject(raw.seller)&&typeof raw.seller.name==='string'&&typeof raw.seller.location==='string'))throw new Error('invalid_analysis');
 const replay=raw as Replay;
 if(replay.schema==='seo-outreach-analysis-v2'&&!['source.json','source.zip'].includes(replay.inputPath))throw new Error('invalid_analysis');
 const opts:AnalyzeOptions={input:replay.schema==='seo-outreach-analysis-v2'?join(dirname(resolve(options.analysis)),replay.inputPath):replay.inputPath,out:options.out,locale:replay.locale,sellerName:replay.seller?.name,sellerLocation:replay.seller?.location,crmPublishedDir:dirname(resolve(options.analysis)),dryRun:options.dryRun};
 const p=await prepare(opts,replay);
 let review:ReviewedReport|undefined;
 if(options.customerReview){
  if(!p.decision||!p.reportPossible)throw new Error('customer_review_invalid');
  const publishedPdf=await readPublishedArtifact(dirname(resolve(options.analysis)),'report.pdf',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
  const expectedInput=buildReportPdfInput(p.decision),regeneratedPdf=renderCustomerPdf(expectedInput);
  verifyRenderedPdf(expectedInput,publishedPdf);
  if(!publishedPdf.equals(regeneratedPdf))throw new Error('customer_review_mismatch');
  const context={company:p.x.evidence.hostname,analysisSha256:hash(analysisBytes),reportPdfSha256:hash(publishedPdf),findings:p.findings};
  const receipt=validateCustomerReview(await readBounded(options.customerReview),context);
  review={...receipt,analysisSha256:context.analysisSha256,reportPdfSha256:context.reportPdfSha256};
 }
 if(options.dryRun)return review?{...p.dry,customerReview:review,gates:{...p.gates,CUSTOMER_READY:{status:'HOLD',reason:'approved_review_requires_customer_artifact_verification'}}}:p.dry;
 return publish(opts,p,review);
}
export async function batch(options:BatchOptions):Promise<unknown>{
 let crmBase:CRMState;try{crmBase=await loadCrmSnapshot(undefined,{existingJsonPath:options.crmExisting});}catch{throw new Error('invalid_crm_snapshot');}
 const raw=await parseJson(options.manifest);
 if(!isObject(raw)||!Array.isArray(raw.inputs)||raw.inputs.length<1||raw.inputs.length>1000||raw.inputs.some(v=>typeof v!=='string'||!v))throw new Error('invalid_batch_manifest');
 const crmPreviews:ProspectInput[]=[];
 const entries:{input:string;target:string;fingerprint:string}[]=[];const seen=new Map<string,string>();let duplicates=0;
 for(const item of raw.inputs as string[]){
  const input=resolve(dirname(resolve(options.manifest)),item);
  const p=await prepare({input,out:options.out,locale:options.locale,providerPreview:options.providerPreview,dryRun:true},undefined,crmBase);const key=p.x.evidence.targetIdentity, prior=seen.get(key);
  if(prior){if(prior!==p.x.evidence.inputSha256)throw new Error('conflicting_inputs_for_company');duplicates++;continue;}
  seen.set(key,p.x.evidence.inputSha256);crmPreviews.push(p.crmPreview);entries.push({input,target:key,fingerprint:p.x.evidence.inputSha256});
 }
 preflightProspectCapacity(crmBase,crmPreviews);
 if(!options.dryRun){
  for(const entry of entries)await assertSafeOutputTarget(join(options.out,entry.target.slice(0,24)));
  await assertSafeOutputTarget(join(options.out,'crm'));
  if(options.live){const cfg=await liveConfig(options.live.configPath).catch(()=>undefined);if(!cfg)throw new Error('missing_or_invalid_provider_authority_or_pricing');}
 }
 const results:unknown[]=[];const crmInputs:ProspectInput[]=[];
 for(const entry of entries){
  const output=join(options.out,entry.target.slice(0,24));
  const p=await prepare({input:entry.input,out:output,locale:options.locale,live:options.live,providerPreview:options.providerPreview,expectedInputSha256:entry.fingerprint,dryRun:options.dryRun},undefined,crmBase);
  if(p.x.evidence.inputSha256!==entry.fingerprint || p.x.evidence.targetIdentity!==entry.target)throw new Error('source_changed_after_batch_preflight');
  if(options.dryRun)results.push(p.dry);else {
   results.push(await publish({input:entry.input,out:output,locale:options.locale,crmExisting:options.crmExisting,live:options.live,dryRun:false},p));
   const e=p.x.evidence;crmInputs.push({companyKey:e.hostname,branchKey:e.targetIdentity,companyName:e.hostname,website:new URL(e.target).origin+'/',status:'HOLD',evidenceFingerprint:p.d.materialFingerprint,issueCount:p.findings.length,issueCodes:p.findings.map(f=>f.code)});
  }
 }
 let crmDirectory:string|undefined;
 if(!options.dryRun){const snapshot=buildCrmSnapshotFromState(crmBase,crmInputs);const published=await publishArtifacts(join(options.out,'crm'),{'prospects.json':snapshot.json,'prospects.csv':snapshot.csv},{allowedNames:['prospects.json','prospects.csv']});crmDirectory=published.directory;}
 return {count:results.length,duplicates,results,...(crmDirectory?{crmDirectory}:{})};
}
