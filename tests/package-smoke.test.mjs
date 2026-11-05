import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('workspace packages install and typecheck in an isolated offline packed consumer',{timeout:120000},()=>{
 execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/test-packed-consumer.mjs',import.meta.url))],{encoding:'utf8',timeout:110000});
});
