import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,symlink,lstat,mkdir,writeFile,access} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {validateOutputPaths} from '../dist/compat/cli/output-paths.js';
test('dangling output entries fail preflight while absent outputs remain usable',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-output-');
 await validateOutputPaths([`${root}/new.json`]);
 await symlink(`${root}/absent`,`${root}/occupied.json`);
 await assert.rejects(validateOutputPaths([`${root}/occupied.json`]),/output_file_already_exists/);
 assert.ok((await lstat(`${root}/occupied.json`)).isSymbolicLink());
});
test('FIFO batch log fails promptly and releases its owned lock before dispatch',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-fifo-');const out=`${root}/out`;
 await mkdir(out,{mode:0o700});await writeFile(`${root}/sites.csv`,'website\nhttps://fixture.test/\n');
 execFileSync('mkfifo',['-m','600',`${out}/batch.run.log`]);
 const code=`import {runBatch} from './dist/compat/cli/batch.js';await runBatch(process.argv[1],process.argv[2],false,false,false,{request:async()=>{throw Error('UNEXPECTED_DISPATCH')}},false,false,false);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,`${root}/sites.csv`,out],{timeout:5000,encoding:'utf8'});
 assert.equal(child.error,undefined);assert.notEqual(child.status,0);assert.doesNotMatch(child.stderr,/UNEXPECTED_DISPATCH/);
 await assert.rejects(access(`${out}/.batch.lock`),{code:'ENOENT'});
});
