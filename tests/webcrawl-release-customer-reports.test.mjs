import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

const exec=promisify(execFile);
const script=new URL('../scripts/compat/release-customer-reports.mjs',import.meta.url).pathname;
// The formerly supported direct-render branch could issue CLIENT_READY without
// binding a reviewed PDF. Its input/error-path tests are replaced by this guard;
// reviewed-release integrity and rendering remain covered by the dedicated suite.
test('legacy direct release cannot publish without a reviewed manifest',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-no-unreviewed-release-');
 try {
  for (const extra of [[],['--pdf-locale','en']]) {
   const out=join(root,'out');
   await assert.rejects(exec(process.execPath,[script,'--audit',join(root,'missing-audit'),'--qualification',join(root,'missing-qualification'),'--report-contact-file',join(root,'missing-contact'),'--out',out,...extra]),e=>/reviewed_manifest_required/u.test(e.stderr));
   await assert.rejects(readFile(out+'.release.json'),{code:'ENOENT'});
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
