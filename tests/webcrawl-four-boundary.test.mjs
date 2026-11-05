import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { safeGet } from '@spora/webcrawl/crawler/safe-transport';
import { parseSitemapDocument } from '@spora/webcrawl/crawler/sitemap';
import { auditWebsiteWithPageData } from '@spora/webcrawl/core/audit';
import { crawlSite } from '@spora/webcrawl/crawler/crawl';
import { DEFAULT_CRAWL_LIMITS } from '@spora/webcrawl/core/defaults';
import { createEvidencePack, verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
import { renderAuditHtml } from '../dist/reports/html.js';
import { renderCustomerSummaryHtml, renderOperatorStatusHtml } from '../dist/reports/summary.js';
const sentinel = 'synthetic-secret';
const html = '<html lang="en"><head><title>Positive fixture</title></head><body><h1>Positive</h1><a href="mailto:office@fixture.test">Contact</a></body></html>';
const options = { timeoutMs: 25, maxResponseBytes: 100000, maxRedirects: 2, allowedHosts: ['fixture.test'], resolveAddresses: async () => ['93.184.216.34'] };
function config(gzip = false, bad = false) {
  return { startUrl: 'https://fixture.test/', includeSitemapEvidence: true, pagespeed: false,
    policy: { ...DEFAULT_CRAWL_LIMITS, allowedHosts: ['fixture.test'], maxPages: 3, maxRequests: 12, maxRuntimeMs: 5000, maxResponseBytes: 100000, maxTotalResponseBytes: 500000, maxRetries: 0, minRequestIntervalMs: 0, maxConcurrency: 1 },
    resolveAddresses: options.resolveAddresses, request: async url => {
      const source = url.pathname === '/robots.txt' ? 'User-agent: *\nDisallow: /private\nSitemap: https://fixture.test/map.xml' :
        url.pathname === '/map.xml' ? '<urlset><url><loc>https://fixture.test/clean</loc></url>' + (bad ? '<url><loc>https://fixture.test/?token=' + sentinel + '</loc></url>' : '') + '</urlset>' : html;
      return { status: 200, headers: { 'Content-Type': url.pathname.endsWith('.xml') ? 'application/xml' : url.pathname.endsWith('.txt') ? 'text/plain' : 'text/html', ...(gzip ? { 'Content-Encoding': 'GZip' } : {}) }, body: gzip ? gzipSync(source) : Buffer.from(source) };
    } };
}
test('O1 compiled matcher and final advisory observations finish under external watchdog', () => {
  const code = `import {robotsAllows,parseRobots} from '@spora/webcrawl/crawler/robots';
import {crawlSite} from '@spora/webcrawl/crawler/crawl';
import {DEFAULT_CRAWL_LIMITS} from '@spora/webcrawl/core/defaults';
const text='User-agent: *\\nDisallow: /'+ '*a'.repeat(9)+'b$';
const policy={status:'available',...parseRobots(text)};
if (!robotsAllows(policy,new URL('https://fixture.test/'+ 'a'.repeat(100)))) throw Error('match');
setImmediate(()=>console.log('progress'));
const result=await crawlSite({startUrl:'https://fixture.test/'+ 'a'.repeat(100),policy:{...DEFAULT_CRAWL_LIMITS,allowedHosts:['fixture.test'],maxPages:1,maxRequests:4,minRequestIntervalMs:0,maxRetries:0},resolveAddresses:async()=>['93.184.216.34'],request:async u=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from(u.pathname==='/robots.txt'?text:'<title>ok</title>')})});
if(result.robotsObservation.advisoryAllowed!==1) throw Error('advisory');
console.log('complete');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), timeout: 5000, encoding: 'utf8' });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /progress/); assert.match(result.stdout, /complete/);
});
test('O4 DNS deadline settles with no dispatch and no late dispatch', async () => {
  let dispatches = 0, finish;
  const pending = safeGet('https://fixture.test/', { ...options, resolveAddresses: () => new Promise(r => finish = r), request: async () => { dispatches++; return {status:200,headers:{},body:Buffer.alloc(0)}; } });
  const result = await Promise.race([pending.catch(e => e), new Promise(r => setTimeout(() => r('hung'), 150))]);
  finish(['93.184.216.34']);
  await new Promise(r => setImmediate(r));
  assert.notEqual(result, 'hung'); assert.match(result.message, /request_deadline/); assert.equal(result.requestCount, 0); assert.equal(result.responseBytes, 0); assert.equal(dispatches, 0);
});
test('O2 gzip content survives transport, crawl, contacts, page data and verified evidence', async () => {
  const plain = await auditWebsiteWithPageData(config(), {});
  const zipped = await auditWebsiteWithPageData(config(true), {});
  assert.equal(zipped.audit.robotsObservation.retrieval, 'available');
  assert.deepEqual(zipped.pageData.pages.map(p => p.title), plain.pageData.pages.map(p => p.title));
  assert.equal(zipped.audit.contacts.candidates.length, plain.audit.contacts.candidates.length);
  assert.ok(zipped.audit.contacts.candidates.length > 0);
  assert.equal(verifyEvidencePack(createEvidencePack(zipped.audit, zipped.pageData)).members.length, 5);
});
test('O3 sitemap parser and raw/public consumers exclude rejected secrets', async () => {
  const document = parseSitemapDocument('<urlset><url><loc>https://fixture.test/?token=' + sentinel + '</loc></url></urlset>', 'https://fixture.test/map.xml', ['fixture.test']);
  const rawProbe = await auditWebsiteWithPageData(config(false, true), {});
  assert.ok(!JSON.stringify(rawProbe.audit).includes(sentinel), 'raw audit must exclude rejected loc values');
  assert.deepEqual(document.urls, []);
  const result = await auditWebsiteWithPageData(config(false, true), {});
  assert.ok(result.audit.sitemap.documents.some(d => d.memberships?.includes('https://fixture.test/clean')));
  const members = verifyEvidencePack(createEvidencePack(result.audit, result.pageData)).members;
  for (const surface of [JSON.stringify(result), renderAuditHtml(result.audit), renderCustomerSummaryHtml(result.audit), renderOperatorStatusHtml(result.audit), ...members.map(m => m.content.toString())]) assert.ok(!surface.includes(sentinel));
});

test('robots ordinary selection, ties, query/end anchors and long literal paths', async () => {
  const { parseRobots, robotsAllows } = await import('@spora/webcrawl/crawler/robots');
  const policy = { status: 'available', ...parseRobots('User-agent: *\nDisallow: /\nUser-agent: audit\nDisallow: /private\nAllow: /private/open\nDisallow: /equal\nAllow: /equal\nDisallow: /query?x=1$\nDisallow: /end$\nDisallow: /a*b*c$','audit') };
  for (const [path, expected] of [['/',true],['/private',false],['/private/open',true],['/equal',true],['/query?x=1',false],['/query?x=12',true],['/end',false],['/ending',true],['/axbyc',false],['/axbycx',true],['/'+'x'.repeat(30000),true]]) assert.equal(robotsAllows(policy,new URL('https://fixture.test'+path)),expected,path);
  assert.equal(robotsAllows({status:'available',rules:[{allow:false,path:'/'+'x'.repeat(30000)+'$'}]},new URL('https://fixture.test/'+'x'.repeat(30000))),false);
});
test('DNS abort, rejection, noncooperative dispatch and listener cleanup', async () => {
  const { getEventListeners } = await import('node:events');
  const controller = new AbortController();
  let calls = 0;
  const request = async () => { calls++; return {status:200,headers:{},body:Buffer.alloc(0)}; };
  const pending = safeGet('https://fixture.test/', {...options, signal:controller.signal,resolveAddresses:()=>new Promise(()=>{}),request});
  controller.abort();
  await assert.rejects(pending,/request_aborted/);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  await assert.rejects(safeGet('https://fixture.test/',{...options,resolveAddresses:async()=>{throw Error('dns_failure');},request}),/dns_failure/);
  await assert.rejects(safeGet('https://fixture.test/',{...options,resolveAddresses:async()=>['127.0.0.1'],request}),/unsafe_dns_resolution/);
  assert.equal(calls,0);
  await assert.rejects(safeGet('https://fixture.test/',{...options,request:()=>new Promise(()=>{})}),/request_deadline/);
  for(let i=0;i<15;i++) await safeGet('https://fixture.test/',{...options,signal:controller.signal.aborted ? new AbortController().signal : controller.signal,request});
});
test('decoder bounds malformed codings, streams, bombs, cancellation; raw wire body stays compatible', async () => {
  const { decodeResponseText } = await import('@spora/webcrawl/crawler/content-decoding');
  const body=gzipSync(html);
  const response=await safeGet('https://fixture.test/',{...options,request:async()=>({status:200,headers:{'CONTENT-ENCODING':'GZip'},body})});
  assert.deepEqual(response.body,body); assert.equal(response.responseBytes,body.length);
  assert.equal(await decodeResponseText(response,10000),html);
  for(const coding of ['br','deflate','gzip, identity','','gzip\ngzip']) await assert.rejects(decodeResponseText({headers:{'content-encoding':coding},body},10000),/unsupported_content_encoding/);
  for(const bytes of [Buffer.from('bad'),body.subarray(0,body.length-3)]) await assert.rejects(decodeResponseText({headers:{'content-encoding':'gzip'},body:bytes},10000),/invalid_compressed_content/);
  await assert.rejects(decodeResponseText({headers:{'content-encoding':'gzip'},body:gzipSync('x'.repeat(1000000))},100),/decoded_response_too_large/);
  const controller=new AbortController();
  const pending=decodeResponseText({headers:{'content-encoding':'gzip'},body:gzipSync('x'.repeat(1000000))},2000000,controller.signal); controller.abort();
  await assert.rejects(pending,/content_decode_aborted/);
  for(const coding of ['br','gzip']) {
    const base=config();
    const result=await auditWebsiteWithPageData({...base,request:async(url,...args)=>url.pathname==='/robots.txt' ? base.request(url,...args):({status:200,headers:{'content-type':'text/html','content-encoding':coding},body:Buffer.from('invalid')})},{});
    assert.equal(result.audit.crawl.captured,0);
    assert.ok(result.audit.crawl.failed>0);
    assert.notEqual(result.audit.contacts.status,'complete');
    assert.ok(!result.audit.findings.some(f=>f.code==='missing_title'));
    assert.doesNotMatch(renderCustomerSummaryHtml(result.audit),/Coverage limitations|partial coverage/);
    assert.equal(verifyEvidencePack(createEvidencePack(result.audit,result.pageData)).members.length,5);
  }
});
test('sitemap rejection variants, index controls, declaration privacy, disabled evidence and omission counts', async () => {
  const candidates=['https://fixture.test/?%74oken='+sentinel,'https://u:'+sentinel+'@fixture.test/','https://fixture.test/%63heckout','ftp://fixture.test/file','https://external.test/'];
  const doc=parseSitemapDocument('<urlset>'+[...candidates,'https://fixture.test/ok#fragment','https://fixture.test/extra'].map(u=>'<url><loc>'+u+'</loc></url>').join('')+'</urlset>','https://fixture.test/map.xml',['fixture.test'],1);
  assert.deepEqual(doc.urls,['https://fixture.test/ok']); assert.equal(doc.rejectedUrls,5); assert.equal(doc.omittedUrls,1);
  assert.deepEqual(parseSitemapDocument('<sitemapindex><sitemap><loc>/child.xml</loc></sitemap></sitemapindex>','https://fixture.test/map.xml',['fixture.test']).urls,['https://fixture.test/child.xml']);
  for(const includeSitemapEvidence of [false,true]) {
    const base=config(false,true); const requested=[];
    const result=await auditWebsiteWithPageData({...base,includeSitemapEvidence,request:async(url,...args)=>{
      requested.push(url.href);
      if(url.pathname==='/robots.txt') return {status:200,headers:{},body:Buffer.from('Sitemap: https://fixture.test/map.xml\nSitemap: https://fixture.test/?token='+sentinel+'\nSitemap: https://user:'+sentinel+'@fixture.test/secret')};
      return base.request(url,...args);
    }},{});
    assert.ok(!requested.some(u=>u.includes(sentinel)));
    assert.ok(!JSON.stringify(result).includes(sentinel));
    if(includeSitemapEvidence) { assert.equal(result.audit.sitemap.omittedDocuments,2); assert.match(result.audit.sitemap.documents[0].error,/sitemap_rejected_urls:1/); }
  }
});
test('active DNS deadline excludes scheduler pacing and renews for retries/redirects; budgets stay wire based', async () => {
  const { CrawlRequestBudget, CrawlRequestScheduler } = await import('@spora/webcrawl/crawler/request-control');
  const { decodeResponseText } = await import('@spora/webcrawl/crawler/content-decoding');
  const { getEventListeners } = await import('node:events');
  const signal = new AbortController().signal;
  const scheduler = new CrawlRequestScheduler(1, 60);
  const body = gzipSync(html); let calls = 0, resolutions = 0;
  const budget = new CrawlRequestBudget(4, body.length * 4);
  const result = await safeGet('https://fixture.test/', {...options,timeoutMs:40,signal,scheduler,budget,maxRetries:1,retryBaseDelayMs:0,retryMaxDelayMs:0,
    resolveAddresses:async()=>{ resolutions++; await new Promise(r=>setTimeout(r,5)); return ['93.184.216.34']; },
    request:async(url,addresses,hop)=>{ assert.ok(hop.timeoutMs<40); calls++; return {status:calls===1?500:url.pathname==='/'?302:200,headers:{'content-encoding':'gzip',...(url.pathname==='/'?{location:'/done'}:{})},body}; }});
  assert.equal(calls,3); assert.equal(resolutions,3); assert.equal(result.requestCount,3);
  assert.equal(result.responseBytes,body.length*3); assert.equal(budget.responseBytes,result.responseBytes);
  assert.equal(await decodeResponseText(result,10000),html);
  assert.equal(getEventListeners(signal,'abort').length,0);
  for(let i=0;i<20;i++) await safeGet('https://fixture.test/',{...options,signal,request:async()=>({status:200,headers:{},body:Buffer.alloc(0)})});
  assert.equal(getEventListeners(signal,'abort').length,0);
  await assert.rejects(safeGet('https://fixture.test/',{...options,maxResponseBytes:body.length-1,request:async()=>({status:200,headers:{},body})}),e=>e.responseBytes===body.length && e.message==='response_too_large');
  const empty=new CrawlRequestBudget(0,100);
  await assert.rejects(safeGet('https://fixture.test/',{...options,budget:empty,request:async()=>{throw Error('must not dispatch');}}),e=>e.requestCount===0 && e.message==='request_budget_exhausted');
});
test('decoded bomb is an explicit failed inspection through audit and evidence consumers', async () => {
  const base=config(); const compressed=gzipSync('<title>hidden</title>'+'x'.repeat(100000));
  const result=await auditWebsiteWithPageData({...base,policy:{...base.policy,maxResponseBytes:2000},request:async url=>url.pathname==='/robots.txt' ? {status:404,headers:{},body:Buffer.alloc(0)} : {status:200,headers:{'content-type':'text/html','content-encoding':'gzip'},body:compressed}},{});
  assert.equal(result.audit.crawl.captured,0);
  assert.equal(result.audit.coverage.urls[0].reason,'decoded_response_too_large');
  assert.equal(result.audit.crawl.physicalRequests,2);
  assert.equal(result.audit.contacts.candidates.length,0);
  assert.equal(verifyEvidencePack(createEvidencePack(result.audit,result.pageData)).members.length,5);
});
test('exact exhausted budgets stay complete while caps with pending frontier are partial', async () => {
  const { auditWebsite } = await import('@spora/webcrawl/core/audit');
  const run = async (maxPages, maxRequests, body) => auditWebsite({
    startUrl: 'https://fixture.test/', contacts: false, pagespeed: false,
    policy: { ...DEFAULT_CRAWL_LIMITS, allowedHosts: ['fixture.test'], maxPages, maxRequests, maxImageChecks: 0, minRequestIntervalMs: 0, maxRetries: 0 },
    resolveAddresses: options.resolveAddresses,
    request: async url => url.pathname === '/robots.txt'
      ? { status: 404, headers: {}, body: Buffer.alloc(0) }
      : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(body) },
  });
  const complete = '<html><head><title>Only page</title></head><body><h1>Only page</h1></body></html>';
  const exact = await run(1, 2, complete);
  assert.deepEqual(exact.crawl.limitations, []);
  assert.equal(exact.capabilities.http, 'complete');
  const pending = '<html><head><title>Frontier</title></head><body><h1>Frontier</h1><a href="/next">Next</a></body></html>';
  const pageCap = await run(1, 10, pending);
  assert.ok(pageCap.crawl.limitations.includes('page_limit'));
  const requestCap = await run(10, 2, pending);
  assert.ok(requestCap.crawl.limitations.includes('request_limit'));
  assert.equal(requestCap.crawl.unattempted, 1);
});

test('same-host broken-link scope excludes authorized secondary hosts and accounts for safe exclusions', async () => {
  const basePolicy = { ...DEFAULT_CRAWL_LIMITS, allowedHosts: ['primary.fixture', 'secondary.fixture'], maxPages: 2, maxRequests: 8, maxRuntimeMs: 5_000, maxResponseBytes: 50_000, maxTotalResponseBytes: 200_000, maxRetries: 0, minRequestIntervalMs: 0, maxConcurrency: 1, maxImageChecks: 0 };
  const dispatches = [];
  const result = await crawlSite({
    startUrl: 'https://primary.fixture/',
    policy: basePolicy,
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      dispatches.push(url.href);
      if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (url.hostname === 'secondary.fixture') return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Missing</title>') };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Primary</title><h1>Primary</h1><a href="https://secondary.fixture/missing">Allowed host</a><a href="/logout">Logout</a><a href="/checkout">Checkout</a><a href="/?email=private%40example.test">Email route</a>') };
    },
  });
  const coverage = result.coverage.checks.internalLinks;
  assert.equal(coverage.scope, 'same_host');
  assert.equal(coverage.status, 'partial');
  assert.equal(coverage.findings, 0);
  assert.equal(coverage.outOfScope, 1);
  assert.equal(coverage.omittedTargets, 3);
  assert.equal(coverage.skipped, 3);
  assert.ok(dispatches.includes('https://secondary.fixture/missing'));
  assert.ok(!dispatches.some((url) => /logout|checkout|email=/u.test(url)));
  assert.ok(!JSON.stringify(result).includes('private@example.test'));
});
test('unsupported XHTML keeps HTTP capture but leaves DOM-dependent checks partial', async () => {
  const { auditWebsiteWithPageData } = await import('@spora/webcrawl/core/audit');
  const body = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Not parsed</title></head><body><h1>Not parsed</h1></body></html>';
  const result = await auditWebsiteWithPageData({
    startUrl: 'https://fixture.test/', contacts: false, pagespeed: false,
    policy: { ...DEFAULT_CRAWL_LIMITS, allowedHosts: ['fixture.test'], maxPages: 1, maxRequests: 2, maxImageChecks: 0, minRequestIntervalMs: 0, maxRetries: 0 },
    resolveAddresses: options.resolveAddresses,
    request: async url => url.pathname === '/robots.txt'
      ? { status: 404, headers: {}, body: Buffer.alloc(0) }
      : { status: 200, headers: { 'content-type': 'application/xhtml+xml' }, body: Buffer.from(body) },
  }, { includeRawHtml: true });
  assert.equal(result.audit.crawl.captured, 1);
  assert.equal(result.audit.findings.some(f => f.code === 'missing_h1'), false);
  assert.equal(result.audit.coverage.checks.securityHeaders.status, 'complete');
  assert.equal(result.audit.coverage.checks.mixedContent.status, 'partial');
  assert.equal(result.audit.coverage.checks.sensitiveForms.status, 'partial');
  assert.equal(result.pageData.pages[0].contentStatus, 'unavailable');
  assert.equal(result.pageData.pages[0].headings.length, 0);
  assert.match(result.pageData.pages[0].rawHtml, /Not parsed/u);
});
test('final adversarial challenge: literal/star/end ordering agrees with bounded reference; late DNS rejection stays handled', async () => {
  const { robotsAllows }=await import('@spora/webcrawl/crawler/robots');
  const patterns=['/a*b*a$','/**a**b$','/*$','/$','/a?x=*b$','/a.b*','/a$b','/a**a*a'];
  const paths=['/','/a','/ababa','/a.b','/a?x=ab','/a?x=abc','/a$b','/aaaaab'];
  for(const pattern of patterns) for(const path of paths) {
    const escaped=pattern.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&').replaceAll('\\*','.*').replace(/\\\$$/u,'$');
    const url=new URL('https://fixture.test'+path);
    assert.equal(robotsAllows({status:'available',rules:[{allow:false,path:pattern}]},url),!new RegExp('^'+escaped,'u').test(url.pathname+url.search),pattern+' '+path);
  }
  let rejectLate;
  await assert.rejects(safeGet('https://fixture.test/',{...options,resolveAddresses:()=>new Promise((_,reject)=>rejectLate=reject),request:async()=>{throw Error('late dispatch');}}),/request_deadline/);
  rejectLate(Error('late rejection')); await new Promise(r=>setImmediate(r));
});
