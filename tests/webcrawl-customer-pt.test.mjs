import test from 'node:test';
import assert from 'node:assert/strict';
import { portugueseOpportunities } from '../dist/reports/customer-pt.js';
import { renderCustomerSummaryHtml, renderCustomerSummaryPdf } from '../dist/reports/summary.js';
import { playwrightPdfRenderer } from '../dist/reports/pdf-playwright.js';
import { renderPortugueseWhatsAppDraft } from '../dist/reports/whatsapp-draft.js';
import { renderMobileCustomerPdf } from '../dist/reports/mobile.js';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const issuer = {name:'Pessoa Teste',company:'Empresa Teste',email:'teste@example.test',phone:'+55 11 99999 0000'};
const evidence = (pageUrl, extras={}) => ({pageUrl,source:'http',observedAt:new Date(Date.now()-30_000).toISOString(),...extras});
function setup() {
 const {audit}=createEvidenceFixture(1); audit.startedAt=new Date(Date.now()-60_000).toISOString(); audit.completedAt=new Date(Date.now()-20_000).toISOString(); const home=audit.target; const course=new URL('/curso-kitesurf/',home).href; const legal=new URL('/privacy/',home).href;
 audit.coverage.urls=[{url:home,outcome:'captured',statusCode:200},{url:course,outcome:'captured',statusCode:200},{url:legal,outcome:'captured',statusCode:200}];
 audit.findings=[{code:'noindex',category:'indexability',observed:'noindex',evidence:[evidence(legal),evidence(course)]},{code:'missing_meta_description',category:'metadata',observed:'missing',evidence:[evidence(home)]}];
 return {audit,home,course};
}
test('PT projection preserves course evidence and ignores intentional legal noindex',()=>{
 const {audit,course}=setup(); audit.capabilities.images='failed'; const topics=portugueseOpportunities(audit);assert.equal(topics.length,2);assert.equal(topics[0].url,course);assert.ok(Date.parse(topics[0].observedAt)>=Date.parse(audit.startedAt));assert.ok(topics.every(x=>!x.url.includes('privacy')));
 const html=renderCustomerSummaryHtml(audit,'pt-BR',{issuer,clientReady:true});assert.match(html,/data-publication-status="HOLD"/);assert.match(html,/revisão/i);assert.ok(html.includes(course));assert.doesNotMatch(html.replace(/<body\b[^>]*>/u,'<body>'),/\bHOLD\b/u);assert.ok(html.includes(issuer.email));assert.ok(html.includes(issuer.phone));assert.doesNotMatch(html,/posições perdidas|receita perdida/i);
});
test('PT projection excludes blog tags and unrelated retail products from school offers',()=>{
 const {audit,home}=setup();const tag=new URL('/blog/hashtags/AprendaKitesurf',home).href;const retail=new URL('/product-page/kite-board',home).href;const boxing=new URL('/booking-calendar/boxe-para-iniciantes',home).href;audit.coverage.urls.push({url:tag,outcome:'captured',statusCode:200},{url:retail,outcome:'captured',statusCode:200},{url:boxing,outcome:'captured',statusCode:200});audit.findings=[{code:'noindex',category:'indexability',observed:'noindex',evidence:[evidence(tag),evidence(boxing)]},{code:'missing_meta_description',category:'metadata',observed:'missing',evidence:[evidence(retail)]}];assert.deepEqual(portugueseOpportunities(audit),[]);
});
test('PT projection groups repeated links only for confirmed 404 or 410, not denied or unknown',()=>{
 const {audit,home}=setup();audit.findings=[]; const destination=new URL('/curso-ausente/',home).href;
 audit.coverage.urls.push({url:destination,outcome:'captured',statusCode:404});
 const linked=(status)=>({code:'broken_internal_link',category:'indexability',observed:'link',evidence:[evidence(destination,{value:status,requestedUrl:destination}),...Array.from({length:30},()=>evidence(home,{value:status,anchorHref:destination,requestedUrl:destination}))]});
 audit.findings=[linked(404),linked(404)];assert.equal(portugueseOpportunities(audit).length,1);audit.findings=[linked(403)];assert.equal(portugueseOpportunities(audit).length,0);audit.findings=[linked(429)];assert.equal(portugueseOpportunities(audit).length,0);
});
test('PT readiness requires evidence and both issuer channels',()=>{
 const {audit}=setup(); audit.findings=[]; assert.match(renderCustomerSummaryHtml(audit,'pt-BR',{issuer}),/data-publication-status="HOLD"/);assert.doesNotMatch(renderCustomerSummaryHtml(audit,'pt-BR',{issuer}).replace(/<body\b[^>]*>/u,'<body>'),/\bHOLD\b/u);assert.match(renderCustomerSummaryHtml(audit,'pt-BR',{issuer,clientReady:true}),/data-publication-status="HOLD"/);
 const positive=setup().audit;assert.match(renderCustomerSummaryHtml(positive,'pt-BR',{issuer:{name:'Pessoa Teste',email:'teste@example.test'},clientReady:true}),/data-publication-status="HOLD"/);
});
test('PT draft requires a supported finding and keeps recipient and send decisions on hold',()=>{
 const {audit,course}=setup();const draft=renderPortugueseWhatsAppDraft(audit,issuer);assert.ok(draft.includes(course));assert.match(draft,/recipient_review_required:\*\* true/);assert.match(draft,/selected_send_target:\*\* null/);assert.doesNotMatch(draft,/wa\.me|SEO findings|equipe do site/iu);audit.findings=[];assert.equal(renderPortugueseWhatsAppDraft(audit,issuer),null);
});
test('actual PT PDF keeps readable linked page labels, accents and sender footer',async()=>{
 const {audit,course}=setup();const dir=await mkdtemp(join(tmpdir(),'webcrawl-pt-'));try {for(const [name,bytes] of [['a4',await renderCustomerSummaryPdf(audit,playwrightPdfRenderer,{locale:'pt-BR',issuer,clientReady:true})],['mobile',await renderMobileCustomerPdf(audit,playwrightPdfRenderer,issuer,'pt-BR','CLIENT_READY')]]){const path=join(dir,`${name}.pdf`);await writeFile(path,bytes);const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});assert.match(text,/REVISÃO DO SITE/u);assert.doesNotMatch(text,new RegExp(course.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),'u'));assert.match(text,/Curso kitesurf|Página inicial/u);assert.ok(execFileSync('pdfinfo',['-url',path],{encoding:'utf8'}).includes(course));assert.ok(text.includes(issuer.email));assert.ok(text.includes(issuer.phone));assert.match(text,/Observação arquivada/u);} } finally {await rm(dir,{recursive:true,force:true});}
});
