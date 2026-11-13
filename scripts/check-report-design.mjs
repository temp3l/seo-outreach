#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const revision='customer-pdf-v6-source-accuracy-20261113-operator-coverage';
const allowed=new Set(['src/reports/summary.ts','src/reports/mobile.ts','scripts/check-report-design.mjs','scripts/check-report-visuals.mjs','tests/report-design-contract.test.mjs','tests/customer-issue-counts.test.mjs']);
const added=new Set(['docs/pdf-design-approval.json','docs/pdf-design-versions/customer-pdf-v6-20261106/report-design.lock.json']);
export async function verifyReportDesign(root=resolve(dirname(fileURLToPath(import.meta.url)),'..')) {
 const bytes=await readFile(join(root,'report-design.lock.json'));
 const contract=JSON.parse(bytes),approval=JSON.parse(await readFile(join(root,'docs/pdf-design-approval.json')));
 const originalBytes=await readFile(join(root,'docs/pdf-design-versions/customer-pdf-v6-20261106/report-design.lock.json'));
 if(sha(originalBytes)!=='b077ab04973d6d3ad5d7859f184c2582b9b068e770bf7b6c9a5c4d2e20f0aa8e'||sha(originalBytes)!==approval.designLockSha256||approval.status!=='APPROVED_FROZEN')throw Error('approved_v6_reference_changed');
 const original=JSON.parse(originalBytes);
 const archived=await readFile(join(root,`docs/pdf-design-versions/${revision}/report-design.lock.json`));
 if(!bytes.equals(archived)||contract.design!==approval.design||contract.sourceIntegrityRevision!==revision||contract.status!=='SOURCE_REVISION_AUTHORIZED'||contract.schema!==original.schema||!Array.isArray(contract.files))throw Error('invalid_pdf_design_lock');
 const originalByPath=new Map(original.files.map(file=>[file.path,file]));
 if(contract.files.length!==original.files.length+added.size||new Set(contract.files.map(file=>file.path)).size!==contract.files.length)throw Error('invalid_pdf_design_lock');
 const changed=[];
 for(const file of contract.files){
  if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').includes('..')||!/^[a-f0-9]{64}$/u.test(file.sha256))throw Error('invalid_pdf_design_lock');
  const baseline=originalByPath.get(file.path);
  if(!baseline&&!added.has(file.path)||baseline&&(file.kind!==baseline.kind||!allowed.has(file.path)&&file.sha256!==baseline.sha256)||!baseline&&file.kind!=='file')throw Error('invalid_pdf_design_lock');
  let input;try{input=await readFile(join(root,file.path));}catch{changed.push(file.path);continue;}
  if(file.kind==='presentation'){
   const source=input.toString('utf8');const styles=[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gu)].map(m=>m[1]);const footer=/const footer = (`[^;]+`);/u.exec(source)?.[1];
   if(styles.length!==1||!footer)throw Error('missing_frozen_presentation');input=Buffer.from(JSON.stringify({styles,footer}));
  }else if(file.kind!=='file')throw Error('invalid_pdf_design_lock');
  if(sha(input)!==file.sha256)changed.push(file.path);
 }
 if([...originalByPath.keys()].some(path=>!contract.files.some(file=>file.path===path))||[...added].some(path=>!contract.files.some(file=>file.path===path)))throw Error('invalid_pdf_design_lock');
 if(changed.length)throw Error(`frozen_pdf_design_changed: ${changed.join(', ')}. Restore the approved files; do not refresh locks or references to silence a failure.`);
 return {design:contract.design,sourceIntegrityRevision:revision,checked:contract.files.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==2){console.error('No baseline-update or bypass option is available.');process.exitCode=1;}
 else try{console.log(JSON.stringify(await verifyReportDesign()));}catch(e){console.error(e.message);process.exitCode=1;}
}
