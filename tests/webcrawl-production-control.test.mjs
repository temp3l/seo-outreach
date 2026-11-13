import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, writeFile, readFile, unlink, stat, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runCli, assertPageDataReadback } from '../dist/compat/cli.js';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { runBatch } from '../dist/compat/cli/batch.js';
import { crawlSite } from '@spora/webcrawl/crawler/crawl';
import { createDefaultCrawlPolicy } from '@spora/webcrawl/core/defaults';
import { safeGet } from '@spora/webcrawl/crawler/safe-transport';
import { CrawlRequestScheduler } from '@spora/webcrawl/crawler/request-control';
import { imageEnrichment } from '@spora/webcrawl/enrichments/images';
import { createPageSpeedEnrichment } from '@spora/webcrawl/enrichments/pagespeed';
import { verifyEvidencePack } from '@spora/webcrawl/reports/evidence-pack';
const html = '<html lang="en"><title>Fixture</title><h1>Fixture</h1><a href="/next">Next</a></html>';
const transport = { resolveAddresses: async () => ['93.184.216.34'], request: async (url) => ({ status: url.pathname === '/' ? 200 : 404, headers: { 'content-type': 'text/html' }, body: Buffer.from(url.pathname === '/' ? html : '') }) };
test('CLI PageSpeed protects query URLs by default and requires a separate query disclosure opt-in', async () => {
  const root = await mkdtemp('/tmp/webcrawl-cli-pagespeed-query-');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const request = new URL(url);
    calls.push(request.searchParams.get('url'));
    const requestedUrl = request.searchParams.get('url');
    return Response.json({ lighthouseResult: { requestedUrl, finalUrl: requestedUrl, fetchTime: new Date().toISOString(), configSettings: { formFactor: 'mobile' }, categories: Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map(name => [name, { score: .9 }])) } });
  };
  try {
    const target = 'https://fixture.example/?campaign=private';
    const baseArgs = [target, '--no-pdf', '--no-page-data'];
    const defaultOut = `${root}/default`;
    await runCli([...baseArgs, '--out', defaultOut], transport);
    const safeResult = JSON.parse(await readFile(`${defaultOut}.json`, 'utf8'));
    assert.equal(calls.length, 0);
    assert.equal(safeResult.enrichmentLimitations.pagespeed, 'pagespeed_query_requires_explicit_opt_in');

    await runCli([...baseArgs, '--out', `${root}/enabled`, '--pagespeed'], transport);
    assert.equal(calls.length, 0);
    const explicitOut = `${root}/explicit`;
    await runCli([...baseArgs, '--out', explicitOut, '--pagespeed', '--pagespeed-include-query'], transport);
    const explicitResult = JSON.parse(await readFile(`${explicitOut}.json`, 'utf8'));
    assert.deepEqual(calls, [target]);
    assert.equal(explicitResult.capabilities.pagespeed, 'complete');
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
test('client-report contact-file errors fail preflight before runtime, requests or publication', async () => {
  const root = await mkdtemp('/tmp/webcrawl-report-contact-');
  let requests = 0;
  const injected = {...transport,request:async(...args)=>{requests++;return transport.request(...args);}};
  const contactFile = root+'/issuer.json';
  for (const value of [{name:'Valid Name'}, {name:'Valid Name',email:'bad'}, {name:'Valid Name',website:'javascript:alert(1)'}, {name:'X'.repeat(101),email:'reviewer@example.test'}]) {
    await writeFile(contactFile,JSON.stringify(value),{mode:0o600});
    await assert.rejects(runCli(['https://fixture.example/','--pdf','--report-contact-file',contactFile,'--out',root+'/audit'],injected));
  }
  await assert.rejects(runCli(['https://fixture.example/','--pdf','--report-contact-file',root+'/absent.json','--out',root+'/audit'],injected));
  await assert.rejects(runCli(['https://fixture.example/','--pdf','--report-contact-file'],injected),/missing_cli_option_value/u);
  assert.equal(requests,0);
  assert.deepEqual(await readdir(root),['issuer.json']);
});
test('private readback detects page payload and limit changes even when envelope counts and audit hash match', () => {
  const { audit, pageData } = createEvidenceFixture(1);
  const expected = { ...pageData, target: audit.target, auditStartedAt: audit.startedAt, auditCompletedAt: audit.completedAt, auditSha256: createHash('sha256').update(JSON.stringify(audit)).digest('hex') };
  assert.doesNotThrow(() => assertPageDataReadback(structuredClone(expected), audit, expected));
  for (const mutate of [data => { data.pages[0] = {}; }, data => { data.pages[0].source = 'rendered_dom'; }, data => { data.limits.includeRawHtml = true; }]) {
    const changed = structuredClone(expected); mutate(changed);
    assert.throws(() => assertPageDataReadback(changed, audit, expected), /page_data_readback_digest_mismatch/u);
  }
});
test('raw export rejects nonprivate and unwritable parent permissions before any request', async () => {
  const root = await mkdtemp('/tmp/webcrawl-private-preflight-');
  let requests = 0;
  try {
    for (const mode of [0o777, 0o755, 0o500]) {
      await chmod(root, mode);
      await assert.rejects(runCli(['https://fixture.example/', '--out', `${root}/audit`, '--page-data-html'], { ...transport, request: async (...args) => { requests++; return transport.request(...args); } }));
      assert.equal(requests, 0);
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await chmod(root, 0o700); }
});
test('CLI rejects unknown, extra, missing and batch-inapplicable options before requests/output', async () => {
  const root = await mkdtemp('/tmp/webcrawl-control-cli-');
  let calls = 0;
  for (const bad of [['--requests=1'], ['--request','1'], ['extra'], ['--out'], ['--requests','1','--requests','2'], ['--locale','xx']]) {
    await assert.rejects(runCli(['https://fixture.example/', ...bad], { ...transport, request: async (...args) => { calls++; return transport.request(...args); } }));
  }
  await assert.rejects(runCli(['--batch','missing.csv','--requests','1']));
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
  await runCli(['https://fixture.example/','--out',root+'/ok','--requests','1','--no-contacts','--no-page-data','--no-pagespeed','--no-pdf','--no-evidence-pack'], transport);
  const result = JSON.parse(await readFile(root+'/ok.json','utf8'));
  assert.equal(result.crawlSettings.policy.maxRequests, 1);
  assert.equal(result.capabilities.pagespeed,'disabled');
  assert.deepEqual((await readdir(root)).sort(), ['ok.html','ok.json','ok.run.log','ok.scan-status.json','ok.whatsapp-draft.md']);
});
test('one injected crawl publishes a safe evidence pack and separate private page data without repeated fetches', async () => {
  const root = await mkdtemp('/tmp/webcrawl-control-many-outputs-');
  const trace = [];
  const privateMarker = 'PRIVATE_HTML_ONLY_X9B7';
  const fixture = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url, _addresses, options) => {
      trace.push(`${options.method}:${url.pathname}`);
      if (url.pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('User-agent: *\nAllow: /') };
      if (url.pathname === '/') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><head><title>Fixture</title><link rel="canonical" href="https://fixture.example/"></head><body><script>${privateMarker}</script><main><h1>Home</h1><h3>Details</h3><a href="/contact">Contact</a><img src="/hero.jpg"></main></body></html>`) };
      if (url.pathname === '/contact') return { status: 302, headers: { location: '/contact-us', 'content-type': 'text/html' }, body: Buffer.alloc(0) };
      if (url.pathname === '/contact-us') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><title>Contact</title></head><body><main><h1>Contact us</h1></main></body></html>') };
      if (url.pathname === '/hero.jpg' && options.method === 'HEAD') return { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '600000' }, body: Buffer.alloc(0) };
      return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.alloc(0) };
    },
  };
  const common = ['--requests', '10', '--pages', '2', '--image-checks', '1', '--interval-ms', '0', '--retries', '0', '--no-contacts', '--no-pagespeed'];
  const out = `${root}/combined`;
  const privatePath = `${root}/private.json`;
  const zipPath = `${root}/evidence.zip`;
  const issuerPath = `${root}/issuer.json`;
  await writeFile(issuerPath, JSON.stringify({name:'PRIVATE_ISSUER_FIXTURE',email:'private-issuer@example.test'}), {mode:0o600});
  await runCli(['https://fixture.example/', '--out', out, '--evidence-pack', zipPath, '--page-data', privatePath, '--page-data-html', '--pdf', '--operator-pdf', '--report-contact-file', issuerPath, ...common], fixture);
  const firstTrace = [...trace];
  assert.deepEqual(firstTrace, ['GET:/robots.txt', 'GET:/', 'GET:/contact', 'GET:/contact-us', 'HEAD:/hero.jpg']);
  const audit = JSON.parse(await readFile(`${out}.json`, 'utf8'));
  const privateData = JSON.parse(await readFile(privatePath, 'utf8'));
  assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_ISSUER_FIXTURE|private-issuer@example.test/u);
  assert.equal(privateData.sensitivity, 'REVIEW_BEFORE_UPLOAD');
  assert.equal(privateData.auditSha256, createHash('sha256').update(JSON.stringify(audit)).digest('hex'));
  assert.equal(privateData.auditStartedAt, audit.startedAt);
  assert.equal(privateData.auditCompletedAt, audit.completedAt);
  assert.equal(privateData.targetPages, audit.crawl.captured);
  assert.equal(privateData.exportedPages, privateData.pages.length);
  assert.match(JSON.stringify(privateData), new RegExp(privateMarker, 'u'));
  assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  for (const pdfPath of [`${out}.pdf`, `${out}.operator-status.pdf`]) {
    assert.equal((await readFile(pdfPath)).subarray(0, 4).toString(), '%PDF');
    assert.equal((await stat(pdfPath)).mode & 0o777, 0o600);
  }
  const checked = verifyEvidencePack(await readFile(zipPath));
  assert.deepEqual(checked.members.map((member) => member.name), ['README.md', 'audit.json', 'pages.jsonl', 'site-graph.json', 'manifest.json']);
  for (const member of checked.members) {
    assert.doesNotMatch(member.content.toString('utf8'), /PRIVATE_ISSUER_FIXTURE|private-issuer@example.test/u);
    assert.doesNotMatch(member.content.toString('utf8'), new RegExp(privateMarker, 'u'));
    assert.doesNotMatch(member.content.toString('utf8'), /"rawHtml(?:Truncated)?"/u);
  }
  assert.equal(checked.manifest.originalAuditSha256, privateData.auditSha256);
  assert.equal(checked.manifest.rawSource.included, false);
  trace.length = 0;
  const packOnlyOut = `${root}/pack-only`;
  await runCli(['https://fixture.example/', '--out', packOnlyOut, '--evidence-pack', `${root}/pack-only.zip`, '--no-pdf', ...common], fixture);
  assert.deepEqual(trace, firstTrace);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('pack-only')).sort(), ['pack-only.html', 'pack-only.json', 'pack-only.run.log', 'pack-only.scan-status.json', 'pack-only.whatsapp-draft.md', 'pack-only.zip']);
  trace.length = 0;
  const defaultOut = `${root}/default`;
  await runCli(['https://fixture.example/', '--out', defaultOut, '--no-pdf', '--no-evidence-pack', '--page-data', `${defaultOut}.page-data.json`, ...common], fixture);
  assert.deepEqual(trace, firstTrace);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('default')).sort(), ['default.html', 'default.json', 'default.page-data.json', 'default.run.log', 'default.scan-status.json', 'default.whatsapp-draft.md']);
  trace.length = 0;
  const packDisabledOut = `${root}/pack-disabled`;
  await runCli(['https://fixture.example/', '--out', packDisabledOut, '--evidence-pack', `${root}/pack-disabled.zip`, '--no-page-data', '--no-pdf', ...common], fixture);
  assert.deepEqual(trace, firstTrace);
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('pack-disabled')).sort(), ['pack-disabled.html', 'pack-disabled.json', 'pack-disabled.run.log', 'pack-disabled.scan-status.json', 'pack-disabled.whatsapp-draft.md', 'pack-disabled.zip']);
  trace.length = 0;
  const rawOnlyOut = `${root}/raw-only`;
  await runCli(['https://fixture.example/', '--out', rawOnlyOut, '--page-data-html', '--no-pdf', ...common], fixture);
  assert.deepEqual(trace, firstTrace);
  assert.match(await readFile(`${rawOnlyOut}.page-data.json`, 'utf8'), new RegExp(privateMarker, 'u'));
  trace.length = 0;
  const packRawOut = `${root}/pack-raw-default`;
  await runCli(['https://fixture.example/', '--out', packRawOut, '--evidence-pack', `${root}/pack-raw-default.zip`, '--page-data-html', '--no-pdf', ...common], fixture);
  assert.deepEqual(trace, firstTrace);
  assert.match(await readFile(`${packRawOut}.page-data.json`, 'utf8'), new RegExp(privateMarker, 'u'));
  for (const member of verifyEvidencePack(await readFile(`${root}/pack-raw-default.zip`)).members) assert.doesNotMatch(member.content.toString('utf8'), new RegExp(privateMarker, 'u'));
  let invalidCalls = 0;
  for (const flags of [['--no-page-data', '--page-data', `${root}/invalid.json`], ['--no-page-data', '--page-data-html']]) {
    await assert.rejects(runCli(['https://fixture.example/', '--out', `${root}/invalid-${invalidCalls}`, ...flags], { ...fixture, request: async (...args) => { invalidCalls++; return fixture.request(...args); } }), /cannot be combined/u);
  }
  await assert.rejects(runCli(['--batch', `${root}/missing.csv`, '--page-data', `${root}/batch.json`], { ...fixture, request: async (...args) => { invalidCalls++; return fixture.request(...args); } }), /unsupported_batch_option/u);
  assert.equal(invalidCalls, 0);
});
test('a later publication failure preserves and exposes the already-published prefix without false completion', async () => {
  const root = await mkdtemp('/tmp/webcrawl-control-partial-');
  const out = `${root}/audit`;
  const zip = `${root}/evidence.zip`;
  const privatePath = `${root}/private.json`;
  let planted = false;
  const racingTransport = {
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => {
      if (!planted) { planted = true; await writeFile(`${out}.html`, 'preserve competing output', { mode: 0o600, flag: 'wx' }); }
      return url.pathname === '/robots.txt'
        ? { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(0) }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><title>Fixture</title><main>Fixture</main></html>') };
    },
  };
  await assert.rejects(runCli(['https://fixture.example/', '--out', out, '--evidence-pack', zip, '--page-data', privatePath, '--requests', '2', '--pages', '1', '--image-checks', '0', '--interval-ms', '0', '--retries', '0', '--no-contacts', '--no-pagespeed', '--no-pdf'], racingTransport), { code: 'EEXIST' });
  assert.equal(await readFile(`${out}.html`, 'utf8'), 'preserve competing output');
  assert.equal(JSON.parse(await readFile(`${out}.json`, 'utf8')).target, 'https://fixture.example/');
  assert.equal(verifyEvidencePack(await readFile(zip)).members.length, 5);
  await assert.rejects(readFile(privatePath), { code: 'ENOENT' });
});
test('byte exhaustion terminates with queued unattempted URLs and lets timers run', { timeout: 2000 }, async () => {
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 15);
  const result = await crawlSite({ startUrl: 'https://fixture.example/', contacts: false, policy: createDefaultCrawlPolicy('https://fixture.example/', { maxResponseBytes: Buffer.byteLength(html), maxTotalResponseBytes: Buffer.byteLength(html), maxRequests: 10, minRequestIntervalMs: 0, maxRetries: 0, maxImageChecks: 0 }), ...transport });
  await new Promise(resolve => setTimeout(resolve, 20));
  clearTimeout(timer);
  assert.equal(fired,true);
  assert.ok(result.summary.unattempted > 0);
  assert.ok(result.summary.limitations.includes('total_response_byte_limit'));
});
test('500 Retry-After delays retry with and without scheduler', async () => {
  for (const scheduler of [undefined, new CrawlRequestScheduler(1,0)]) {
    const starts = [];
    await safeGet('https://fixture.example/', { ...transport, request: async () => { starts.push(Date.now()); return { status: starts.length === 1 ? 500 : 200, headers: { 'retry-after':'0.05' }, body: Buffer.alloc(0) }; }, allowedHosts:['fixture.example'], timeoutMs:2000, maxResponseBytes:1000, maxRedirects:0, userAgent:'fixture', maxRetries:1, retryBaseDelayMs:50, retryMaxDelayMs:100, ...(scheduler ? { scheduler } : {}) });
    assert.equal(starts.length,2);
    assert.ok(starts[1]-starts[0] >= 40);
  }
});
test('batch excludes same/incompatible owners, resumes without requests and preserves uncertain lock', async () => {
  const root = await mkdtemp('/tmp/webcrawl-control-batch-');
  const input = root+'/sites.csv';
  await writeFile(input,'website\nhttps://fixture.example/\n');
  let release;
  const barrier = new Promise(resolve => { release=resolve; });
  let started;
  const start = new Promise(resolve => { started=resolve; });
  const owner = runBatch(input,root+'/out',false,false,false,{ ...transport, request: async (...args) => { started(); await barrier; return transport.request(...args); } },false);
  await start;
  await assert.rejects(runBatch(input,root+'/out',true,false,false,transport,false), /batch_directory_locked/);
  release(); await owner;
  await runBatch(input,root+'/out',true,false,false,{ ...transport, request: async () => { throw new Error('resume must not crawl'); } },false);
  await writeFile(root+'/out/.batch.lock','interrupted owner');
  await assert.rejects(runBatch(input,root+'/out',true,false,false,transport,false), /batch_directory_locked/);
  assert.equal(await readFile(root+'/out/.batch.lock','utf8'),'interrupted owner');
  await unlink(root+'/out/.batch.lock');
});
test('image alt uses DOM attributes, comments and malformed input safely', async () => {
  const result = await imageEnrichment.run({ target:'https://fixture.example/', capturedAt:new Date().toISOString(), pages:[{ url:'https://fixture.example/', html:'<!-- <img> --><img alt=Logo><img data-alt="x"><img alt="quoted > value">' }] });
  assert.equal(result.findings[0].evidence[0].value,1);
  let fired = false; setImmediate(() => { fired=true; });
  await imageEnrichment.run({ target:'https://fixture.example/', capturedAt:new Date().toISOString(), pages:[{ url:'https://fixture.example/', html:'<img '.repeat(20000) }] });
  assert.equal(fired,true);
});
test('PageSpeed cancels HTTP errors and validates scores and outbound identity', async () => {
  let cancelled=false;
  const context={ target:'https://fixture.example/?meaningful=yes#private', capturedAt:new Date().toISOString(), pages:[] };
  const error = createPageSpeedEnrichment({ includeQuery:true, fetch: async url => { assert.equal(new URL(url).searchParams.get('url'),'https://fixture.example/?meaningful=yes'); return new Response(new ReadableStream({ cancel() { cancelled=true; } }),{ status:429 }); } });
  assert.equal((await error.run(context)).status,'unavailable'); assert.equal(cancelled,true);
  assert.equal((await error.run({ ...context,target:'https://user:secret@fixture.example/' })).status,'failed');
  for (const [categories,status] of [[{},'unavailable'],[{seo:{score:0.8},performance:{score:2}},'partial'],[Object.fromEntries(['performance','accessibility','best-practices','seo'].map(name=>[name,{score:1}])),'complete']]) {
    const requestedUrl='https://fixture.example/?meaningful=yes';
    const adapter=createPageSpeedEnrichment({ includeQuery:true, fetch:async()=>Response.json({lighthouseResult:{requestedUrl,finalUrl:requestedUrl,fetchTime:new Date().toISOString(),configSettings:{formFactor:'mobile'},categories}}) });
    assert.equal((await adapter.run(context)).status,status);
  }
});
test('adapter identity collisions fail before crawl; ordinary adapters and missing HTML are truthful', async () => {
  const { auditWebsite } = await import('@spora/webcrawl/core/audit');
  let calls=0;
  const config={ startUrl:'https://fixture.example/', contacts:false, pagespeed:false, policy:createDefaultCrawlPolicy('https://fixture.example/', { maxRequests:1, maxPages:1, maxImageChecks:0 }), ...transport, request:async(...args)=>{calls++; return transport.request(...args);} };
  const good={name:'custom',run:async()=>({status:'complete',findings:[]})};
  const bad={name:'custom',run:async()=>{throw new Error('fixture');}};
  for (const adapters of [[good,bad],[bad,good],[{...good,name:'http'}],[{...good,name:'contacts'}]]) await assert.rejects(auditWebsite(config,adapters), /enrichment_name/);
  await assert.rejects(auditWebsite({...config,retainHtml:false},[imageEnrichment]), /requires_html/);
  assert.equal(calls,0);
  assert.equal((await auditWebsite(config,[good])).capabilities.custom,'complete');
  assert.equal((await auditWebsite(config,[bad])).capabilities.custom,'failed');
  const empty=await auditWebsite({...config,request:async()=>{throw new Error('offline fixture');}},[imageEnrichment]);
  assert.equal(empty.capabilities.images,'unavailable');
});
test('malformed enrichment results fail only their adapter and large title evidence stays recordable', async () => {
  const { auditWebsite } = await import('@spora/webcrawl/core/audit');
  const { MemoryRecordingStore, recordingDigest } = await import('@spora/webcrawl/recordings/store');
  const config = { startUrl: 'https://fixture.example/', contacts: false, pagespeed:false, policy: createDefaultCrawlPolicy('https://fixture.example/', { maxRequests: 2, maxPages: 1, maxImageChecks: 0, minRequestIntervalMs: 0, maxRetries: 0 }), ...transport };
  const good = { name: 'good', requirements: { input: 'target' }, run: async () => ({ status: 'complete', findings: [] }) };
  let malformedIndex = 0;
  for (const run of [async () => undefined, async () => null, async () => ({ status: 'success', findings: [] }), async () => ({ status: 'partial', findings: [], limitation: { private: 'object' } }), async () => ({ status: 'complete', findings: [], limitation: 'x'.repeat(501) })]) {
    const malformed = { name: `malformed-${malformedIndex++}`, requirements: { input: 'target' }, run };
    const result = await auditWebsite(config, [good, malformed]);
    assert.equal(result.capabilities.good, 'complete');
    assert.equal(result.capabilities[malformed.name], 'failed');
    assert.equal(result.enrichmentLimitations[malformed.name], 'invalid_enrichment_result');
  }
  const title = 'T'.repeat(2_100_000);
  const large = await auditWebsite({ ...config, request: async (url) => url.pathname === '/robots.txt' ? { status: 404, headers: {}, body: Buffer.alloc(0) } : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<html><head><title>${title}</title></head><body><h1>Large title</h1></body></html>`) }, policy: { ...config.policy, maxRequests: 2, maxResponseBytes: 3_000_000, maxTotalResponseBytes: 4_000_000 } });
  const titleFinding = large.findings.find((finding) => finding.code === 'title_long');
  assert.equal(titleFinding.evidence[0].excerpt.length, 2_000);
  assert.equal(titleFinding.evidence[0].excerptOriginalLength, title.length);
  assert.equal(titleFinding.evidence[0].excerptTruncated, true);
  const unsigned = { schemaVersion: '1', id: 'large-title', capturedAt: large.completedAt, target: large.target, payload: large };
  const recording = { ...unsigned, sha256: recordingDigest(unsigned) };
  const store = new MemoryRecordingStore();
  await store.put(recording);
  assert.deepEqual(await store.get(recording.id), recording);
});
test('image candidates deduplicate before limits and disclose real distinct overflow under effective base',async()=>{
 const {inspectPage}=await import('@spora/webcrawl/analysis/technical');
 const page={requestedUrl:'https://fixture.example/',finalUrl:'https://fixture.example/',statusCode:200,contentType:'text/html',fetchedAt:new Date().toISOString(),responseBytes:1};
 const repeated=inspectPage({...page,html:'<base href="/assets/">'+'<img src="repeat.png">'.repeat(10000)+'<img src="late.png">'});
 assert.equal(repeated.images.length,2);assert.equal(repeated.images[1].src,'https://fixture.example/assets/late.png');
 const distinct=inspectPage({...page,html:Array.from({length:1001},(_,i)=>`<img src="/${i}.png">`).join('')});
 assert.equal(distinct.images.length,1000);assert.equal(distinct.omittedImageCandidates,1);
});
test('late 13th contact source suppresses affected primary while preserving other contact kind',async()=>{
 const {ContactCollector}=await import('@spora/webcrawl/enrichments/contacts');
 const {auditWebsite}=await import('@spora/webcrawl/core/audit');
 const html='<main>'+Array.from({length:12},(_,i)=>`<a id="booking-${i}" href="mailto:office@fixture.example">Booking</a>`).join('')+'<a id="privacy" href="mailto:office@fixture.example">Privacy</a><a href="tel:+493012345678">Booking</a></main>';
 const collector=new ContactCollector();collector.observe({requestedUrl:'https://fixture.example/contact',finalUrl:'https://fixture.example/contact',statusCode:200,contentType:'text/html',fetchedAt:new Date().toISOString(),responseBytes:Buffer.byteLength(html),html});
 const inventory=collector.result(1);assert.equal(inventory.coverage.omittedSources,1);assert.equal(inventory.suggestedPrimary.email,null);assert.equal(inventory.suggestedPrimary.phone,'+493012345678');
 const audit=await auditWebsite({startUrl:'https://fixture.example/contact',pagespeed:false,policy:createDefaultCrawlPolicy('https://fixture.example/',{maxPages:1,maxRequests:1,maxImageChecks:0}),resolveAddresses:transport.resolveAddresses,request:async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)})});
 assert.equal(audit.contacts.suggestedPrimary.email,null);assert.equal(audit.contacts.suggestedPrimary.phone,'+493012345678');assert.equal(audit.contacts.status,'partial');
});
