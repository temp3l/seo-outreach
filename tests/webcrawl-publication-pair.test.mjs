import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {renderCustomerPdfPair} from '../dist/reports/publication.js';
import {auditResultSha256} from '../dist/reports/qualification.js';
const issuer={name:'Synthetic Reviewer',email:'reviewer@example.test'};
test('direct paired renderer remains HOLD even with caller-supplied qualification',async()=>{
 const {audit}=createEvidenceFixture(1);const q={decision:'RELEASE',target:audit.target,auditSha256:auditResultSha256(audit),qualifiedAt:audit.completedAt,qualifiedBy:'Synthetic',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED'};
 const pair=await renderCustomerPdfPair(audit,async html=>Buffer.from(html),issuer,q);assert.equal(pair.status,'HOLD');for(const bytes of [pair.en,pair.de])assert.match(Buffer.from(bytes).toString(),/data-publication-status="HOLD"/);
 await assert.rejects(renderCustomerPdfPair(audit,async()=>{throw Error('pdf_render_timeout');},issuer,q),/pdf_render_timeout/);
});
test('default English customer output retains page evidence; explicit opt-out remains review-only',async()=>{
 const {runCli}=await import('../dist/compat/cli.js');const root=await mkdtemp('/tmp/webcrawl-customer-evidence-default-');
 try {
  const contact=join(root,'issuer.json');await writeFile(contact,JSON.stringify(issuer),{mode:0o600});
  const html='<main><h1>Fixture</h1><a href="/offer"><img src="/image.png" alt=""></a></main>';
  const transport={resolveAddresses:async()=>['93.184.216.34'],request:async u=>({status:u.pathname==='/'?200:404,headers:{'content-type':u.pathname==='/'?'text/html':'text/plain'},body:Buffer.from(u.pathname==='/'?html:'')})};
  const common=['--pdf','--report-contact-file',contact,'--no-progress','--no-pagespeed','--no-contacts','--no-technology','--no-evidence-pack','--pages','1','--requests','5','--image-checks','0','--retries','0','--interval-ms','0'];
  const full=join(root,'full'),limited=join(root,'limited');await runCli(['https://fixture.example/','--out',full,...common],transport);await runCli(['https://fixture.example/','--out',limited,...common,'--no-page-data'],transport);
  const complete=JSON.parse(await readFile(full+'.review.json')),recovery=JSON.parse(await readFile(limited+'.review.json'));
  assert.equal(complete.reportStatus,'HOLD');assert.equal(recovery.reportStatus,'HOLD');assert.equal(complete.outboundApproval,false);
  assert.equal(complete.customerObservationCount,recovery.customerObservationCount+1);assert.equal(complete.pageEvidencePath,full+'.page-data.json');assert.equal(recovery.pageEvidenceSha256,null);
  await access(full+'.page-data.json');await assert.rejects(access(limited+'.page-data.json'),{code:'ENOENT'});
  await assert.rejects(access(full+'.report-de.pdf'),{code:'ENOENT'});await assert.rejects(access(full+'.operator-status.pdf'),{code:'ENOENT'});
 } finally {await rm(root,{recursive:true,force:true});}
});
