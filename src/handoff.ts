import { CUSTOMER_REPORT_FRESHNESS_MS } from './reports/freshness.js';
import { canonicalCompanyHost } from './company-host.js';
export { canonicalCompanyHost, canonicalCampaignKey } from './company-host.js';
/** A handoff describes one reviewable document. It never grants sender/recipient approval. */
export const HANDOFF_SCHEMA = 'spora-outreach-handoff-v1' as const;
export type DocumentHandoff = {
  schema: typeof HANDOFF_SCHEMA; action: 'DOCUMENT';
  identity: { company: string; branch: string; campaign: string };
  source: { target: string; auditSha256: string; startedAt: string; completedAt: string; scanStatus: 'COMPLETED' | 'UNKNOWN' | 'INCOMPLETE' };
  release: { path: string; sha256: string; qualifiedAt: string; reviewedManifestSha256: string };
  attachment: { role: 'a4' | 'mobile'; locale: 'en' | 'de'; path: string; filename: string; bytes: number; sha256: string };
  message: string; recipientReviewRequired: true; selectedSendTarget: null; outboundApproval: false;
};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const key=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(v);
const time=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v));
export function validRelativeArtifactPath(v:unknown):v is string {
 return typeof v==='string'&&v.length>0&&v.length<=512&&!v.startsWith('/')&&!v.includes('\\')&&!/[\u0000-\u001f\u007f]/u.test(v)&&v.split('/').every(p=>p!==''&&p!=='.'&&p!=='..');
}
function exact(v:Record<string,unknown>,keys:string[]):boolean{return Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
export function validateDocumentHandoff(value:unknown, now=Date.now()):DocumentHandoff {
 const fail=():never=>{throw new Error('invalid_reviewed_document_handoff');};
 if(!record(value)||!exact(value,['schema','action','identity','source','release','attachment','message','recipientReviewRequired','selectedSendTarget','outboundApproval']))return fail();
 const {identity:i,source:s,release:r,attachment:a}=value;
 if(value.schema!==HANDOFF_SCHEMA||value.action!=='DOCUMENT'||value.recipientReviewRequired!==true||value.selectedSendTarget!==null||value.outboundApproval!==false)return fail();
 if(!record(i)||!exact(i,['company','branch','campaign'])||![i.company,i.branch,i.campaign].every(key))return fail();
 if(!record(s)||!exact(s,['target','auditSha256','startedAt','completedAt','scanStatus'])||!sha(s.auditSha256)||!time(s.startedAt)||!time(s.completedAt)||!['COMPLETED','UNKNOWN','INCOMPLETE'].includes(String(s.scanStatus)))return fail();
 try{const u=new URL(String(s.target));if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||u.href!==s.target||canonicalCompanyHost(i.company)!==canonicalCompanyHost(u.hostname))return fail();}catch{return fail();}
 if(!record(r)||!exact(r,['path','sha256','qualifiedAt','reviewedManifestSha256'])||!validRelativeArtifactPath(r.path)||!sha(r.sha256)||!sha(r.reviewedManifestSha256)||!time(r.qualifiedAt))return fail();
 const started=Date.parse(s.startedAt),completed=Date.parse(s.completedAt),qualified=Date.parse(r.qualifiedAt),skew=600_000;
 if(completed<started||completed>now+skew||started>now+skew||now-started>=CUSTOMER_REPORT_FRESHNESS_MS||qualified<completed-skew||qualified>now+skew||qualified-started>=CUSTOMER_REPORT_FRESHNESS_MS)return fail();
 if(!record(a)||!exact(a,['role','locale','path','filename','bytes','sha256'])||!['a4','mobile'].includes(String(a.role))||!['en','de'].includes(String(a.locale))||!validRelativeArtifactPath(a.path)||!sha(a.sha256)||!Number.isSafeInteger(a.bytes)||Number(a.bytes)<8||Number(a.bytes)>8*1024*1024||typeof a.filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,155}\.pdf$/u.test(a.filename))return fail();
 if(typeof value.message!=='string'||!value.message.trim()||value.message.startsWith('INTERNAL / HOLD')||value.message.length>1000||/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value.message)||value.message.includes('\r'))return fail();
 return value as unknown as DocumentHandoff;
}
export function campaignIdentityKey(value:DocumentHandoff['identity']):string {return JSON.stringify([value.company,value.campaign]);}
