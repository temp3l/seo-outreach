import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, chmod, symlink, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { MemoryRecordingStore, FileRecordingStore, recordingDigest } from '@spora/webcrawl/recordings/store';
import { validateOutputPaths } from '../dist/compat/cli/output-paths.js';
function record(id='fixture',payload={data:'original'}) { const unsigned={schemaVersion:'1',id,capturedAt:'2026-01-01T00:00:00Z',target:'https://fixture.example/',payload}; return {...unsigned,sha256:recordingDigest(unsigned)}; }
test('recording stores snapshot put/get and share exclusive ID policy',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-store-');
 for(const store of [new MemoryRecordingStore(),new FileRecordingStore(root)]) {
 const input=record(); await store.put(input); input.payload.data='mutated';
 const first=await store.get('fixture'); assert.equal(first.payload.data,'original'); first.payload.data='read mutation';
 assert.equal((await store.get('fixture')).payload.data,'original');
 await assert.rejects(store.put(record()),{code:'EEXIST'});
 await assert.rejects(store.put(record('fixture',{data:'conflict'})),{code:'EEXIST'});
 }
 assert.equal((await stat(root+'/fixture.json')).mode&0o777,0o600);
});
test('recording root fails closed on unsafe permissions and symlink; oversized content rejected before parse',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-root-'); await chmod(root,0o777);
 await assert.rejects(new FileRecordingStore(root).put(record()),/unsafe_recording_root/);
 assert.equal((await stat(root)).mode&0o777,0o777);
 await chmod(root,0o700); await symlink(root,root+'-alias');
 await assert.rejects(new FileRecordingStore(root+'-alias').put(record()),/unsafe_recording_root/);
 await writeFile(root+'/huge.json','x'.repeat(2_000_100),{mode:0o600});
 await assert.rejects(new FileRecordingStore(root).get('huge'),/recording_too_large/);
 await writeFile(root+'/fixture.json','corrupt',{mode:0o600});
 await assert.rejects(new FileRecordingStore(root).put(record()),{code:'EEXIST'});
 assert.equal(await readFile(root+'/fixture.json','utf8'),'corrupt');
 assert.equal((await readdir(root)).some(name=>name.endsWith('.tmp')),false);
});
test('short write cannot publish final; retry publishes valid record exclusively',async()=>{
 const code=`import { FileRecordingStore,recordingDigest } from '@spora/webcrawl/recordings/store'; const root=process.argv[1]; const u={schemaVersion:'1',id:'interrupted',capturedAt:'2026-01-01T00:00:00Z',target:'https://fixture.example/',payload:{data:'x'.repeat(100000)}}; await new FileRecordingStore(root).put({...u,sha256:recordingDigest(u)});`;
 const make=spawnSync(process.execPath,['--input-type=module','-e',"import {mkdtemp} from 'node:fs/promises'; console.log(await mkdtemp('/tmp/webcrawl-shortwrite-'));"],{encoding:'utf8'}); assert.equal(make.status,0);
 const root=make.stdout.trim();
 const child=spawnSync('/bin/bash',['-c','ulimit -f 8; exec "$@"','bash',process.execPath,'--input-type=module','-e',code,root],{encoding:'utf8',timeout:5000});
 assert.notEqual(child.status,0);
 assert.match(child.stderr,/EFBIG|file too large/i);
 assert.equal((await readdir(root)).some(name=>name.endsWith('.tmp')),false);
 const retry=spawnSync(process.execPath,['--input-type=module','-e',`import {access} from 'node:fs/promises'; try { await access(process.argv[1]+'/interrupted.json'); throw new Error('partial final'); } catch(e) { if(e.code!=='ENOENT') throw e; } ${code}`,root],{encoding:'utf8',timeout:5000});
 assert.equal(retry.status,0,retry.stderr);
});
test('output preflight detects symlink-parent aliases and preserves distinct paths',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-alias-'); await symlink(root,root+'-alias');
 await assert.rejects(validateOutputPaths([root+'/same.json',root+'-alias/same.json']),/output_paths_must_be_distinct/);
 await validateOutputPaths([root+'/a.json',root+'-alias/b.json']);
 await writeFile(root+'/a.json','existing');
 await assert.rejects(validateOutputPaths([root+'/a.json']),/output_file_already_exists/);
});
test('current semantic audit corruption fails export/replay/store independently of a matching digest',async()=>{
 const {auditWebsite}=await import('@spora/webcrawl/core/audit');
 const {createDefaultCrawlPolicy}=await import('@spora/webcrawl/core/defaults');
 const {createAuditRecording,replayAuditRecording}=await import('@spora/webcrawl/recordings/replay');
 const audit=await auditWebsite({startUrl:'https://fixture.example/#private',contacts:false,pagespeed:false,policy:createDefaultCrawlPolicy('https://fixture.example/',{maxPages:1,maxRequests:1,maxImageChecks:0}),resolveAddresses:async()=>['93.184.216.34'],request:async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from('<h1>Fixture</h1>')})});
 assert.equal(audit.target,'https://fixture.example/');
 const missing=structuredClone(audit);delete missing.coverage.checks.securityHeaders;
 for(const corrupt of [missing,{...audit,contacts:[42]},{...audit,coverage:{...audit.coverage,checks:{...audit.coverage.checks,securityHeaders:{...audit.coverage.checks.securityHeaders,checked:-1}}}}]) {
 assert.throws(()=>createAuditRecording({id:'bad',capturedAt:audit.completedAt,target:audit.target,audit:corrupt}),/invalid_audit/);
 const forged=record('bad',corrupt); forged.capturedAt=audit.completedAt;const {sha256,...u}=forged;forged.sha256=recordingDigest(u);
 assert.throws(()=>replayAuditRecording(forged),/invalid_audit/);
 await assert.rejects(new MemoryRecordingStore().put(forged),/invalid_audit/);
 }
});
