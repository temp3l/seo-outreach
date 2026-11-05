#!/usr/bin/env node
// Read-only local reconciliation; only stdout receives the ledger. No dispatch.
import { readBounded, checkEntry } from './data-integrity-core.mjs';
try {
 if(process.argv.length!==4||process.argv[2]!=='--input')throw Error('invalid_options');
 const input=JSON.parse((await readBounded(process.argv[3],5_000_000)).toString());
 if(input.schema!=='webcrawl-integrity-input-v1'||!Array.isArray(input.entries)||!input.entries.length||input.entries.length>1000)throw Error('input_schema_invalid');
 const ids=new Set();for(const e of input.entries){if(!e||typeof e.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(e.id)||ids.has(e.id)||typeof e.audit!=='string'||Object.keys(e).some(k=>!['id','audit','qualification','reviewManifest','evidencePack','release','reports','handoff'].includes(k)))throw Error('entry_identity_or_shape_invalid');ids.add(e.id);}
 const checkedAt=new Date().toISOString(),rows=[];
 for(const e of [...input.entries].sort((a,b)=>a.id.localeCompare(b.id)))rows.push(await checkEntry(e,Date.parse(checkedAt)));
 const summary=Object.fromEntries(['PASS','HOLD','ERROR'].map(s=>[s,rows.filter(r=>r.decision===s).length]));
 process.stdout.write(`${JSON.stringify({schema:'webcrawl-integrity-ledger-v1',checkedAt,summary,rows},null,2)}\n`);
 if(summary.ERROR)process.exitCode=1;
}catch{process.stderr.write('integrity_check_failed: invalid_options_or_input\n');process.exitCode=1;}
