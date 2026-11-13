import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyReportDesign} from '../scripts/check-report-design.mjs';
import {assertFrozenCustomerStyles,CUSTOMER_PDF_DESIGN} from '../dist/reports/design-contract.js';

test('approved design lock rejects renderer and reference drift',async()=>{
 const contract=JSON.parse(await readFile(new URL('../report-design.lock.json',import.meta.url),'utf8'));
 assert.equal((await verifyReportDesign()).design,CUSTOMER_PDF_DESIGN);
 const root=await mkdtemp(join(tmpdir(),'report-design-lock-'));
 try{
  await copyFile(new URL('../report-design.lock.json',import.meta.url),join(root,'report-design.lock.json'));
  for(const f of contract.files){const p=join(root,f.path);await mkdir(dirname(p),{recursive:true});await copyFile(new URL('../'+f.path,import.meta.url),p);}
  const revision='docs/pdf-design-versions/customer-pdf-v6-source-accuracy-20261113-operator-coverage/report-design.lock.json';await mkdir(dirname(join(root,revision)),{recursive:true});await copyFile(new URL('../'+revision,import.meta.url),join(root,revision));
  for(const name of ['src/reports/customer.ts','src/reports/summary.ts','src/reports/mobile.ts','tests/fixtures/report-golden/a4-en-1.png']){
   const path=join(root,name),bytes=await readFile(path);await writeFile(path,name==='src/reports/customer.ts'?Buffer.from(bytes.toString().replace('background:#102d3a','background:#702d3a')):Buffer.concat([bytes,Buffer.from('changed')]));
   await assert.rejects(verifyReportDesign(root),/frozen_pdf_design_changed/);await writeFile(path,bytes);
  }
  assert.equal((await verifyReportDesign(root)).design,CUSTOMER_PDF_DESIGN);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('runtime accepts frozen variants and rejects color, padding and appended overrides',async()=>{
 for(const name of ['a4-en','a4-de','a4-pt-BR','mobile-en','mobile-de','mobile-pt-BR']){
  const html=await readFile(new URL(`./fixtures/report-golden/${name}.html`,import.meta.url),'utf8');
  assert.doesNotThrow(()=>assertFrozenCustomerStyles(html));
  for(const changed of [html.replace('background:#102d3a','background:#702d3a'),html.replace('padding:0 12mm','padding:12mm'),html.replace('</head>','<style>footer{margin:20px}</style></head>'),html.replace('class="hero"','class="hero" style="background:red"')])
   assert.throws(()=>assertFrozenCustomerStyles(changed),/frozen PDF design changed/);
 }
});
