import { getEventListeners } from 'node:events';
import { registerHooks } from 'node:module';
const stage=process.argv[2];
const never=()=>new Promise(()=>{});
const controller=new AbortController();
let contextCloses=0,browserCloses=0;
const run=(name,value)=>{
  if(stage==='late-'+name)return new Promise(r=>setImmediate(()=>{controller.abort();setImmediate(()=>r(value));}));
  if(stage==='abort-'+name)controller.abort();
  return stage===name?never():Promise.resolve(value);
};
let launches=0;
globalThis.__fixtureChromium={launch:()=>{launches++;return run('launch',{
  isConnected:()=>true,
  newContext:()=>run('context',{
    route:()=>run('route'),
    newPage:()=>run('page',{setContent:()=>run('content'),pdf:()=>run('pdf',new Uint8Array([37,80,68,70]))}),
    close:()=>{contextCloses++;return run('context-close');}
  }),close:()=>{browserCloses++;return run('close');}
});}};
registerHooks({
  resolve(specifier,context,next){return specifier==='playwright'?{url:'fixture:playwright',shortCircuit:true}:next(specifier,context);},
  load(url,context,next){return url==='fixture:playwright'?{format:'module',source:'export const chromium=globalThis.__fixtureChromium;',shortCircuit:true}:next(url,context);}
});
const unhandled=[];process.on('unhandledRejection',e=>unhandled.push(e.message));
const {playwrightPdfRenderer,withPlaywrightPdfSession}=await import('../../dist/reports/pdf-playwright.js');
let error,bytes;
const options={timeoutMs:150,signal:stage==='preabort'?AbortSignal.abort():controller.signal};
try {bytes=(await (process.argv[3]==='session'?withPlaywrightPdfSession(renderer=>renderer('<title>Fixture</title>',options),{closeTimeoutMs:150}):playwrightPdfRenderer('<title>Fixture</title>',options))).length;}catch(e){error=e.message;}
await new Promise(r=>setTimeout(r,10));
process.stdout.write(JSON.stringify({error,bytes,launches,unhandled,contextCloses,browserCloses,listeners:getEventListeners(controller.signal,'abort').length}));
