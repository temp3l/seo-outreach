#!/usr/bin/env node
import {readFile,writeFile,mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {renderCustomerSummaryHtml,renderOperatorStatusHtml} from '../dist/reports/summary.js';
import {renderMobileCustomerPdf} from '../dist/reports/mobile.js';
import {withPlaywrightPdfSession} from '../dist/reports/pdf-playwright.js';
const root=dirname(fileURLToPath(import.meta.url)),gold=join(root,'../tests/fixtures/report-golden');
const manifest=JSON.parse(await readFile(join(gold,'manifest.json'),'utf8'));
const audit=JSON.parse(await readFile(join(gold,'fixture-audit.json'),'utf8')),issuer=JSON.parse(await readFile(join(gold,'fixture-issuer.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(import.meta.url);
const argv=process.argv.slice(2);let output,selfTest=false;
for(let i=0;i<argv.length;i++){if(argv[i]==='--out'&&!output&&argv[i+1])output=resolve(argv[++i]);else if(argv[i]==='--self-test'&&!selfTest)selfTest=true;else throw Error('invalid_visual_check_options');}
const out=output??await mkdtemp(join(tmpdir(),'spora-report-visual-'));if(output)await mkdir(output,{recursive:false,mode:0o700});
const env=manifest.environment,font=execFileSync('fc-match',['-f','%{file}','Arial'],{encoding:'utf8'});
const poppler=spawnSync('pdfinfo',['-v'],{encoding:'utf8'}).stderr.split('\n')[0];
if(process.platform!==env.platform||process.arch!==env.architecture||poppler!==env.poppler||process.version!==env.node||process.versions.icu!==env.icu||require('playwright/package.json').version!==env.playwright||sha(await readFile(font))!==env.font.sha256)throw Error('report_visual_environment_mismatch: use the frozen Node, ICU, Playwright and Arial font');
const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});try{if(browser.version()!==env.chromium)throw Error('report_visual_chromium_mismatch');}finally{await browser.close();}
const results=[];let failed=false;
await withPlaywrightPdfSession(async renderer=>{
 for(const c of manifest.results){
  const data=structuredClone(audit);if(c.id==='a4-one-topic')data.findings=data.findings.slice(0,1);
  const locale=c.id.includes('pt-BR')?'pt-BR':c.id.endsWith('-de')?'de':'en';let html,pdf;
  if(c.id.startsWith('mobile'))pdf=await renderMobileCustomerPdf(data,async value=>{html=value;return renderer(value);},issuer,locale,'HOLD');
  else{html=c.id.startsWith('operator')?renderOperatorStatusHtml(data,locale):renderCustomerSummaryHtml(data,locale,{issuer});pdf=await renderer(html);}
  const stem=join(out,c.id);await writeFile(stem+'.html',html);await writeFile(stem+'.pdf',pdf);execFileSync('pdftoppm',['-r',String(manifest.dpi),'-png',stem+'.pdf',stem],{timeout:30_000});
  const text=execFileSync('pdftotext',['-layout',stem+'.pdf','-'],{encoding:'utf8'});const info=execFileSync('pdfinfo',[stem+'.pdf'],{encoding:'utf8'});const urls=execFileSync('pdfinfo',['-url',stem+'.pdf'],{encoding:'utf8'}).split('\n').filter(l=>/^\s*\d/.test(l)).join('\n');
  const pages=(await readdir(out)).filter(f=>f.startsWith(c.id+'-')&&f.endsWith('.png')).sort();const png=await Promise.all(pages.map(p=>readFile(join(out,p)).then(sha)));
  const fontTable=path=>execFileSync('pdffonts',[path],{encoding:'utf8'}).split('\n').slice(2).map(line=>line.replace(/\s+\d+\s+\d+\s*$/u,'').trim()).join('\n');
  const r={id:c.id,fonts:fontTable(stem+'.pdf')===fontTable(join(gold,c.id+'.pdf')),html:sha(Buffer.from(html))===c.htmlSha256,text:text===c.text,links:urls===c.urls,geometry:info.split('\n').filter(l=>/^(Pages:|Page size:)/.test(l)).join('\n')===c.geometry,pages:pages.length===c.pages,visual:png.length===c.pngSha256.length&&png.every((h,i)=>h===c.pngSha256[i])};
  if(Object.entries(r).some(([k,v])=>k!=='id'&&v!==true))failed=true;results.push(r);
 }
 if(selfTest){const html=(await readFile(join(gold,'a4-en.html'),'utf8')).replace('background:#102d3a','background:#702d3a');const stem=join(out,'intentional-color-change');await writeFile(stem+'.pdf',await renderer(html));execFileSync('pdftoppm',['-r',String(manifest.dpi),'-png',stem+'.pdf',stem]);const rejected=sha(await readFile(stem+'-1.png'))!==manifest.results.find(c=>c.id==='a4-en').pngSha256[0];results.push({id:'intentional-color-change',visualGuardRejected:rejected});if(!rejected)failed=true;}
});
await writeFile(join(out,'results.json'),JSON.stringify({baseline:manifest.sourceFingerprint,results},null,2)+'\n');
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
// Portable gallery includes frozen references alongside this run's actual output.
let gallery='<!doctype html><meta charset="utf-8"><title>Report visual comparison</title><style>body{font:16px system-ui;margin:24px;color:#183640}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%}article{margin:30px 0}a{color:#145c6a}</style><h1>Frozen reference / current report</h1>';
for(const c of manifest.results){gallery+=`<article><h2>${escape(c.id)}</h2><p><a href="${c.id}.pdf">Current PDF</a></p>`;for(let i=1;i<=c.pages;i++){const name=`reference-${c.id}-${i}.png`;await writeFile(join(out,name),await readFile(join(gold,`${c.id}-${i}.png`)));gallery+=`<div class="pair"><figure><figcaption>Frozen reference: page ${i}</figcaption><img src="${name}"></figure><figure><figcaption>Current: page ${i}</figcaption><img src="${c.id}-${i}.png"></figure></div>`;}gallery+='</article>';}
await writeFile(join(out,'gallery.html'),gallery);console.log(JSON.stringify({ok:!failed,directory:out,results}));if(failed)process.exitCode=1;
