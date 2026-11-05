import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyze, render } from '../dist/pipeline.js';
import { isArtifactDirectoryPublished, readPublishedArtifact } from '../dist/files.js';

const site05=sampleFile('site-05.zip');
const site04=sampleFile('site-04.zip');
const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex');

test('customer report requires an explicit fresh six-finding review and preserves HOLD on outreach',async(t)=>{
  if(!existsSync(site05)||!existsSync(site04)){t.skip('verified Belize archive fixtures unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'seo-customer-release-'));
  const originalFetch=globalThis.fetch;let networkCalls=0;
  globalThis.fetch=async()=>{networkCalls++;throw new Error('unexpected_network_request');};
  try{
    const source=join(dir,'site.evidence.zip');await copyFile(site05,source);
    const analyzedDir=join(dir,'analyzed');
    const analyzed=await analyze({input:source,out:analyzedDir,locale:'en',dryRun:false});
    assert.equal(analyzed.gates.CUSTOMER_READY.status,'HOLD');
    assert.equal(analyzed.gates.OUTREACH_READY.status,'HOLD');
    const files=await readdir(analyzedDir);
    assert.ok(files.includes('customer-review.json'));assert.ok(files.includes('report.pdf'));assert.ok(!files.includes('customer-report.pdf'));
    const heldPdf=await readFile(join(analyzedDir,'report.pdf'));
    assert.ok(heldPdf.subarray(0,8).toString('latin1').startsWith('%PDF-'));
    assert.ok(heldPdf.toString('latin1').includes('INTERNAL / HOLD'));
    for(const name of ['whatsapp-opener.txt','whatsapp-after-interest.txt']){
      const draft=(await readFile(join(analyzedDir,name),'utf8'));
      assert.match(draft,/INTERNAL \/ HOLD — DO NOT SEND/);
    }

    const template=JSON.parse(await readFile(join(analyzedDir,'customer-review.json'),'utf8'));
    assert.deepEqual(Object.keys(template).sort(),['analysisSha256','coverageReviewed','findings','reportPdfSha256','schema'].sort());
    assert.equal(template.schema,'seo-outreach-customer-review-v1');assert.equal(template.coverageReviewed,false);
    assert.equal(template.findings.length,6);assert.ok(template.findings.every(f=>f.approved===false&&f.indexingIntended===null));
    assert.ok(template.findings.every(f=>typeof f.issueId==='string'&&/^https:\/\//.test(f.reference)));
    const analysisBytes=await readPublishedArtifact(analyzedDir,'analysis.json');
    const reportBytes=await readPublishedArtifact(analyzedDir,'report.pdf');
    assert.equal(template.analysisSha256,sha(analysisBytes));assert.equal(template.reportPdfSha256,sha(reportBytes));

    const noindexId=template.findings.find(finding=>finding.code==='noindex')?.issueId;
    assert.ok(noindexId,'selected review set should contain its noindex issue');
    const approval=structuredClone(template);approval.coverageReviewed=true;
    for(const finding of approval.findings){finding.approved=true;finding.indexingIntended=finding.issueId===noindexId?true:null;}
    const reviewPath=join(dir,'operator-review.json');await writeFile(reviewPath,JSON.stringify(approval));

    const previewDir=join(dir,'approved-review-preview');
    const preview=await render({analysis:join(analyzedDir,'analysis.json'),out:previewDir,customerReview:reviewPath,dryRun:true});
    assert.equal(preview.gates.CUSTOMER_READY.status,'HOLD');assert.equal(existsSync(previewDir),false);

    const approvedDir=join(dir,'approved-render');
    const approved=await render({analysis:join(analyzedDir,'analysis.json'),out:approvedDir,customerReview:reviewPath,dryRun:false});
    assert.equal(approved.gates.CUSTOMER_READY.status,'READY');assert.equal(approved.gates.OUTREACH_READY.status,'HOLD');
    const approvedFiles=await readdir(approvedDir);assert.ok(approvedFiles.includes('customer-report.pdf'));assert.ok(approvedFiles.includes('report.pdf'));
    const customerPdf=await readFile(join(approvedDir,'customer-report.pdf'));
    assert.ok(customerPdf.subarray(0,8).toString('latin1').startsWith('%PDF-'));
    assert.ok((await readFile(join(approvedDir,'report.pdf'))).toString('latin1').includes('INTERNAL / HOLD'));
    for(const name of ['whatsapp-opener.txt','whatsapp-after-interest.txt']){
      const draft=(await readFile(join(approvedDir,name),'utf8'));
      assert.match(draft,/INTERNAL \/ HOLD — DO NOT SEND/);assert.match(draft,/reviewed report/i);
    }

    const expectRejectedWithoutOutput=async(label,review)=>{
      const reviewFile=join(dir,`${label}-review.json`),out=join(dir,`${label}-out`);
      await writeFile(reviewFile,JSON.stringify(review));
      await assert.rejects(()=>render({analysis:join(analyzedDir,'analysis.json'),out,customerReview:reviewFile,dryRun:true}));
      assert.equal(await isArtifactDirectoryPublished(out),false);
      assert.equal(existsSync(join(out,'customer-report.pdf')),false);
    };
    const stale=structuredClone(approval);stale.analysisSha256='0'.repeat(64);await expectRejectedWithoutOutput('stale',stale);
    const partial=structuredClone(approval);partial.findings[0].approved=false;await expectRejectedWithoutOutput('partial',partial);
    const unclearIndex=structuredClone(approval);unclearIndex.findings.find(f=>f.issueId===noindexId).indexingIntended=null;await expectRejectedWithoutOutput('indexing-unknown',unclearIndex);

    const implicitDir=join(dir,'implicit-review-render');
    const implicit=await render({analysis:join(approvedDir,'analysis.json'),out:implicitDir,dryRun:false});
    assert.equal(implicit.gates.CUSTOMER_READY.status,'HOLD');
    assert.equal(existsSync(join(implicitDir,'customer-report.pdf')),false);

    await copyFile(site04,source);
    await copyFile(site04,join(analyzedDir,'source.zip'));
    const staleSourceOut=join(dir,'changed-source-out');
    await assert.rejects(()=>render({analysis:join(analyzedDir,'analysis.json'),out:staleSourceOut,customerReview:reviewPath,dryRun:false}));
    assert.equal(await isArtifactDirectoryPublished(staleSourceOut),false);
    assert.equal(existsSync(join(staleSourceOut,'customer-report.pdf')),false);
    assert.equal(networkCalls,0);
  }finally{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});
