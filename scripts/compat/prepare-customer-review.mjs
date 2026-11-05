#!/usr/bin/env node
// Offline presentation only: saved audit -> clean private PDFs + HOLD manifest.
import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { renderCustomerSummaryHtml } from '../../dist/reports/summary.js';
import { renderMobileCustomerPdf } from '../../dist/reports/mobile.js';
import { withPlaywrightPdfSession } from '../../dist/reports/pdf-playwright.js';
import { readReportContactFile } from '../../dist/reports/report-contact.js';
import { createCustomerReviewManifest } from '../../dist/reports/review.js';

async function prepare(args) {
  const values = new Map(); const allowed = ['--audit','--report-contact-file','--out','--pdf-locale'];
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
  const audit=JSON.parse(bytes);if(!isAuditResultRecord(audit))throw Error('audit_schema_invalid');
  const issuer=await readReportContactFile(resolve(values.get('--report-contact-file')));
  const html=renderCustomerSummaryHtml(audit,locale,{issuer});
  const pdfs=await withPlaywrightPdfSession(async renderer=>({
    a4:await renderer(html),
    mobile:await renderMobileCustomerPdf(audit,renderer,issuer,locale,'HOLD'),
  }));
  const manifest={...createCustomerReviewManifest(audit,locale,[{role:'a4',path:paths[0],content:pdfs.a4},{role:'mobile',path:paths[1],content:pdfs.mobile}]),
    sourceAuditFileSha256:createHash('sha256').update(bytes).digest('hex'),sourceAuditPath:auditPath,
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
