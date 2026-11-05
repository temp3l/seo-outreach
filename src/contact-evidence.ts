/** Bounded, internal projection of Webcrawl contact evidence. This module does
 * not select recipients or authorize outreach; eligibility is always HOLD. */
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const MAX_CANDIDATES = 1000;
const MAX_SOURCES = 12;
const MAX_UNRESOLVED = 1000;
const MAX_RAW_VARIANTS = 20;
const COVERAGE_FIELDS = [
  'capturedHtmlPages','inspectedPages','pagesWithNoCandidates','uninspectedPages',
  'knownContactPagesOmitted','incompleteDiscoveryPages','acceptedEmails','acceptedPhones',
  'rejectedValues','mergedOccurrences','retainedSources','omittedCandidates',
  'untrackedCandidateOverflowOccurrences','omittedSources','omittedRawVariants',
  'truncatedHtmlPages','omittedPageCandidates','omittedTraversalNodes','omittedJsonLdValues',
  'omittedVisibleText','unresolvedWhatsAppLinks','omittedWhatsAppLinks'
] as const;
const CHANNELS = new Set(['email','phone','whatsapp']);
const SOURCE_TYPES = new Set(['mailto-tel','visible-text','json-ld','whatsapp-link','static-widget']);
const REGIONS = new Set(['main','contact-section','footer','organization','other']);
const WHATSAPP_EVIDENCE = new Set(['VALID_DIRECT_WHATSAPP_LINK','WHATSAPP_LABELLED_PHONE','BUTTON_OBSERVED_NUMBER_UNRESOLVED']);
const WHATSAPP_STATE = new Set(['VALID_DIRECT_WHATSAPP_LINK','WHATSAPP_LABELLED_PHONE']);

export type ContactSourceEvidence = {
  pageUrl: string | null; type: string; region: string; contactPage: boolean | null;
  observedAt: string | null; captureMode: string | null; channel: string | null;
  whatsappEvidenceKind: string | null; whatsappLinkState: string | null;
  locator: string | null; context: string | null; elementLabel: string | null; branchLabel: string | null;
  truncatedFields: string[]; sanitizedFields: string[]; pageUrlOmitted: boolean; pageUrlRedacted: boolean;
};
export type ContactCandidateEvidence = {
  kind: 'email'|'phone'; normalizedValue: string | null; normalizedValueOmitted: boolean; e164: string | null; e164Omitted: boolean; rawValue: string[]; rawValueTruncated: number; rawValueOmitted: number; rawValueSanitized: number;
  channels: string[]; whatsappLinkState: string | null; rank: {tier: number|null; reasons: string[]};
  rankReasonsOmitted: number; rankReasonsTruncated: number; rankReasonsSanitized: number;
  validation: string; ownership: string; upstreamEligibleForPrimary: boolean|null;
  sources: ContactSourceEvidence[]; sourcesOmitted: number;
};
export type ContactEvidence = {
  profile: string|null; status: 'complete'|'partial'|'disabled'|'unknown';
  coverage: Record<string, number>; knownContactPagesUncaptured: number|null;
  candidates: ContactCandidateEvidence[]; candidatesOmitted: number; upstreamCandidatesOmitted: number|null;
  unresolvedWhatsApp: ContactSourceEvidence[]; unresolvedWhatsAppOmitted: number;
  suggestedPrimary: {email:{known:boolean;value:string|null};phone:{known:boolean;value:string|null}};
  eligibility: 'HOLD';
};

function boundedText(value: unknown, max: number): {value:string|null;truncated:boolean;sanitized:boolean} {
  if (typeof value !== 'string' || !value.trim()) return {value:null,truncated:false,sanitized:false};
  const cleaned=value.replace(/[\u0000-\u001f\u007f<>]/g,' ').replace(/\s+/g,' ').trim();
  return {value:cleaned.slice(0,max)||null,truncated:cleaned.length>max,sanitized:cleaned!==value};
}
function safeText(value: unknown, max: number): string|null {
  return boundedText(value,max).value;
}
function safePage(value: unknown): {value:string|null;omitted:boolean;redacted:boolean} {
  if (typeof value !== 'string' || value.length > 4096) return {value:null,omitted:value!==undefined,redacted:false};
  try {
    const u = new URL(value);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password) return {value:null,omitted:true,redacted:false};
    const redacted=!!u.search||!!u.hash; u.search=''; u.hash=''; return {value:u.href,omitted:false,redacted};
  } catch { return {value:null,omitted:true,redacted:false}; }
}
function source(value: unknown): ContactSourceEvidence|null {
  if (!isObj(value)) return null;
  const type = typeof value.type==='string' && SOURCE_TYPES.has(value.type) ? value.type : null;
  const region = typeof value.region==='string' && REGIONS.has(value.region) ? value.region : null;
  if (!type || !region) return null;
  const page=safePage(value.pageUrl);
  const trunc:string[]=[]; const sanitized:string[]=[];
  const field=(key:string,max:number)=>{const r=boundedText(value[key],max);if(r.truncated)trunc.push(key);if(r.sanitized)sanitized.push(key);return r.value;};
  return {
    pageUrl:page.value, type, region,
    contactPage:typeof value.contactPage==='boolean'?value.contactPage:null,
    observedAt:typeof value.observedAt==='string' && Number.isFinite(Date.parse(value.observedAt))?value.observedAt.slice(0,40):null,
    captureMode:value.captureMode==='http'||value.captureMode==='rendered-dom'?value.captureMode:null,
    channel:typeof value.channel==='string'&&CHANNELS.has(value.channel)?value.channel:null,
    whatsappEvidenceKind:typeof value.whatsappEvidenceKind==='string'&&WHATSAPP_EVIDENCE.has(value.whatsappEvidenceKind)?value.whatsappEvidenceKind:null,
    whatsappLinkState:typeof value.whatsappLinkState==='string'&&WHATSAPP_STATE.has(value.whatsappLinkState)?value.whatsappLinkState:null,
    locator:field('locator',160), context:field('context',240),
    elementLabel:field('elementLabel',160), branchLabel:field('branchLabel',120),
    truncatedFields:trunc, sanitizedFields:sanitized, pageUrlOmitted:page.omitted, pageUrlRedacted:page.redacted
  };
}
function suggestion(value: unknown): {known:boolean;value:string|null} {
  if (!isObj(value) || !Object.hasOwn(value,'value')) return {known:false,value:null};
  if (value.value === null) return {known:true,value:null};
  const text=boundedText(value.value,320);
  return text.value&&!text.truncated&&!text.sanitized ? {known:true,value:text.value} : {known:false,value:null};
}
function candidate(value: unknown): ContactCandidateEvidence|null {
  if (!isObj(value) || (value.kind!=='email'&&value.kind!=='phone')) return null;
  const normalizedValid=typeof value.normalizedValue==='string'&&!!value.normalizedValue.trim()&&value.normalizedValue.length<=320&&!/[\u0000-\u001f\u007f<>]/.test(value.normalizedValue);
  const normalizedValue=normalizedValid?value.normalizedValue as string:null;
  const e164Valid=typeof value.e164==='string'&&!!value.e164.trim()&&value.e164.length<=32&&!/[\u0000-\u001f\u007f<>]/.test(value.e164);
  const rank=isObj(value.rank)?value.rank:{};
  const tier=count(rank.tier)&&rank.tier>=1&&rank.tier<=4?rank.tier:null;
  const rawReasons=Array.isArray(rank.reasons)?rank.reasons:[];
  let rankReasonsTruncated=0,rankReasonsSanitized=0;
  const reasons=rawReasons.slice(0,32).flatMap(x=>{if(typeof x!=='string')return [];const b=boundedText(x,100);if(b.truncated)rankReasonsTruncated++;if(b.sanitized)rankReasonsSanitized++;return b.value?[b.value]:[];});
  const rawVariants=Array.isArray(value.rawValue)?value.rawValue:[];
  let rawValueTruncated=0,rawValueOmitted=Math.max(0,rawVariants.length-MAX_RAW_VARIANTS),rawValueSanitized=0;
  const rawValue=rawVariants.slice(0,MAX_RAW_VARIANTS).flatMap(x=>{if(typeof x!=='string'){rawValueOmitted++;return [];}const cleaned=x.replace(/[\u0000-\u001f\u007f<>]/g,' ');if(x.length>254)rawValueTruncated++;if(cleaned!==x)rawValueSanitized++;return cleaned?[cleaned.slice(0,254)]:[];});
  const sources=Array.isArray(value.sources)?value.sources.slice(0,MAX_SOURCES).map(source).filter((x):x is ContactSourceEvidence=>!!x):[];
  const sourceCount=Array.isArray(value.sources)?value.sources.length:0;
  const channels=Array.isArray(value.channels)?[...new Set(value.channels.filter((x):x is string=>typeof x==='string'&&CHANNELS.has(x)))].slice(0,3):[];
  return {
    kind:value.kind, normalizedValue, normalizedValueOmitted:!normalizedValid,
    e164:e164Valid?value.e164 as string:null,e164Omitted:value.e164!==undefined&&!e164Valid, rawValue, rawValueTruncated,rawValueOmitted,rawValueSanitized, channels,
    whatsappLinkState:typeof value.whatsappLinkState==='string'&&WHATSAPP_STATE.has(value.whatsappLinkState)?value.whatsappLinkState:null,
    rank:{tier,reasons},rankReasonsOmitted:Math.max(0,rawReasons.length-reasons.length),rankReasonsTruncated,rankReasonsSanitized, validation:value.validation==='FORMAT_VALID'||value.validation==='NEEDS_REVIEW'?value.validation:'unknown',
    ownership:value.ownership==='UNVERIFIED'?'UNVERIFIED':'unknown',
    upstreamEligibleForPrimary:typeof value.eligibleForPrimary==='boolean'?value.eligibleForPrimary:null,
    sources, sourcesOmitted:Math.max(0,sourceCount-sources.length)
  };
}

/** Retain only bounded Webcrawl confidence, value, coverage, and source fields. */
export function projectContactEvidence(input: unknown): ContactEvidence {
  const v=isObj(input)?input:{};
  const coverage:Record<string,number>={};
  if (isObj(v.coverage)) for (const key of COVERAGE_FIELDS) if (count(v.coverage[key])) coverage[key]=v.coverage[key] as number;
  const rawCandidates=Array.isArray(v.candidates)?v.candidates:[];
  const candidates:ContactCandidateEvidence[]=[]; let candidatesOmitted=0;
  for (const raw of rawCandidates.slice(0,MAX_CANDIDATES)) {
    const projected=candidate(raw); if(projected)candidates.push(projected); else candidatesOmitted++;
  }
  candidatesOmitted+=Math.max(0,rawCandidates.length-MAX_CANDIDATES);
  const rawUnresolved=Array.isArray(v.unresolvedWhatsApp)?v.unresolvedWhatsApp:[];
  const unresolvedWhatsApp=rawUnresolved.slice(0,MAX_UNRESOLVED).map(source).filter((x):x is ContactSourceEvidence=>!!x);
  const primary=isObj(v.suggestedPrimary)?v.suggestedPrimary:{};
  const knownPages=isObj(v.coverage)&&Array.isArray(v.coverage.knownContactPagesUncaptured)?v.coverage.knownContactPagesUncaptured.length:null;
  return {
    profile:safeText(v.profile,100),
    status:v.status==='complete'||v.status==='partial'||v.status==='disabled'?v.status:'unknown',
    coverage, knownContactPagesUncaptured:knownPages,
    candidates, candidatesOmitted, upstreamCandidatesOmitted:count(coverage.omittedCandidates)?coverage.omittedCandidates:null,
    unresolvedWhatsApp, unresolvedWhatsAppOmitted:Math.max(0,rawUnresolved.length-unresolvedWhatsApp.length),
    suggestedPrimary:{email:suggestion(Object.hasOwn(primary,'email')?{value:primary.email}:undefined),phone:suggestion(Object.hasOwn(primary,'phone')?{value:primary.phone}:undefined)},
    eligibility:'HOLD'
  };
}
