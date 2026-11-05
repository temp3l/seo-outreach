import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertSafeOutputTarget,isArtifactDirectoryPublished,publishArtifacts,readPublishedArtifact,READY_MARKER} from '../dist/files.js';

async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'seo-files-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const names=['analysis.json','manifest.json','report.pdf'];

test('read-only output preflight rejects existing targets, symlink ancestors, and non-directory parents',async()=>fixture(async dir=>{
 const absent=join(dir,'missing','company');await assert.doesNotReject(()=>assertSafeOutputTarget(absent));
 const existing=join(dir,'existing');await (await import('node:fs/promises')).mkdir(existing);await assert.rejects(()=>assertSafeOutputTarget(existing),/destination_exists/);
 const file=join(dir,'parent-file');await writeFile(file,'x');await assert.rejects(()=>assertSafeOutputTarget(join(file,'company')),/unsafe_output_path/);
 const real=join(dir,'real-parent'),linked=join(dir,'linked-parent');await (await import('node:fs/promises')).mkdir(real);await symlink(real,linked);
 await assert.rejects(()=>assertSafeOutputTarget(join(linked,'company')),/unsafe_output_path/);
}));

test('publishes a complete artifact directory atomically with private files',async()=>fixture(async dir=>{
 const destination=join(dir,'company-a');const result=await publishArtifacts(destination,{'analysis.json':Buffer.from('{"ok":true}'),'report.pdf':Buffer.from('%PDF')},{allowedNames:names});
 assert.equal(result.directory,destination);assert.deepEqual(result.files,['analysis.json','report.pdf']);assert.equal(result.bytes,15);
 assert.equal(await isArtifactDirectoryPublished(destination),true);
 assert.ok((await readdir(destination)).includes(READY_MARKER));
 assert.equal(await readFile(join(destination,'analysis.json'),'utf8'),'{"ok":true}');
}));

test('ready-marker reader detects same-size artifact corruption and enforces read bounds',async()=>fixture(async dir=>{
 const destination=join(dir,'company');await publishArtifacts(destination,{'analysis.json':Buffer.from('original')},{allowedNames:names});
 assert.equal(await isArtifactDirectoryPublished(destination),true);
 await writeFile(join(destination,'analysis.json'),'tampered');
 assert.equal(await isArtifactDirectoryPublished(destination),false);
 const other=join(dir,'bounded');await publishArtifacts(other,{'analysis.json':Buffer.from('12345')},{allowedNames:names});
 assert.equal(await isArtifactDirectoryPublished(other,{maxFileBytes:4}),false);
}));

test('returns the exact verified bytes and rejects unsupported, missing, and symlinked artifacts',async()=>fixture(async dir=>{
 const destination=join(dir,'verified');await publishArtifacts(destination,{'analysis.json':Buffer.from('original'),'manifest.json':Buffer.from('metadata')},{allowedNames:names});
 const returned=await readPublishedArtifact(destination,'analysis.json');assert.equal(returned.toString(),'original');
 await writeFile(join(destination,'analysis.json'),'tampered');assert.equal(returned.toString(),'original');
 await assert.rejects(()=>readPublishedArtifact(destination,'not-listed.txt'),/unsupported_artifact_name/);
 await assert.rejects(()=>readPublishedArtifact(destination,'../manifest.json'),/unsupported_artifact_name/);
 assert.equal(await isArtifactDirectoryPublished(destination),false);

 const missing=join(dir,'missing-marker');await publishArtifacts(missing,{'analysis.json':Buffer.from('ok')},{allowedNames:names});await rm(join(missing,READY_MARKER));
 await assert.rejects(()=>readPublishedArtifact(missing,'analysis.json'));
 const symlinked=join(dir,'symlinked');await publishArtifacts(symlinked,{'analysis.json':Buffer.from('ok')},{allowedNames:names});
 const target=join(dir,'target');await writeFile(target,'ok');await rm(join(symlinked,'analysis.json'));await symlink(target,join(symlinked,'analysis.json'));
 await assert.rejects(()=>readPublishedArtifact(symlinked,'analysis.json'));
}));

test('rejects existing destination and concurrent publication without overwriting',async()=>fixture(async dir=>{
 const destination=join(dir,'company');await publishArtifacts(destination,{'analysis.json':Buffer.from('original')},{allowedNames:names});
 await assert.rejects(()=>publishArtifacts(destination,{'analysis.json':Buffer.from('replacement')},{allowedNames:names}),/destination_exists/);
 assert.equal(await readFile(join(destination,'analysis.json'),'utf8'),'original');
 const second=join(dir,'company-b');const payload={'analysis.json':Buffer.alloc(1024*1024,7)};
 const attempts=await Promise.allSettled([publishArtifacts(second,payload,{allowedNames:names}),publishArtifacts(second,payload,{allowedNames:names})]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(await readFile(join(second,'analysis.json')).then(b=>b.length),1024*1024);
 const entries=await readdir(dir);assert.ok(!entries.some(x=>x.endsWith('.stage')));
}));

test('rejects traversal, unlisted names, symlinked parents, and size overflows before publication',async()=>fixture(async dir=>{
 await assert.rejects(()=>publishArtifacts(join(dir,'unsafe'),{'../outside':Buffer.from('x')},{allowedNames:names}),/not_allowed/);
 await assert.rejects(()=>publishArtifacts(join(dir,'unsafe'),{'unknown.txt':Buffer.from('x')},{allowedNames:names}),/not_allowed/);
 await assert.rejects(()=>publishArtifacts(join(dir,'unsafe'),{'analysis.json':Buffer.alloc(4)},{allowedNames:names,maxFileBytes:3}),/too_large/);
 await assert.rejects(()=>publishArtifacts(join(dir,'unsafe'),{'analysis.json':Buffer.from('aa'),'manifest.json':Buffer.from('bb')},{allowedNames:names,maxTotalBytes:3}),/too_large/);
 const real=join(dir,'real');const linked=join(dir,'linked');await import('node:fs/promises').then(fs=>fs.mkdir(real));await symlink(real,linked);
 await assert.rejects(()=>publishArtifacts(join(linked,'company'),{'analysis.json':Buffer.from('x')},{allowedNames:names}),/unsafe_output_path/);
 assert.deepEqual((await readdir(dir)).sort(),['linked','real']);
}));

test('validation failures leave no destination, stage, or lock behind',async()=>fixture(async dir=>{
 const destination=join(dir,'not-created');
 await assert.rejects(()=>publishArtifacts(destination,{'analysis.json':Buffer.from('x')},{allowedNames:['report.pdf']}),/not_allowed/);
 assert.deepEqual(await readdir(dir),[]);
}));

test('exclusive directory claim wins publication races without replacing external empty folders',async()=>fixture(async dir=>{
 const destination=join(dir,'race');await (await import('node:fs/promises')).mkdir(destination);
 await assert.rejects(()=>publishArtifacts(destination,{'analysis.json':Buffer.from('x')},{allowedNames:names}),/destination_exists/);
 assert.deepEqual(await readdir(destination),[]);assert.equal(await isArtifactDirectoryPublished(destination),false);
 const concurrent=join(dir,'concurrent');const attempts=await Promise.allSettled([
  publishArtifacts(concurrent,{'analysis.json':Buffer.from('one')},{allowedNames:names}),
  publishArtifacts(concurrent,{'analysis.json':Buffer.from('two')},{allowedNames:names})
 ]);
 assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(await isArtifactDirectoryPublished(concurrent),true);
}));

test('rolls back only linked inodes if another writer collides with a later artifact',async()=>fixture(async dir=>{
 const destination=join(dir,'rollback');let injected=false;
 const publishing=publishArtifacts(destination,{'analysis.json':Buffer.alloc(7*1024*1024,5),'report.pdf':Buffer.from('%PDF')},{allowedNames:names});
 for(let i=0;i<500&&!injected;i++){
  try{const entries=await readdir(destination);if(entries.length===0){await (await import('node:fs/promises')).writeFile(join(destination,'report.pdf'),'keep');injected=true;}}
  catch(e){if(e.code!=='ENOENT')throw e;}
  if(!injected)await new Promise(r=>setTimeout(r,1));
 }
 assert.ok(injected,'exclusive destination directory was observed');
 await assert.rejects(()=>publishing);
 assert.deepEqual((await readdir(destination)).sort(),['report.pdf']);
 assert.equal(await readFile(join(destination,'report.pdf'),'utf8'),'keep');
 assert.equal(await isArtifactDirectoryPublished(destination),false);
 assert.ok(!(await readdir(dir)).some(x=>x.startsWith('.rollback.')&&x.endsWith('.stage')));
}));
