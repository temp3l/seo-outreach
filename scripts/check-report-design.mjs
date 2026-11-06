#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function verifyReportDesign(root=resolve(dirname(fileURLToPath(import.meta.url)),'..')) {
 const contract=JSON.parse(await readFile(join(root,'report-design.lock.json'),'utf8'));
 if(contract.design!=='customer-pdf-v6-20261106'||contract.schema!=='spora-pdf-design-lock-v1'||!Array.isArray(contract.files)||contract.files.length<20)throw Error('invalid_pdf_design_lock');
 const changed=[];
 for(const file of contract.files){
  if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').includes('..')||!/^[a-f0-9]{64}$/u.test(file.sha256))throw Error('invalid_pdf_design_lock');
  let bytes;try{bytes=await readFile(join(root,file.path));}catch{changed.push(file.path);continue;}
  if(file.kind==='presentation') {
   const source=bytes.toString('utf8');
   const styles=[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gu)].map(m=>m[1]);
   const footer=/const footer = (`[^;]+`);/u.exec(source)?.[1];
   if(styles.length!==1||!footer)throw Error('missing_frozen_presentation');
   bytes=Buffer.from(JSON.stringify({styles,footer}));
  }else if(file.kind!=='file')throw Error('invalid_pdf_design_lock');
  if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)changed.push(file.path);
 }
 if(changed.length)throw Error(`frozen_pdf_design_changed: ${changed.join(', ')}. Restore the approved files. A new design requires explicit user approval and a reviewed versioned baseline; never refresh the lock to silence this failure.`);
 return {design:contract.design,checked:contract.files.length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==2){console.error('No baseline-update or bypass option is available.');process.exitCode=1;}
 else try{console.log(JSON.stringify(await verifyReportDesign()));}catch(e){console.error(e.message);process.exitCode=1;}
}
