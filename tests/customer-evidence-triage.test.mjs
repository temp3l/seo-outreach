import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageDataExport} from '@spora/webcrawl/analysis/page-data';
import {auditResultSha256} from '../dist/reports/qualification.js';
import {customerEvidenceTriage,withCustomerEvidence} from '../dist/reports/customer-evidence.js';
import {customerPriorityProjection} from '../dist/reports/customer.js';
import {renderCustomerSummaryHtml} from '../dist/reports/summary.js';
import {renderCustomerPdfPair} from '../dist/reports/publication.js';
import {renderMobileCustomerPdf} from '../dist/reports/mobile.js';
import {renderOperatorStatusHtml} from '../dist/reports/summary.js';
import {createCustomerReviewManifest} from '../dist/reports/review.js';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {auditWebsiteWithPageData} from '@spora/webcrawl/core/audit';
import {createDefaultCrawlPolicy} from '@spora/webcrawl/core/defaults';

test('canonical evidence distinguishes consolidation, independent pages and uncertainty',()=>{
 const {audit}=createEvidenceFixture(2);const urls=audit.coverage.urls.map(p=>p.url);
 const finding={code:'duplicate_title_across_pages',category:'metadata',observed:'same',evidence:urls.map(pageUrl=>({pageUrl,source:'http',observedAt:audit.startedAt}))};
 function data(canonicals,robots=['index','index']) {const pages=urls.map((url,i)=>({requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:50,xRobotsTag:robots[i],xRobotsTagCaptured:robots[i]!==undefined,html:`<title>Same</title><link rel="canonical" href="${canonicals[i]}">`}));return {...createPageDataExport(pages),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};}
 assert.equal(customerEvidenceTriage(audit,finding,data([urls[0],urls[0]])),'consolidated');
 assert.equal(customerEvidenceTriage(audit,finding,data([urls[0],urls[0]],[undefined,undefined])),'consolidated');
 assert.equal(customerEvidenceTriage(audit,finding,data([urls[0],urls[0]],['noindex','index'])),'review');
 assert.equal(customerEvidenceTriage(audit,finding,data([urls[0],urls[0]],['bingbot: index','index'])),'consolidated');
 assert.equal(customerEvidenceTriage(audit,finding,data(urls)),'admitted');
 assert.equal(customerEvidenceTriage(audit,finding,data(urls,[undefined,undefined])),'review');
 assert.equal(customerEvidenceTriage(audit,finding,data(urls,['index, '.repeat(150)+'noindex','index'])),'review');
 assert.equal(customerEvidenceTriage(audit,finding,data(urls,['bingbot: index','index'])),'review');
 assert.equal(customerEvidenceTriage(audit,finding,data([urls[0],'https://fixture.example/not-captured'])),'review');
 assert.equal(customerEvidenceTriage(audit,finding,undefined),'review');
 for (const mutate of [p=>{delete p.statusCode;},p=>{p.statusCode=201;},p=>{delete p.finalUrl;},p=>{p.fetchedAt='2001-01-01T00:00:00.000Z';},p=>{p.source='rendered_dom';},p=>{p.xRobotsTagStatus='ABSENT';},p=>{p.canonicalCandidates[0].value='javascript:alert(1)';},p=>{p.canonicalCandidates[0].value='https://fixture.example/elsewhere';},p=>{p.metaRobotsStatus='ABSENT';p.metaRobotsDeclarations=[{name:'robots',content:'index',status:'observed'}];}]) {
  const candidate=data(urls);mutate(candidate.pages[0]);assert.equal(customerEvidenceTriage(audit,finding,candidate),'review');
 }
});

test('new capture distinguishes verified absent X-Robots-Tag from legacy unknown',async()=>{
 const base='https://fixture.example/';
 const {audit,pageData}=await auditWebsiteWithPageData({startUrl:base,pagespeed:false,contacts:false,policy:createDefaultCrawlPolicy(base,{maxPages:2,maxRequests:8,minRequestIntervalMs:0,maxConcurrency:1,maxRetries:0,maxImageChecks:0}),resolveAddresses:async()=>['93.184.216.34'],request:async u=>u.pathname==='/robots.txt'?{status:200,headers:{'content-type':'text/plain'},body:Buffer.from('User-agent: *\nAllow: /')}:{status:200,headers:{'content-type':'text/html'},body:Buffer.from(`<title>Same title</title><link rel="canonical" href="${u.href}"><main><h1>Fixture</h1><a href="/other">Other</a></main>`)}});
 assert.ok(pageData.pages.every(p=>p.xRobotsTagStatus==='ABSENT'));
 const finding=audit.findings.find(f=>f.code==='duplicate_title_across_pages');assert.ok(finding);
 assert.equal(customerEvidenceTriage(audit,finding,pageData),'admitted');
 const legacy=structuredClone(pageData);legacy.pages.forEach(p=>delete p.xRobotsTagStatus);
 assert.equal(customerEvidenceTriage(audit,finding,legacy),'review');
});

test('renderer APIs cannot mark unreviewed PDFs ready through caller-supplied qualification',async()=>{
 const {audit}=createEvidenceFixture(1);const issuer={name:'Synthetic',email:'reviewer@example.test'};
 const q={decision:'RELEASE',target:audit.target,auditSha256:auditResultSha256(audit),qualifiedAt:audit.completedAt,qualifiedBy:'Synthetic',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED'};
 assert.match(renderCustomerSummaryHtml(audit,'en',{issuer,qualification:q}),/data-publication-status="HOLD"/);
 const pair=await renderCustomerPdfPair(audit,async html=>Buffer.from(html),issuer,q);assert.equal(pair.status,'HOLD');
 const mobile=await renderMobileCustomerPdf(audit,async html=>Buffer.from(html),issuer,'en','CLIENT_READY',q);assert.match(Buffer.from(mobile).toString(),/data-publication-status="HOLD"/);
});

test('sanitized target matching retains exact query identity',()=>{
 const {audit}=createEvidenceFixture(1);const url='https://fixture.example/page-000?token=private&variant=1';
 audit.target=url;audit.coverage.urls[0].url=url;audit.coverage.urls[0].finalUrl=url;
 const finding={code:'image_alt_missing_or_empty',category:'accessibility',observed:'Image inventory',evidence:[{pageUrl:url,source:'http',observedAt:audit.startedAt,value:1}]};audit.findings=[finding];
 const html='<a href="/next"><img src="/x.png" alt=""></a>';
 const page={requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:50,html};
 const pd={...createPageDataExport([page]),target:'https://fixture.example/page-000?variant=1',auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 assert.equal(customerEvidenceTriage(audit,finding,pd),'admitted');
 assert.equal(customerEvidenceTriage(audit,{...finding,evidence:[{...finding.evidence[0],pageUrl:url.replace('variant=1','variant=2')}]},pd),'review');
});

test('operator marks only header findings whose required values were not retained as unverified',()=>{
 const {audit}=createEvidenceFixture(1);const e={pageUrl:audit.coverage.urls[0].url,source:'http',observedAt:audit.startedAt};
 const headers=[{name:'strictTransportSecurity',status:'absent'},{name:'contentSecurityPolicy',status:'not_captured'},{name:'contentSecurityPolicyReportOnly',status:'absent'},{name:'xContentTypeOptions',status:'observed',value:'nosniff'},{name:'referrerPolicy',status:'absent'},{name:'xFrameOptions',status:'absent'}];
 audit.findings=[{code:'hsts_missing_or_inactive',category:'security',observed:'HSTS missing',evidence:[{...e,securityHeaderEvidence:headers}]},{code:'missing_frame_protection',category:'security',observed:'Frame protection missing',evidence:[{...e,securityHeaderEvidence:headers}]}];
 const html=renderOperatorStatusHtml(audit,'en');assert.doesNotMatch(html,/Unverified: HSTS missing or inactive/);assert.match(html,/Unverified: Frame protection missing/);
 delete audit.findings[0].evidence[0].securityHeaderEvidence;assert.match(renderOperatorStatusHtml(audit,'en'),/Unverified: HSTS missing or inactive/);
});

test('triage ledger separates eligible source evidence from the final counted projection',()=>{
 const {audit}=createEvidenceFixture(2);const urls=[audit.target,new URL('/other',audit.target).href];
 audit.coverage.urls=urls.map(url=>({url,finalUrl:url,outcome:'captured',statusCode:200}));
 const finding={code:'duplicate_title_across_pages',category:'metadata',observed:'same',evidence:urls.map(pageUrl=>({pageUrl,source:'http',observedAt:audit.startedAt}))};audit.findings=[finding];
 const pages=urls.map(url=>({requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:50,xRobotsTag:'index',xRobotsTagCaptured:true,html:`<title>Same</title><link rel="canonical" href="${url}">`}));
 const pd={...createPageDataExport(pages),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 const result=withCustomerEvidence(audit,pd),pdf=Buffer.from('%PDF-test');
 const review=createCustomerReviewManifest(result,'en',[{role:'a4',path:'/tmp/a4.pdf',content:pdf},{role:'mobile',path:'/tmp/mobile.pdf',content:pdf}]);
 assert.equal(review.evidenceTriage[0].evidenceClassification,'eligible');assert.equal(review.evidenceTriage[0].inCount,false);assert.equal(review.customerObservationCount,0);assert.equal(review.customerAffectedCapturedUrls,0);
});

test('image admission uses each page context and preserves raw observations',()=>{
 const {audit}=createEvidenceFixture(2);const urls=audit.coverage.urls.map(p=>p.url);
 const f={code:'image_alt_missing_or_empty',category:'accessibility',observed:'image inventory',evidence:urls.map(pageUrl=>({pageUrl,source:'http',observedAt:audit.startedAt,value:1}))};audit.findings=[f];
 const html=['<a href="/next"><img src="/a.png" alt=""><span>Gift</span></a>','<a href="/next"><img src="/b.png" alt=""></a>'];
 const pages=urls.map((url,i)=>({requestedUrl:url,finalUrl:url,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:50,html:html[i]}));
 const data={...createPageDataExport(pages),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
 const original=structuredClone(audit), projected=customerPriorityProjection(withCustomerEvidence(audit,data));
 assert.equal(projected.customerFindings.length,1);
 assert.deepEqual(projected.customerFindings[0].evidence.map(x=>x.pageUrl),[urls[1]]);
 assert.equal(projected.deduplicatedIssues,1);
 assert.equal(customerPriorityProjection(audit).deduplicatedIssues,0);
 assert.equal(customerEvidenceTriage(audit,{...f,code:'images_missing_alt'},data),'review');
 for (const mutate of [p=>{delete p.statusCode;},p=>{p.statusCode=201;},p=>{p.fetchedAt='2001-01-01T00:00:00.000Z';},p=>{p.source='rendered_dom';}]) {
  const candidate=structuredClone(data);mutate(candidate.pages[1]);assert.equal(customerEvidenceTriage(audit,{...f,evidence:[f.evidence[1]]},candidate),'review');
 }
 assert.deepEqual(audit,original);
});
