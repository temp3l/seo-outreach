import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('frozen customer PDFs match reviewed visual references',{timeout:150000},async()=>{
 await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/check-report-visuals.mjs',import.meta.url)),'--self-test'],{timeout:140000,maxBuffer:1024*1024});
});
