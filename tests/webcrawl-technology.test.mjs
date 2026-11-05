import assert from 'node:assert/strict';
import test from 'node:test';
import { detectTechnologies, HomepageTechnologyCollector, TECHNOLOGY_PROFILE } from '@spora/webcrawl/enrichments/technology';
import { auditWebsite } from '@spora/webcrawl/core/audit';
import { DEFAULT_CRAWL_LIMITS } from '@spora/webcrawl/core/defaults';

test('CMS signals inspect structured markers rather than text, comments, query strings or foreign paths', () => {
  assert.deepEqual(detectTechnologies('<p>wp-content Shopify.theme</p><!-- wixstatic.com --><script src="https://evil.test/?x=cdn.shopify.com"></script><script src="https://evil.test/wp-content/a.js"></script>'), []);
  assert.deepEqual(detectTechnologies('<meta name="generator" content="WordPress 6.5"><script src="/wp-content/a.js"></script><script src="https://cdn.shopify.com/a.js"></script>'), ['Shopify', 'WordPress']);
  assert.deepEqual(detectTechnologies('<html data-wf-page="abc"><script src="https://static.wixstatic.com/a.js"></script>'), ['Webflow', 'Wix']);
});

test('homepage collector treats signals as observations and missing, failed or oversized pages as unavailable', () => {
  const base={requestedUrl:'https://fixture.test/',finalUrl:'https://fixture.test/',statusCode:200,html:'<meta name="generator" content="WordPress 6.0">',fetchedAt:'2026-10-30T00:00:00Z',contentInspectionStatus:'complete'};
  const collector=new HomepageTechnologyCollector(base.requestedUrl);
  collector.observe({...base,requestedUrl:'https://fixture.test/other'});
  assert.equal(collector.result().status,'unavailable');
  collector.observe(base);
  assert.equal(collector.result().status,'complete');
  assert.match(collector.result().findings[0].observed,/not a confirmed CMS/u);
  assert.equal(collector.result().findings[0].evidence[0].pageUrl,base.finalUrl);
  const redirected=new HomepageTechnologyCollector(base.requestedUrl); redirected.observe({...base,finalUrl:'https://fixture.test/welcome?token=private',html:'<script src="https://fixture.test/wp-content/a.js"></script>'});
  assert.equal(redirected.result().findings[0].evidence[0].value,'WordPress');
  assert.doesNotMatch(redirected.result().findings[0].evidence[0].pageUrl,/private/u);
  const partial=new HomepageTechnologyCollector(base.requestedUrl); partial.observe({...base,contentInspectionStatus:'partial'});
  assert.equal(partial.result().status,'partial');
  for (const page of [{...base,statusCode:404},{...base,html:'x'.repeat(2_000_001)}]) { const c=new HomepageTechnologyCollector(base.requestedUrl); c.observe(page); assert.equal(c.result().status,'unavailable'); }
  const path=new HomepageTechnologyCollector('https://fixture.test/course'); path.observe({...base,requestedUrl:'https://fixture.test/course'}); assert.equal(path.result().status,'complete'); assert.equal(path.result().findings[0].evidence[0].value,'WordPress');
});

test('default audit checks homepage without another request or retaining HTML and can opt out', async () => {
  let homes=0;
  const config={startUrl:'https://fixture.test/',pagespeed:false,policy:{...DEFAULT_CRAWL_LIMITS,allowedHosts:['fixture.test'],maxPages:1,maxRequests:6,maxRuntimeMs:10_000,maxResponseBytes:100_000,maxTotalResponseBytes:500_000,maxRetries:0,minRequestIntervalMs:0,maxConcurrency:1,robots:'observation-only'},resolveAddresses:async()=>['93.184.216.34'],request:async url=>{if(url.pathname==='/') homes++; return {status:url.pathname==='/'?200:404,headers:{'content-type':url.pathname==='/'?'text/html':'text/plain'},body:Buffer.from(url.pathname==='/'?'<html><head><meta name="generator" content="WordPress 6.5"></head><body><h1>Test</h1></body></html>':'missing')};}};
  const a=await auditWebsite(config); assert.equal(homes,1); assert.equal(a.crawlSettings.retainHtml,false); assert.equal(a.capabilities.technology,'complete'); assert.equal(a.crawlSettings.technologyProfile,TECHNOLOGY_PROFILE); assert.equal(a.findings.find(f=>f.code==='technology_detected').evidence[0].value,'WordPress');
  const b=await auditWebsite({...config,technology:false}); assert.equal(b.capabilities.technology,'disabled'); assert.equal(b.crawlSettings.technologyProfile,undefined); assert.equal(b.findings.some(f=>f.code==='technology_detected'),false);
});

const square = '<script src="https://assets.squarespace.com/universal/scripts-compressed/common.js"></script><script src="https://static1.squarespace.com/static/ta/site/scripts/site-bundle.js"></script>';
const duda = '<script id="d-js-core" src="https://static.cdn-website.com/mnlt/production/6878/_dm/s/rt/dist/scripts/d-js-one-runtime-unified-desktop.min.js"></script><link rel="stylesheet" href="https://static.cdn-website.com/mnlt/production/6878/_dm/s/rt/dist/css/d-css-runtime-desktop-one-package-structured-global.min.css">';
const daddy = '<script src="https://img1.wsimg.com/blobby/go/site/gpub/build/script.js"></script><script src="https://img1.wsimg.com/ceph-p3-01/website-builder-data-prod/static/widgets/UX.1.js"></script>';
test('new builders require explicit generator or paired runtime evidence', () => {
 assert.deepEqual(detectTechnologies(square),['Squarespace']);
 assert.deepEqual(detectTechnologies(duda),['Duda']);
 assert.deepEqual(detectTechnologies(duda.replace('rel="stylesheet"','rel="preload" as="style"')),['Duda']);
 assert.deepEqual(detectTechnologies(duda.replace('rel="stylesheet"','rel="preload" as="image"')),[]);
 assert.deepEqual(detectTechnologies(daddy),['GoDaddy Website Builder']);
 assert.deepEqual(detectTechnologies('<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000">'),['GoDaddy Website Builder']);
 for(const html of [square,duda,daddy]) {
  assert.deepEqual(detectTechnologies(`<!-- ${html} -->`),[]);
  assert.deepEqual(detectTechnologies(`<template>${html}</template>`),[]);
  assert.deepEqual(detectTechnologies(html.replaceAll('https://','https://evil.example/?url=https://')),[]);
  assert.deepEqual(detectTechnologies(html.split(/(?=<(?:script|link))/).filter(Boolean)[0]),[]);
 }
 for(const html of ['<script src="https://img1.wsimg.com/traffic-assets/js/tccl.min.js"></script>','<img src="https://images.squarespace-cdn.com/content/image.jpg">','<img src="https://irp.cdn-website.com/site/logo.jpg">',duda.replace('static.cdn-website.com','static.cdn-website.com.evil.test'),duda.replace('rel="stylesheet"','rel="canonical"')]) assert.deepEqual(detectTechnologies(html),[]);
 assert.deepEqual(detectTechnologies('<script src="https://real.example/wp-content/app.js"></script>','https://real.example/offer'),['WordPress']);
});
test('captured interior seed is inspected without an additional homepage request', async () => {
 let seed=0,home=0;
 const audit=await auditWebsite({startUrl:'https://fixture.test/offer/',pagespeed:false,contacts:false,technology:true,policy:{...DEFAULT_CRAWL_LIMITS,allowedHosts:['fixture.test'],maxPages:1,maxRequests:4,maxRuntimeMs:5000,minRequestIntervalMs:0,maxRetries:0},resolveAddresses:async()=>['93.184.216.34'],request:async url=>{if(url.pathname==='/')home++;if(url.pathname==='/offer/')seed++;return {status:url.pathname==='/offer/'?200:404,headers:{'content-type':'text/html'},body:Buffer.from(url.pathname==='/offer/'?`<html><head>${square}</head><body><h1>Offer</h1></body></html>`:'missing')};}});
 assert.equal(seed,1);assert.equal(home,0);assert.equal(audit.capabilities.technology,'complete');
 const finding=audit.findings.find(f=>f.code==='technology_detected');assert.equal(finding.evidence[0].value,'Squarespace');assert.equal(finding.evidence[0].pageUrl,'https://fixture.test/offer/');assert.match(finding.observed,/Seed-page/);
});
test('invalid subsequent seed observation clears prior signals; other pages cannot contaminate seed', () => {
 const page={requestedUrl:'https://fixture.test/offer',finalUrl:'https://fixture.test/offer',statusCode:200,html:square,fetchedAt:'2026-11-01T00:00:00Z',contentInspectionStatus:'complete'};
 const c=new HomepageTechnologyCollector(page.requestedUrl);c.observe(page);assert.equal(c.result().findings.length,1);
 c.observe({...page,requestedUrl:'https://fixture.test/other',html:duda});assert.equal(c.result().findings[0].evidence[0].value,'Squarespace');
 c.observe({...page,statusCode:401});assert.equal(c.result().status,'unavailable');assert.deepEqual(c.result().findings,[]);
});

test('foreign hosted images and passive links do not identify the embedding site CMS', () => {
 for(const host of ['cdn.shopify.com','static.wixstatic.com','assets.website-files.com','cdn.prod.website-files.com']) {
  for(const tag of [`<img src="https://${host}/site/photo.jpg">`,`<link rel="canonical" href="https://${host}/site">`,`<link rel="preload" as="image" href="https://${host}/site/photo.jpg">`]) assert.deepEqual(detectTechnologies(tag,'https://independent.example/'),[]);
 }
});

test('asset identity honors the first HTML base URL without admitting foreign WordPress paths', () => {
 const html='<head><base href="https://foreign.example/"><base href="https://fixture.test/"></head><body><script src="/wp-content/app.js"></script></body>';
 assert.deepEqual(detectTechnologies(html,'https://fixture.test/offer/'),[]);
 assert.deepEqual(detectTechnologies('<head><base href="/assets/"></head><script src="../wp-includes/app.js"></script>','https://fixture.test/offer/'),['WordPress']);
});
