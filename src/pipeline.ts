import {fileURLToPath} from 'node:url';
import {readReportContactFile} from './reports/report-contact.js';
import {resolve,join,dirname,basename,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeAudit,readBounded,type Normalized} from './evidence.js';
import {unpackEvidenceArchive,attachArchiveCoverage} from './archive.js';
import {qualifiedDigest,validateSelection,auditReviewFindings,type Decision,type Finding,type Locale} from './decision.js';
import {buildDigest} from './digest.js';
import {validateRecordedOutput,estimateRequest,type ProviderConfig,type SalesOutput} from './provider.js';
import {dispatchAuthorized,liveSettingsFingerprint,LIVE_PROMPT_VERSION,LIVE_SCHEMA_VERSION} from './live.js';
import {contextForCompany,validateOutreachContext,reviewGeneratedDrafts,type OutreachContext} from './outreach.js';
import {buildDrafts,validateSellerIdentity,type SellerIdentity} from './drafts.js';
import {renderCustomerPdf,type CustomerPdfInput} from './pdf.js';
import {verifyRenderedPdf} from './pdf-verification.js';
import {buildReportPdfInput} from './report.js';
import {customerReviewTemplate} from './customer-review.js';
import {loadCrmSnapshot,buildCrmSnapshotFromState} from './crm-session.js';
import type {ProspectInput,CRMState} from './crm.js';
import {publishArtifacts,readPublishedArtifact,assertSafeOutputTarget} from './files.js';

export type LiveOptions={paidCallOptIn:true;configPath:string;statePath:string;batchId:string};
export type AnalyzeOptions={input:string;out:string;locale:Locale;recorded?:string;sellerName?:string;sellerLocation?:string;reportContactFile?:string;outreachContext?:string;crmExisting?:string;crmPublishedDir?:string;expectedInputSha256?:string;providerPreview?:string;live?:LiveOptions;dryRun:boolean};
export type RenderOptions={analysis:string;out:string;dryRun:boolean;customerReview?:string};
export type BatchOptions={sellerName?:string;sellerLocation?:string;reportContactFile?:string;outreachContext?:string;manifest:string;out:string;locale:Locale;crmExisting?:string;providerPreview?:string;live?:LiveOptions;dryRun:boolean};
type Source={bytes:Buffer;evidence:Normalized;pages:unknown[];format:'JSON'|'ZIP';verification:string};
type Replay={schema:'seo-outreach-analysis-v1'|'seo-outreach-analysis-v2';inputPath:string;inputSha256:string;locale:Locale;selectedIssueIds:string[];seller:SellerIdentity|null;source:'OFFLINE_TEMPLATE'|'RECORDED'|'LIVE'|'CACHE';status:'INTERNAL_HOLD';outreach?:{context:OutreachContext;output:SalesOutput|null}};
const names=['source.json','source.zip','analysis.json','manifest.json','report.pdf','customer-review.json','whatsapp-opener.txt','whatsapp-after-interest.txt','sales-brief.md','prospects.json','prospects.csv','outreach-review.json'];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
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
 return {SOFTWARE_READY:{status:'READY',reason:'supported_local_generation_route'},CRAWL_READY:{status:x.evidence.crawl.captured?'PARTIAL':'HOLD',reason:'captured_scope_only'},EVIDENCE_READY:{status:findings.length?'PARTIAL':'HOLD',reason:x.verification},CUSTOMER_READY:{status:'HOLD',reason:pdf?'internal_review_pdf_only':'supported_corroborated_finding_required'},OUTREACH_READY:{status:'HOLD',reason:'recipient_channel_consent_suppression_and_operator_approval_not_established'},LIVE:{status:['COMPLETED','CACHED'].includes(providerStatus)?'READY':'HOLD',reason:providerStatus==='COMPLETED'?'provider_response_completed_and_validated':providerStatus==='CACHED'?'validated_completed_receipt_zero_new_dispatches':'no_completed_provider_receipt_in_this_run'}};
}
/** Coverage limitations remain visible without vetoing independently supported claims. */
function reportAssessment(x:Source,findings:Finding[],pdf:boolean,approved=false){
 const limitations=[...x.evidence.crawl.limitations];
 if(x.evidence.crawl.failed)limitations.push('failed_page_urls');
 if(x.evidence.crawl.unattempted)limitations.push('unattempted_page_urls');
 if(x.evidence.exportCoverage?.omitted)limitations.push('omitted_page_exports');
 if(x.evidence.exportCoverage?.truncatedPages)limitations.push('truncated_export_fields');
 const distinct=[...new Set(limitations)].sort();
 const blockers=pdf?[]:[x.format==='JSON'?'page_corroboration_required':findings.length?'supported_report_findings_required':'no_supported_findings'];
 return {status:approved?(distinct.length?'APPROVED_WITH_LIMITATIONS':'APPROVED'):pdf?'READY_FOR_REVIEW':'BLOCKED',blockers,limitations:distinct};
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
 let seller:SellerIdentity|null;
 if(replay)seller=replay.seller?validateSellerIdentity(replay.seller.name,replay.seller.location,replay.seller.email):null;
 else if(options.sellerName!==undefined||options.sellerLocation!==undefined){
  if(options.reportContactFile)throw new Error('seller_identity_sources_conflict');
  seller=validateSellerIdentity(options.sellerName,options.sellerLocation);
 }else{
  try{const contact=await readReportContactFile(options.reportContactFile??fileURLToPath(new URL('../.report-contact.json',import.meta.url)));seller=validateSellerIdentity(contact.name,undefined,contact.email);}
  catch(e){if(!options.reportContactFile&&(e as NodeJS.ErrnoException).code==='ENOENT')seller=null;else throw new Error('invalid_seller_identity');}
 }
 let crmBase:CRMState;try{crmBase=existingCrm??await loadCrmSnapshot(options.crmPublishedDir,{existingJsonPath:options.crmExisting});}catch{throw new Error('invalid_crm_snapshot');}
 const inputPath=resolve(options.input);const x=await source(inputPath);const evidence=x.evidence;
 if((replay && replay.inputSha256!==evidence.inputSha256)||(options.expectedInputSha256 && options.expectedInputSha256!==evidence.inputSha256))throw new Error('source_fingerprint_changed');
 const d=x.format==='ZIP'?qualifiedDigest(evidence,x.pages):buildDigest(evidence);
 const outreachContext=replay?.outreach?validateOutreachContext(replay.outreach.context):options.outreachContext?contextForCompany(await parseJson(options.outreachContext),evidence.hostname):validateOutreachContext({});
 let salesOutput:SalesOutput|undefined;
 if(replay?.outreach?.output){const checked=validateRecordedOutput(replay.outreach.output,d,options.locale);if(!checked.ok||JSON.stringify(checked.output.selectedIssueIds)!==JSON.stringify(replay.selectedIssueIds))throw new Error('invalid_analysis');salesOutput=checked.output;}
 // Reserve enough local snapshot capacity for any allowed selection of up to six issues.
 const crmPreview=prospectInput(evidence,d.materialFingerprint,6,[...new Set(d.issues.map(i=>i.code))]);
 preflightProspectCapacity(crmBase,[crmPreview]);
 let ids:string[]=[];let sourceType:'OFFLINE_TEMPLATE'|'RECORDED'|'LIVE'|'CACHE'='OFFLINE_TEMPLATE';
 let provider:{status:string;dispatches:number;cost:unknown;costBasis?:string;reason?:string;predicted?:unknown}={status:'NOT_SENT',dispatches:0,cost:'UNKNOWN',reason:'offline_no_paid_dispatch'};
 if(options.dryRun&&options.providerPreview){try{const c={...(await liveConfig(options.providerPreview,true)).config,salesContext:{business:outreachContext,seller}};const estimate=estimateRequest(d,c,options.locale);provider={status:'NOT_SENT',dispatches:0,cost:'UNKNOWN',reason:'dry_run_no_dispatch',predicted:{requestTokens:estimate.requestTokens,maxCostUsd:estimate.maxCostUsd,company:{requests:c.companyRequestCap,tokens:c.companyTokenCap,usd:c.companyUsdCap},batch:{requests:c.batchRequestCap,tokens:c.batchTokenCap,usd:c.batchUsdCap}}};}catch{provider.reason='invalid_preview_configuration_or_insufficient_evidence';}}
 if(replay){ids=replay.selectedIssueIds;sourceType=replay.source;}
 else if(options.recorded){
  const record=await parseJson(options.recorded);
  const checked=validateRecordedOutput(record,d,options.locale);if(!checked.ok)throw new Error('recorded_output_invalid');
  // Selection is independently corroborated; generated copy is only an internal review draft.
  ids=checked.output.selectedIssueIds;salesOutput=checked.output;sourceType='RECORDED';
 }else if(options.live && !options.dryRun){
  if(x.format!=='ZIP'||d.readiness!=='REVIEW_REQUIRED')provider.reason='insufficient_corroborated_evidence';
  else {
   await assertSafeOutputTarget(options.out);
   const statePath=resolve(options.live.statePath),outPath=resolve(options.out);
   if(statePath===inputPath || statePath===resolve(options.live.configPath) || statePath===outPath || statePath.startsWith(outPath+sep))throw new Error('unsafe_state_path');
   let cfg:Awaited<ReturnType<typeof liveConfig>>|undefined;try{cfg=await liveConfig(options.live.configPath);}catch{provider.reason='missing_or_invalid_provider_authority_or_pricing';}
   if(cfg){
    const c={...cfg.config,salesContext:{business:outreachContext,seller}};const caps={currency:'USD',company:{requests:c.companyRequestCap,tokens:c.companyTokenCap,money:c.companyUsdCap},batch:{requests:c.batchRequestCap,tokens:c.batchTokenCap,money:c.batchUsdCap}};
    const identity={company:evidence.hostname,branch:evidence.targetIdentity,evidenceFingerprint:d.materialFingerprint,locale:options.locale,model:c.model,settingsFingerprint:liveSettingsFingerprint(c),promptVersion:LIVE_PROMPT_VERSION,schemaVersion:LIVE_SCHEMA_VERSION};
    const outcome=await dispatchAuthorized({digest:d,locale:options.locale,config:c,identity,batchId:options.live.batchId,caps,statePath:options.live.statePath,paidCallOptIn:options.live.paidCallOptIn,retry:{maxAttempts:cfg.retry.maxAttempts,deadlineAtMs:Date.now()+cfg.retry.overallDeadlineMs,maxRetryAfterMs:cfg.retry.maxRetryAfterMs}});
    provider={status:outcome.status,dispatches:outcome.attempts??0,cost:outcome.status==='COMPLETED'||outcome.status==='CACHED'?outcome.cost:'UNKNOWN',costBasis:outcome.status==='COMPLETED'||outcome.status==='CACHED' ? ('amount' in outcome.cost ? 'ESTIMATED_STANDARD_TOKEN_RATES_NOT_INVOICE' : 'UNKNOWN') : 'UNKNOWN',...('reason' in outcome?{reason:outcome.reason}:{})};
    if(outcome.status==='COMPLETED'||outcome.status==='CACHED'){ids=outcome.output.selectedIssueIds;salesOutput=outcome.output;sourceType=outcome.status==='CACHED'?'CACHE':'LIVE';}
   }
  }
 }else if(x.format==='ZIP')ids=pickIds(d);
 if(x.format==='ZIP' && ids.length===0 && !replay && !options.recorded && provider.status!=='COMPLETED' && provider.status!=='CACHED')ids=pickIds(d);
 let decision:Decision|undefined;let findings:Finding[]=[];
 if(x.format==='ZIP'){decision=validateSelection(evidence,x.pages,ids,options.locale);findings=decision.findings;}
 else {if(ids.length)throw new Error('audit_json_has_no_page_corroboration');findings=auditReviewFindings(evidence,options.locale);}
 const reportPossible=!!decision&&findings.length>=1&&findings.length<=6;
 const gates=summary(x,findings,reportPossible,provider.status);
 const dry={reportAssessment:reportAssessment(x,findings,reportPossible),inputFormat:x.format,inputSha256:evidence.inputSha256,hostname:evidence.hostname,digest:d,findings:findings.length,provider,gates};
 return {inputPath,x,d,ids,sourceType,seller,crmBase,crmPreview,decision,findings,reportPossible,gates,dry,provider,outreachContext,salesOutput,hasOutreach:!!replay?.outreach||!!options.outreachContext||!!salesOutput};
}
async function publish(options:AnalyzeOptions,prepared:Awaited<ReturnType<typeof prepare>>){
 const p=prepared;const {evidence}=p.x;
 const inputSnapshot=p.x.format==='ZIP'?'source.zip':'source.json';
 const replay:Replay={schema:'seo-outreach-analysis-v2',inputPath:inputSnapshot,inputSha256:evidence.inputSha256,locale:options.locale,selectedIssueIds:p.ids,seller:p.seller,source:p.sourceType,status:'INTERNAL_HOLD',...(p.hasOutreach?{outreach:{context:p.outreachContext,output:p.salesOutput??null}}:{})};
 const artifacts:Record<string,Uint8Array>={'analysis.json':json(replay),[inputSnapshot]:p.x.bytes};
 let pdfInput:CustomerPdfInput|undefined;let pdfVerification:ReturnType<typeof verifyRenderedPdf>|undefined;
 if(p.reportPossible&&p.decision){pdfInput=buildReportPdfInput(p.decision);artifacts['report.pdf']=renderCustomerPdf(pdfInput);pdfVerification=verifyRenderedPdf(pdfInput,artifacts['report.pdf']);}
 if(pdfVerification){
  const context={company:evidence.hostname,analysisSha256:hash(artifacts['analysis.json']!),reportPdfSha256:pdfVerification.sha256,findings:p.findings};
  // Retained as private factual-review notes; this legacy template cannot release a customer PDF.
  if(p.findings.every(f=>/^https?:\/\//.test(f.reference)))artifacts['customer-review.json']=json(customerReviewTemplate(context));
 }
 const gates=p.gates;
 const status='INTERNAL_HOLD';
 const assessment=reportAssessment(p.x,p.findings,p.reportPossible);
 const draftFinding=p.findings.find(f=>f.code!=='noindex' && /^https?:\/\//.test(f.reference));
 if(draftFinding){const f=draftFinding;const fallback=buildDrafts({company:evidence.hostname,locale:options.locale,seller:p.seller,reportAvailable:false,finding:{code:f.code,observed:f.observed,reference:f.reference,implication:f.implication,fix:f.fix}});
  const reviewed=reviewGeneratedDrafts(p.salesOutput,p.findings,p.seller,fallback,options.locale);const draft=reviewed.drafts;
  artifacts['outreach-review.json']=json({schema:'seo-outreach-draft-review-v1',status:'INTERNAL_HOLD',source:reviewed.source,reasons:reviewed.reasons,context:p.outreachContext,contextProvenance:'OPERATOR_SUPPLIED_OR_UNKNOWN',selectedIssueIds:p.ids,reviewNotes:draft.reviewNotes,attachment:null,attachmentMode:'AUTOMATIC_ON_APPROVED_DOCUMENT_SEND',attachmentDetails:null,modelSuggestions:p.salesOutput?{salesAngle:p.salesOutput.salesAngle,opportunities:p.salesOutput.opportunities,businessContext:p.salesOutput.businessContext,buyerRoleHypothesis:p.salesOutput.buyerRoleHypothesis,salesBrief:p.salesOutput.salesBrief,uncertainties:p.salesOutput.uncertainties}:null});
  artifacts['whatsapp-opener.txt']=encode('INTERNAL / HOLD — DO NOT SEND WITHOUT RECIPIENT AND CHANNEL REVIEW\n\n'+draft.opener+'\n');
  artifacts['whatsapp-after-interest.txt']=encode('INTERNAL / HOLD — DO NOT SEND WITHOUT RECIPIENT AND CHANNEL REVIEW\n\n'+draft.afterInterest+'\n');
 }
 const reviewCodes=[...new Set(evidence.groups.filter(g=>g.category==='indexability'||g.category==='security').map(g=>g.code))].sort();
 const brief=['# Internal sales brief — HOLD',`Site: ${evidence.hostname}`,`Captured pages: ${evidence.crawl.captured}; failed: ${evidence.crawl.failed}; skipped: ${evidence.crawl.skipped}; unattempted: ${evidence.crawl.unattempted}; robots retrieval: ${evidence.robots}.`,`Evidence source: ${p.x.verification}. Site-wide coverage and recipient eligibility are not established.`,`Additional indexability/security check codes for review: ${reviewCodes.slice(0,30).join(', ')||'none retained'}${reviewCodes.length>30?` (and ${reviewCodes.length-30} more)`:''}. These are observations, not confirmed vulnerabilities.`,`Contact inventory: ${evidence.contacts.status}; ${evidence.contacts.candidates.length} candidate(s) retained; ${evidence.contacts.candidatesOmitted+(evidence.contacts.coverage.omittedCandidates??0)} known omissions or invalid candidates; additional omissions may be unknown. Ownership and outreach eligibility remain unverified.`,...p.findings.map(f=>`- ${f.code}: ${f.observed} Source: ${f.reference}`),p.provider.dispatches===0?'No provider call or message was sent.':'No message was sent; provider usage is recorded separately.'].join('\n\n');
 artifacts['sales-brief.md']=encode(brief+'\n');
 const crm=buildCrmSnapshotFromState(p.crmBase,[prospectInput(evidence,p.d.materialFingerprint,p.findings.length,p.findings.map(f=>f.code))]);
 artifacts['prospects.json']=crm.json;artifacts['prospects.csv']=crm.csv;
 artifacts['manifest.json']=json({schema:'seo-outreach-manifest-v1',status,reportAssessment:assessment,source:p.x.format,sourceSha256:evidence.inputSha256,exportCoverage:evidence.exportCoverage??{status:'UNKNOWN',reason:'audit_only_no_page_export'},checkCoverage:evidence.checkCoverage,decisionSource:p.sourceType,readiness:gates,pdfVerification:pdfVerification??null,customerPdfVerification:null,customerReview:null,artifacts:[...Object.keys(artifacts),'manifest.json'].sort(),spend:p.provider});
 const publication=await publishArtifacts(resolve(options.out),artifacts,{allowedNames:names,maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
 // Verify the exact published bytes of each report before reporting success.
 if(artifacts['report.pdf']){const actual=await readPublishedArtifact(publication.directory,'report.pdf',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});const expected=Buffer.from(artifacts['report.pdf']);if(!actual.equals(expected)||!pdfInput)throw new Error('report_readback_failed');const verified=verifyRenderedPdf(pdfInput,actual);if(verified.sha256!==pdfVerification?.sha256)throw new Error('report_readback_failed');}
 return {status,reportAssessment:assessment,directory:publication.directory,files:publication.files,gates,provider:p.provider};
}
export async function analyze(options:AnalyzeOptions):Promise<unknown>{
 if(options.live&&options.recorded)throw new Error('live_and_recorded_mutually_exclusive');
 const p=await prepare(options);return options.dryRun?p.dry:publish(options,p);
}
export async function render(options:RenderOptions):Promise<unknown>{
 // The legacy text renderer is internal only. Customer documents use the frozen, exact-byte reviewed styled route.
 if(options.customerReview)throw new Error('customer_pdf_requires_frozen_design_use_reports_prepare_and_release');
 if(basename(options.analysis)!=='analysis.json')throw new Error('unpublished_or_corrupt_analysis');
 const analysisBytes=await readPublishedArtifact(dirname(resolve(options.analysis)),'analysis.json',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
 let raw:unknown;try{raw=JSON.parse(analysisBytes.toString('utf8'));}catch{throw new Error('invalid_analysis');}
 if(!isObject(raw)||!['seo-outreach-analysis-v1','seo-outreach-analysis-v2'].includes(String(raw.schema))||typeof raw.inputPath!=='string'||typeof raw.inputSha256!=='string'||!Array.isArray(raw.selectedIssueIds)||!['en','es','de','pt-BR'].includes(String(raw.locale))||!['OFFLINE_TEMPLATE','RECORDED','LIVE','CACHE'].includes(String(raw.source))||raw.status!=='INTERNAL_HOLD'||!(raw.seller===null||isObject(raw.seller)&&typeof raw.seller.name==='string'&&(raw.seller.location===undefined||typeof raw.seller.location==='string')&&(raw.seller.email===undefined||typeof raw.seller.email==='string')))throw new Error('invalid_analysis');
 if(raw.outreach!==undefined&&(!isObject(raw.outreach)||Object.keys(raw.outreach).length!==2||!Object.hasOwn(raw.outreach,'context')||!Object.hasOwn(raw.outreach,'output')||!(raw.outreach.output===null||isObject(raw.outreach.output))))throw new Error('invalid_analysis');
 const replay=raw as Replay;
 if(replay.schema==='seo-outreach-analysis-v2'&&!['source.json','source.zip'].includes(replay.inputPath))throw new Error('invalid_analysis');
 const opts:AnalyzeOptions={input:replay.schema==='seo-outreach-analysis-v2'?join(dirname(resolve(options.analysis)),replay.inputPath):replay.inputPath,out:options.out,locale:replay.locale,sellerName:replay.seller?.name,sellerLocation:replay.seller?.location,crmPublishedDir:dirname(resolve(options.analysis)),dryRun:options.dryRun};
 const p=await prepare(opts,replay);
 if(options.dryRun)return p.dry;
 return publish(opts,p);
}
export async function batch(options:BatchOptions):Promise<unknown>{
 let crmBase:CRMState;try{crmBase=await loadCrmSnapshot(undefined,{existingJsonPath:options.crmExisting});}catch{throw new Error('invalid_crm_snapshot');}
 const raw=await parseJson(options.manifest);
 if(!isObject(raw)||!Array.isArray(raw.inputs)||raw.inputs.length<1||raw.inputs.length>1000||raw.inputs.some(v=>typeof v!=='string'||!v))throw new Error('invalid_batch_manifest');
 const crmPreviews:ProspectInput[]=[];
 const entries:{input:string;target:string;fingerprint:string}[]=[];const seen=new Map<string,string>();let duplicates=0;
 for(const item of raw.inputs as string[]){
  const input=resolve(dirname(resolve(options.manifest)),item);
  const p=await prepare({input,out:options.out,locale:options.locale,sellerName:options.sellerName,sellerLocation:options.sellerLocation,reportContactFile:options.reportContactFile,outreachContext:options.outreachContext,providerPreview:options.providerPreview,dryRun:true},undefined,crmBase);const key=p.x.evidence.targetIdentity, prior=seen.get(key);
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
  const p=await prepare({input:entry.input,out:output,locale:options.locale,sellerName:options.sellerName,sellerLocation:options.sellerLocation,reportContactFile:options.reportContactFile,outreachContext:options.outreachContext,live:options.live,providerPreview:options.providerPreview,expectedInputSha256:entry.fingerprint,dryRun:options.dryRun},undefined,crmBase);
  if(p.x.evidence.inputSha256!==entry.fingerprint || p.x.evidence.targetIdentity!==entry.target)throw new Error('source_changed_after_batch_preflight');
  if(options.dryRun)results.push(p.dry);else {
   results.push(await publish({input:entry.input,out:output,locale:options.locale,sellerName:options.sellerName,sellerLocation:options.sellerLocation,reportContactFile:options.reportContactFile,outreachContext:options.outreachContext,crmExisting:options.crmExisting,live:options.live,dryRun:false},p));
   const e=p.x.evidence;crmInputs.push({companyKey:e.hostname,branchKey:e.targetIdentity,companyName:e.hostname,website:new URL(e.target).origin+'/',status:'HOLD',evidenceFingerprint:p.d.materialFingerprint,issueCount:p.findings.length,issueCodes:p.findings.map(f=>f.code)});
  }
 }
 let crmDirectory:string|undefined;
 if(!options.dryRun){const snapshot=buildCrmSnapshotFromState(crmBase,crmInputs);const published=await publishArtifacts(join(options.out,'crm'),{'prospects.json':snapshot.json,'prospects.csv':snapshot.csv},{allowedNames:['prospects.json','prospects.csv']});crmDirectory=published.directory;}
 return {count:results.length,duplicates,results,...(crmDirectory?{crmDirectory}:{})};
}
