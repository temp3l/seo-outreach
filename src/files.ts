import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export type ArtifactInput = Readonly<Record<string, Uint8Array>>;
export type PublishOptions = { allowedNames: readonly string[]; maxFileBytes?: number; maxTotalBytes?: number };
export type PublishResult = { directory: string; files: string[]; bytes: number };
export type ArtifactReadLimits = { maxFileBytes?: number; maxTotalBytes?: number };
export const READY_MARKER = '.seo-outreach-ready.json';

const DEFAULT_FILE_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TOTAL_LIMIT = 24 * 1024 * 1024;
const HARD_FILE_LIMIT = 64 * 1024 * 1024;
const HARD_TOTAL_LIMIT = 128 * 1024 * 1024;
const MARKER_LIMIT = 64 * 1024;

function safeName(name: string): boolean {
  return name !== '.' && name !== '..' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  const abs=resolve(path);const parts=abs.split('/').filter(Boolean);let cur='/';
  for(const part of parts){cur=cur==='/'?`/${part}`:`${cur}/${part}`;try{const s=await lstat(cur);if(s.isSymbolicLink()||!s.isDirectory())throw new Error('unsafe_output_path');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}}
}

/** Read-only preflight for a fresh output directory; call again at publication time. */
export async function assertSafeOutputTarget(directory:string):Promise<void>{
  const destination=resolve(directory);const parent=dirname(destination);
  if(destination===dirname(destination))throw new Error('invalid_output_directory');
  await rejectSymlinkAncestors(parent);
  try{await lstat(destination);throw new Error('destination_exists');}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
}

/**
 * Publish a complete company artifact set behind an atomic ready marker. The directory
 * is claimed with exclusive mkdir and each artifact/marker is installed with no-replace
 * hard links. Readers must call isArtifactDirectoryPublished before consuming files.
 * A crash before the marker leaves an unpublished directory for operator recovery.
 */
export async function publishArtifacts(companyDirectory: string, artifacts: ArtifactInput, options: PublishOptions): Promise<PublishResult> {
  const destination=resolve(companyDirectory);const parent=dirname(destination);const leaf=basename(destination);
  if(!leaf||leaf==='.'||leaf==='..'||!leaf.trim())throw new Error('invalid_output_directory');
  if(!Array.isArray(options.allowedNames)||options.allowedNames.length===0||options.allowedNames.some(n=>!safeName(n))||new Set(options.allowedNames).size!==options.allowedNames.length)throw new Error('invalid_allowlist');
  const allowed=new Set(options.allowedNames);
  if(allowed.has(READY_MARKER))throw new Error('reserved_artifact_name');
  const names=Object.keys(artifacts);
  if(names.length===0)throw new Error('empty_artifacts');if(names.length>100)throw new Error('too_many_artifacts');
  for(const name of names)if(!safeName(name)||!allowed.has(name))throw new Error('artifact_name_not_allowed');
  const maxFile=options.maxFileBytes??DEFAULT_FILE_LIMIT,maxTotal=options.maxTotalBytes??DEFAULT_TOTAL_LIMIT;
  if(!Number.isSafeInteger(maxFile)||maxFile<=0||!Number.isSafeInteger(maxTotal)||maxTotal<=0)throw new Error('invalid_size_limit');
  const materialized=new Map<string,Buffer>();let total=0;
  for(const name of names){const value=artifacts[name];if(!(value instanceof Uint8Array))throw new Error('artifact_must_be_bytes');const bytes=Buffer.from(value);if(bytes.byteLength>maxFile)throw new Error('artifact_too_large');total+=bytes.byteLength;if(total>maxTotal)throw new Error('artifacts_too_large');materialized.set(name,bytes);}

  await rejectSymlinkAncestors(parent);await mkdir(parent,{recursive:true});
  const stagePath=`${parent}/.${leaf}.${randomUUID()}.stage`;
  let ownedStage=false;let stageStat:{dev:number;ino:number}|undefined;
  let ownedDestination=false;let destinationStat:{dev:number;ino:number}|undefined;
  const installed=new Map<string,{dev:number;ino:number}>();let markerStat:{dev:number;ino:number}|undefined;
  const stagedFiles=new Map<string,{dev:number;ino:number}>();
  try{
    try{await mkdir(destination,{mode:0o700});ownedDestination=true;const d=await lstat(destination);destinationStat={dev:d.dev,ino:d.ino};}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('destination_exists');throw e;}
    const parentDir=await open(parent,'r');try{await parentDir.sync();}finally{await parentDir.close();}
    await mkdir(stagePath,{mode:0o700});ownedStage=true;{const d=await lstat(stagePath);stageStat={dev:d.dev,ino:d.ino};}
    for(const [name,bytes] of materialized){const path=`${stagePath}/${name}`;const f=await open(path,'wx',0o600);try{await f.writeFile(bytes);await f.sync();const s=await f.stat();stagedFiles.set(name,{dev:s.dev,ino:s.ino});}finally{await f.close();}}
    const stageDir=await open(stagePath,'r');try{await stageDir.sync();}finally{await stageDir.close();}
    for(const name of names){const staged=await lstat(`${stagePath}/${name}`);await link(`${stagePath}/${name}`,`${destination}/${name}`);installed.set(name,{dev:staged.dev,ino:staged.ino});}
    const manifestFiles=names.slice().sort().map(name=>{const b=materialized.get(name)!;return {name,bytes:b.byteLength,sha256:createHash('sha256').update(b).digest('hex')};});
    const markerPayload=Buffer.from(JSON.stringify({version:1,files:manifestFiles,bytes:total}));
    const markerStage=`${stagePath}/${READY_MARKER}`;const marker=await open(markerStage,'wx',0o600);try{await marker.writeFile(markerPayload);await marker.sync();}finally{await marker.close();}
    const stagedMarker=await lstat(markerStage);stagedFiles.set(READY_MARKER,{dev:stagedMarker.dev,ino:stagedMarker.ino});await link(markerStage,`${destination}/${READY_MARKER}`);markerStat={dev:stagedMarker.dev,ino:stagedMarker.ino};
    const outputDir=await open(destination,'r');try{await outputDir.sync();}finally{await outputDir.close();}
    return {directory:destination,files:names.slice().sort(),bytes:total};
  }catch(e){
    if(ownedDestination&&destinationStat){
      try{const d=await lstat(destination);if(d.dev===destinationStat.dev&&d.ino===destinationStat.ino){
        for(const [name,own] of installed){try{const f=await lstat(`${destination}/${name}`);if(f.dev===own.dev&&f.ino===own.ino)await rm(`${destination}/${name}`);}catch{}}
        if(markerStat)try{const f=await lstat(`${destination}/${READY_MARKER}`);if(f.dev===markerStat.dev&&f.ino===markerStat.ino)await rm(`${destination}/${READY_MARKER}`);}catch{}
        await rmdir(destination).catch(()=>{});
      }}catch{}
    }
    throw e;
  }
  finally{
    if(ownedStage&&stageStat)try{const d=await lstat(stagePath);if(d.dev===stageStat.dev&&d.ino===stageStat.ino){
      for(const [name,own] of stagedFiles){try{const f=await lstat(`${stagePath}/${name}`);if(f.dev===own.dev&&f.ino===own.ino)await rm(`${stagePath}/${name}`);}catch{}}
      await rmdir(stagePath).catch(()=>{});
    }}catch{}
  }
}

type MarkerEntry={name:string;bytes:number;sha256:string};
type ReadyManifest={version:number;files:MarkerEntry[];bytes:number};
async function readAtMost(file:Awaited<ReturnType<typeof open>>,limit:number):Promise<Buffer>{
  const out=Buffer.alloc(limit+1);let offset=0;
  while(offset<out.length){const {bytesRead}=await file.read(out,offset,out.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
  if(offset>limit)throw new Error('artifact_read_limit_exceeded');return out.subarray(0,offset);
}
async function validatedArtifactSet(directory:string,selectedName:string|undefined,limits:ArtifactReadLimits):Promise<Buffer|undefined>{
  if(selectedName!==undefined&&(!safeName(selectedName)||selectedName===READY_MARKER))throw new Error('unsupported_artifact_name');
  const root=resolve(directory);const maxFile=limits.maxFileBytes??DEFAULT_FILE_LIMIT,maxTotal=limits.maxTotalBytes??DEFAULT_TOTAL_LIMIT;
  if(!Number.isSafeInteger(maxFile)||maxFile<=0||maxFile>HARD_FILE_LIMIT||!Number.isSafeInteger(maxTotal)||maxTotal<=0||maxTotal>HARD_TOTAL_LIMIT)throw new Error('invalid_artifact_read_limits');
  const rootInfo=await lstat(root);if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error('unpublished_or_corrupt_artifacts');
  const marker=await open(`${root}/${READY_MARKER}`,constants.O_RDONLY|constants.O_NOFOLLOW);
  let manifest:ReadyManifest;
  try{
    const info=await marker.stat();if(!info.isFile()||info.size>MARKER_LIMIT)throw new Error('unpublished_or_corrupt_artifacts');
    const bytes=await readAtMost(marker,MARKER_LIMIT);const raw:unknown=JSON.parse(bytes.toString('utf8'));
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('unpublished_or_corrupt_artifacts');
    const m=raw as Record<string,unknown>;
    if(m.version!==1||!Array.isArray(m.files)||m.files.length<1||m.files.length>100||!Number.isSafeInteger(m.bytes)||(m.bytes as number)<0||(m.bytes as number)>maxTotal)throw new Error('unpublished_or_corrupt_artifacts');
    const seen=new Set<string>();const files:MarkerEntry[]=[];
    for(const value of m.files){
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('unpublished_or_corrupt_artifacts');
      const entry=value as Record<string,unknown>;
      if(typeof entry.name!=='string'||!safeName(entry.name)||entry.name===READY_MARKER||seen.has(entry.name)||!Number.isSafeInteger(entry.bytes)||(entry.bytes as number)<0||(entry.bytes as number)>maxFile||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('unpublished_or_corrupt_artifacts');
      seen.add(entry.name);files.push({name:entry.name,bytes:entry.bytes as number,sha256:entry.sha256});
    }
    if(selectedName!==undefined&&!seen.has(selectedName))throw new Error('unsupported_artifact_name');
    manifest={version:1,files,bytes:m.bytes as number};
  }finally{await marker.close();}
  let total=0;let selected:Buffer|undefined;
  for(const entry of manifest.files){
    const data=await open(`${root}/${entry.name}`,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await data.stat();if(!stat.isFile()||stat.size!==entry.bytes||stat.size>maxFile)throw new Error('unpublished_or_corrupt_artifacts');
      const bytes=await readAtMost(data,maxFile);
      if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('unpublished_or_corrupt_artifacts');
      total+=bytes.length;if(total>maxTotal)throw new Error('unpublished_or_corrupt_artifacts');
      if(entry.name===selectedName)selected=bytes;
    }finally{await data.close();}
  }
  if(total!==manifest.bytes||selectedName!==undefined&&!selected)throw new Error('unpublished_or_corrupt_artifacts');
  return selected;
}

/** Validate the whole published set and return the exact selected bytes whose digest was checked. */
export async function readPublishedArtifact(directory:string,name:string,limits:ArtifactReadLimits={}):Promise<Buffer>{
  return (await validatedArtifactSet(directory,name,limits))!;
}

/** Compatibility boolean gate; it validates the same complete file set as the read API. */
export async function isArtifactDirectoryPublished(directory:string,limits:ArtifactReadLimits={}):Promise<boolean>{
  try{await validatedArtifactSet(directory,undefined,limits);return true;}catch{return false;}
}
