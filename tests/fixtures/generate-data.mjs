// Synthetic portable exports. Every response is injected; no real site is requested.
import {createHash} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {auditWebsiteWithPageData,createEvidencePack,imageEnrichment} from '@spora/webcrawl';
const dest=fileURLToPath(new URL('./data/',import.meta.url));await mkdir(dest,{recursive:true});
const NativeDate=Date,fixed=Date.parse('2026-10-29T00:00:00.000Z');globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
globalThis.fetch=async()=>{throw Error('synthetic_fixture_network_forbidden');};
const html=(body,head='<title>Synthetic lessons</title>')=>`<!doctype html><html lang="en"><head>${head}</head><body><main>${body}</main></body></html>`;
async function generate(name,target,pages,{maxPages=20,images=false}={}){
 const audit=await auditWebsiteWithPageData({startUrl:target,pagespeed:false,contacts:true,technology:false,renderBrowser:false,policy:{allowedHosts:[new URL(target).hostname],maxPages,maxRequests:100,maxRuntimeMs:10000,maxResponseBytes:200000,maxTotalResponseBytes:4000000,minRequestIntervalMs:0,maxConcurrency:1,maxRetries:0,maxImageChecks:0},resolveAddresses:async()=>['93.184.216.34'],request:async u=>{
 if(u.pathname==='/robots.txt')return{status:404,headers:{'content-type':'text/plain'},body:Buffer.from('')};
 const page=pages[u.pathname+u.search]??pages[u.pathname];
 return page?{status:200,headers:{'content-type':'text/html'},body:Buffer.from(page)}:{status:200,headers:{'content-type':'application/octet-stream'},body:Buffer.from('synthetic asset')};
 }},{includeSourceEvidenceSamples:true},images?[imageEnrichment]:[]);
 if(name==='br-kite'){audit.audit.coverage.checks.imageSizes={scope:'same_host',outOfScope:1,status:'partial',discovered:18,checked:15,findings:0,failed:0,skipped:3,unattempted:0,omittedTargets:3};audit.audit.coverage.checks.internalLinks.outOfScope=4;}
 if(name==='ckc')audit.audit.contacts.suggestedPrimary.phone=null;
 await writeFile(join(dest,name+'.json'),JSON.stringify(audit.audit,null,2)+'\n');
 audit.pageData.auditSha256=createHash('sha256').update(JSON.stringify(audit.audit)).digest('hex');
 await writeFile(join(dest,name+'.zip'),createEvidencePack(audit.audit,audit.pageData));
 return audit;
}
try{
 await generate('br-kite','https://escola.brkite.com.br/',{'/':html('<h1>Synthetic lessons</h1>'+Array.from({length:12},(_,i)=>`<a href="/asset-${i}.bin">Asset</a>`).join(''))});
 await generate('kitepoeira','https://kitepoeira.com/',{'/':html('<h1>Lessons</h1><a href="/hello-world/?replytocom=PRIVATE_FIXTURE">Archive</a><a href="https://wa.me/442079460958">WhatsApp</a>'),'/hello-world/?replytocom=PRIVATE_FIXTURE':html('<h1>Archive</h1>','<title>Archive</title><meta name="robots" content="noindex">')});
 await generate('ckc','https://ckc.example/',{'/':html('<h1>Lessons</h1><a href="tel:+442079460958">Phone</a><a href="https://wa.me/message/SYNTHETIC">WhatsApp</a>')});
 await generate('site-01','https://theplacencia.com/adventures',{'/adventures':html('<h2>Lessons</h2><a href="/adventures/more">More</a>')},{maxPages:1});
 const content=html('<h2>Synthetic diving lessons</h2>'+ '<img src="/course.jpg">'.repeat(1001) +'<a href="/2016/course/">Archive course</a>');
 const archive=html('<h2>Synthetic archive course</h2>','<title>Synthetic archive course</title><meta name="robots" content="noindex">');
 await generate('site-05','https://www.belizedivingadventures.net/',{'/':content,'/2016/course/':archive},{images:true});
 await generate('site-04','https://four.example/',{'/':html('<h1>One observation</h1>')});
}finally{globalThis.Date=NativeDate;}
console.log('Generated bounded synthetic audit/ZIP fixtures without network access.');
