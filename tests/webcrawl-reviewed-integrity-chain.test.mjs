import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,link,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {auditResultSha256} from '../dist/reports/qualification.js';
import {TECHNOLOGY_PROFILE} from '@spora/webcrawl/enrichments/technology';
import {checkEntry,digest} from '../scripts/compat/data-integrity-core.mjs';
const exec=promisify(execFile);

test('real saved PDF producer -> approval -> integrity consumer binds bytes, rejects tampering, retains no-send',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-reviewed-integrity-');
 try{
  const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;
  audit.startedAt=new Date(Date.now()-120000).toISOString();audit.completedAt=new Date(Date.now()-90000).toISOString();audit.crawlSettings.technologyProfile=TECHNOLOGY_PROFILE;
  audit.findings=[{code:'missing_meta_description',category:'metadata',observed:'Synthetic description',evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.completedAt}]}];
  audit.coverage.findings={records:1,checkCodes:1,affectedPages:1,evidenceOccurrences:1,byCheck:[{code:'missing_meta_description',records:1,affectedPages:1,evidenceOccurrences:1}]};
  const put=(p,v)=>writeFile(p,JSON.stringify(v),{mode:0o600});
  const ap=root+'/audit.json',qp=root+'/q.json',rp=root+'/prepared.review.json',release=root+'/approved.release.json';
  await put(ap,audit);await put(root+'/issuer.json',{name:'Synthetic checker integration',email:'issuer@example.test'});
  await exec(process.execPath,['scripts/compat/prepare-customer-review.mjs','--audit',ap,'--report-contact-file',root+'/issuer.json','--out',root+'/prepared']);
  const rb=await readFile(rp),review=JSON.parse(rb),before=await Promise.all(review.artifacts.map(a=>readFile(a.path)));
  const q={decision:'RELEASE',target:audit.target,auditSha256:auditResultSha256(audit),qualifiedAt:new Date().toISOString(),qualifiedBy:'Synthetic integration reviewer',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED',reviewedManifestSha256:digest(rb)};
  await put(qp,q);
  await exec(process.execPath,['scripts/compat/release-customer-reports.mjs','--audit',ap,'--qualification',qp,'--review-manifest',rp,'--out',root+'/approved'],{env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:root+'/no-browser'}});
  const entry={audit:ap,qualification:qp,reviewManifest:rp,release};
  const input=root+'/input.json';await put(input,{schema:'webcrawl-integrity-input-v1',entries:[{id:'synthetic-reviewed',...entry}]});
  const {stdout:ledger}=await exec(process.execPath,['scripts/compat/check-data-integrity.mjs','--input',input]);
  const checked=JSON.parse(ledger);assert.equal(checked.summary.ERROR,0);assert.equal(checked.rows[0].release.status,'CURRENT_QUALIFICATION_VERIFIED');
  const result=await checkEntry(entry);assert.equal(result.release?.status,'CURRENT_QUALIFICATION_VERIFIED',JSON.stringify(result));
  for(const code of ['review_manifest_binding','release_hash_binding','current_customer_qualification'])assert.ok(result.checks.some(c=>c.code===code&&c.status==='PASS'),code);
  assert.equal(result.decision,'HOLD','missing evidence pack/handoff must remain HOLD');
  const stale=await checkEntry(entry,Date.now()+25*3600000);assert.equal(stale.decision,'HOLD');assert.equal(stale.release.status,'ARCHIVED_OR_UNQUALIFIED');
  const released=JSON.parse(await readFile(release));assert.equal(released.outboundApproval,false);
  for(let i=0;i<before.length;i++)assert.deepEqual(await readFile(review.artifacts[i].path),before[i]);
  async function rejects(entry,code){const r=await checkEntry(entry);assert.equal(r.decision,'ERROR',JSON.stringify(r));assert.ok(r.checks.some(c=>c.code===code),JSON.stringify(r));return r;}
  await rejects({...entry,reviewManifest:undefined},'entry_shape_invalid');
  const missing={...entry};delete missing.reviewManifest;await rejects(missing,'review_manifest_required');
  await writeFile(rp,Buffer.concat([rb,Buffer.from(' ')]));await rejects(entry,'review_manifest_hash_mismatch');await writeFile(rp,rb);
  await put(release,{...released,artifacts:[{...released.artifacts[0],path:'/outside/must-not-read.pdf'},released.artifacts[1]]});
  const bad=await rejects(entry,'release_artifact_path_invalid');assert.ok(!bad.files.some(f=>f.path==='/outside/must-not-read.pdf'));await put(release,released);
  await chmod(review.artifacts[0].path,0o644);await rejects(entry,'unsafe_or_oversized_file');await chmod(review.artifacts[0].path,0o600);
  await link(review.artifacts[0].path,root+'/hardlink.pdf');await rejects(entry,'unsafe_or_oversized_file');await unlink(root+'/hardlink.pdf');
  const duplicate={...review,artifacts:[review.artifacts[0],{...review.artifacts[1],role:'a4'}]};await put(rp,duplicate);await put(qp,{...q,reviewedManifestSha256:digest(await readFile(rp))});await rejects(entry,'review_manifest_invalid');await writeFile(rp,rb);await put(qp,q);
  await writeFile(review.artifacts[0].path,'%PDF- changed');await rejects(entry,'release_artifact_hash_mismatch');await writeFile(review.artifacts[0].path,before[0]);
  await put(release,{...released,outboundApproval:true});await rejects(entry,'release_manifest_invalid');await put(release,released);
  await put(release,{...released,artifacts:[released.artifacts[0],released.artifacts[0]]});await rejects(entry,'release_artifact_path_invalid');await put(release,released);
  await put(qp,{...q,security:'NOT_CLEARED'});await put(release,{...released,qualificationSha256:digest(await readFile(qp))});
  const held=await checkEntry(entry);assert.equal(held.decision,'HOLD');assert.equal(held.release.status,'ARCHIVED_OR_UNQUALIFIED');
 }finally{await rm(root,{recursive:true,force:true});}
});
