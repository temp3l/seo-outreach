import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { auditResultSha256 } from '../dist/reports/qualification.js';
const execFile=promisify(exec),hash=b=>createHash('sha256').update(b).digest('hex');
const script=new URL('../scripts/compat/prepare-customer-review.mjs',import.meta.url).pathname;

test('prepares clean private PDFs from saved evidence with a HOLD manifest and no source mutation',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-prepare-review-');
 try{
  const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;
  audit.findings=[{code:'missing_meta_description',category:'metadata',observed:'Synthetic missing description',evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.startedAt}]}];
  audit.coverage.findings={records:1,checkCodes:1,affectedPages:1,evidenceOccurrences:1,byCheck:[{code:'missing_meta_description',records:1,affectedPages:1,evidenceOccurrences:1}]};
  const ap=join(root,'audit.json'),cp=join(root,'issuer.json'),prefix=join(root,'review');
  const original=Buffer.from(JSON.stringify(audit));await writeFile(ap,original,{mode:0o600});await writeFile(cp,JSON.stringify({name:'Synthetic Review Issuer',email:'issuer@example.test'}),{mode:0o600});
  const args=[script,'--audit',ap,'--report-contact-file',cp,'--out',prefix];
  await execFile(process.execPath,args);
  const m=JSON.parse(await readFile(`${prefix}.review.json`));assert.equal(m.reportStatus,'HOLD');assert.equal(m.outboundApproval,false);assert.equal(m.auditSha256,auditResultSha256(audit));
  assert.deepEqual(await readFile(ap),original);assert.equal(m.artifacts.length,2);
  for(const a of m.artifacts){
   const bytes=await readFile(a.path);assert.equal(hash(bytes),a.sha256);assert.equal(bytes.length,a.bytes);
   const {stdout:text}=await execFile('pdftotext',['-layout',a.path,'-']);assert.doesNotMatch(text,/HOLD|NOT FOR CUSTOMER|Recorded observation|2026-10-29T/u);assert.match(text,/Synthetic Review Issuer/u);
   const {stdout:urls}=await execFile('pdfinfo',['-url',a.path]);assert.ok(urls.includes(audit.target));
  }
  const first=await readFile(m.artifacts[0].path);await assert.rejects(execFile(process.execPath,args),e=>/output_collision/u.test(e.stderr));assert.deepEqual(await readFile(m.artifacts[0].path),first);
  assert.equal((await readdir(root)).some(n=>n.endsWith('.release.json')),false);
 }finally{await rm(root,{recursive:true,force:true});}
});
