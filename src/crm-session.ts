import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { readPublishedArtifact } from './files.js';
import { mergeProspects, prospectsCsv, type ProspectInput, type CRMState } from './crm.js';
import { resolve } from 'node:path';

const MAX_SNAPSHOT_BYTES=8*1024*1024;

export type CrmSnapshotSourceOptions={existingJsonPath?:string};

async function readExplicitState(path:string):Promise<Buffer>{
  const file=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>MAX_SNAPSHOT_BYTES)throw new Error('unsafe_crm_state_file');
    const buffer=Buffer.alloc(MAX_SNAPSHOT_BYTES+1);let offset=0;
    while(offset<buffer.length){const {bytesRead}=await file.read(buffer,offset,buffer.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
    if(offset>MAX_SNAPSHOT_BYTES)throw new Error('crm_state_too_large');return buffer.subarray(0,offset);
  }finally{await file.close();}
}

/** Read and validate a prior snapshot once, before provider dispatch. */
export async function loadCrmSnapshot(existingDirectory:string|undefined,options:CrmSnapshotSourceOptions={}):Promise<CRMState>{
  let existing:unknown;
  if(options.existingJsonPath!==undefined&&existingDirectory!==undefined)throw new Error('ambiguous_crm_source');
  if(options.existingJsonPath!==undefined){
    const prior=await readExplicitState(options.existingJsonPath);
    try{existing=JSON.parse(prior.toString('utf8'));}catch{throw new Error('corrupt_crm_state');}
  }else if(existingDirectory!==undefined){
    const prior=await readPublishedArtifact(existingDirectory,'prospects.json',{maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024});
    if(prior.byteLength>MAX_SNAPSHOT_BYTES)throw new Error('crm_state_too_large');
    try{existing=JSON.parse(prior.toString('utf8'));}catch{throw new Error('corrupt_crm_state');}
  }
  const state=mergeProspects(existing,[]);
  // Validate derived size limits during preflight as well as after the merge.
  buildCrmSnapshotFromState(state,[]);return state;
}

/** Build from the exact validated preflight snapshot, without later file reads. */
export function buildCrmSnapshotFromState(existing:CRMState,incoming:ProspectInput[]):{json:Buffer;csv:Buffer;count:number}{
  const state=mergeProspects(existing,incoming);
  const json=Buffer.from(`${JSON.stringify(state,null,2)}\n`,'utf8');
  const csv=Buffer.from(prospectsCsv(state),'utf8');
  if(json.byteLength>MAX_SNAPSHOT_BYTES||csv.byteLength>MAX_SNAPSHOT_BYTES)throw new Error('crm_snapshot_too_large');
  return {json,csv,count:state.prospects.length};
}

/** Compatibility wrapper for callers that need a single local read and merge. */
export async function buildCrmSnapshot(existingDirectory:string|undefined,incoming:ProspectInput[],options:CrmSnapshotSourceOptions={}):Promise<{json:Buffer;csv:Buffer;count:number}>{
  return buildCrmSnapshotFromState(await loadCrmSnapshot(existingDirectory,options),incoming);
}
