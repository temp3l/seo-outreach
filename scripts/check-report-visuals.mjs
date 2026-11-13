#!/usr/bin/env node
import {readFile,writeFile,mkdir,mkdtemp,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {renderCustomerSummaryHtml} from '../dist/reports/summary.js';
import {renderMobileCustomerPdf} from '../dist/reports/mobile.js';
import {withPlaywrightPdfSession} from '../dist/reports/pdf-playwright.js';
import {assertFrozenCustomerStyles} from '../dist/reports/design-contract.js';
const root=dirname(fileURLToPath(import.meta.url)),gold=join(root,'../tests/fixtures/report-golden');
const manifest=JSON.parse(await readFile(join(gold,'manifest.json'),'utf8'));
const audit=JSON.parse(await readFile(join(gold,'fixture-audit.json'),'utf8')),issuer=JSON.parse(await readFile(join(gold,'fixture-issuer.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(import.meta.url);
const argv=process.argv.slice(2);let output,selfTest=false;
for(let i=0;i<argv.length;i++){if(argv[i]==='--out'&&!output&&argv[i+1])output=resolve(argv[++i]);else if(argv[i]==='--self-test'&&!selfTest)selfTest=true;else throw Error('invalid_visual_check_options');}
const out=output??await mkdtemp(join(tmpdir(),'spora-v6-visual-'));if(output)await mkdir(output,{recursive:false,mode:0o700});
const env=manifest.environment,font=execFileSync('fc-match',['-f','%{file}','Arial'],{encoding:'utf8'});
const poppler=spawnSync('pdfinfo',['-v'],{encoding:'utf8'}).stderr.split('\n')[0];
if(process.platform!==env.platform||process.arch!==env.architecture||poppler!==env.poppler||process.version!==env.node||process.versions.icu!==env.icu||require('playwright/package.json').version!==env.playwright||sha(await readFile(font))!==env.font.sha256)throw Error('report_visual_environment_mismatch');
const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});try{if(browser.version()!==env.chromium)throw Error('report_visual_chromium_mismatch');}finally{await browser.close();}
const results=[],selected=manifest.results.filter(c=>['a4-en','mobile-en','a4-one-topic','a4-two-topics','a4-six-topics'].includes(c.id));let failed=false;
await withPlaywrightPdfSession(async renderer=>{
 for(const c of selected){
  // Render the immutable approved reference without substituting or rewriting it.
  const html=await readFile(join(gold,c.id+'.html'),'utf8'),stem=join(out,c.id),pdf=await renderer(html);await writeFile(stem+'.pdf',pdf);
  execFileSync('pdftoppm',['-r',String(manifest.dpi),'-png',stem+'.pdf',stem],{timeout:30000});
  const text=execFileSync('pdftotext',['-layout',stem+'.pdf','-'],{encoding:'utf8'}),info=execFileSync('pdfinfo',[stem+'.pdf'],{encoding:'utf8'}),urls=execFileSync('pdfinfo',['-url',stem+'.pdf'],{encoding:'utf8'}).split('\n').filter(l=>/^\s*\d/.test(l)).join('\n');
  const pages=(await readdir(out)).filter(n=>n.startsWith(c.id+'-')&&n.endsWith('.png')).sort(),png=await Promise.all(pages.map(p=>readFile(join(out,p)).then(sha)));
  const fonts=path=>execFileSync('pdffonts',[path],{encoding:'utf8'}).split('\n').slice(2).map(line=>line.replace(/\s+\d+\s+\d+\s*$/u,'').trim()).join('\n');
  const r={id:c.id,html:sha(Buffer.from(html))===c.htmlSha256,pixels:JSON.stringify(png)===JSON.stringify(c.pngSha256),text:text===c.text,links:urls===c.urls,fonts:fonts(stem+'.pdf')===fonts(join(gold,c.id+'.pdf')),pages:pages.length===c.pages,geometry:info.split('\n').filter(l=>/^(Pages:|Page size:)/u.test(l)).join('\n')===c.geometry};
  if(Object.entries(r).some(([k,v])=>k!=='id'&&v!==true))failed=true;results.push(r);
 }
 // Current source is tested independently of editorial differences in frozen fixture text.
 const currentHtml=renderCustomerSummaryHtml(audit,'en',{issuer});assertFrozenCustomerStyles(currentHtml);
 if((currentHtml.match(/class="snapshot"/gu)??[]).length!==3||!currentHtml.includes('Contact us to discuss this review.')||!currentHtml.includes('data-publication-status="HOLD"'))throw Error('current_customer_structure_invalid');
 const currentA4=join(out,'current-a4.pdf');await writeFile(currentA4,await renderer(currentHtml));
 const currentMobile=join(out,'current-mobile.pdf');await writeFile(currentMobile,await renderMobileCustomerPdf(audit,renderer,issuer,'en','HOLD'));
 for(const path of [currentA4,currentMobile]){const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});if((text.match(/Contact us to discuss this review\./gu)??[]).length!==1)throw Error('current_customer_footer_invalid');}
 results.push({id:'current-source',a4:true,mobile:true,frozenStyles:true,threeBadges:true,footer:true});
 if(selfTest){let rejected=false;try{await renderer((await readFile(join(gold,'a4-en.html'),'utf8')).replace('background:#102d3a','background:#702d3a'));}catch(e){if(!(e instanceof Error)||!e.message.includes('frozen PDF design changed'))throw e;rejected=true;}results.push({id:'intentional-color-change',visualGuardRejected:rejected});if(!rejected)failed=true;}
});
await writeFile(join(out,'results.json'),JSON.stringify({design:manifest.design,sourceIntegrityRevision:'customer-pdf-v6-source-accuracy-20261113',results},null,2)+'\n');
console.log(JSON.stringify({ok:!failed,directory:out,results}));if(failed)process.exitCode=1;
