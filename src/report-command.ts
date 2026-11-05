import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, relative, basename, join } from 'node:path';
import { open, realpath, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAuditResultRecord, classifyScanCompletion } from '@spora/webcrawl/evidence';
import { auditResultSha256 } from './reports/qualification.js';
import { HANDOFF_SCHEMA, validateDocumentHandoff, canonicalCompanyHost, type DocumentHandoff } from './handoff.js';
const exec=promisify(execFile),hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function read(path:string,max:number):Promise<Buffer>{
 const absolute=resolve(path);if(await realpath(absolute)!==absolute)throw Error('unsafe_report_input');
 const f=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await f.stat();if(!s.isFile()||s.size<1||s.size>max)throw Error('unsafe_report_input');const b=Buffer.alloc(s.size+1);let total=0;
  while(total<b.length){const n=await f.read(b,total,b.length-total,null);if(!n.bytesRead)break;total+=n.bytesRead;}
  const after=await f.stat();if(total!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)throw Error('report_input_changed');return b.subarray(0,total);
 }finally{await f.close();}
}
function args(argv:string[],allowed:string[],required:string[]):Map<string,string>{const m=new Map<string,string>();for(let n=0;n<argv.length;n++){const k=argv[n]!,v=argv[++n];if(!allowed.includes(k)||m.has(k)||!v||v.startsWith('--'))throw Error('invalid_report_options');m.set(k,v);}if(required.some(k=>!m.has(k)))throw Error('missing_report_options');return m;}
async function script(name:string,argv:string[]):Promise<unknown>{
 const path=fileURLToPath(new URL(`../scripts/compat/${name}.mjs`,import.meta.url));
 try{const r=await exec(process.execPath,[path,...argv],{timeout:120_000,maxBuffer:4*1024*1024});return JSON.parse(r.stdout.trim());}catch{throw Error('report_operation_failed');}
}
export async function prepareReports(argv:string[]):Promise<unknown>{return script('prepare-customer-review',argv);}
export async function releaseReports(argv:string[]):Promise<unknown>{
 if(!argv.includes('--review-manifest'))throw Error('reviewed_manifest_required');return script('release-customer-reports',argv);
}
export async function createDocumentHandoff(argv:string[]):Promise<{path:string;state:'NEEDS_REVIEW';pdfSha256:string}>{
 const m=args(argv,['--audit','--release','--message-file','--company','--branch','--campaign','--artifact','--out'],['--audit','--release','--message-file','--company','--branch','--campaign','--out']);
 const auditBytes=await read(m.get('--audit')!,64*1024*1024);const audit:unknown=JSON.parse(auditBytes.toString('utf8'));if(!isAuditResultRecord(audit))throw Error('audit_schema_invalid');
 const releasePath=resolve(m.get('--release')!),releaseBytes=await read(releasePath,64*1024);const release=JSON.parse(releaseBytes.toString('utf8'));
 if(!release||release.schema!=='webcrawl-customer-release-v1'||release.reportStatus!=='CLIENT_READY'||release.outboundApproval!==false||release.target!==audit.target||release.auditSha256!==auditResultSha256(audit)||!Array.isArray(release.artifacts)||!/^[a-f0-9]{64}$/u.test(release.reviewedManifestSha256??''))throw Error('reviewed_customer_release_required');
 const role=m.get('--artifact')??'a4';const candidates=release.artifacts.filter((a:Record<string,unknown>)=>a.role===role);if(candidates.length!==1)throw Error('ambiguous_customer_attachment');const a=candidates[0];
 if(typeof a.path!=='string')throw Error('invalid_customer_attachment');const pdf=await read(a.path,8*1024*1024);if(a.bytes!==pdf.length||a.sha256!==hash(pdf)||pdf.subarray(0,5).toString()!=='%PDF-'||!pdf.subarray(-1024).includes(Buffer.from('%%EOF')))throw Error('released_pdf_changed');
 const out=resolve(m.get('--out')!),dir=dirname(out);
 // A handoff must live alongside the referenced immutable release/PDF; no parent traversal.
 const rel=(path:string)=>relative(dir,resolve(path)).replaceAll('\\','/');
 const message=(await read(m.get('--message-file')!,4096)).toString('utf8').replace(/\r\n/gu,'\n').replace(/\n$/u,'');
 const status=classifyScanCompletion(audit).status;const bundle:DocumentHandoff={schema:HANDOFF_SCHEMA,action:'DOCUMENT',identity:{company:canonicalCompanyHost(m.get('--company')!),branch:m.get('--branch')!,campaign:m.get('--campaign')!},source:{target:audit.target,auditSha256:auditResultSha256(audit),startedAt:audit.startedAt,completedAt:audit.completedAt,scanStatus:status==='COMPLETED'?'COMPLETED':status==='INCOMPLETE'?'INCOMPLETE':'UNKNOWN'},release:{path:rel(releasePath),sha256:hash(releaseBytes),qualifiedAt:release.qualifiedAt,reviewedManifestSha256:release.reviewedManifestSha256},attachment:{role:a.role,locale:a.locale,path:rel(a.path),filename:basename(a.path),bytes:pdf.length,sha256:hash(pdf)},message,recipientReviewRequired:true,selectedSendTarget:null,outboundApproval:false};
 validateDocumentHandoff(bundle);
 await mkdir(dir,{recursive:true,mode:0o700});if(await realpath(dir)!==dir)throw Error('unsafe_handoff_directory');
 // Recheck the original released bytes before creating a handoff. Approval is independent.
 if(!(await read(releasePath,64*1024)).equals(releaseBytes)||!(await read(a.path,8*1024*1024)).equals(pdf))throw Error('released_pdf_changed');
 await writeFile(out,JSON.stringify(bundle,null,2)+'\n',{flag:'wx',mode:0o600});return {path:out,state:'NEEDS_REVIEW',pdfSha256:hash(pdf)};
}
export async function runReportCommand(argv:string[]):Promise<unknown>{
 const [command,...options]=argv;if(command==='prepare')return prepareReports(options);if(command==='release')return releaseReports(options);if(command==='handoff')return createDocumentHandoff(options);throw Error('unknown_report_command');
}
