import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { createPsiAssociationJournal } from '../dist/reports/psi-association-journal.js';

test('post-crawl PSI writer → persisted manifest/journal → production report and PDFs', async t => {
  const root=await mkdtemp(join(tmpdir(),'psi-association-production-'),{mode:0o700});
  t.after(()=>rm(root,{recursive:true,force:true}));
  const out=join(root,'out');await mkdir(out,{mode:0o700});
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;audit.capabilities.pagespeed='complete';audit.startedAt=new Date(Date.now()-120_000).toISOString();audit.completedAt=new Date(Date.now()-60_000).toISOString();for(const finding of audit.findings)for(const evidence of finding.evidence)evidence.observedAt=audit.completedAt;
  const auditBytes=Buffer.from(JSON.stringify(audit)),captureBytes=Buffer.from('synthetic persisted homepage capture');
  const manifest={schema:'webcrawl-run-capture-manifest-v1',runId:'synthetic-run-live',sites:[{siteId:'WC-TEST',homepageUrl:audit.target,auditSha256:hash(auditBytes),sourceCaptureSha256:hash(captureBytes),captureStartedAt:audit.startedAt,captureCompletedAt:audit.completedAt}]};
  const manifestBytes=Buffer.from(JSON.stringify(manifest)),manifestPath=join(root,'capture-manifest.json');
  await Promise.all([writeFile(join(root,'audit.json'),auditBytes,{mode:0o600}),writeFile(join(root,'capture.bin'),captureBytes,{mode:0o600}),writeFile(manifestPath,manifestBytes,{mode:0o600}),writeFile(join(root,'contact.json'),JSON.stringify({name:'Fixture Publisher',email:'publisher@example.test'}),{mode:0o600})]);
  const fakeFetch=async request=>{
    assert.equal(request.searchParams.get('strategy'),'mobile');
    assert.deepEqual(request.searchParams.getAll('category'),['performance','accessibility','best-practices','seo']);
    return new Response(JSON.stringify({lighthouseResult:{fetchTime:new Date().toISOString(),requestedUrl:audit.target,finalUrl:audit.target,configSettings:{formFactor:'mobile'},categories:{performance:{score:.65}},audits:{'largest-contentful-paint':{numericValue:10_000,numericUnit:'millisecond'}}}}),{status:200});
  };
  const journalPath=join(root,'psi-journal.json'),writer=createPsiAssociationJournal({path:journalPath,fetch:fakeFetch});
  await writer.initialize();
  const result=await writer.dispatch({runId:manifest.runId,siteId:'WC-TEST',captureManifestSha256:hash(manifestBytes),sourceCaptureSha256:hash(captureBytes),auditSha256:hash(auditBytes),requestedUrl:audit.target,captureStartedAt:audit.startedAt,captureCompletedAt:audit.completedAt});
  assert.equal(result.state,'completed');assert.ok(result.association);assert.ok(result.responseBytes);
  await Promise.all([writeFile(join(root,'psi-response.json'),result.responseBytes,{mode:0o600}),writeFile(join(root,'psi-association.json'),JSON.stringify(result.association),{mode:0o600})]);
  const prepared=spawnSync(process.execPath,['scripts/compat/prepare-customer-review.mjs','--audit',join(root,'audit.json'),'--report-contact-file',join(root,'contact.json'),'--out',join(out,'report'),'--psi-response',join(root,'psi-response.json'),'--psi-association',join(root,'psi-association.json'),'--psi-journal',journalPath,'--capture-manifest',manifestPath],{encoding:'utf8'});
  assert.equal(prepared.status,0,prepared.stderr||prepared.stdout);
  const originalJournal=await readFile(journalPath,'utf8');
  for(const change of [
    events=>{events.at(-1).responseSha256='0'.repeat(64);},
    events=>{events.at(-1).httpStatus=429;},
    events=>{events.at(-1).categories=['performance'];},
    events=>{events.push({...events[0],dispatchId:'another-attempt'});},
    events=>{events.splice(1,1);},
  ]) {
    const tampered=JSON.parse(originalJournal);change(tampered.attempts);await writeFile(journalPath,JSON.stringify(tampered),{mode:0o600});
    const rejected=spawnSync(process.execPath,['scripts/compat/prepare-customer-review.mjs','--audit',join(root,'audit.json'),'--report-contact-file',join(root,'contact.json'),'--out',join(out,'negative'),'--psi-response',join(root,'psi-response.json'),'--psi-association',join(root,'psi-association.json'),'--psi-journal',journalPath,'--capture-manifest',manifestPath],{encoding:'utf8'});
    assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/psi_attempt_journal_ambiguous/);
  }
  await writeFile(journalPath,originalJournal,{mode:0o600});

  const review=JSON.parse(await readFile(join(out,'report.review.json'),'utf8'));
  const html=await readFile(join(out,'report.html'),'utf8');
  assert.equal(review.reportStatus,'HOLD');assert.equal(review.outboundApproval,false);
  assert.equal(review.mobileLabEvidence.association.runId,manifest.runId);
  const perfTopic=review.selectedTopics.find(topic=>topic.code==='pagespeed_category_score');
  assert.ok(perfTopic);assert.equal(perfTopic.performanceEvidence.responseSha256,result.association.responseSha256);assert.equal(perfTopic.performanceEvidence.association.dispatchId,result.association.dispatchId);
  assert.match(html,/LCP was 10\.0 seconds/);assert.match(html,/aria-label=\"Performance 65\/100\"/);
  assert.ok(review.artifacts.some(item=>item.role==='a4'));assert.ok(review.artifacts.some(item=>item.role==='mobile'));
  const reviewBytes=await readFile(join(out,'report.review.json')),qualificationPath=join(root,'qualification.json');
  await writeFile(qualificationPath,JSON.stringify({decision:'RELEASE',target:audit.target,auditSha256:hash(Buffer.from(JSON.stringify(audit))),qualifiedAt:new Date().toISOString(),qualifiedBy:'Synthetic report-readback test',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED',reviewedManifestSha256:hash(reviewBytes)}),{mode:0o600});
  const releaseScript=new URL('../scripts/compat/release-customer-reports.mjs',import.meta.url).pathname;
  const fakeBin=join(root,'fake-bin');await mkdir(fakeBin,{mode:0o700});
  await writeFile(join(fakeBin,'pdftotext'),'#!/bin/sh\n/usr/bin/pdftotext "$@" | sed "s/10\\.0 seconds/20.0 seconds/g"\n',{mode:0o700});
  const altered=spawnSync(process.execPath,[releaseScript,'--audit',join(root,'audit.json'),'--qualification',qualificationPath,'--review-manifest',join(out,'report.review.json'),'--out',join(out,'altered-release')],{encoding:'utf8',env:{...process.env,PATH:`${fakeBin}:${process.env.PATH}`}});
  assert.notEqual(altered.status,0);assert.match(altered.stderr,/review_pdf_content_invalid/);
  const released=spawnSync(process.execPath,[releaseScript,'--audit',join(root,'audit.json'),'--qualification',qualificationPath,'--review-manifest',join(out,'report.review.json'),'--out',join(out,'release')],{encoding:'utf8'});
  assert.equal(released.status,0,released.stderr||released.stdout);
  assert.equal(JSON.parse(await readFile(join(out,'release.release.json'),'utf8')).outboundApproval,false);
});
