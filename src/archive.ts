import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { readBounded, normalizeAudit, type Normalized } from './evidence.js';

const NAMES = ['README.md', 'audit.json', 'pages.jsonl', 'site-graph.json', 'manifest.json'];
const MAX_UNCOMPRESSED = 128 * 1024 * 1024;
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Member = {name: string; bytes: Buffer; crc: number; offset: number; compressed: number};
function json(b: Buffer): unknown { try { return JSON.parse(b.toString('utf8')); } catch { throw new Error('archive_json_invalid'); } }
function obj(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
/** Structural integrity is checked here; producer-specific semantic verification remains a separate gate. */
export function unpackEvidenceArchive(bytes: Buffer): {audit: unknown; manifest: Record<string, unknown>; fingerprint: string; pages: unknown[]} {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('archive_input_size_invalid');
  const members: Member[] = []; let offset = 0; let total = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (members.length >= NAMES.length || offset + 30 > bytes.length) throw new Error('archive_local_header_invalid');
    const flags=bytes.readUInt16LE(offset+6), method=bytes.readUInt16LE(offset+8), crc=bytes.readUInt32LE(offset+14), compressed=bytes.readUInt32LE(offset+18), size=bytes.readUInt32LE(offset+22), nl=bytes.readUInt16LE(offset+26), extra=bytes.readUInt16LE(offset+28);
    const start=offset+30+nl+extra, end=start+compressed;
    if (flags!==0x800 || method!==8 || nl===0 || start>bytes.length || end>bytes.length || size>MAX_UNCOMPRESSED-total) throw new Error('archive_member_unsafe');
    const name=bytes.subarray(offset+30,offset+30+nl).toString('utf8');
    if (name!==NAMES[members.length]) throw new Error('archive_member_name_or_order_invalid');
    let payload: Buffer; try { payload=inflateRawSync(bytes.subarray(start,end),{maxOutputLength:Math.max(1,size)}); } catch { throw new Error('archive_decompression_invalid'); }
    if (payload.length!==size || crc32(payload)!==crc) throw new Error('archive_member_corrupt');
    members.push({name,bytes:payload,crc,offset,compressed}); total+=size; offset=end;
  }
  if (members.length!==NAMES.length) throw new Error('archive_members_missing');
  const centralStart=offset;
  for (const m of members) {
    if (offset+46>bytes.length || bytes.readUInt32LE(offset)!==0x02014b50) throw new Error('archive_central_invalid');
    const nl=bytes.readUInt16LE(offset+28), extra=bytes.readUInt16LE(offset+30), comment=bytes.readUInt16LE(offset+32), end=offset+46+nl+extra+comment;
    if (end>bytes.length || bytes.readUInt16LE(offset+8)!==0x800 || bytes.readUInt16LE(offset+10)!==8 || bytes.readUInt32LE(offset+16)!==m.crc || bytes.readUInt32LE(offset+20)!==m.compressed || bytes.readUInt32LE(offset+24)!==m.bytes.length || bytes.readUInt32LE(offset+42)!==m.offset || bytes.subarray(offset+46,offset+46+nl).toString('utf8')!==m.name) throw new Error('archive_central_mismatch');
    const madeBy=bytes.readUInt16LE(offset+4)>>>8, unixMode=bytes.readUInt32LE(offset+38)>>>16;
    if (madeBy===3 && (unixMode & 0xf000)!==0 && (unixMode & 0xf000)!==0x8000) throw new Error('archive_nonregular_member');
    offset=end;
  }
  if (offset+22!==bytes.length || bytes.readUInt32LE(offset)!==0x06054b50 || bytes.readUInt16LE(offset+4)!==0 || bytes.readUInt16LE(offset+6)!==0 || bytes.readUInt16LE(offset+8)!==members.length || bytes.readUInt16LE(offset+10)!==members.length || bytes.readUInt32LE(offset+12)!==offset-centralStart || bytes.readUInt32LE(offset+16)!==centralStart || bytes.readUInt16LE(offset+20)!==0) throw new Error('archive_end_invalid');
  const manifest=json(members[4]!.bytes);
  if (!obj(manifest) || manifest.schemaVersion!=='1' || !Array.isArray(manifest.members) || manifest.members.length!==4) throw new Error('archive_manifest_invalid');
  for (const [i,m] of members.slice(0,4).entries()) { const item=manifest.members[i]; if (!obj(item) || item.name!==m.name || item.bytes!==m.bytes.length || item.sha256!==digest(m.bytes)) throw new Error('archive_manifest_hash_mismatch'); }
  const pageText=members[2]!.bytes.toString('utf8');
  const lines=pageText.split('\n'); if(lines.at(-1)==='')lines.pop();
  if(lines.length>10_000 || lines.some(line=>Buffer.byteLength(line)>4_000_000 || !line)) throw new Error('archive_pages_limit_or_format_invalid');
  const pages=lines.map(line=>json(Buffer.from(line)));
  if(!obj(manifest.coverage) || !Number.isSafeInteger(manifest.coverage.exported) || manifest.coverage.exported!==pages.length || !Number.isSafeInteger(manifest.coverage.captured) || !Number.isSafeInteger(manifest.coverage.omitted) || (manifest.coverage.exported as number)+(manifest.coverage.omitted as number)!==manifest.coverage.captured) throw new Error('archive_page_coverage_invalid');
  return {audit:json(members[1]!.bytes), manifest, fingerprint:digest(bytes),pages};
}
/** Preserve declared limits without upgrading structural integrity to semantic truth. */
export function attachArchiveCoverage(evidence:Normalized,manifest:Record<string,unknown>,pageCount:number):void {
 if(!obj(manifest.coverage)||!obj(manifest.omissions)||!obj(manifest.truncationCounts)||!['PARTIAL','COMPLETE'].includes(String(manifest.status)))throw new Error('archive_coverage_metadata_invalid');
 const c=manifest.coverage;
 for(const key of ['discovered','attempted','captured','failed','skipped','unattempted'] as const)if(c[key]!==evidence.crawl[key])throw new Error('archive_audit_coverage_mismatch');
 const count=(v:unknown):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('archive_coverage_metadata_invalid');return v;};
 const exported=count(c.exported),omitted=count(c.omitted),truncatedPages=count(c.truncatedPages);
 if(exported!==pageCount||exported+omitted!==evidence.crawl.captured||truncatedPages>evidence.crawl.captured||manifest.omissions.pages!==omitted)throw new Error('archive_audit_coverage_mismatch');
 const projectCounts=(source:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.filter(k=>Object.hasOwn(source,k)).map(k=>[k,count(source[k])]));
 const truncationCounts=projectCounts(manifest.truncationCounts,['pages','sourceLimit','text','title','description','headings','links','linkEdgesOmitted','linkAnchorTexts','images','structuredData']);
 const omissionCounts=projectCounts(manifest.omissions,['pages','pageDataLimit','archiveByteLimit','truncatedPages']);
 if(truncationCounts.pages!==undefined&&truncationCounts.pages!==truncatedPages)throw new Error('archive_audit_coverage_mismatch');
 if(manifest.status==='COMPLETE'&&(omitted>0||truncatedPages>0||evidence.crawl.failed>0||evidence.crawl.unattempted>0))throw new Error('archive_false_complete_status');
 evidence.exportCoverage={status:manifest.status as 'PARTIAL'|'COMPLETE',provenance:manifest.originalAuditProvenance==='VERIFIED_AT_PACK_CREATION'?'VERIFIED_AT_PACK_CREATION':'UNVERIFIED_OR_UNKNOWN',exported,omitted,truncatedPages,truncationCounts,omissionCounts};
}
export async function loadEvidenceArchive(path: string): Promise<{evidence: Normalized; manifest: Record<string, unknown>; pages: unknown[]; verification: 'STRUCTURAL_ONLY'}> {
 const {audit, manifest, fingerprint,pages}=unpackEvidenceArchive(await readBounded(path));
 const evidence=normalizeAudit(audit,fingerprint);evidence.format='webcrawl-evidence-zip-1';
 if (!obj(audit) || manifest.target!==audit.target) throw new Error('archive_target_mismatch');
 attachArchiveCoverage(evidence,manifest,pages.length);
 return {evidence,manifest,pages,verification:'STRUCTURAL_ONLY'};
}
