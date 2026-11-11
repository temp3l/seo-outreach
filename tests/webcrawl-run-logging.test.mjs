import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {runCli} from '../dist/compat/cli.js';
import {runBatch} from '../dist/compat/cli/batch.js';
import {ProgressReporter} from '../dist/compat/cli/progress.js';
import {safeGet} from '@spora/webcrawl/crawler/safe-transport';
import {createHash} from 'node:crypto';
import {auditResultSha256} from '../dist/reports/qualification.js';

const flags=['--pages','1','--requests','5','--interval-ms','0','--retries','1','--image-checks','0','--no-pdf','--no-pagespeed','--no-evidence-pack','--no-contacts','--no-technology','--no-images'];
const resolveAddresses=async()=>['93.184.216.34'];
const response=(status,body='',headers={})=>({status,headers:{'content-type':'text/html',...headers},body:Buffer.from(body)});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function assertReviewSidecar(prefix, locale, pdfPaths){
 const audit=JSON.parse(await readFile(`${prefix}.json`,'utf8'));
 const review=JSON.parse(await readFile(`${prefix}.review.json`,'utf8'));
 assert.equal(review.schema,'webcrawl-customer-review-v1');assert.equal(review.target,audit.target);assert.equal(review.auditSha256,auditResultSha256(audit));
 assert.equal(review.reportStatus,'HOLD');assert.equal(review.outboundApproval,false);
 assert.deepEqual(review.artifacts.map(({role,locale:artifactLocale,path})=>({role,locale:artifactLocale,path})),[
  {role:'a4',locale,path:pdfPaths[0]},{role:'mobile',locale,path:pdfPaths[1]},
 ]);
 for(const artifact of review.artifacts){const bytes=await readFile(artifact.path);assert.equal(artifact.bytes,bytes.length);assert.equal(artifact.sha256,sha(bytes));}
}

test('saved CLI logs include retries, counts and partial coverage with no URL/query/contact leakage',async()=>{
 const dir=await mkdtemp('/tmp/webcrawl-run-log-');
 const original=process.stderr.write;const consoleLines=[];
 process.stderr.write=function(line){consoleLines.push(String(line));return true;};
 try{
  let attempts=0;
  const request=async url=>url.pathname==='/robots.txt'?response(200,'User-agent: *\nAllow: /',{'content-type':'text/plain'}):++attempts===1?response(429,'PRIVATE_BODY',{'retry-after':'0.01'}):response(200,'<title>Offer</title><main><h1>Offer</h1><a href="/next?person=PRIVATE_QUERY">Next</a><p>PRIVATE_CONTACT@example.test</p></main>');
  await runCli(['https://fixture.example/private?campaign=PRIVATE_QUERY','--out',`${dir}/audit`,'--progress',...flags],{resolveAddresses,request});
  const log=await readFile(`${dir}/audit.run.log`,'utf8');
  assert.match(log,/request cooldown status=429/);assert.match(log,/request retry status=429 attempt=1 delay_ms=1000 next_retry_at=/);
  assert.match(log,/physicalRequests=3/);assert.match(log,/crawl status=incomplete/);assert.match(log,/success status=partial/);
  assert.doesNotMatch(log,/PRIVATE_|https?:\/\/|campaign=|person=|@/);
  assert.match(consoleLines.join(''),/request retry/);
  assert.equal((await stat(`${dir}/audit.run.log`)).mode&0o777,0o600);
  consoleLines.length=0;
  await runCli(['https://fixture.example/','--out',`${dir}/quiet`,'--no-progress',...flags],{resolveAddresses,request:async()=>response(404)});
  assert.equal(consoleLines.length,0);assert.match(await readFile(`${dir}/quiet.run.log`,'utf8'),/success/);
 } finally{process.stderr.write=original;await rm(dir,{recursive:true,force:true});}
});

test('heartbeats are incremental, continue without progress events, and stop on close',async()=>{
 const dir=await mkdtemp('/tmp/webcrawl-heartbeat-');
 const reporter=new ProgressReporter(()=>{});
 try{
  reporter.attachFile(`${dir}/run.log`,false,10);reporter.begin('fetch');reporter.request({kind:'request'});
  await new Promise(resolve=>setTimeout(resolve,35));
  const running=await readFile(`${dir}/run.log`,'utf8');assert.match(running,/fetching heartbeat.*physicalRequests=1/);
  reporter.fail('operation_failed');reporter.close();
  const done=await readFile(`${dir}/run.log`,'utf8');await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await readFile(`${dir}/run.log`,'utf8'),done);assert.match(done,/failure category=operation_failed action=/);
  await symlink(`${dir}/run.log`,`${dir}/alias.log`);
  assert.throws(()=>reporter.attachFile(`${dir}/alias.log`,true));assert.equal(await readFile(`${dir}/run.log`,'utf8'),done);
 } finally{reporter.close();await rm(dir,{recursive:true,force:true});}
});

test('retry observers are URL-free and cannot change request semantics',async()=>{
 let calls=0;const events=[];
 const result=await safeGet('https://fixture.example/private?campaign=SECRET',{allowedHosts:['fixture.example'],timeoutMs:1000,maxResponseBytes:100,maxRedirects:0,maxRetries:1,retryBaseDelayMs:0,retryMaxDelayMs:0,resolveAddresses,onRequestEvent:event=>{events.push(event);throw Error('observer');},request:async()=>response(++calls===1?429:200)});
 assert.equal(result.status,200);assert.equal(result.requestCount,2);
 assert.equal(events.filter(e=>e.kind==='request').length,2);assert.ok(events.some(e=>e.kind==='retry'));
 assert.doesNotMatch(JSON.stringify(events),/SECRET|fixture|private|https/);
});

test('batch and per-site logs persist, append verified reuse and record failures safely',async()=>{
 const dir=await mkdtemp('/tmp/webcrawl-batch-logs-');
 try{
  await writeFile(`${dir}/sites.csv`,'website\nhttps://fixture.example/private?campaign=SECRET\n');
  let calls=0;const transport={resolveAddresses,request:async()=>{calls++;return response(200,'<main><h1>Offer</h1></main>');}};
  const run=()=>runBatch(`${dir}/sites.csv`,`${dir}/out`,true,false,false,transport,false,false,false);
  await run();const firstCalls=calls;const files=(await readdir(`${dir}/out`)).sort();
  const siteLog=files.find(name=>name.endsWith('.run.log')&&name!=='batch.run.log');assert.ok(siteLog);
  await run();assert.equal(calls,firstCalls);assert.deepEqual((await readdir(`${dir}/out`)).sort(),files);
  for(const name of [siteLog,'batch.run.log']){
   const log=await readFile(`${dir}/out/${name}`,'utf8');assert.match(log,/site reused verified_saved_result/);assert.doesNotMatch(log,/SECRET|campaign=|https:/);
  }
  await writeFile(`${dir}/sites.csv`,'website\nhttps://different.example/\n');
  await assert.rejects(run(),/batch_input_changed/);
  assert.match(await readFile(`${dir}/out/batch.run.log`,'utf8'),/failure category=/);
 } finally{await rm(dir,{recursive:true,force:true});}
});

test('CLI accepts batch progress and HOLD publication preserves evidence with a closed diagnostic log',async()=>{
 const dir=await mkdtemp('/tmp/webcrawl-logging-cli-');
 const transport={resolveAddresses,request:async()=>response(200,'<main><h1>Offer</h1></main>')};
 try {
  await writeFile(`${dir}/sites.csv`,'website\nhttps://fixture.example/\n');
  await runCli(['--batch',`${dir}/sites.csv`,'--out',`${dir}/batch`,'--progress','--no-contacts','--no-pagespeed'],transport);
  assert.match(await readFile(`${dir}/batch/batch.run.log`,'utf8'),/success status=/);
  await writeFile(`${dir}/issuer.json`,JSON.stringify({name:'PRIVATE_ISSUER',email:'PRIVATE_ISSUER@example.test'}),{mode:0o600});
  const args=flags.filter(value=>value!=='--no-pdf');
  await runCli(['https://fixture.example/','--out',`${dir}/pdf`,'--no-progress','--pdf','--operator-pdf','--report-contact-file',`${dir}/issuer.json`,...args],transport);
  assert.equal(JSON.parse(await readFile(`${dir}/pdf.json`,'utf8')).target,'https://fixture.example/');
  assert.equal((await readFile(`${dir}/pdf.operator-status.pdf`)).subarray(0,5).toString('ascii'),'%PDF-');
  const englishPdfText=execFileSync('pdftotext',['-layout',`${dir}/pdf.pdf`,'-'],{encoding:'utf8'});
  assert.doesNotMatch(englishPdfText,/\bHOLD\b/u);
  await assertReviewSidecar(`${dir}/pdf`,'en',[`${dir}/pdf.pdf`,`${dir}/pdf.mobile.pdf`]);
  assert.match(await readFile(`${dir}/pdf.whatsapp-draft.md`,'utf8'),/selected_send_target:\*\* null/);
  const log=await readFile(`${dir}/pdf.run.log`,'utf8');
  assert.match(log,/optional-pdfs complete/);assert.match(log,/publication\] status=HOLD locale=en/);assert.doesNotMatch(log,/publication\] status=HOLD locale=de/);assert.match(log,/success status=/);
  assert.doesNotMatch(log,/PRIVATE_ISSUER|@|https:/);
  const germanOut=`${dir}/pdf-de`;
  await runCli(['https://fixture.example/','--out',germanOut,'--no-progress','--pdf-locale','de','--operator-pdf','--report-contact-file',`${dir}/issuer.json`,...args],transport);
  const germanPdfText=execFileSync('pdftotext',['-layout',`${germanOut}.report-de.pdf`,'-'],{encoding:'utf8'});
  assert.doesNotMatch(germanPdfText,/\bHOLD\b|NICHT ZUR KUNDENWEITERGABE/u);
  await assertReviewSidecar(germanOut,'de',[`${germanOut}.report-de.pdf`,`${germanOut}.mobile-de.pdf`]);
  await assert.rejects(readFile(`${germanOut}.pdf`),{code:'ENOENT'});
  assert.match(await readFile(`${germanOut}.whatsapp-draft.md`,'utf8'),/pdf-de\.report-de\.pdf/u);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(await readFile(`${dir}/pdf.run.log`,'utf8'),log);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('operator status PDF can be generated on demand without customer PDFs or publisher contact',async()=>{
 const dir=await mkdtemp('/tmp/webcrawl-operator-pdf-opt-in-');
 try{
  const out=`${dir}/operator-only`;
  await runCli(['https://fixture.example/','--out',out,'--no-progress','--no-pdf','--operator-pdf','--no-pagespeed','--no-contacts','--no-technology','--no-images','--pages','1','--requests','3','--interval-ms','0','--retries','0'],{
   resolveAddresses,
   request:async()=>response(200,'<html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1></main></body></html>'),
  });
  assert.equal((await readFile(`${out}.operator-status.pdf`)).subarray(0,5).toString('ascii'),'%PDF-');
  for(const suffix of ['.pdf','.mobile.pdf','.review.json']) await assert.rejects(readFile(`${out}${suffix}`),{code:'ENOENT'});
  assert.match(await readFile(`${out}.run.log`,'utf8'),/optional-pdfs complete/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('browser navigation, resource redirects and errors all reach live logging without changing accounting',async()=>{
 const {auditWebsite}=await import('@spora/webcrawl/core/audit');
 const {DEFAULT_CRAWL_LIMITS}=await import('@spora/webcrawl/core/defaults');
 let physical=0,observed=0;const lines=[];const reporter=new ProgressReporter(line=>lines.push(line));
 const audit=await auditWebsite({startUrl:'https://fixture.example/',pagespeed:false,contacts:false,technology:false,renderBrowser:true,
  policy:{...DEFAULT_CRAWL_LIMITS,allowedHosts:['fixture.example'],maxPages:1,maxRequests:12,maxRuntimeMs:10000,maxResponseBytes:100000,maxTotalResponseBytes:500000,maxImageChecks:0,minRequestIntervalMs:0,maxRetries:0},
  resolveAddresses,onProgress:event=>reporter.progress(event),onRequestEvent:event=>{reporter.request(event);if(event.kind==='request')observed++;throw Error('observer must not affect browser');},
  request:async url=>{
   physical++;
   if(url.pathname==='/robots.txt')return response(200,'User-agent: *\nAllow: /',{'content-type':'text/plain'});
   if(url.pathname==='/asset.js')return response(302,'',{location:'/final.js?campaign=SECRET'});
   if(url.pathname==='/final.js')return response(429,'PRIVATE_BODY',{'content-type':'application/javascript'});
   return response(200,'<title>Fixture</title><main><h1>Offer</h1></main><script src="/asset.js"></script>');
  }});
 assert.ok(physical>=5);assert.equal(observed,physical);assert.equal(audit.crawl.physicalRequests,physical);assert.equal(audit.crawl.captured,1);
 reporter.result(audit);reporter.begin('publication');reporter.heartbeat();reporter.close();
 assert.match(lines.at(-1),new RegExp(`physicalRequests=${physical}\\b`));
 assert.match(lines.join(''),/request response status=429/);assert.match(lines.join(''),/request retry_exhausted status=429/);
 assert.doesNotMatch(lines.join(''),/SECRET|PRIVATE_BODY|https:|asset\.js|final\.js/);
});

test('duplicate and canonical-equivalent batch rows finish with matching row counts, including on resume',async()=>{
 const dir=await mkdtemp('/tmp/webcrawl-row-counts-');
 try{
  await writeFile(`${dir}/sites.csv`,'website\nhttps://fixture.example/#section\nhttps://fixture.example/\n');
  let requests=0;const transport={resolveAddresses,request:async()=>{requests++;return response(200,'<h1>Offer</h1>');}};
  const run=()=>runBatch(`${dir}/sites.csv`,`${dir}/out`,true,false,false,transport,false,false,false);
  await run();const firstRequests=requests;await run();assert.equal(requests,firstRequests);
  const log=await readFile(`${dir}/out/batch.run.log`,'utf8');
  const finishes=log.split('\n').filter(line=>/fetching complete completed=/.test(line)&&!line.includes('host='));
  assert.equal(finishes.length,2);assert.ok(finishes.every(line=>line.includes('completed=2 total=2')));
  assert.equal((await readdir(`${dir}/out`)).filter(name=>name.endsWith('.json')&&name!=='batch-state.json').length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
