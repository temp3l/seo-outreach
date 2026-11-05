import { constants } from 'node:fs';
import { open, link, unlink, rename, lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const inside = (base, path) => { const rel=relative(base,path); return !!rel&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!rel.startsWith(sep); };
async function readOriginal(path) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try { const stat=await file.stat(); if(!stat.isFile()||stat.nlink!==1)throw Error(`unsafe_original:${path}`); return await file.readFile(); }
  finally { await file.close(); }
}
async function createBackup(path, bytes, expectedHash) {
  const backup=`${path}.cumbuco-backup-${expectedHash.slice(0,16)}-${randomUUID()}`;
  const file=await open(backup,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  if(sha256(await readOriginal(backup))!==expectedHash)throw Error(`backup_readback_failed:${backup}`);
  return backup;
}

/** Apply a fully prevalidated Cumbuco plan; manifest replacement is the commit boundary. */
export async function publishCumbucoReplacements(root, replacements, oldHashes, manifestPath, { retirePaths = [], operations = {} } = {}) {
  if(await realpath(root)!==root)throw Error('unsafe_publication_root');
  if(typeof manifestPath!=='string'||!inside(root,manifestPath)||join(root,relative(root,manifestPath))!==manifestPath)throw Error('unsafe_manifest_path');
  const ops={link,unlink,rename,...operations};
  const resolve=rel=>{if(typeof rel!=='string'||rel.includes('\\')||rel.startsWith('/')||rel.split('/').some(x=>!x||x==='.'||x==='..'))throw Error(`unsafe_output_path:${rel}`);const p=join(root,rel);if(!inside(root,p)||relative(root,p)!==rel.split('/').join(sep))throw Error(`unsafe_output_path:${rel}`);return p;};
  const validateParents=async p=>{const d=dirname(p);if(d!==root&&!inside(root,d))throw Error(`unsafe_output_parent:${p}`);let current=root;for(const part of relative(root,d).split(sep).filter(Boolean)){current=join(current,part);const s=await lstat(current);if(s.isSymbolicLink()||!s.isDirectory()||await realpath(current)!==current)throw Error(`unsafe_output_parent:${current}`);}};
  const read=readOriginal;
  const paths=[...replacements.map(([p])=>p),...retirePaths];
  const resolved=paths.map(resolve); if(new Set(resolved).size!==resolved.length)throw Error('duplicate_output_path');
  const manifestIndex=replacements.findIndex(([p])=>resolve(p)===manifestPath);
  if(manifestIndex!==-1&&manifestIndex!==replacements.length-1)throw Error('manifest_must_be_last');
  if(retirePaths.some(p=>!/^scraped\/[^/]*CB-(?:EXT-)?[A-F0-9]{10}\/report\.(?:pt-review\.pdf|mobile-pt-review\.pdf|whatsapp-pt-review\.md)$/u.test(p)||!oldHashes.has(p)))throw Error('invalid_retirement_path');
  // Validate every destination and original before creating any backup or changing any path.
  const originals=new Map();
  for(const rel of paths){const p=resolve(rel);await validateParents(p);const expected=oldHashes.get(rel);let exists=true;try{await lstat(p);}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
    if(expected){if(!exists)throw Error(`original_missing:${rel}`);const b=await read(p);if(sha256(b)!==expected)throw Error(`original_changed:${rel}`);const proposed=replacements.find(([name])=>name===rel)?.[1];if(retirePaths.includes(rel)||!proposed||sha256(proposed)!==expected)originals.set(rel,b);}
    else if(exists)throw Error(`output_already_exists:${rel}`);
  }
  const backups=new Map();
  for(const [rel,bytes] of originals)backups.set(rel,await createBackup(resolve(rel),bytes,oldHashes.get(rel)));
  const mutations=[];
  const stages=new Map();
  const cleanupStage=async path=>{
    if(!stages.has(path))return;
    const expected=stages.get(path);
    if(!expected)throw Error(`stage_identity_unavailable:${path}`);
    try {
      const current=await lstat(path);
      if(!current.isFile()||current.dev!==expected.dev||current.ino!==expected.ino)throw Error(`stage_identity_changed:${path}`);
      await ops.unlink(path);
    } catch(error) { if(error.code!=='ENOENT')throw error; }
    stages.delete(path);
  };
  const stageFile=async(rel,bytes,isReplace)=>{
    const p=resolve(rel),temp=join(dirname(p),`.cumbuco-${randomUUID()}.tmp`);
    let file,primary;
    try {
      file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      stages.set(temp,null);
      stages.set(temp,await file.stat());
      await file.writeFile(bytes);
      await file.sync();
      await file.close();file=undefined;
      if(isReplace){
        if(sha256(await read(p))!==oldHashes.get(rel))throw Error(`original_changed:${rel}`);
        await ops.rename(temp,p);
        mutations.push({rel,kind:'replace',bytes});
        stages.delete(temp);
      }else{
        await ops.link(temp,p);
        mutations.push({rel,kind:'create',bytes});
      }
    }catch(error){primary=error;}
    const cleanup=[];
    try{if(file)await file.close();}catch(error){cleanup.push(error);}
    try{await cleanupStage(temp);}catch(error){cleanup.push(error);}
    if(primary&&cleanup.length)throw new AggregateError([primary,...cleanup],`promotion_and_stage_cleanup_failed: ${primary.message}; ${cleanup.map(e=>e.message).join('; ')}`);
    if(primary)throw primary;
    if(cleanup.length)throw new AggregateError(cleanup,`stage_cleanup_failed: ${cleanup.map(e=>e.message).join('; ')}`);
  };
  try {
    for(const rel of retirePaths){const p=resolve(rel);const current=await read(p);if(sha256(current)!==oldHashes.get(rel))throw Error(`original_changed:${rel}`);await ops.unlink(p);mutations.push({rel,kind:'retire',bytes:current});}
    for(const [rel,bytes] of replacements){const old=oldHashes.get(rel);if(old&&old===sha256(bytes))continue;await stageFile(rel,bytes,!!old);if(sha256(await read(resolve(rel)))!==sha256(bytes))throw Error(`output_readback_failed:${rel}`);}
    if(manifestIndex>=0){const [rel,bytes]=replacements[manifestIndex];if(sha256(await read(resolve(rel)))!==sha256(bytes))throw Error('manifest_readback_failed');}
    return [...backups.values()];
  } catch(error) {
    const rollbackErrors=[];
    // A linked new output has two links until its owned staging link is removed.
    // Retry cleanup before the single-link safety check used by rollback reads.
    for(const path of stages.keys())try{await cleanupStage(path);}catch(e){rollbackErrors.push(e);}
    for(const m of [...mutations].reverse())try{const p=resolve(m.rel);let current;try{current=await read(p);}catch(e){if(e.code==='ENOENT')current=null;else throw e;}
      if(m.kind==='create'){if(!current)continue;if(sha256(current)!==sha256(m.bytes))throw Error(`rollback_unexpected_destination:${p}`);await ops.unlink(p);}
      else if(m.kind==='replace'){if(!current||sha256(current)!==sha256(m.bytes))throw Error(`rollback_unexpected_destination:${p}`);const backup=backups.get(m.rel);if(!backup||sha256(await read(backup))!==oldHashes.get(m.rel))throw Error(`rollback_backup_invalid:${backup??p}`);const restore=join(dirname(p),`.cumbuco-restore-${randomUUID()}.tmp`);const restoreFile=await open(restore,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await restoreFile.writeFile(await read(backup));await restoreFile.sync();}finally{await restoreFile.close();}await ops.rename(restore,p);}
      else {if(current)throw Error(`rollback_unexpected_destination:${p}`);const backup=backups.get(m.rel);if(!backup||sha256(await read(backup))!==oldHashes.get(m.rel))throw Error(`rollback_backup_invalid:${backup??p}`);const restore=join(dirname(p),`.cumbuco-restore-${randomUUID()}.tmp`);const restoreFile=await open(restore,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await restoreFile.writeFile(await read(backup));await restoreFile.sync();}finally{await restoreFile.close();}await ops.rename(restore,p);}
    }catch(e){rollbackErrors.push(e);}
    if(rollbackErrors.length)throw new AggregateError([error,...rollbackErrors],`publication_failed_and_rollback_failed: ${error.message}; ${rollbackErrors.map(e=>e.message).join('; ')}`);
    throw error;
  }
}

export async function publishNewFile(path, bytes) {
  const stage=join(dirname(path),`.cumbuco-${randomUUID()}.tmp`);let f,created=false;
  try{f=await open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;await f.writeFile(bytes);await f.sync();await f.close();f=undefined;await link(stage,path);}
  finally{if(f)await f.close();if(created)await unlink(stage).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function replaceVerifiedFile(path, bytes, expectedHash) {
  const original=await readOriginal(path);if(sha256(original)!==expectedHash)throw Error('original_changed');if(sha256(bytes)===expectedHash)return {changed:false};
  const backup=await createBackup(path,original,expectedHash);const stage=join(dirname(path),`.cumbuco-${randomUUID()}.tmp`);let f,created=false;
  try{f=await open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;await f.writeFile(bytes);await f.sync();await f.close();f=undefined;if(sha256(await readOriginal(path))!==expectedHash)throw Error('original_changed');await rename(stage,path);created=false;return {changed:true,backup};}
  finally{if(f)await f.close();if(created)await unlink(stage).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
