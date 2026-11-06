import { createHash } from 'node:crypto';
import { openLocalState, type CacheIdentity, type Caps, type Cost, type Reservation } from './state.js';
import { estimateRequest, generateSalesOutput, validateRecordedOutput, type ProviderConfig, type ProviderLocale, type ProviderResult, type SalesOutput } from './provider.js';
import type { Digest } from './digest.js';

export const LIVE_PROMPT_VERSION = 'seo-outreach-sales-prompt-v6';
export const LIVE_SCHEMA_VERSION = 'seo-outreach-sales-output-v1';
const MAX_OVERALL_DURATION_MS=300_000;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Must be used by the caller when constructing CacheIdentity.settingsFingerprint. */
export function liveSettingsFingerprint(config: ProviderConfig): string {
  return hash({ endpoint:config.endpoint,model:config.model,reasoningEffort:'medium',timeoutMs:config.timeoutMs,maxInputTokens:config.maxInputTokens,maxOutputTokens:config.maxOutputTokens,inputUsdPerMillionTokens:config.inputUsdPerMillionTokens,outputUsdPerMillionTokens:config.outputUsdPerMillionTokens,companyRequestCap:config.companyRequestCap,companyTokenCap:config.companyTokenCap,companyUsdCap:config.companyUsdCap,batchRequestCap:config.batchRequestCap,batchTokenCap:config.batchTokenCap,batchUsdCap:config.batchUsdCap,salesContext:config.salesContext??null });
}

export type DispatchAuthorizedOptions = {
  digest: Digest;
  locale: ProviderLocale;
  config: ProviderConfig;
  identity: CacheIdentity;
  batchId: string;
  caps: Caps;
  statePath: string;
  paidCallOptIn: boolean;
  retry: { maxAttempts:number; deadlineAtMs:number; maxRetryAfterMs:number };
  fetchImpl?: typeof fetch;
};

export type DispatchResult =
  | { status:'NOT_SENT'; reason:string; attempts?:number }
  | { status:'DEFINITELY_REJECTED'; reason:string; retryAfter?:string; reservationId:string; attempts:number }
  | { status:'AMBIGUOUS'; reason:string; reservationId:string; attempts:number }
  | { status:'COMPLETED'; output:SalesOutput; responseId:string; cost:Cost; usage?:{inputTokens:number;outputTokens:number}; reservationId:string; attempts:number }
  | { status:'CACHED'; output:SalesOutput; cost:Cost; usage?:{inputTokens:number;outputTokens:number}; attempts:0 };

type Cached = { schema:'seo-outreach-provider-cache-v1'; reservationId:string; output:SalesOutput; responseId:string; cost:Cost; usage?:{inputTokens:number;outputTokens:number} };

function configMatchesCaps(config:ProviderConfig,caps:Caps):boolean {
  return caps.currency==='USD' && caps.company.requests===config.companyRequestCap && caps.company.tokens===config.companyTokenCap && caps.company.money===config.companyUsdCap && caps.batch.requests===config.batchRequestCap && caps.batch.tokens===config.batchTokenCap && caps.batch.money===config.batchUsdCap;
}

/** Parse RFC Retry-After delay-seconds or HTTP-date. Invalid values are never guessed. */
export function retryAfterDelayMs(value:string|undefined,nowMs=Date.now()):number|undefined {
  if (!value || !Number.isFinite(nowMs)) return undefined;
  const trimmed=value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds=Number(trimmed), milliseconds=seconds*1000; if (!Number.isSafeInteger(seconds)||!Number.isSafeInteger(milliseconds)) return undefined;
    return milliseconds;
  }
  const at=Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0,at-nowMs);
}

function validRetryPolicy(policy:DispatchAuthorizedOptions['retry']):boolean {
  return !!policy && Number.isInteger(policy.maxAttempts)&&policy.maxAttempts>=1&&policy.maxAttempts<=3&&Number.isSafeInteger(policy.deadlineAtMs)&&Number.isInteger(policy.maxRetryAfterMs)&&policy.maxRetryAfterMs>=0&&policy.maxRetryAfterMs<=60_000;
}

function validateIdentity(o:DispatchAuthorizedOptions):string|undefined {
  const {digest,locale,config,identity}=o;
  if (!o.paidCallOptIn) return 'paid_call_opt_in_required';
  if (!digest || String(digest.version)!=='digest-v2' || digest.readiness!=='REVIEW_REQUIRED') return 'digest_not_eligible';
  if (!identity || identity.company!==digest.targetHost || !identity.branch?.trim()) return 'company_or_branch_identity_mismatch';
  if (identity.evidenceFingerprint!==digest.materialFingerprint) return 'evidence_fingerprint_mismatch';
  if (identity.locale!==locale || identity.model!==config.model) return 'locale_or_model_identity_mismatch';
  if (identity.settingsFingerprint!==liveSettingsFingerprint(config)) return 'request_settings_identity_mismatch';
  if (identity.promptVersion!==LIVE_PROMPT_VERSION || identity.schemaVersion!==LIVE_SCHEMA_VERSION) return 'prompt_or_schema_identity_mismatch';
  if (!configMatchesCaps(config,o.caps)) return 'configured_caps_mismatch';
  return undefined;
}

function sameIdentity(a:CacheIdentity,b:CacheIdentity):boolean {
  return a.company===b.company&&a.branch===b.branch&&a.evidenceFingerprint===b.evidenceFingerprint&&a.locale===b.locale&&a.model===b.model&&a.settingsFingerprint===b.settingsFingerprint&&a.promptVersion===b.promptVersion&&a.schemaVersion===b.schemaVersion;
}

function sameCost(a:Cost,b:Cost):boolean {
  return 'status' in a ? 'status' in b&&a.status===b.status : 'amount' in b&&a.amount===b.amount&&a.currency===b.currency;
}

function validCached(value:unknown,digest:Digest,locale:ProviderLocale,identity:CacheIdentity,reservations:Reservation[]):Cached|undefined {
  if (!value || typeof value!=='object' || Array.isArray(value)) return;
  const v=value as Record<string,unknown>;
  const keys=Object.keys(v),baseKeys=['schema','reservationId','output','responseId','cost'];
  if (!baseKeys.every(k=>keys.includes(k)) || (keys.length!==5&&!(keys.length===6&&keys.includes('usage'))) || v.schema!=='seo-outreach-provider-cache-v1' || typeof v.reservationId!=='string' || !v.reservationId || typeof v.responseId!=='string' || !v.responseId || !v.cost || typeof v.cost!=='object') return;
  let usage:{inputTokens:number;outputTokens:number}|undefined;
  if(Object.hasOwn(v,'usage')){
    const u=v.usage as Record<string,unknown>;
    if(!u||typeof u!=='object'||Array.isArray(u)||Object.keys(u).length!==2||!Number.isSafeInteger(u.inputTokens)||(u.inputTokens as number)<0||!Number.isSafeInteger(u.outputTokens)||(u.outputTokens as number)<0)return;
    usage={inputTokens:u.inputTokens as number,outputTokens:u.outputTokens as number};
  }
  const validation=validateRecordedOutput(v.output,digest,locale);
  if (!validation.ok) return;
  const cost=v.cost as Record<string,unknown>;
  let normalizedCost:Cost|undefined;
  if (cost.status==='UNKNOWN' && Object.keys(cost).length===1) normalizedCost={status:'UNKNOWN'};
  else if (typeof cost.amount==='number' && Number.isFinite(cost.amount) && cost.amount>=0 && cost.currency==='USD' && Object.keys(cost).length===2) normalizedCost={amount:cost.amount,currency:'USD'};
  if (!normalizedCost) return;
  const reservation=reservations.find(r=>r.id===v.reservationId);
  if (!reservation||reservation.status!=='COMPLETED'||reservation.responseId!==v.responseId||!sameIdentity(reservation.identity,identity)||!sameCost(reservation.cost,normalizedCost)) return;
  return {schema:'seo-outreach-provider-cache-v1',reservationId:v.reservationId,output:validation.output,responseId:v.responseId,cost:normalizedCost,...(usage?{usage}:{})};
}

function providerUsage(result:Extract<ProviderResult,{status:'COMPLETED'}>):{inputTokens:number;outputTokens:number}|undefined {
  const input=result.usage?.inputTokens,output=result.usage?.outputTokens;
  if(!Number.isSafeInteger(input)||!Number.isSafeInteger(output)||(input as number)<0||(output as number)<0)return undefined;
  return {inputTokens:input as number,outputTokens:output as number};
}

function providerCost(result:Extract<ProviderResult,{status:'COMPLETED'}>,config:ProviderConfig):Cost {
  const usage=providerUsage(result);
  if (!usage) return {status:'UNKNOWN'};
  return { amount:usage.inputTokens*config.inputUsdPerMillionTokens/1_000_000+usage.outputTokens*config.outputUsdPerMillionTokens/1_000_000, currency:'USD' };
}

/**
 * Serialize cache lookup, durable exposure reservation and one provider dispatch under the state lock.
 * The digest has no branch field; this adapter verifies company against targetHost and requires the
 * caller-supplied stable branch key, whose provenance must be established by the caller.
 */
export async function dispatchAuthorized(options:DispatchAuthorizedOptions):Promise<DispatchResult> {
  if (!options || !options.config || !options.identity || !options.caps || !options.statePath || !validRetryPolicy(options.retry)) return {status:'NOT_SENT',reason:'required_configuration_or_retry_policy_missing'};
  const identityFailure=validateIdentity(options);
  if (identityFailure) return {status:'NOT_SENT',reason:identityFailure};
  let estimate;
  try { estimate=estimateRequest(options.digest,options.config,options.locale); }
  catch { return {status:'NOT_SENT',reason:'request_estimate_invalid'}; }
  if (estimate.inputTokens>options.config.maxInputTokens) return {status:'NOT_SENT',reason:'input_token_cap_exceeded'};
  if (Date.now()>=options.retry.deadlineAtMs) return {status:'NOT_SENT',reason:'overall_deadline_elapsed'};
  if (options.retry.deadlineAtMs-Date.now()>MAX_OVERALL_DURATION_MS) return {status:'NOT_SENT',reason:'overall_deadline_exceeds_maximum'};
  const state=openLocalState(options.statePath);
  let lock:Awaited<ReturnType<typeof state.acquire>>|undefined;
  let reservationId:string|undefined;
  let dispatchStarted=false;
  let attempt=0;
  try {
    lock=await state.acquire();
    const cached=await lock.getCache(options.identity);
    if (cached!==undefined) {
      const safe=validCached(cached,options.digest,options.locale,options.identity,await lock.reservations());
      if (!safe) return {status:'NOT_SENT',reason:'cached_output_invalid'};
      return {status:'CACHED',output:safe.output,cost:safe.cost,...(safe.usage?{usage:safe.usage}:{}),attempts:0};
    }
    let lastRejected:{reservationId:string;retryAfter?:string}|undefined;
    for (attempt=1;attempt<=options.retry.maxAttempts;attempt++) {
      if (Date.now()>=options.retry.deadlineAtMs) return lastRejected?{status:'DEFINITELY_REJECTED',reason:'provider_rate_limit_rejected',retryAfter:lastRejected.retryAfter,reservationId:lastRejected.reservationId,attempts:attempt-1}:{status:'NOT_SENT',reason:'overall_deadline_elapsed',attempts:attempt-1};
      const reservationsBefore=await lock.reservations();
      // Request-count caps count every attempt, including definitively rejected rate limits.
      const companyRequestCount=reservationsBefore.filter(r=>r.identity.company===options.identity.company&&r.currency===options.caps.currency).reduce((n,r)=>n+r.estimate.requests,0);
      const batchRequestCount=reservationsBefore.filter(r=>r.batchId===options.batchId&&r.currency===options.caps.currency).reduce((n,r)=>n+r.estimate.requests,0);
      if (companyRequestCount+1>options.caps.company.requests||batchRequestCount+1>options.caps.batch.requests) return lastRejected?{status:'DEFINITELY_REJECTED',reason:'request_cap_reached_after_rate_limit',retryAfter:lastRejected.retryAfter,reservationId:lastRejected.reservationId,attempts:attempt-1}:{status:'NOT_SENT',reason:'request_cap_exceeded',attempts:attempt-1};
      const reservationEstimate={requests:1,tokens:estimate.requestTokens,money:estimate.maxCostUsd};
      const activeCompany=reservationsBefore.filter(r=>r.identity.company===options.identity.company&&r.currency===options.caps.currency&&r.status!=='DEFINITELY_REJECTED').reduce((a,r)=>({requests:a.requests+r.estimate.requests,tokens:a.tokens+r.estimate.tokens,money:a.money+r.estimate.money}),{requests:0,tokens:0,money:0});
      const activeBatch=reservationsBefore.filter(r=>r.batchId===options.batchId&&r.currency===options.caps.currency&&r.status!=='DEFINITELY_REJECTED').reduce((a,r)=>({requests:a.requests+r.estimate.requests,tokens:a.tokens+r.estimate.tokens,money:a.money+r.estimate.money}),{requests:0,tokens:0,money:0});
      if (activeCompany.requests+1>options.caps.company.requests||activeCompany.tokens+reservationEstimate.tokens>options.caps.company.tokens||activeCompany.money+reservationEstimate.money>options.caps.company.money||activeBatch.requests+1>options.caps.batch.requests||activeBatch.tokens+reservationEstimate.tokens>options.caps.batch.tokens||activeBatch.money+reservationEstimate.money>options.caps.batch.money) return lastRejected?{status:'DEFINITELY_REJECTED',reason:'budget_cap_reached_after_rate_limit',retryAfter:lastRejected.retryAfter,reservationId:lastRejected.reservationId,attempts:attempt-1}:{status:'NOT_SENT',reason:'budget_cap_exceeded',attempts:attempt-1};
      const reserved=await lock.reserve(options.identity,options.batchId,reservationEstimate,options.caps);
      reservationId=reserved.id;
      if (Date.now()>=options.retry.deadlineAtMs) { await lock.markRejected(reserved.id,'deadline_elapsed_before_dispatch'); return lastRejected?{status:'DEFINITELY_REJECTED',reason:'overall_deadline_elapsed',retryAfter:lastRejected.retryAfter,reservationId:lastRejected.reservationId,attempts:attempt-1}:{status:'NOT_SENT',reason:'overall_deadline_elapsed',attempts:attempt-1}; }
      const reservations=await lock.reservations();
      const companyRequestsReserved=reservations.filter(r=>r.currency===options.caps.currency&&r.identity.company===options.identity.company).reduce((n,r)=>n+r.estimate.requests,0);
      const batchRequestsReserved=reservations.filter(r=>r.currency===options.caps.currency&&r.batchId===options.batchId).reduce((n,r)=>n+r.estimate.requests,0);
      const company=reservations.filter(r=>r.status!=='DEFINITELY_REJECTED'&&r.currency===options.caps.currency&&r.identity.company===options.identity.company).reduce((a,r)=>({tokens:a.tokens+r.estimate.tokens,money:a.money+r.estimate.money}),{tokens:0,money:0});
      const batch=reservations.filter(r=>r.status!=='DEFINITELY_REJECTED'&&r.currency===options.caps.currency&&r.batchId===options.batchId).reduce((a,r)=>({tokens:a.tokens+r.estimate.tokens,money:a.money+r.estimate.money}),{tokens:0,money:0});
      await lock.markDispatched(reserved.id);
      dispatchStarted=true;
      const remaining=options.retry.deadlineAtMs-Date.now();
      if (remaining<1) { await lock.markRejected(reserved.id,'deadline_elapsed_before_provider_call'); dispatchStarted=false; return lastRejected?{status:'DEFINITELY_REJECTED',reason:'overall_deadline_elapsed',retryAfter:lastRejected.retryAfter,reservationId:lastRejected.reservationId,attempts:attempt-1}:{status:'NOT_SENT',reason:'overall_deadline_elapsed',attempts:attempt-1}; }
      const attemptConfig={...options.config,timeoutMs:Math.max(1,Math.min(options.config.timeoutMs,Math.floor(remaining)))};
      const result=await generateSalesOutput(options.digest,options.locale,{config:attemptConfig,fetchImpl:options.fetchImpl,spend:{paidCallOptIn:options.paidCallOptIn,companyRequestsReserved:companyRequestsReserved,companyTokensReserved:company.tokens,companyUsdReserved:company.money,batchRequestsReserved:batchRequestsReserved,batchTokensReserved:batch.tokens,batchUsdReserved:batch.money}}).catch(()=>({status:'AMBIGUOUS',reason:'provider_adapter_failed'} as const));
      if (result.status==='COMPLETED') {
        const usage=providerUsage(result);
        const cost=providerCost(result,options.config);
        await lock.completeWithCache(reserved.id,options.identity,result.responseId,{schema:'seo-outreach-provider-cache-v1',reservationId:reserved.id,output:result.output,responseId:result.responseId,cost,...(usage?{usage}:{})},cost);
        return {status:'COMPLETED',output:result.output,responseId:result.responseId,cost,...(usage?{usage}:{}),reservationId:reserved.id,attempts:attempt};
      }
      if (result.status==='DEFINITELY_REJECTED') {
        await lock.markRejected(reserved.id,'provider_429'); dispatchStarted=false;
        lastRejected={reservationId:reserved.id,retryAfter:result.retryAfter};
        if (attempt>=options.retry.maxAttempts) return {status:'DEFINITELY_REJECTED',reason:'provider_rate_limit_rejected',retryAfter:result.retryAfter,reservationId:reserved.id,attempts:attempt};
        const delay=retryAfterDelayMs(result.retryAfter);
        if (delay===undefined||delay>options.retry.maxRetryAfterMs) return {status:'DEFINITELY_REJECTED',reason:'provider_rate_limit_rejected',retryAfter:result.retryAfter,reservationId:reserved.id,attempts:attempt};
        const timeLeft=options.retry.deadlineAtMs-Date.now();
        if (delay>=timeLeft) return {status:'DEFINITELY_REJECTED',reason:'overall_deadline_prevents_retry',retryAfter:result.retryAfter,reservationId:reserved.id,attempts:attempt};
        if (delay>0) await new Promise(r=>setTimeout(r,delay));
        if (Date.now()>=options.retry.deadlineAtMs) return {status:'DEFINITELY_REJECTED',reason:'overall_deadline_prevents_retry',retryAfter:result.retryAfter,reservationId:reserved.id,attempts:attempt};
        continue;
      }
      // The reservation was durably marked ambiguous before I/O. Do not turn a timeout or unknown
      // provider result into a replayable operation.
      if (result.status==='NOT_SENT') return {status:'AMBIGUOUS',reason:'provider_preflight_failed_after_reservation',reservationId:reserved.id,attempts:attempt};
      return {status:'AMBIGUOUS',reason:result.reason,reservationId:reserved.id,attempts:attempt};
    }
    return lastRejected?{status:'DEFINITELY_REJECTED',reason:'provider_rate_limit_rejected',retryAfter:lastRejected.retryAfter,reservationId:lastRejected.reservationId,attempts:attempt-1}:{status:'NOT_SENT',reason:'no_dispatch_attempt',attempts:0};
  } catch (e) {
    if (reservationId && dispatchStarted) return {status:'AMBIGUOUS',reason:'dispatch_state_or_provider_outcome_uncertain',reservationId,attempts:attempt};
    const code=e instanceof Error?e.message:'';
    const safe=['state_locked','dispatch_already_reserved','operation_not_replayable','budget_cap_exceeded','invalid_estimate','invalid_caps','invalid_cache_identity'].includes(code)?code:'local_state_operation_failed';
    return {status:'NOT_SENT',reason:safe};
  } finally { if(lock) await lock.release().catch(()=>undefined); }
}
