import {sampleFile} from './fixtures/data.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {analyze,render} from '../dist/pipeline.js';

// Positive styled customer publication is exercised by webcrawl-reviewed-pdf-release,
// reviewed-integrity-chain and release-qualification; legacy approvals cannot bypass it.
test('legacy analysis PDFs stay internal and cannot be promoted by an old customer review',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seo-frozen-customer-route-'));
 try{
  for(const site of ['site-04.zip','site-05.zip']){
   const out=join(dir,site),result=await analyze({input:sampleFile(site),out,locale:'en',dryRun:false});
   assert.equal(result.gates.CUSTOMER_READY.status,'HOLD');assert.equal(result.gates.OUTREACH_READY.status,'HOLD');
   const pdf=await readFile(join(out,'report.pdf'));assert.ok(pdf.toString('latin1').includes('INTERNAL / HOLD'));
   const approval=JSON.parse(await readFile(join(out,'customer-review.json'),'utf8'));approval.coverageReviewed=true;
   for(const f of approval.findings){f.approved=true;f.indexingIntended=f.code==='noindex'?true:null;}
   const file=join(dir,site+'.review.json');await writeFile(file,JSON.stringify(approval));
   for(const dryRun of [true,false]){
    const released=join(dir,site+'-'+dryRun);
    await assert.rejects(render({analysis:join(out,'analysis.json'),out:released,customerReview:file,dryRun}),/customer_pdf_requires_frozen_design_use_reports_prepare_and_release/);
    await assert.rejects(access(released));
   }
   const replay=join(dir,site+'-replay');const held=await render({analysis:join(out,'analysis.json'),out:replay,dryRun:false});
   assert.equal(held.gates.CUSTOMER_READY.status,'HOLD');await assert.rejects(access(join(replay,'customer-report.pdf')));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('partial crawl scope remains a recorded limitation for internal evidence review',async()=>{
 const result=await analyze({input:sampleFile('site-01.zip'),out:'/tmp/unused-design-dry-run',locale:'en',dryRun:true});
 assert.equal(result.reportAssessment.status,'READY_FOR_REVIEW');assert.deepEqual(result.reportAssessment.blockers,[]);
 assert.ok(result.reportAssessment.limitations.includes('unattempted_page_urls'));assert.equal(result.findings,3);
});
