import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { customerBriefing, customerPriorityProjection } from '../dist/reports/customer.js';
import { withSavedMobileLabEvidence, mobileLcpEvidence } from '../dist/reports/performance-evidence.js';
import { observationScope } from '../dist/reports/observation-scope.js';
import { renderCustomerSummaryHtml } from '../dist/reports/summary.js';
import { countDeduplicatedIssues } from '../dist/reports/issue-counts.js';
import { CUSTOMER_REPORT_FRESHNESS_MS } from '../dist/reports/freshness.js';
const fixture=(score=65)=>{const {audit}=createEvidenceFixture(1);audit.target=audit.coverage.urls[0].url;audit.capabilities.pagespeed='complete';audit.findings=[{code:'pagespeed_category_score',category:'performance',observed:`performance score: ${score}/100.`,evidence:[{pageUrl:audit.target,observedAt:audit.startedAt,source:'pagespeed',value:score}]}];return audit;};
const raw=(audit,lcp=10000)=>({lighthouseResult:{fetchTime:audit.startedAt,requestedUrl:audit.target,finalUrl:audit.target,configSettings:{formFactor:'mobile'},categories:{performance:{score:audit.findings[0].evidence[0].value/100}},audits:{'largest-contentful-paint':{numericValue:lcp,numericUnit:'millisecond'}}}});
const attach=(audit,r)=>withSavedMobileLabEvidence(audit,Buffer.from(JSON.stringify(r)));
test('customer report distinguishes a saved PSI HTTP 429 from disabled PSI',()=>{
 const audit=fixture();audit.findings=[];audit.capabilities.pagespeed='partial';audit.enrichmentLimitations={pagespeed:'pagespeed_http_429'};
 const html=customerBriefing(audit,'en');assert.match(html,/Mobile performance was not measured in this run/);assert.doesNotMatch(html,/429|quota|provider|Not run for this audit/i);assert.match(customerBriefing(audit,'de'),/Die mobile Leistung wurde in diesem Lauf nicht gemessen/);
});
test('material saved mobile LCP selects the existing topic above score 50; evidence stays immutable and lab dated',()=>{
 for(const score of [51,53,56,63,65,66,94]){
 const audit=fixture(score),before=JSON.stringify(audit);attach(audit,raw(audit));
 const p=customerPriorityProjection(audit);assert.ok(p.selected.some(t=>t.measurement==='performance'));assert.equal(p.deduplicatedIssues,1);
 const html=renderCustomerSummaryHtml(audit,'en');assert.match(html,/mobile PageSpeed lab measurement recorded 29 Oct 2026/);assert.match(html,/LCP was 10.0 seconds/);assert.match(html,/not a measurement of lost enquiries/);assert.equal(JSON.stringify(audit),before);
 }
 for(const lcp of [0,2500,4000]){const audit=fixture();attach(audit,raw(audit,lcp));assert.equal(customerPriorityProjection(audit).selected.length,0);}
 assert.equal(customerPriorityProjection(fixture(49)).selected[0].measurement,'performance');
});
test('saved mobile evidence rejects stale, mismatched, desktop, unavailable and conflicting measurements',()=>{
 for(const mutate of [r=>{r.lighthouseResult.fetchTime='2000-01-01T00:00:00Z';},r=>{r.lighthouseResult.finalUrl='https://elsewhere.example/';},r=>{r.lighthouseResult.requestedUrl+='?variant=1';},r=>{r.lighthouseResult.categories.performance.score=.5;},r=>{r.lighthouseResult.runtimeError={code:'FAILED'};},r=>{r.lighthouseResult.configSettings.formFactor='desktop';}]){const a=fixture(),r=raw(a);mutate(r);assert.throws(()=>attach(a,r),/saved_psi_audit_mismatch/);assert.equal(mobileLcpEvidence(a),undefined);}
 const a=fixture(),metric={code:'pagespeed_lab_lcp',category:'performance',observed:'Mobile lab',evidence:[{...a.findings[0].evidence[0],value:10000}]};a.findings.push(metric);assert.equal(mobileLcpEvidence(a).milliseconds,10000);a.findings.push({...metric,evidence:[{...metric.evidence[0],value:20000}]});assert.equal(mobileLcpEvidence(a),undefined);
});
test('post-crawl PSI requires exact persisted run/site capture provenance and response digest',()=>{
 const audit=fixture(), response=raw(audit); response.lighthouseResult.fetchTime=new Date(Date.parse(audit.completedAt)+600_000).toISOString();
 const bytes=Buffer.from(JSON.stringify(response)), sha=value=>createHash('sha256').update(value).digest('hex');
 const association={schema:'psi-run-association-v1',runId:'run-2026-unique',siteId:'WC-TEST',captureManifestSha256:'a'.repeat(64),sourceCaptureSha256:'b'.repeat(64),captureCompletedAt:audit.completedAt,auditSha256:sha(JSON.stringify(audit)),requestedUrl:audit.target,finalUrl:audit.target,strategy:'mobile',categories:['performance','accessibility','best-practices','seo'],dispatchId:randomUUID(),requestedAt:new Date(Date.parse(audit.completedAt)+540_000).toISOString(),completedAt:new Date(Date.parse(audit.completedAt)+660_000).toISOString(),responseSha256:sha(bytes),result:'completed'};
 const expected={...association};
 withSavedMobileLabEvidence(audit,bytes,undefined,association,expected);
 assert.equal(mobileLcpEvidence(audit).association.runId,'run-2026-unique');
 assert.ok(customerPriorityProjection(audit).selected.some(topic=>topic.measurement==='performance'));
 for(const change of [
  {runId:'other-run'}, {siteId:'WC-OTHER'}, {requestedUrl:'https://other.example/'},
  {strategy:'desktop'}, {dispatchId:randomUUID()}, {captureManifestSha256:'c'.repeat(64)},
  {sourceCaptureSha256:'d'.repeat(64)}, {responseSha256:'e'.repeat(64)}, {result:'unknown'},
 ]) {
  const altered={...association,...change};
  assert.throws(()=>withSavedMobileLabEvidence(fixture(),bytes,undefined,altered,expected),/saved_psi_audit_mismatch/,JSON.stringify(change));
 }
 const stale=fixture();stale.startedAt=new Date(Date.now()-CUSTOMER_REPORT_FRESHNESS_MS-60_000).toISOString();stale.completedAt=new Date(Date.now()-60_000).toISOString();for(const finding of stale.findings)for(const evidence of finding.evidence)evidence.observedAt=stale.completedAt;
 const staleResponse=raw(stale);staleResponse.lighthouseResult.fetchTime=new Date().toISOString();const staleBytes=Buffer.from(JSON.stringify(staleResponse));const staleAssociation={...association,auditSha256:sha(JSON.stringify(stale)),captureCompletedAt:stale.completedAt,responseSha256:sha(staleBytes),requestedAt:new Date().toISOString(),completedAt:new Date().toISOString()};
 assert.throws(()=>withSavedMobileLabEvidence(stale,staleBytes,undefined,staleAssociation,{...staleAssociation}),/saved_psi_audit_mismatch/,'a recent completion cannot refresh a stale original capture start');
 assert.throws(()=>withSavedMobileLabEvidence(fixture(),bytes),/saved_psi_audit_mismatch/,'legacy unattached post-crawl PSI fails closed');
 assert.throws(()=>withSavedMobileLabEvidence(fixture(),Buffer.concat([bytes,Buffer.from('tampered')]),undefined,association,expected));
});
test('invalid canonical and proven contact error outrank length warnings; counts match selected details',()=>{
 const a=fixture(95),page=a.target;a.findings.push(...['invalid_canonical','meta_description_length','missing_meta_description','images_missing_dimensions','missing_h1','heading_hierarchy_skip','missing_canonical'].map(code=>({code,category:'indexability',severity:code==='invalid_canonical'?'medium':'low',observed:code,evidence:[{pageUrl:page,observedAt:a.startedAt,source:'http'}]})));
 const p=customerPriorityProjection(a);assert.equal(p.selected[0].code,'invalid_canonical');const shown=new Set(p.selected.map(t=>t.code));assert.ok(p.countedFindings.some(f=>!shown.has(f.code)),'the v6 badge retains admitted observations before the six-card limit');assert.equal(p.deduplicatedIssues,countDeduplicatedIssues(p.countedFindings));assert.equal(p.selected.length,6);
});
test('asset observations carry affected-page references but do not invent remediation groups',()=>{
 const a=fixture(),asset='https://fixture.example/shared.png';const f={code:'images_missing_alt',category:'accessibility',observed:'missing',evidence:['/a','/b'].map(path=>({pageUrl:new URL(path,a.target).href,observedAt:a.startedAt,source:'http',imageObservations:[{src:asset,occurrence:0,scope:'document',altStatus:'missing',widthStatus:'missing',heightStatus:'missing'}]}))};
 const p=observationScope(a,[f]);assert.equal(p.evidenceInstances,2);assert.equal(p.observedImageAssets,1);assert.equal(p.assetReviewGroups.length,1);assert.equal(p.assetReviewGroups[0].affectedPages.length,2);assert.equal(p.substantiatedRemediationGroups,null);
});


test('saved-response review readback reproduces counts and rejects changed bytes without releasing',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {restoreSavedMobileLabEvidence}=await import('../dist/reports/performance-evidence.js');
 const dir=await mkdtemp('/tmp/report-lab-readback-');
 try {
  const a=fixture(),path=dir+'/psi.json',bytes=Buffer.from(JSON.stringify(raw(a)));await writeFile(path,bytes);withSavedMobileLabEvidence(a,bytes,path);
  const descriptor=structuredClone(mobileLcpEvidence(a)),replay=structuredClone(a);await restoreSavedMobileLabEvidence(replay,descriptor);
  assert.equal(customerPriorityProjection(replay).deduplicatedIssues,customerPriorityProjection(a).deduplicatedIssues);
  await writeFile(path,Buffer.from(JSON.stringify(raw(a,20000))));await assert.rejects(restoreSavedMobileLabEvidence(structuredClone(a),descriptor),/review_mobile_lab_evidence_changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('asset review references retain distinct query identities while withholding query values',()=>{
 const a=fixture();const f={code:'images_missing_alt',category:'accessibility',observed:'missing',evidence:[1,2].map(i=>({pageUrl:'https://fixture.example/offer?variant='+i,observedAt:a.startedAt,source:'http',imageObservations:[{src:'https://fixture.example/shared.png',occurrence:0,scope:'document',altStatus:'missing',widthStatus:'missing',heightStatus:'missing'}]}))};
 const scope=observationScope(a,[f]);assert.equal(scope.assetReviewGroups[0].affectedPages.length,2);assert.notEqual(...scope.assetReviewGroups[0].affectedPages.map(p=>p.identitySha256));assert.doesNotMatch(JSON.stringify(scope),/variant=/u);
});

test('analyzed HTML counts require matching saved evidence rather than response status alone',async()=>{
 const {reportEvidenceCounts}=await import('../dist/reports/references.js');
 const {withCustomerEvidence}=await import('../dist/reports/customer-evidence.js');
 const {auditResultSha256}=await import('../dist/reports/qualification.js');
 const {audit,pageData}=createEvidenceFixture(2);Object.assign(pageData,{target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)});
 assert.equal(reportEvidenceCounts(audit).analyzedHtmlPages,null);assert.equal(reportEvidenceCounts(withCustomerEvidence(audit,pageData)).analyzedHtmlPages,2);
 pageData.auditSha256='0'.repeat(64);assert.equal(reportEvidenceCounts(withCustomerEvidence(audit,pageData)).analyzedHtmlPages,null);
});


test('v6 badge keeps admitted observations before the card limit and traces each source in the manifest',async()=>{
 const {createCustomerReviewManifest}=await import('../dist/reports/review.js');const {customerPriorityTitle}=await import('../dist/reports/customer.js');const audit=fixture(95),page=audit.target;
 audit.findings.push(...['invalid_canonical','meta_description_length','missing_meta_description','images_missing_dimensions','missing_h1','heading_hierarchy_skip','missing_canonical'].map(code=>({code,category:'indexability',severity:'low',observed:code,evidence:[{pageUrl:page,observedAt:audit.startedAt,source:'http'}]})));
 const projection=customerPriorityProjection(audit),shown=new Set(projection.selected.map(t=>t.code));assert.ok(projection.countedFindings.some(f=>!shown.has(f.code)));
 const pdf=Buffer.from('%PDF-fixture'),review=createCustomerReviewManifest(audit,'en',[{role:'a4',path:'/tmp/ledger-a4.pdf',content:pdf},{role:'mobile',path:'/tmp/ledger-mobile.pdf',content:pdf}]);
 assert.equal(review.customerObservationCount,projection.deduplicatedIssues);assert.equal(review.admittedEvidenceReferencesOmitted,0);
 assert.equal(review.admittedEvidenceReferences.length,projection.countedFindings.reduce((sum,f)=>sum+f.evidence.length,0));
 assert.deepEqual(review.selectedTopics.map(topic=>topic.code),projection.selected.map(topic=>topic.code));
 assert.deepEqual(review.selectedTopics.map(topic=>topic.title),projection.selected.map(topic=>customerPriorityTitle(topic,'en')));
 for(const ref of [...review.admittedEvidenceReferences,...review.selectedTopics.flatMap(topic=>topic.evidenceReferences)])assert.ok(audit.findings[ref.findingIndex].evidence[ref.evidenceIndex]);
 for(const topic of review.selectedTopics){const expected=projection.countedFindings.filter(f=>topic.findingCodes.includes(f.code)).reduce((n,f)=>n+f.evidence.length,0);assert.equal(topic.evidenceReferences.length,expected);}
 assert.equal(review.reportStatus,'HOLD');assert.equal(review.outboundApproval,false);
});


test('partial coverage remains explicit when no customer topic is selected and in review metadata',async()=>{
 const {createCustomerReviewManifest}=await import('../dist/reports/review.js');const audit=fixture(95);audit.findings=[];audit.crawl.limitations=['content_inspection_incomplete'];
 const html=renderCustomerSummaryHtml(audit,'en');assert.match(html,/No specific priority was selected/);assert.match(html,/some pages or checks were not inspected/);
 const pdf=Buffer.from('%PDF-fixture'),review=createCustomerReviewManifest(audit,'en',[{role:'a4',path:'/tmp/partial-a4.pdf',content:pdf},{role:'mobile',path:'/tmp/partial-mobile.pdf',content:pdf}]);
 assert.deepEqual(review.selectedTopics,[]);
 assert.equal(review.scanExecutionStatus,'COMPLETED');assert.equal(review.scanCoverageStatus,'PARTIAL');assert.equal(review.reportStatus,'HOLD');assert.equal(review.outboundApproval,false);
});


test('even a fresh valid synthetic qualification cannot make direct renderers client-ready',async()=>{
 const {auditResultSha256,isCustomerReleaseQualified}=await import('../dist/reports/qualification.js');const {renderMobileCustomerPdf}=await import('../dist/reports/mobile.js');const {renderCustomerPdfPair}=await import('../dist/reports/publication.js');
 const {audit}=createEvidenceFixture(1),now=new Date().toISOString();audit.target=audit.coverage.urls[0].url;audit.startedAt=now;audit.completedAt=now;
 audit.findings=[{code:'missing_meta_description',category:'metadata',observed:'Missing',evidence:[{pageUrl:audit.target,source:'http',observedAt:now}]}];audit.coverage.findings={records:1,checkCodes:1,affectedPages:1,evidenceOccurrences:1,byCheck:[{code:'missing_meta_description',records:1,affectedPages:1,evidenceOccurrences:1}]};
 const qualification={decision:'RELEASE',target:audit.target,auditSha256:auditResultSha256(audit),qualifiedAt:now,qualifiedBy:'Synthetic reviewer',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED'},issuer={name:'Synthetic',email:'fixture@example.test'};
 assert.equal(isCustomerReleaseQualified(audit,qualification),true);assert.match(renderCustomerSummaryHtml(audit,'en',{issuer,qualification}),/data-publication-status="HOLD"/);
 const renderer=async html=>Buffer.from(html),mobile=await renderMobileCustomerPdf(audit,renderer,issuer,'en','CLIENT_READY',qualification),pair=await renderCustomerPdfPair(audit,renderer,issuer,qualification);
 assert.match(mobile.toString(),/data-publication-status="HOLD"/);assert.equal(pair.status,'HOLD');assert.match(pair.en.toString(),/data-publication-status="HOLD"/);
});

test('a visible mobile laboratory score includes its measurement time even without a performance card',()=>{
 assert.doesNotMatch(customerBriefing(fixture(95),'en'),/Mobile lab measured/);
 const audit=fixture(95);attach(audit,raw(audit,2500));assert.equal(customerPriorityProjection(audit).selected.length,0);const en=customerBriefing(audit,'en'),de=customerBriefing(audit,'de');assert.match(en,/Mobile lab measured 29 Oct 2026, 00:00 UTC; not field data/);assert.match(de,/Mobile Labormessung vom 29\.10\.2026, 00:00 UTC; keine Felddaten/);
});
