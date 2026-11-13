import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPsiAssociationJournal } from '../dist/reports/psi-association-journal.js';

const digest = letter => letter.repeat(64);
const input = (siteId='WC-TEST') => ({runId:'capetown-synthetic-run',siteId,captureManifestSha256:digest('a'),sourceCaptureSha256:digest('b'),auditSha256:digest('c'),requestedUrl:'https://fixture.example/',captureStartedAt:new Date(Date.now()-120_000).toISOString(),captureCompletedAt:new Date(Date.now()-60_000).toISOString()});
const body = url => ({lighthouseResult:{fetchTime:new Date().toISOString(),requestedUrl:url,finalUrl:url,configSettings:{formFactor:'mobile'},categories:{performance:{score:.6}}}});
async function temp(t){const path=await mkdtemp(join(tmpdir(),'psi-association-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('PSI writer journals reservation, dispatch, response hash and exact request before returning a post-crawl association',async t=>{
 const dir=await temp(t), journal=createPsiAssociationJournal({path:join(dir,'attempts.json'),fetch:async(url,init)=>{assert.equal(init.method,'GET');const parsed=new URL(url);assert.equal(parsed.searchParams.get('strategy'),'mobile');assert.deepEqual(parsed.searchParams.getAll('category'),['performance','accessibility','best-practices','seo']);return new Response(JSON.stringify(body(parsed.searchParams.get('url'))),{status:200});}});
 await journal.initialize();const result=await journal.dispatch(input());assert.equal(result.state,'completed');assert.equal(result.events.filter(x=>x.state==='reserved').length,1);assert.ok(result.association.dispatchId);assert.ok(result.association.responseSha256);assert.deepEqual(await (await import('node:fs/promises')).readFile(result.responsePath),result.responseBytes);const metadata=JSON.parse(await (await import('node:fs/promises')).readFile(result.responsePath+'.metadata.json','utf8'));assert.equal(metadata.responseSha256,result.association.responseSha256);assert.equal(metadata.dispatchId,result.dispatchId);assert.ok(Date.parse(result.association.requestedAt)>=Date.parse(input().captureCompletedAt));assert.equal((await journal.read()).filter(e=>e.dispatchId===result.dispatchId).map(e=>e.state).join(','),'reserved,dispatched,completed');
});

test('PSI writer never repeats a site after completed or ambiguous dispatch and records unknown',async t=>{
 const dir=await temp(t);let calls=0;const journal=createPsiAssociationJournal({path:join(dir,'attempts.json'),fetch:async()=>{calls++;throw Error('socket closed after dispatch');}});
 const result=await journal.dispatch(input());assert.equal(result.state,'unknown');assert.equal(calls,1);assert.ok((await journal.read()).some(e=>e.state==='unknown'));
 await assert.rejects(journal.dispatch(input()),/psi_association_site_already_reserved/);assert.equal(calls,1);
});

test('PSI writer rejects a capture timestamp later than dispatch before reserving or calling provider',async t=>{
 const dir=await temp(t);let calls=0;const path=join(dir,'attempts.json'),journal=createPsiAssociationJournal({path,fetch:async()=>{calls++;return new Response('{}',{status:200});}});
 await assert.rejects(journal.dispatch({...input(),captureCompletedAt:new Date(Date.now()+60_000).toISOString()}),/psi_association_input_invalid/);
 assert.equal(calls,0);assert.equal((await journal.read()).length,0);
});

test('PSI writer rejects post-capture dispatch beyond shared 14-day freshness before reservation',async t=>{
 const dir=await temp(t);let calls=0;const journal=createPsiAssociationJournal({path:join(dir,'attempts.json'),fetch:async()=>{calls++;return new Response('{}',{status:200});}});
 const {CUSTOMER_REPORT_FRESHNESS_MS}=await import('../dist/reports/freshness.js');
 const captureCompletedAt=new Date(Date.now()-CUSTOMER_REPORT_FRESHNESS_MS-1).toISOString();
 await assert.rejects(journal.dispatch({...input(),captureCompletedAt}),/psi_association_input_invalid/);
 assert.equal(calls,0);assert.equal((await journal.read()).length,0);
});

test('PSI writer caps total attempts at ten and rejects malformed source identity before dispatch',async t=>{
 const dir=await temp(t);let calls=0;const journal=createPsiAssociationJournal({path:join(dir,'attempts.json'),fetch:async url=>{calls++;return new Response(JSON.stringify(body(new URL(url).searchParams.get('url'))),{status:200});}});
 await assert.rejects(journal.dispatch({...input(),sourceCaptureSha256:'wrong'}),/psi_association_input_invalid/);assert.equal(calls,0);
 for(let i=0;i<10;i++) await journal.dispatch(input(`WC-${String(i).padStart(3,'0')}`));
 await assert.rejects(journal.dispatch(input('WC-011')),/psi_journal_attempt_limit/);assert.equal(calls,10);
});

test('stale capture start is rejected before provider dispatch despite recent completion',async t=>{
 const dir=await temp(t);let calls=0;const journal=createPsiAssociationJournal({path:join(dir,'attempts.json'),fetch:async()=>{calls++;return new Response('{}');}});
 const {CUSTOMER_REPORT_FRESHNESS_MS}=await import('../dist/reports/freshness.js');
 await assert.rejects(journal.dispatch({...input(),captureStartedAt:new Date(Date.now()-CUSTOMER_REPORT_FRESHNESS_MS-1000).toISOString()}),/psi_association_input_invalid/);assert.equal(calls,0);assert.equal((await journal.read()).length,0);
});

test('restart exposes a nonterminal dispatch as unresolved and never replays it',async t=>{
 const dir=await temp(t),path=join(dir,'attempts.json');let calls=0;
 const journal=createPsiAssociationJournal({path,fetch:async()=>{calls++;throw Error('unknown');}});
 const result=await journal.dispatch(input());
 const fs=await import('node:fs/promises');const saved=JSON.parse(await fs.readFile(path,'utf8'));saved.attempts=saved.attempts.filter(e=>e.dispatchId===result.dispatchId&&e.state!=='unknown');await fs.writeFile(path,JSON.stringify(saved),{mode:0o600});
 const restarted=createPsiAssociationJournal({path,fetch:async()=>{calls++;throw Error('must not call');}});
 const unresolved=await restarted.unresolved();assert.deepEqual(unresolved,[result.dispatchId]);
 await assert.rejects(restarted.dispatch(input()),/psi_association_site_already_reserved/);assert.equal(calls,1);
});

test('response persistence failure leaves a spent unresolved dispatch without replay',async t=>{
 const fs=await import('node:fs/promises');const dir=await temp(t),path=join(dir,'attempts.json');let calls=0;
 const journal=createPsiAssociationJournal({path,fetch:async request=>{calls++;await fs.chmod(dir,0o500);return new Response(JSON.stringify(body(new URL(request).searchParams.get('url'))),{status:200});}});
 try {await assert.rejects(journal.dispatch(input()));} finally {await fs.chmod(dir,0o700);}
 assert.equal(calls,1);assert.equal((await journal.unresolved()).length,1);
 await assert.rejects(journal.dispatch(input()),/psi_association_site_already_reserved/);assert.equal(calls,1);
});
