import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { withReleaseUnit } from '../scripts/compat/customer-release-unit.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const root = await mkdtemp('/tmp/webcrawl-unit-');
  const prefix = `${root}/release`, paths = ['en.pdf','de.pdf','mobile-en.pdf','whatsapp-draft.md','release.json'].map(s => `${prefix}.${s}`);
  const payloads = ['one','two','three','draft'].map(s=>Buffer.from(s));
  payloads.push(Buffer.from(JSON.stringify({schema:'webcrawl-customer-release-v1',reportStatus:'CLIENT_READY',outboundApproval:false,artifacts:paths.slice(0,4).map((path,i)=>({path,sha256:hash(payloads[i])}))})));
  let builds = 0;
  const run = phase => withReleaseUnit(prefix, paths, 'identity', async unit => { builds++; for(let i=0;i<5;i++) await writeFile(unit.stagePath(i),payloads[i],{flag:'wx',mode:0o600}); return unit.commit(); },phase);
  return {root,paths,payloads,run,builds:()=>builds};
}
test('release resumes failures before/after every link, then replay is a no-op', async () => {
  for(const when of ['before','after']) for(let index=0;index<5;index++) {
    const f=await fixture();
    try {
      await assert.rejects(f.run(async (phase,i)=> { if(phase===when && i===index) throw Error('interrupted'); }),/interrupted/);
      if(index<4 || when==='before') await assert.rejects(readFile(f.paths[4]),{code:'ENOENT'});
      await f.run(); await f.run(); assert.equal(f.builds(),1);
      for(let i=0;i<5;i++) assert.deepEqual(await readFile(f.paths[i]),f.payloads[i]);
    } finally { await rm(f.root,{recursive:true,force:true}); }
  }
});
test('same-prefix concurrency locks; foreign/symlink files are never replaced', async () => {
  const f=await fixture(); let release, entered;
  const ready=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  try {
    const first=f.run(async (phase,i)=>{if(phase==='before'&&i===0){entered();await gate;}}); await ready;
    await assert.rejects(f.run(),/release_busy/); release(); await first;
    await rm(f.paths[0]); await symlink(f.paths[1],f.paths[0]);
    await assert.rejects(f.run(),/output_collision/);
    assert.deepEqual(await readFile(f.paths[1]),f.payloads[1]);
  } finally { release?.(); await rm(f.root,{recursive:true,force:true}); }
});
test('malformed stage manifest and unsafe parent permissions fail closed', async () => {
  const f=await fixture();
  try { await f.run(); await writeFile(`${f.root}/.release.release-stage/4`,'{}'); await assert.rejects(f.run(),/artifact_hash_readback_mismatch/); await chmod(f.root,0o777); await assert.rejects(f.run(),/unsafe_output_parent/); }
  finally {await rm(f.root,{recursive:true,force:true});}
});

test('different release prefixes do not share a working-directory lock', async () => {
  const a=await fixture(), b=await fixture();let release, entered;
  const ready=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  const first=a.run(async (phase,i)=>{if(phase==='before'&&i===0){entered();await gate;}});
  try {await ready; await b.run();}
  finally {release(); await first; await rm(a.root,{recursive:true,force:true});await rm(b.root,{recursive:true,force:true});}
});

test('a changed release profile cannot replay a prior committed unit', async () => {
 const f=await fixture();try{await f.run();const before=await readFile(f.paths[4]);
 await assert.rejects(withReleaseUnit(`${f.root}/release`,f.paths,'new-profile',async()=>{throw Error('must not render');}),/output_collision/);
 assert.deepEqual(await readFile(f.paths[4]),before);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
