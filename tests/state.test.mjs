import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalState} from '../dist/state.js';

const fp='a'.repeat(64), settings='b'.repeat(64);
const identity=(over={})=>({company:'kite-co',branch:'tarifa',evidenceFingerprint:fp,locale:'en',model:'configured-model',settingsFingerprint:settings,promptVersion:'p1',schemaVersion:'s1',...over});
const caps={currency:'EUR',company:{requests:2,tokens:1000,money:1},batch:{requests:3,tokens:2000,money:2}};
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-state-'));try{await fn(join(dir,'state.json'));}finally{await rm(dir,{recursive:true,force:true});}}

test('durable reservation, status truth, cache and no replay after ambiguous dispatch',async()=>fixture(async file=>{
 const store=openLocalState(file);let lock=await store.acquire();const id=identity();
 const reservation=await lock.reserve(id,'run-1',{requests:1,tokens:400,money:.4},caps);
 assert.equal(reservation.status,'NOT_SENT');assert.deepEqual(reservation.cost,{status:'UNKNOWN'});
 await lock.markDispatched(reservation.id);await lock.release();
 lock=await store.acquire();assert.equal((await lock.reservations())[0].status,'AMBIGUOUS');
 await assert.rejects(()=>lock.reserve(id,'run-1',{requests:1,tokens:400,money:.4},caps),/not_replayable/);
 const settingsChanged=identity({settingsFingerprint:'c'.repeat(64)});
 await lock.putCache(settingsChanged,{analysis:'opaque'});assert.deepEqual(await lock.getCache(settingsChanged),{analysis:'opaque'});
 assert.equal(await lock.getCache(id),undefined);await lock.release();
}));

test('caps apply atomically to company and batch; definitive rejection releases exposure for safe retry',async()=>fixture(async file=>{
 const store=openLocalState(file);let lock=await store.acquire();const id=identity();
 const first=await lock.reserve(id,'batch-1',{requests:1,tokens:700,money:.6},caps);
 await assert.rejects(()=>lock.reserve(identity({company:'other'}),'batch-1',{requests:1,tokens:1400,money:1.5},caps),/cap_exceeded/);
 await lock.markRejected(first.id,'HTTP 429');
 const retry=await lock.reserve(id,'batch-1',{requests:1,tokens:700,money:.6},caps);
 assert.equal(retry.status,'NOT_SENT');
 await assert.rejects(()=>lock.reserve(identity({branch:'other'}),'batch-1',{requests:2,tokens:1400,money:1.5},caps),/cap_exceeded/);
 await lock.release();
}));

test('company caps span batch IDs while batch caps remain independently scoped',async()=>fixture(async file=>{
 const store=openLocalState(file),lock=await store.acquire();
 const first=await lock.reserve(identity({evidenceFingerprint:'c'.repeat(64)}),'batch-a',{requests:1,tokens:500,money:.5},caps);
 assert.equal(first.batchId,'batch-a');
 await assert.rejects(()=>lock.reserve(identity({evidenceFingerprint:'d'.repeat(64)}),'batch-b',{requests:2,tokens:700,money:.7},caps),/budget_cap_exceeded/);
 await lock.markRejected(first.id);
 const second=await lock.reserve(identity({evidenceFingerprint:'d'.repeat(64)}),'batch-b',{requests:2,tokens:700,money:.7},caps);
 assert.equal(second.batchId,'batch-b');await lock.markRejected(second.id);
 const a=await lock.reserve(identity({company:'school-a',evidenceFingerprint:'e'.repeat(64)}),'batch-a',{requests:2,tokens:900,money:.9},caps);
 const b=await lock.reserve(identity({company:'school-b',evidenceFingerprint:'f'.repeat(64)}),'batch-b',{requests:2,tokens:900,money:.9},caps);
 assert.equal(a.batchId,'batch-a');assert.equal(b.batchId,'batch-b');await lock.release();
}));

test('simultaneous owners are excluded and abandoned locks are never silently stolen',async()=>fixture(async file=>{
 const store=openLocalState(file);const a=await store.acquire();
 await assert.rejects(()=>store.acquire(),/state_locked/);
 assert.equal((await store.inspectLock()).token,a.token);await assert.rejects(()=>store.acquire(),/state_locked/);
 await a.release();const b=await store.acquire();await b.release();
}));

test('cache identity contains every caller supplied version and fingerprint',async()=>fixture(async file=>{
 const store=openLocalState(file);const lock=await store.acquire();const base=identity();
 await lock.putCache(base,{validated:false});
 for(const changed of [identity({company:'other'}),identity({branch:'other'}),identity({evidenceFingerprint:'c'.repeat(64)}),identity({locale:'es'}),identity({model:'other'}),identity({settingsFingerprint:'d'.repeat(64)}),identity({promptVersion:'p2'}),identity({schemaVersion:'s2'})]) assert.equal(await lock.getCache(changed),undefined);
 await lock.release();
}));

test('same-handle operations serialize reservations against caps and identity order is canonical',async()=>fixture(async file=>{
 const store=openLocalState(file),lock=await store.acquire();const ordered=identity();
 const reordered={schemaVersion:'s1',promptVersion:'p1',settingsFingerprint:settings,model:'configured-model',locale:'en',evidenceFingerprint:fp,branch:'tarifa',company:'kite-co'};
 await lock.putCache(ordered,{safe:true});assert.deepEqual(await lock.getCache(reordered),{safe:true});
 const outcomes=await Promise.allSettled([lock.reserve(ordered,'same-batch',{requests:1,tokens:600,money:.6},caps),lock.reserve(identity({branch:'elsewhere'}),'same-batch',{requests:2,tokens:1000,money:1},caps)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal((await lock.reservations()).length,1);await lock.release();
}));

test('corrupt and symlinked persisted state are rejected',async()=>fixture(async file=>{
 const store=openLocalState(file),lock=await store.acquire();await lock.putCache(identity(),{safe:true});await lock.release();
 const {writeFile,symlink,rm}=await import('node:fs/promises');const original=await (await import('node:fs/promises')).readFile(file,'utf8');
 await writeFile(file,JSON.stringify({version:1,fence:-1,reservations:[],cache:{}}));await assert.rejects(()=>store.inspectReservations(),/corrupt_state/);
 await writeFile(file,original);const target=file+'.target';await writeFile(target,original);await rm(file);await symlink(target,file);
 await assert.rejects(()=>store.inspectReservations());
}));

test('rejection reasons are not persisted and positive caps/prices are mandatory',async()=>fixture(async file=>{
 const store=openLocalState(file),lock=await store.acquire();const r=await lock.reserve(identity(),'batch',{requests:1,tokens:10,money:.1},caps);
 await lock.markRejected(r.id,'authorization=secret-token');await lock.release();
 const raw=await (await import('node:fs/promises')).readFile(file,'utf8');assert.ok(!raw.includes('secret-token'));
 const again=await store.acquire();await assert.rejects(()=>again.reserve(identity({evidenceFingerprint:'c'.repeat(64)}),'batch',{requests:1,tokens:1,money:0},caps),/invalid_estimate/);
 await assert.rejects(()=>again.reserve(identity({evidenceFingerprint:'d'.repeat(64)}),'batch',{requests:1,tokens:1,money:1},{...caps,company:{...caps.company,money:0}}),/invalid_caps/);await again.release();
}));

test('completed reservation and response cache are one durable transaction; mismatch and orphan attempts fail closed',async()=>fixture(async file=>{
 const store=openLocalState(file);let lock=await store.acquire();const id=identity();
 const reservation=await lock.reserve(id,'batch-cache',{requests:1,tokens:100,money:.2},caps);await lock.markDispatched(reservation.id);
 const cost={amount:.05,currency:'EUR'};const value={schema:'seo-outreach-provider-cache-v1',reservationId:reservation.id,responseId:'resp_123',output:{selectedIssueIds:['abc']},cost};
 await assert.rejects(()=>lock.completeWithCache(reservation.id,identity({branch:'wrong'}),'resp_123',value,cost),/reservation_identity_mismatch/);
 assert.equal((await lock.reservations())[0].status,'AMBIGUOUS');assert.equal(await lock.getCache(id),undefined);
 await assert.rejects(()=>lock.completeWithCache(reservation.id,id,'resp_123',{...value,responseId:'resp_other'},cost),/invalid_cache_binding/);
 await lock.completeWithCache(reservation.id,id,'resp_123',value,cost);await lock.release();
 lock=await store.acquire();const restored=(await lock.reservations())[0];assert.equal(restored.status,'COMPLETED');assert.equal(restored.responseId,'resp_123');assert.deepEqual(restored.cost,cost);assert.deepEqual(await lock.getCache(id),value);
 await assert.rejects(()=>lock.reserve(id,'batch-cache',{requests:1,tokens:100,money:.2},caps),/not_replayable/);await lock.release();
}));

test('completion refuses an existing orphan cache without changing ambiguous reservation',async()=>fixture(async file=>{
 const store=openLocalState(file),lock=await store.acquire(),id=identity();const reservation=await lock.reserve(id,'batch-orphan',{requests:1,tokens:100,money:.2},caps);await lock.markDispatched(reservation.id);
 await lock.putCache(id,{schema:'seo-outreach-provider-cache-v1',reservationId:'missing',responseId:'resp_123',output:{},cost:{status:'UNKNOWN'}});
 const cost={status:'UNKNOWN'},value={schema:'seo-outreach-provider-cache-v1',reservationId:reservation.id,responseId:'resp_123',output:{ok:true},cost};
 await assert.rejects(()=>lock.completeWithCache(reservation.id,id,'resp_123',value,cost),/cache_already_exists/);
 assert.equal((await lock.reservations())[0].status,'AMBIGUOUS');await lock.release();
}));
