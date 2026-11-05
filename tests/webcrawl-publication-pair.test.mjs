import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {renderCustomerPdfPair} from '../dist/reports/publication.js';
import {playwrightPdfRenderer} from '../dist/reports/pdf-playwright.js';
import {auditResultSha256,isCustomerReleaseQualified} from '../dist/reports/qualification.js';
import {isAuditResultRecord} from '@spora/webcrawl/core/audit-validation';
const issuer={name:'Synthetic Reviewer',email:'reviewer@example.test'};
function qualify(audit){return {decision:'RELEASE',target:audit.target,auditSha256:auditResultSha256(audit),qualifiedAt:new Date(Date.now()-10_000).toISOString(),qualifiedBy:'Synthetic responsible reviewer',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED'};}
function recount(audit){const groups=new Map();for(const f of audit.findings){const row=groups.get(f.code)??{records:0,pages:new Set(),evidenceOccurrences:0};row.records++;row.evidenceOccurrences+=f.evidence.length;f.evidence.forEach(e=>row.pages.add(e.pageUrl));groups.set(f.code,row);}audit.coverage.findings={records:audit.findings.length,checkCodes:groups.size,affectedPages:new Set(audit.findings.flatMap(f=>f.evidence.map(e=>e.pageUrl))).size,evidenceOccurrences:audit.findings.reduce((n,f)=>n+f.evidence.length,0),byCheck:[...groups].map(([code,row])=>({code,records:row.records,affectedPages:row.pages.size,evidenceOccurrences:row.evidenceOccurrences}))};}
function fixture() {
 const {audit}=createEvidenceFixture(1);
 audit.startedAt=new Date(Date.now()-60_000).toISOString();audit.completedAt=new Date().toISOString();
 audit.findings=['missing_canonical','missing_meta_description','title_long','images_missing_dimensions','missing_h1','heading_hierarchy_skip'].map(code=>({code,category:'content',observed:code,evidence:[{pageUrl:audit.coverage.urls[0].url,source:'http',observedAt:audit.startedAt}]}));
 recount(audit);
 return audit;
}
const decode=bytes=>Buffer.from(bytes).toString();
test('both locales must pass: layout failure retains three selected cards in HOLD',async()=>{
 for(const count of [4,5,6]) for(const failedLocale of ['en','de']) {
  const audit=fixture();audit.findings=audit.findings.slice(0,count);recount(audit);const before=JSON.stringify(audit);const calls=[];
  assert.ok(isAuditResultRecord(audit));assert.equal(isCustomerReleaseQualified(audit,qualify(audit)),true);
  const pair=await renderCustomerPdfPair(audit,async html=>{calls.push(html);if(html.includes(`lang="${failedLocale}"`)&&html.includes('data-client-ready="true"'))throw Error('client_report_not_ready: content exceeds one A4 page');return Buffer.from(html);},issuer,qualify(audit));
  assert.equal(pair.status,'HOLD');
  assert.ok(calls.some(html=>html.includes(`lang="${failedLocale}"`)&&html.includes('data-client-ready="true"')),'the requested locale must actually reach the release layout check');
  for(const bytes of [pair.en,pair.de]){const html=decode(bytes);assert.match(html,/data-publication-status="HOLD"/);assert.match(html,/data-client-ready="false"/);assert.doesNotMatch(html.replace(/<body\b[^>]*>/u,'<body>'),/\bHOLD\b|NOT FOR CUSTOMER DISTRIBUTION|NICHT ZUR KUNDENWEITERGABE/u);assert.equal((html.match(/<article class="card">/g)??[]).length,3);}
  assert.equal(calls.filter(h=>h.includes('data-publication-status="HOLD"')).length,2);assert.equal(JSON.stringify(audit),before);
 }
});
test('qualified pairs, missing evidence, and operational failures remain distinct',async()=>{
 const audit=fixture();const renderer=async html=>Buffer.from(html);
 for(const count of [4,5,6]){
  const candidate={...audit,findings:audit.findings.slice(0,count)};recount(candidate);
  const ready=await renderCustomerPdfPair(candidate,renderer,issuer,qualify(candidate));assert.equal(ready.status,'CLIENT_READY');for(const bytes of [ready.en,ready.de]){assert.match(decode(bytes),/data-client-ready="true"/);assert.doesNotMatch(decode(bytes),/HOLD/);}
 }
 audit.findings=[];const held=await renderCustomerPdfPair(audit,renderer,issuer,qualify(audit));assert.equal(held.status,'HOLD');for(const bytes of [held.en,held.de]){assert.match(decode(bytes),/data-publication-status="HOLD"/);assert.doesNotMatch(decode(bytes).replace(/<body\b[^>]*>/u,'<body>'),/\bHOLD\b|NOT FOR CUSTOMER DISTRIBUTION|NICHT ZUR KUNDENWEITERGABE/u);}
 let calls=0;await assert.rejects(renderCustomerPdfPair(fixture(),async()=>{calls++;throw Error('pdf_render_timeout');},issuer),/pdf_render_timeout/);assert.equal(calls,1);
 let heldCalls=0;await assert.rejects(renderCustomerPdfPair(fixture(),async html=>{if(html.includes('data-client-ready="true"'))throw Error('client_report_not_ready: layout');heldCalls++;throw Error('pdf_render_timeout');},issuer),/pdf_render_timeout/);assert.equal(heldCalls,1);
});
test('actual renderer rejects an overflowing DE companion and produces two visibly held PDFs',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-pair-hold-');
 try {
  let deRejected=false;
    const candidate=fixture();const pair=await renderCustomerPdfPair(candidate,async(html,options)=>{
   const germanReady=html.includes('lang="de"')&&html.includes('data-client-ready="true"');
   // Force the reproduced single-locale overflow independently of future copy edits.
   const source=germanReady?html.replace('</style>','.page{padding-top:250mm}</style>'):html;
   try{return await playwrightPdfRenderer(source,options);}catch(error){if(germanReady&&error.message.startsWith('client_report_not_ready:'))deRejected=true;throw error;}
  },issuer,qualify(candidate));
  assert.ok(deRejected);assert.equal(pair.status,'HOLD');
  for(const locale of ['en','de']){const file=`${root}/${locale}.pdf`;await writeFile(file,pair[locale]);const text=execFileSync('pdftotext',['-layout',file,'-'],{encoding:'utf8'});assert.doesNotMatch(text,/HOLD|NOT FOR CUSTOMER DISTRIBUTION|NICHT ZUR KUNDENWEITERGABE/);assert.match(text,/reviewer@example.test/);}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('qualified small report produces readable EN/DE PDFs with linked evidence and matching release status',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-qualified-pair-');
 try {
  const audit=fixture();audit.findings=audit.findings.slice(0,1);recount(audit);
  const pair=await renderCustomerPdfPair(audit,playwrightPdfRenderer,issuer,qualify(audit));
  assert.equal(pair.status,'CLIENT_READY');
  for(const locale of ['en','de']){
   const path=`${root}/${locale}.pdf`;await writeFile(path,pair[locale]);
   const bytes=await readFile(path);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
   const pdfText=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});
   assert.match(pdfText,/reviewer@example\.test/u);assert.match(pdfText,/Example page|Beispielseite/u);
   assert.doesNotMatch(pdfText,/https:\/\/fixture\.example\/page-000/u);assert.doesNotMatch(pdfText,/HOLD|NOT FOR CUSTOMER DISTRIBUTION/u);
   const links=execFileSync('pdfinfo',['-url',path],{encoding:'utf8'});assert.match(links,/https:\/\/fixture\.example\/page-000/u);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('offline CLI publishes each selected EN/DE customer PDF and records its matching decision',async()=>{
 const {runCli}=await import('../dist/compat/cli.js');const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp('/tmp/webcrawl-ready-pair-');
 try {
  await writeFile(`${root}/issuer.json`,JSON.stringify(issuer),{mode:0o600});
  const html='<html><head><title>'+ 'A useful lesson offer '.repeat(6)+'</title></head><body><main><h1>Lessons</h1><h2>Details</h2><h4>Booking details</h4><img src="/lesson.jpg" width="100" height="100" alt="Synthetic lesson"></main></body></html>';
  for (const [locale, suffix, topicLabel] of [['en', '.pdf', /3\s+topics to review/], ['de', '.report-de.pdf', /3\s+Themen zum Prüfen/]]) {
    const output = `${root}/${locale}-audit`;
    await runCli(['https://fixture.test/','--out',output,'--pdf','--pdf-locale',locale,'--report-contact-file',`${root}/issuer.json`,'--no-progress','--no-pagespeed','--no-contacts','--no-technology','--no-images','--no-evidence-pack','--no-page-data','--pages','1','--requests','5','--image-checks','0','--retries','0','--interval-ms','0'],{resolveAddresses:async()=>['93.184.216.34'],request:async url=>({status:url.pathname==='/'?200:404,headers:{'content-type':url.pathname==='/'?'text/html':'text/plain'},body:Buffer.from(url.pathname==='/'?html:'missing')})});
    const log = await readFile(`${output}.run.log`, 'utf8');
    assert.ok(log.includes(`[publication] status=HOLD locale=${locale}`));
    assert.ok(!log.includes(`[publication] status=CLIENT_READY locale=${locale === 'en' ? 'de' : 'en'}`));
    assert.ok(log.indexOf('optional-pdfs complete') < log.indexOf('status=HOLD'));
    const text = execFileSync('pdftotext', ['-layout', `${output}${suffix}`, '-'], { encoding: 'utf8' });
    assert.doesNotMatch(text,/HOLD|NOT FOR CUSTOMER DISTRIBUTION/); assert.match(text, topicLabel); assert.match(text, /reviewer@example.test/);
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(`${output}${locale === 'en' ? '.report-de.pdf' : '.pdf'}`), { code: 'ENOENT' });
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
