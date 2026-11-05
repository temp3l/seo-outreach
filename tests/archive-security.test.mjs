import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync,crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {unpackEvidenceArchive} from '../dist/archive.js';

const hash=b=>createHash('sha256').update(b).digest('hex');
const encoder=new TextEncoder();
const basePayloads=()=>[
 ['README.md',encoder.encode('fixture evidence archive')],
 ['audit.json',encoder.encode('{}')],
 ['pages.jsonl',encoder.encode('{"url":"https://example.test/"}\n')],
 ['site-graph.json',encoder.encode('{}')]
];

function makeZip({payloads=basePayloads(),manifest,overrides={}}={}){
 const blobs=payloads.map(([name,bytes])=>({name,bytes:Buffer.from(bytes)}));
 if(blobs.length===4){
  const members=blobs.map(m=>({name:m.name,bytes:m.bytes.length,sha256:hash(m.bytes)}));
  const pages=blobs.find(x=>x.name==='pages.jsonl')?.bytes.toString('utf8').split('\n').filter(Boolean).length??0;
  const m=manifest??{schemaVersion:'1',target:'https://example.test/',members,coverage:{exported:pages,captured:pages,omitted:0}};
  blobs.push({name:'manifest.json',bytes:Buffer.from(JSON.stringify(m))});
 }
 const local=[];const central=[];let offset=0;
 for(let i=0;i<blobs.length;i++){
  const b=blobs[i],name=Buffer.from(b.name),compressed=deflateRawSync(b.bytes),crc=crc32(b.bytes);
  const localNameLength=overrides.localNameLength?.[i]??name.length;
  const localCrc=(i===overrides.localCrcIndex)?(crc^1):crc;
  const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt32LE(localCrc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(overrides.declaredSizeIndex===i?overrides.declaredSize:b.bytes.length,22);h.writeUInt16LE(localNameLength,26);h.writeUInt16LE(0,28);
  local.push(h,name,compressed);
  const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(overrides.symlinkIndex===i?(3<<8)|20:20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(b.bytes.length,24);c.writeUInt16LE(overrides.centralNameLength?.[i]??name.length,28);c.writeUInt16LE(0,30);c.writeUInt16LE(0,32);c.writeUInt32LE(overrides.symlinkIndex===i?((0o120777<<16)>>>0):0,38);c.writeUInt32LE(offset,42);
  central.push(c,name);offset+=h.length+name.length+compressed.length;
 }
 const body=Buffer.concat(local),directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(blobs.length,8);end.writeUInt16LE(blobs.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(body.length,16);
 return Buffer.concat([body,directory,end]);
}

test('rejects empty and oversized archive inputs',()=>{
 assert.throws(()=>unpackEvidenceArchive(Buffer.alloc(0)),/archive_input_size_invalid/);
 assert.throws(()=>unpackEvidenceArchive(Buffer.alloc(32*1024*1024+1)),/archive_input_size_invalid/);
});

test('rejects malformed local and central directory member lengths',()=>{
 assert.throws(()=>unpackEvidenceArchive(makeZip({overrides:{localNameLength:{0:0xffff}}})),/archive_member_unsafe/);
 assert.throws(()=>unpackEvidenceArchive(makeZip({overrides:{centralNameLength:{0:0xffff}}})),/archive_central_mismatch/);
});

test('rejects local CRC corruption and manifest hash mismatch',()=>{
 assert.throws(()=>unpackEvidenceArchive(makeZip({overrides:{localCrcIndex:0}})),/archive_member_corrupt/);
 const payloads=basePayloads();const members=payloads.map(([name,bytes])=>({name,bytes:bytes.length,sha256:hash(bytes)}));members[0].sha256='0'.repeat(64);
 const manifest={schemaVersion:'1',target:'https://example.test/',members,coverage:{exported:1,captured:1,omitted:0}};
 assert.throws(()=>unpackEvidenceArchive(makeZip({payloads,manifest})),/archive_manifest_hash_mismatch/);
});

test('rejects duplicate and missing members',()=>{
 const duplicate=basePayloads();duplicate[1]=['README.md',duplicate[1][1]];
 assert.throws(()=>unpackEvidenceArchive(makeZip({payloads:duplicate})),/archive_member_name_or_order_invalid/);
 assert.throws(()=>unpackEvidenceArchive(makeZip({payloads:basePayloads()} ).subarray(0,0)),/archive_input_size_invalid/);
 const missing=makeZip({payloads:basePayloads()});
 // Keep only the four local records: the parser reaches the local/central boundary and reports the missing manifest.
 let p=0;for(let i=0;i<4;i++){const nl=missing.readUInt16LE(p+26),extra=missing.readUInt16LE(p+28),compressed=missing.readUInt32LE(p+18);p+=30+nl+extra+compressed;}
 assert.throws(()=>unpackEvidenceArchive(missing.subarray(0,p)),/archive_members_missing/);
});

test('rejects ZIP slip names and Unix symlink entries',()=>{
 const traversal=basePayloads();traversal[0]=['../evil',traversal[0][1]];
 assert.throws(()=>unpackEvidenceArchive(makeZip({payloads:traversal})),/archive_member_name_or_order_invalid/);
 assert.throws(()=>unpackEvidenceArchive(makeZip({overrides:{symlinkIndex:0}})),/archive_nonregular_member/);
});

test('rejects decompression over declared size and configured uncompressed limit',()=>{
 const explosive=basePayloads();explosive[0]=['README.md',Buffer.alloc(2*1024*1024,0)];
 assert.throws(()=>unpackEvidenceArchive(makeZip({payloads:explosive,overrides:{declaredSizeIndex:0,declaredSize:32}})),/archive_decompression_invalid/);
 // The 32-bit declared size trips the 128 MiB aggregate cap before inflate is attempted.
 assert.throws(()=>unpackEvidenceArchive(makeZip({overrides:{declaredSizeIndex:0,declaredSize:0xffffffff}})),/archive_member_unsafe/);
});

test('rejects mismatch between exported pages and manifest coverage',()=>{
 const payloads=basePayloads();const members=payloads.map(([name,bytes])=>({name,bytes:bytes.length,sha256:hash(bytes)}));
 const manifest={schemaVersion:'1',target:'https://example.test/',members,coverage:{exported:9,captured:9,omitted:0}};
 assert.throws(()=>unpackEvidenceArchive(makeZip({payloads,manifest})),/archive_page_coverage_invalid/);
});
