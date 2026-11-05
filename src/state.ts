import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type OperationStatus = 'NOT_SENT' | 'DEFINITELY_REJECTED' | 'ACCEPTED' | 'COMPLETED' | 'AMBIGUOUS';
export type Cost = { amount: number; currency: string } | { status: 'UNKNOWN' };
export type CacheIdentity = { company: string; branch: string; evidenceFingerprint: string; locale: string; model: string; settingsFingerprint: string; promptVersion: string; schemaVersion: string };
export type Caps = { company: { requests: number; tokens: number; money: number }; batch: { requests: number; tokens: number; money: number }; currency: string };
export type Estimate = { requests: number; tokens: number; money: number };
export type Reservation = { id: string; key: string; batchId: string; currency: string; identity: CacheIdentity; estimate: Estimate; status: OperationStatus; cost: Cost; responseId?: string; createdAt: string; updatedAt: string };
type Disk = { version: 1; fence: number; reservations: Reservation[]; cache: Record<string, unknown> };
const empty = (): Disk => ({ version: 1, fence: 0, reservations: [], cache: {} });
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_VALUE_BYTES = 8 * 1024 * 1024;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validFingerprint = (s: string) => /^[a-f0-9]{64}$/i.test(s);
function identityKey(i: CacheIdentity): string {
  if (!i.company || !i.branch || !i.locale || !i.model || !i.promptVersion || !i.schemaVersion || !validFingerprint(i.evidenceFingerprint) || !validFingerprint(i.settingsFingerprint)) throw new Error('invalid_cache_identity');
  // Deliberately construct this in fixed order; caller object insertion order is immaterial.
  return hash({ company:i.company, branch:i.branch, evidenceFingerprint:i.evidenceFingerprint.toLowerCase(), locale:i.locale, model:i.model, settingsFingerprint:i.settingsFingerprint.toLowerCase(), promptVersion:i.promptVersion, schemaVersion:i.schemaVersion });
}
function finiteNonnegative(n: number): boolean { return Number.isFinite(n) && n >= 0; }
function validateEstimate(e: Estimate): void {
  if (!Number.isSafeInteger(e.requests) || e.requests < 1 || !Number.isSafeInteger(e.tokens) || e.tokens < 0 || !Number.isFinite(e.money) || e.money <= 0) throw new Error('invalid_estimate');
}
function validateCaps(c: Caps): void {
  if (!c.currency || !/^[A-Z]{3}$/.test(c.currency)) throw new Error('invalid_currency');
  for (const x of [c.company, c.batch]) if (!Number.isSafeInteger(x.requests) || x.requests <= 0 || !Number.isSafeInteger(x.tokens) || x.tokens <= 0 || !Number.isFinite(x.money) || x.money <= 0) throw new Error('invalid_caps');
}
function validCost(cost:unknown,currency?:string):cost is Cost{
  if(!cost||typeof cost!=='object'||Array.isArray(cost))return false;
  const c=cost as Record<string,unknown>;
  if(c.status==='UNKNOWN')return Object.keys(c).length===1;
  return Object.keys(c).length===2&&typeof c.amount==='number'&&finiteNonnegative(c.amount)&&typeof c.currency==='string'&&/^[A-Z]{3}$/.test(c.currency)&&(currency===undefined||c.currency===currency);
}
function sameCost(a:Cost,b:Cost):boolean{return 'status'in a?'status'in b&&a.status===b.status:'amount'in b&&a.amount===b.amount&&a.currency===b.currency;}

function validateDisk(v: unknown): Disk {
  if (!v || typeof v !== 'object') throw new Error('corrupt_state');
  const d=v as Disk;
  if(d.version!==1||!Number.isSafeInteger(d.fence)||d.fence<0||!Array.isArray(d.reservations)||!d.cache||typeof d.cache!=='object'||Array.isArray(d.cache))throw new Error('corrupt_state');
  for(const [key,value] of Object.entries(d.cache)){if(!/^[a-f0-9]{64}$/.test(key)||value===undefined)throw new Error('corrupt_state');}
  const ids=new Set<string>();
  for(const r of d.reservations){
    if(!r||typeof r!=='object'||typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.batchId!=='string'||!r.batchId.trim()||!['NOT_SENT','DEFINITELY_REJECTED','ACCEPTED','COMPLETED','AMBIGUOUS'].includes(r.status)||!validFingerprint(r.key)||!r.identity||identityKey(r.identity)!==r.key||!r.currency||!/^[A-Z]{3}$/.test(r.currency)||!r.estimate||!Number.isSafeInteger(r.estimate.requests)||r.estimate.requests<1||!Number.isSafeInteger(r.estimate.tokens)||r.estimate.tokens<0||!Number.isFinite(r.estimate.money)||r.estimate.money<=0||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt))||typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt)))throw new Error('corrupt_state');
    if(!validCost(r.cost,r.currency))throw new Error('corrupt_state');
    if(r.status==='COMPLETED'){if(typeof r.responseId!=='string'||!/^[A-Za-z0-9._:-]{1,512}$/.test(r.responseId))throw new Error('corrupt_state');}
    else if(r.responseId!==undefined)throw new Error('corrupt_state');
    ids.add(r.id);
  }
  return d;
}
async function assertNoSymlinkAncestors(path: string):Promise<void>{
  const absolute=resolve(path);const pieces=absolute.split('/').filter(Boolean);let current='/';
  for(const piece of pieces){current=current==='/'?`/${piece}`:`${current}/${piece}`;try{const s=await lstat(current);if(s.isSymbolicLink())throw new Error('unsafe_state_path');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}}
}

/** A local, durable state store. Cache values are opaque and callers must validate them on every read. */
export function openLocalState(path: string) {
  const file = resolve(path);
  const lockPath = `${file}.lock`;
  async function load(): Promise<Disk> {
    try {
      const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const info=await f.stat();if(!info.isFile()||info.size>MAX_STATE_BYTES)throw new Error('unsafe_state_file');const bytes=await f.readFile();if(bytes.byteLength>MAX_STATE_BYTES)throw new Error('state_too_large');return validateDisk(JSON.parse(bytes.toString('utf8')));}finally{await f.close();}
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw e; }
  }
  async function persist(data: Disk): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    if(Buffer.byteLength(JSON.stringify(data))>MAX_STATE_BYTES)throw new Error('state_too_large');
    const temp = `${file}.${randomUUID()}.tmp`;
    const f = await open(temp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(data)); await f.sync(); } finally { await f.close(); }
    await rename(temp, file);
    const dir = await open(dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  async function readOwner():Promise<{token?:string;pid?:number;acquiredAt?:string}>{
    const f=await open(lockPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.size>1024)throw new Error('lock_record_unreadable');const owner=JSON.parse((await f.readFile()).toString('utf8'));if(!owner||typeof owner!=='object'||typeof owner.token!=='string')throw new Error('lock_record_unreadable');return owner;}finally{await f.close();}
  }
  return {
    /** Acquire an OS-exclusive lock; lock age is never used to steal ownership. */
    async acquire(options: { timeoutMs?: number } = {}) {
      await assertNoSymlinkAncestors(dirname(file));
      await mkdir(dirname(file), { recursive: true });
      const timeoutMs = options.timeoutMs ?? 0;
      const started = Date.now();
      const token = randomUUID();
      let lock: Awaited<ReturnType<typeof open>>;
      for (;;) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          if (Date.now() - started >= timeoutMs) throw new Error('state_locked');
          await new Promise(r => setTimeout(r, Math.min(25, Math.max(1, timeoutMs - (Date.now() - started)))));
        }
      }
      const owner = { token, pid: process.pid, acquiredAt: new Date().toISOString() };
      try { await lock.writeFile(JSON.stringify(owner)); await lock.sync(); } finally { await lock.close(); }
      let released = false;
      let queue:Promise<unknown>=Promise.resolve();
      const serialized=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn,fn);queue=next.then(()=>undefined,()=>undefined);return next;};
      const assertOwner = async () => {
        if (released) throw new Error('lock_released');
        let current: { token?: string };
        try { current = await readOwner(); } catch { throw new Error('lock_lost'); }
        if (current.token !== token) throw new Error('lock_lost');
      };
      let currentFence=0;
      try { const d=await load(); d.fence++; currentFence=d.fence; await persist(d); }
      catch(e){ await rm(lockPath,{force:true}); throw e; }
      const mutate = async <T>(fn: (d: Disk) => T): Promise<T> => serialized(async()=>{await assertOwner(); const d = await load(); d.fence++; const v = fn(d); await persist(d); currentFence=d.fence; await assertOwner(); return v;});
      return {
        token,
        get fence():number{return currentFence;},
        async release() {
          await assertOwner(); released = true;
          // Validate inode before removal to avoid deleting a successor's lock.
          const before = await stat(lockPath); const content = await readOwner();
          if (content.token !== token) throw new Error('lock_lost');
          const after = await stat(lockPath); if (before.ino !== after.ino) throw new Error('lock_lost');
          await rm(lockPath);
        },
        async getCache(identity: CacheIdentity): Promise<unknown | undefined> {
          return serialized(async()=>{await assertOwner(); const d = await load(); return d.cache[identityKey(identity)];});
        },
        async putCache(identity: CacheIdentity, value: unknown): Promise<void> {
          const key = identityKey(identity); await mutate(d => { d.cache[key] = value; });
        },
        async completeWithCache(reservationId:string,identity:CacheIdentity,responseId:string,value:unknown,cost:Cost):Promise<Reservation>{
          const key=identityKey(identity);
          if(typeof responseId!=='string'||!/^[A-Za-z0-9._:-]{1,512}$/.test(responseId))throw new Error('invalid_response_id');
          if(!validCost(cost))throw new Error('invalid_cost');
          let encoded:string;
          try{encoded=JSON.stringify(value);}catch{throw new Error('invalid_cache_value');}
          if(typeof encoded!=='string'||Buffer.byteLength(encoded)>MAX_CACHE_VALUE_BYTES)throw new Error('cache_value_too_large');
          if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_cache_value');
          const cacheValue=value as Record<string,unknown>;
          const keys=Object.keys(cacheValue),baseKeys=['schema','reservationId','responseId','output','cost'];
          const keysValid=baseKeys.every(k=>keys.includes(k))&&(keys.length===5||keys.length===6&&keys.includes('usage'));
          const usageValue=cacheValue.usage as Record<string,unknown>|undefined;
          const usageValid=!Object.hasOwn(cacheValue,'usage') || (!!usageValue && typeof usageValue==='object' && !Array.isArray(usageValue) && Object.keys(usageValue).length===2 && Number.isSafeInteger(usageValue.inputTokens) && typeof usageValue.inputTokens==='number' && usageValue.inputTokens>=0 && Number.isSafeInteger(usageValue.outputTokens) && typeof usageValue.outputTokens==='number' && usageValue.outputTokens>=0);
          if(!keysValid||!usageValid||cacheValue.schema!=='seo-outreach-provider-cache-v1'||cacheValue.reservationId!==reservationId||cacheValue.responseId!==responseId||!('output'in cacheValue)||cacheValue.output===undefined||!validCost(cacheValue.cost)||!sameCost(cacheValue.cost,cost))throw new Error('invalid_cache_binding');
          return mutate(d=>{
            const r=d.reservations.find(x=>x.id===reservationId);if(!r)throw new Error('reservation_not_found');
            if(r.key!==key||identityKey(r.identity)!==key)throw new Error('reservation_identity_mismatch');
            if(!['AMBIGUOUS','ACCEPTED'].includes(r.status))throw new Error('invalid_operation_transition');
            if('amount'in cost&&r.currency!==cost.currency)throw new Error('invalid_cost_currency');
            if(Object.hasOwn(d.cache,key))throw new Error('cache_already_exists');
            r.status='COMPLETED';r.responseId=responseId;r.cost=cost;r.updatedAt=new Date().toISOString();d.cache[key]=value;return r;
          });
        },
        async reserve(identity: CacheIdentity, batchId: string, estimate: Estimate, caps: Caps): Promise<Reservation> {
          if(typeof batchId!=='string'||!batchId.trim())throw new Error('invalid_batch_id');
          const key = identityKey(identity); validateEstimate(estimate); validateCaps(caps);
          return mutate(d => {
            const old = d.reservations.find(r => r.key === key && r.status !== 'DEFINITELY_REJECTED');
            if (old && old.status !== 'DEFINITELY_REJECTED') throw new Error(old.status === 'NOT_SENT' ? 'dispatch_already_reserved' : 'operation_not_replayable');
            const active = d.reservations.filter(r => r.status !== 'DEFINITELY_REJECTED' && r.batchId===batchId && r.currency===caps.currency);
            const company = d.reservations.filter(r => r.status !== 'DEFINITELY_REJECTED' && r.identity.company === identity.company && r.currency===caps.currency).reduce((a, r) => ({ requests:a.requests+r.estimate.requests,tokens:a.tokens+r.estimate.tokens,money:a.money+r.estimate.money }), {requests:0,tokens:0,money:0});
            const batch = active.reduce((a,r)=>({requests:a.requests+r.estimate.requests,tokens:a.tokens+r.estimate.tokens,money:a.money+r.estimate.money}),{requests:0,tokens:0,money:0});
            const fits=(a:Estimate,c:Caps['company'])=>a.requests<=c.requests&&a.tokens<=c.tokens&&a.money<=c.money;
            const nextC={requests:company.requests+estimate.requests,tokens:company.tokens+estimate.tokens,money:company.money+estimate.money};
            const nextB={requests:batch.requests+estimate.requests,tokens:batch.tokens+estimate.tokens,money:batch.money+estimate.money};
            if (!fits(nextC,caps.company)||!fits(nextB,caps.batch)) throw new Error('budget_cap_exceeded');
            const now=new Date().toISOString(); const reservation:Reservation={id:randomUUID(),key,batchId,currency:caps.currency,identity,estimate,status:'NOT_SENT',cost:{status:'UNKNOWN'},createdAt:now,updatedAt:now};
            d.reservations.push(reservation); return reservation;
          });
        },
        async markDispatched(id: string): Promise<Reservation> { return mutate(d=>transition(d,id,'AMBIGUOUS')); },
        async markRejected(id: string, _reason?: string): Promise<Reservation> { return mutate(d=>transition(d,id,'DEFINITELY_REJECTED')); },
        async markAccepted(id: string): Promise<Reservation> { return mutate(d=>transition(d,id,'ACCEPTED')); },
        async markAmbiguous(id: string, _reason?: string): Promise<Reservation> { return mutate(d=>transition(d,id,'AMBIGUOUS')); },
        async reservations(): Promise<Reservation[]> { return serialized(async()=>{await assertOwner(); return (await load()).reservations;}); }
      };
    },
    /** Recovery is intentionally operator-controlled: inspect an abandoned lock before removing it. */
    async inspectLock(): Promise<unknown | undefined> { try { return await readOwner(); } catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw new Error('lock_record_unreadable'); } },
    async inspectReservations(): Promise<Reservation[]> { return (await load()).reservations; }
  };
}

function transition(d: Disk, id: string, status: OperationStatus): Reservation {
  const r=d.reservations.find(x=>x.id===id); if(!r)throw new Error('reservation_not_found');
  const allowed:Record<OperationStatus,OperationStatus[]>={NOT_SENT:['AMBIGUOUS','DEFINITELY_REJECTED'],AMBIGUOUS:['ACCEPTED','COMPLETED','DEFINITELY_REJECTED'],ACCEPTED:['COMPLETED','AMBIGUOUS'],COMPLETED:[],DEFINITELY_REJECTED:[]};
  if(!allowed[r.status].includes(status))throw new Error('invalid_operation_transition');
  r.status=status; r.updatedAt=new Date().toISOString(); return r;
}
