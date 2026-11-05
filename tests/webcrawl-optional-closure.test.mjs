import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEventListeners } from 'node:events';
import { fileURLToPath } from 'node:url';
import { renderPageInBrowser } from '@spora/webcrawl/crawler/browser-render';
import { inspectPage, findDuplicateMetadata } from '@spora/webcrawl/analysis/technical';
import { auditWebsite, auditWebsiteWithPageData } from '@spora/webcrawl/core/audit';
import { classifyScanCompletion } from '@spora/webcrawl/core/scan-completion';
import { imageEnrichment } from '@spora/webcrawl/enrichments/images';
import { createPageSpeedEnrichment } from '@spora/webcrawl/enrichments/pagespeed';
import { createEvidencePack, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { renderOperatorStatusHtml, renderCustomerSummaryHtml } from '../dist/reports/summary.js';
const exec = promisify(execFile);
const policy={allowedHosts:['fixture.test'],maxPages:2,maxRequests:50,maxRuntimeMs:15000,maxResponseBytes:100000,maxTotalResponseBytes:1000000,minRequestIntervalMs:0,maxConcurrency:1,maxRetries:0,maxImageChecks:0};
const input={url:'https://fixture.test/',policy,robots:{status:'missing',rules:[],sitemapUrls:[]},userAgent:'fixture',timeoutMs:1000,resolveAddresses:async()=>['93.184.216.34']};
function fakeBrowser({content=async()=>'<title>ok</title>',close=async()=>{},goto=async()=>{},newContext,newPage}={}) {
  let handler;
  const page={setDefaultNavigationTimeout(){},setDefaultTimeout(){},addInitScript:async()=>{},goto:async()=>goto(handler),waitForTimeout:async()=>{},content};
  return {newContext:newContext??(async()=>({addInitScript:async()=>{},on(){},newPage:newPage??(async()=>page),route:async(_,fn)=>{handler=fn;},close})),close:async()=>{}};
}
test('operation deadline disposes a late acquisition after controlled cancellation', async () => {
  const { OperationDeadline } = await import('../dist/reports/operation-deadline.js');
  const controller = new AbortController();
  let finish, startedResolve, closed = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const deadline = new OperationDeadline(60_000, controller.signal);
  try {
    const pending = deadline.run(() => { startedResolve(); return new Promise(resolve => { finish = resolve; }); }, async () => { closed++; });
    await started;
    controller.abort();
    await assert.rejects(pending, /operation_aborted/);
    finish({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, 1);
    assert.equal(getEventListeners(deadline.signal, 'abort').length, 0);
  } finally { deadline.dispose(); }
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('operation deadline times out noncooperative work', async () => {
  const { OperationDeadline } = await import('../dist/reports/operation-deadline.js');
  const deadline = new OperationDeadline(20, undefined, 'fixture_timeout');
  try { await assert.rejects(deadline.run(() => new Promise(() => {})), /fixture_timeout/); }
  finally { deadline.dispose(); }
});
test('operation deadline does not start pre-aborted work', async () => {
  const { OperationDeadline } = await import('../dist/reports/operation-deadline.js');
  const deadline = new OperationDeadline(100, AbortSignal.abort());
  let called = false;
  try {
    await assert.rejects(deadline.run(async () => { called = true; }), /operation_aborted/);
    assert.equal(called, false);
  } finally { deadline.dispose(); }
});
test('browser blocked/failed resources are partial and accepted controls remain complete',async()=>{
  let dispatches=0;
  for (const url of ['https://external.test/script.js','https://fixture.test/login','https://fixture.test/failed.js']) {
    const result=await renderPageInBrowser({...input,request:async()=>{dispatches++;return {status:503,headers:{},body:Buffer.alloc(0)};}},fakeBrowser({goto:async handler=>handler({request:()=>({method:()=> 'GET',url:()=>url}),abort:async()=>{},fulfill:async()=>{}})}));
    assert.equal(result.status,'partial');
    assert.equal(result.blockedResources+result.failedResources,1);
  }
  assert.equal(dispatches,1);
  assert.equal((await renderPageInBrowser(input,fakeBrowser())).status,'complete');
});
test('browser deadline/abort bounds setup, DOM capture and context close',async()=>{
  const never=()=>new Promise(()=>{});
  for(const options of [{content:never},{close:never},{newContext:never},{newPage:never}]) {
    await assert.rejects(renderPageInBrowser({...input,timeoutMs:25},fakeBrowser(options)),/browser_.*timeout/);
  }
  const controller=new AbortController();
  await assert.rejects(renderPageInBrowser({...input,signal:controller.signal},fakeBrowser({content:async()=>{controller.abort(); await new Promise(r=>setImmediate(r)); return 'late';}})),/browser_render_aborted/);
});
test('public reanalysis and mixed-source duplicate metadata keep selected source, including empty rendered DOM',()=>{
  const page={requestedUrl:input.url,finalUrl:input.url,statusCode:200,contentType:'text/html',fetchedAt:new Date().toISOString(),responseBytes:0,html:'<title>HTTP</title>',renderedHtml:'<title>Rendered</title><h1>Rendered</h1><a href="/selected">selected</a>'};
  const selected=inspectPage(page);
  assert.equal(selected.title,'Rendered'); assert.equal(selected.source,'rendered-dom');
  assert.ok(!selected.findings.some(f=>f.code==='missing_title'));
  assert.ok(selected.linkTargets.some(l=>l.url.endsWith('/selected')));
  const second=inspectPage({...page,finalUrl:input.url+'two'});
  assert.ok(findDuplicateMetadata([selected,second]).every(f=>f.evidence.every(e=>e.source==='rendered-dom')));
  const {renderedHtml,...http}=page;
  const mixed=findDuplicateMetadata([selected,inspectPage({...http,html:'<title>Rendered</title>',finalUrl:input.url+'http'})]);
  assert.deepEqual(mixed[0].evidence.map(e=>e.source),['rendered-dom','http']);
  assert.ok(inspectPage({...page,renderedHtml:''}).findings.some(f=>f.code==='missing_title'));
});
function transport({external=false}={}) {
  const requested=[];
  return {pagespeed:false,requested,resolveAddresses:input.resolveAddresses,request:async(url,addresses,options)=>{
    assert.deepEqual(addresses,['93.184.216.34']);
    requested.push(url.href);
    const path=url.pathname;
    if(path==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
    if(path==='/old.js')return {status:302,headers:{location:'/assets/module.js'},body:Buffer.alloc(0)};
    const content=path==='/assets/module.js'
      ? 'import {label} from "./dep.js"; document.title=label; document.querySelector("h1").textContent=label; const img=document.createElement("img");img.src="/pixel.png";document.body.append(img);'
      : path==='/assets/dep.js' ? 'export const label="Shared rendered";'
      : '<title>HTTP '+path+'</title><h1>HTTP</h1><a href="/second">Next</a><script type="module" src="/old.js"></script>'+(external?'<script src="https://external.test/app.js"></script>':'');
    if(path==='/pixel.png') return {status:200,headers:{'content-type':'image/png'},body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')};
    return {status:200,headers:{'content-type':path.endsWith('.js')?'application/javascript':'text/html'},body:Buffer.from(content)};
  }};
}
test('real Chromium preserves intercepted module redirects and resolves relative imports at final URL',async()=>{
  const fixture=transport();
  const result=await renderPageInBrowser({...input,...fixture,timeoutMs:8000});
  assert.match(result.html,/<title>Shared rendered<\/title>/,JSON.stringify({result,requested:fixture.requested}));
  assert.ok(fixture.requested.includes('https://fixture.test/assets/dep.js'));
  assert.ok(!fixture.requested.includes('https://fixture.test/dep.js'));
  assert.equal(fixture.requested.filter(u=>u.endsWith('/assets/module.js')).length,1);
  assert.equal(result.status,'complete');
});
test('public rendered audit propagates provenance through enrichments, duplicates, page data and verified ZIP',async()=>{
  const fixture=transport();
  const result=await auditWebsiteWithPageData({startUrl:input.url,policy,renderBrowser:true,...fixture},{},[imageEnrichment]);
  assert.equal(result.audit.capabilities.browser,'complete');
  const duplicate=result.audit.findings.find(f=>f.code==='duplicate_title_across_pages');
  assert.ok(duplicate); assert.ok(duplicate.evidence.every(e=>e.source==='rendered-dom'));
  const images=result.audit.findings.filter(f=>f.code==='image_alt_missing_or_empty');
  assert.equal(images.length,2); assert.ok(images.every(f=>f.evidence.every(e=>e.source==='rendered-dom')));
  assert.ok(result.pageData.pages.every(p=>p.title==='Shared rendered'));
  const members=verifyEvidencePack(createEvidencePack(result.audit,result.pageData)).members;
  assert.equal(members.length,5);
});
test('public audit with blocked rendered resources is partial in JSON, reports and verified evidence',async()=>{
  const fixture=transport({external:true});
  const result=await auditWebsiteWithPageData({startUrl:input.url,policy:{...policy,maxPages:1},renderBrowser:true,...fixture},{});
  assert.equal(result.audit.capabilities.browser,'partial');
  assert.ok(result.audit.crawl.limitations.includes('browser_render_incomplete'));
  assert.ok(result.audit.crawl.limitations.includes('html_analysis_incomplete'));
  assert.equal(classifyScanCompletion(result.audit).status,'INCOMPLETE');
  assert.equal(classifyScanCompletion(result.audit,result.pageData).status,'INCOMPLETE');
  assert.match(renderOperatorStatusHtml(result.audit,'en'),/Crawl incomplete/);
  assert.doesNotMatch(renderCustomerSummaryHtml(result.audit,'en'),/Coverage limitations/);
  assert.equal(verifyEvidencePack(createEvidencePack(result.audit,result.pageData)).members.length,5);
  assert.ok(fixture.requested.every(u=>new URL(u).hostname==='fixture.test'));
});
test('a skipped duplicate with unavailable rendering does not reopen an already analyzed page',async()=>{
  let rootRequests=0;
  const result=await auditWebsiteWithPageData({startUrl:input.url,policy,renderBrowser:true,pagespeed:false,contacts:false,technology:false,resolveAddresses:input.resolveAddresses,request:async url=>{
    if(url.pathname==='/robots.txt')return {status:404,headers:{},body:Buffer.alloc(0)};
    if(url.pathname==='/again')return {status:302,headers:{location:'/'},body:Buffer.alloc(0)};
    rootRequests++;
    const html='<title>Fixture</title><h1>Fixture</h1><a href="/again">Duplicate</a>'+(rootRequests>=4?'<script src="https://external.test/app.js"></script>':'');
    return {status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)};
  }},{});
  assert.equal(result.audit.crawl.captured,1);
  assert.equal(result.audit.crawl.skipped,1);
  assert.ok(result.audit.coverage.urls.some(row=>row.reason==='duplicate_final_url'));
  assert.equal(result.audit.capabilities.browser,'partial');
  assert.ok(!result.audit.crawl.limitations.includes('html_analysis_incomplete'));
  assert.equal(classifyScanCompletion(result.audit,result.pageData).status,'COMPLETED');
});
test('adapter requirements bound inputs, declare source, avoid target-only HTML retention and settle timeouts',async()=>{
  const base={startUrl:input.url,policy:{...policy,maxPages:1},...transport(),pagespeed:false};
  let observed;
  const target={name:'target-only',requirements:{input:'target'},run:async context=>{observed=context;return {status:'complete',findings:[]};}};
  const result=await auditWebsite({...base,retainHtml:false},[target]);
  assert.equal(result.crawlSettings.retainHtml,false); assert.deepEqual(observed.pages,[]);
  const limited={name:'limited',requirements:{input:'html',maxInputBytes:1},run:async()=>{throw Error('must not inspect omitted input');}};
  const small=await auditWebsite(base,[limited]);
  assert.equal(small.capabilities.limited,'unavailable'); assert.equal(small.enrichmentLimitations.limited,'enrichment_input_byte_limit');
  const stalled={name:'stalled',requirements:{input:'target',timeoutMs:25},run:()=>new Promise(()=>{})};
  const timeout=await auditWebsite(base,[stalled]);
  assert.equal(timeout.capabilities.stalled,'failed'); assert.equal(timeout.enrichmentLimitations.stalled,'enrichment_timeout');
  let calls=0;
  const psi=createPageSpeedEnrichment({fetch:async()=>{calls++;return Response.json({lighthouseResult:{categories:Object.fromEntries(['performance','accessibility','best-practices','seo'].map(k=>[k,{score:1}]))}});}});
  const psiResult=await auditWebsite({...base,pagespeed:true,retainHtml:false},[psi]);
  assert.equal(psiResult.crawlSettings.retainHtml,false); assert.equal(psiResult.capabilities.pagespeed,'complete'); assert.equal(calls,1);
});
test('PageSpeed runs by default for library audits and pagespeed false is an explicit opt-out',async()=>{
  const originalFetch=globalThis.fetch; let calls=0;
  globalThis.fetch=async url=>{calls++;assert.equal(new URL(url).hostname,'pagespeedonline.googleapis.com');return Response.json({lighthouseResult:{categories:Object.fromEntries(['performance','accessibility','best-practices','seo'].map(k=>[k,{score:.9}]))}});};
  try {
    const base={startUrl:input.url,policy:{...policy,maxPages:1},...transport(),pagespeed:false};
    const enabled=await auditWebsite({...base,pagespeed:true});
    assert.equal(enabled.capabilities.pagespeed,'complete');
    assert.ok(enabled.crawlSettings.enrichments.includes('pagespeed'));
    assert.equal(calls,1);
    const disabled=await auditWebsite({...base,pagespeed:false});
    assert.equal(disabled.capabilities.pagespeed,'disabled');
    assert.ok(!disabled.crawlSettings.enrichments.includes('pagespeed'));
    assert.equal(calls,1);
    const explicit=await auditWebsite({...base,pagespeed:false},[createPageSpeedEnrichment({fetch:async()=>{calls++;throw Error('opt-out dispatched PageSpeed');}})]);
    assert.equal(explicit.capabilities.pagespeed,'disabled');
    assert.equal(calls,1);
    const privateTarget=await auditWebsite({...base,pagespeed:true,startUrl:input.url+'?source=campaign'});
    assert.equal(privateTarget.capabilities.pagespeed,'unavailable');
    assert.equal(privateTarget.enrichmentLimitations.pagespeed,'pagespeed_query_requires_explicit_opt_in');
    assert.equal(calls,1);
    const directCalls=[];
    const direct=createPageSpeedEnrichment({fetch:async url=>{directCalls.push(new URL(url).searchParams.get('url'));return Response.json({lighthouseResult:{categories:Object.fromEntries(['performance','accessibility','best-practices','seo'].map(k=>[k,{score:1}]))}});}});
    const directResult=await auditWebsite({...base,pagespeed:true,startUrl:input.url+'?source=campaign'},[direct]);
    assert.equal(directResult.capabilities.pagespeed,'unavailable');
    assert.equal(directResult.enrichmentLimitations.pagespeed,'pagespeed_query_requires_explicit_opt_in');
    assert.deepEqual(directCalls,[]);
  } finally { globalThis.fetch=originalFetch; }
});
test('PDF lifecycle bounds pre-abort, setup, render and close without unhandled rejection',async()=>{
  for(const stage of ['preabort','launch','context','page','route','content','pdf','close','late-launch','late-context','abort-content','success']) {
    const {stdout}=await exec(process.execPath,[fileURLToPath(new URL('./fixtures/pdf-lifecycle.mjs',import.meta.url)),stage],{timeout:5000});
    const result=JSON.parse(stdout);
    assert.deepEqual(result.unhandled,[],stage);
    assert.equal(result.listeners,0,stage);
    if(stage==='late-launch')assert.equal(result.browserCloses,1);
    if(stage==='late-context')assert.equal(result.contextCloses,1);
    if(stage==='success')assert.equal(result.bytes,4);
    else assert.match(result.error,/pdf_.*(?:timeout|aborted)/,stage);
    if(stage==='preabort') assert.equal(result.launches,0);
  }
});

test('browser redirect chains remain bounded and external/private destinations never dispatch',async()=>{
  const fixture=transport();
  let calls=0;
  const chain=await renderPageInBrowser({...input,timeoutMs:8000,request:async(url,...args)=>{
    calls++;
    if(url.pathname.startsWith('/loop'))return {status:302,headers:{location:'/loop'+(Number.parseInt(url.pathname.slice(5),10)+1)+'.js'},body:Buffer.alloc(0)};
    if(url.pathname==='/old.js')return {status:302,headers:{location:'/loop0'},body:Buffer.alloc(0)};
    return fixture.request(url,...args);
  }});
  assert.equal(chain.status,'partial'); assert.ok(calls<12,'redirect chain must stop before the request budget');
  const requested=[];
  const external=await renderPageInBrowser({...input,timeoutMs:8000,request:async(url,...args)=>{
    requested.push(url.href);
    if(url.pathname==='/old.js')return {status:302,headers:{location:'https://external.test/not-admitted'},body:Buffer.alloc(0)};
    return fixture.request(url,...args);
  }});
  assert.equal(external.status,'partial'); assert.ok(requested.every(u=>new URL(u).hostname==='fixture.test'));
  let privateDispatch=0;
  await assert.rejects(renderPageInBrowser({...input,timeoutMs:8000,resolveAddresses:async()=>['127.0.0.1'],request:async()=>{privateDispatch++;throw Error('unsafe dispatch');}}));
  assert.equal(privateDispatch,0);
});
test('browser navigation redirects retain destination URL and relative module resolution',async()=>{
  const fixture=transport();
  const result=await renderPageInBrowser({...input,url:'https://fixture.test/start',timeoutMs:8000,request:async(url,...args)=>{
    if(url.pathname==='/start')return {status:302,headers:{location:'/assets/final'},body:Buffer.alloc(0)};
    if(url.pathname==='/assets/final')return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<title>Initial</title><script>document.title=location.pathname</script>')};
    return fixture.request(url,...args);
  }});
  assert.match(result.html,/<title>\/assets\/final<\/title>/);
  assert.equal(result.status,'complete');
});
test('declared HTTP input remains HTTP while selected rendered adapters receive rendered provenance',async()=>{
  const fixture=transport(); let httpInput,renderedInput;
  const http={name:'http-input',requirements:{input:'html',source:'http'},run:async ctx=>{httpInput=ctx;return {status:'complete',findings:[]};}};
  const selected={name:'selected-input',requirements:{input:'html',source:'selected'},run:async ctx=>{renderedInput=ctx;return {status:'complete',findings:[]};}};
  const result=await auditWebsite({startUrl:input.url,policy:{...policy,maxPages:1},renderBrowser:true,...fixture},[http,selected]);
  assert.equal(result.capabilities.browser,'complete');
  assert.equal(httpInput.pages[0].source,'http'); assert.match(httpInput.pages[0].html,/<title>HTTP/);
  assert.equal(renderedInput.pages[0].source,'rendered-dom'); assert.match(renderedInput.pages[0].html,/<title>Shared rendered/);
});
test('actual Chromium PDF renderer succeeds offline and rejects pre-cancelled calls without unhandled rejection',async()=>{
  const path=fileURLToPath(new URL('../dist/reports/pdf-playwright.js',import.meta.url));
  const {stdout}=await exec(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {pathToFileURL} from 'node:url';
    const {playwrightPdfRenderer}=await import(pathToFileURL(process.argv[1]).href);
    const unhandled=[];process.on('unhandledRejection',e=>unhandled.push(e.message));
    await assert.rejects(playwrightPdfRenderer('<title>cancelled</title>',{signal:AbortSignal.abort(),timeoutMs:5000}),/pdf_render_aborted/);
    const bytes=await playwrightPdfRenderer('<html><title>Offline PDF</title><p>Positive control</p></html>',{timeoutMs:8000});
    assert.equal(Buffer.from(bytes).subarray(0,4).toString(),'%PDF');
    await new Promise(r=>setTimeout(r,25));
    assert.deepEqual(unhandled,[]);
    console.log('offline PDF and cancellation verified');
  `,path],{timeout:15000});
  assert.match(stdout,/verified/);
});

test('Chromium intercepted gzip representation decodes at the browser boundary',async()=>{
  const {gzipSync}=await import('node:zlib');
  const fixture=transport();
  const result=await renderPageInBrowser({...input,timeoutMs:8000,request:async(...args)=>{
    const response=await fixture.request(...args);
    return {...response,headers:{...response.headers,'content-encoding':'gzip'},body:gzipSync(response.body)};
  }});
  assert.match(result.html,/<title>Shared rendered<\/title>/);
  assert.equal(result.status,'complete');
});
test('pending asynchronous browser resources make capture partial and are cancelled after the snapshot',async()=>{
  let slowSignal;
  const result=await renderPageInBrowser({...input,timeoutMs:8000,request:async(url,_addresses,options)=>{
    if(url.pathname==='/slow.js'){slowSignal=options.signal;return new Promise(()=>{});}
    return {status:200,headers:{'content-type':'text/html'},body:Buffer.from('<title>Loading shell</title><script async src="/slow.js"></script>')};
  }});
  assert.equal(result.status,'partial');
  assert.ok(result.pendingResources>0);
  assert.equal(slowSignal.aborted,true);
});
test('context guard blocks popup targets outside the page interception session before loopback dispatch',async()=>{
  const {createServer}=await import('node:http');
  let hits=0;
  const server=createServer((_request,response)=>{hits++;response.end('must not be reached');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url='http://127.0.0.1:'+server.address().port+'/popup';
    const result=await renderPageInBrowser({...input,timeoutMs:8000,request:async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from('<title>Popup fixture</title><script>window.open('+JSON.stringify(url)+')</script>')})});
    assert.equal(hits,0);
    assert.equal(result.status,'partial');
    assert.ok(result.blockedResources>0,'the context guard must actually observe and block the popup');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
