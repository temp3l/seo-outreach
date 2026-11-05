import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {runCli} from '../dist/compat/cli.js';
test('batch query disclosure requires its own flag and changed permission invalidates resume',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-batch-query-'), original=globalThis.fetch,calls=[];
 globalThis.fetch=async url=>{calls.push(new URL(url).searchParams.get('url'));return Response.json({lighthouseResult:{categories:Object.fromEntries(['performance','accessibility','best-practices','seo'].map(k=>[k,{score:.8}]))}});};
 let requests=0;
 const transport={resolveAddresses:async()=>['93.184.216.34'],request:async()=>{requests++;return {status:404,headers:{},body:Buffer.alloc(0)};}};
 try {
  const input=`${root}/input.csv`,target='https://fixture.example/?campaign=PRIVATE';await writeFile(input,`website\n${target}\n`);
  const args=['--batch',input,'--out',`${root}/out`,'--resume','--no-contacts','--no-progress','--pagespeed'];
  await runCli(args,transport);assert.equal(calls.length,0);const first=requests;
  await runCli(args,transport);assert.equal(requests,first);
  await runCli([...args,'--pagespeed-include-query'],transport);assert.deepEqual(calls,[target]);assert.ok(requests>first);
  const second=requests;await runCli([...args,'--pagespeed-include-query'],transport);assert.equal(requests,second);assert.deepEqual(calls,[target]);
  await runCli(args,transport);assert.deepEqual(calls,[target]);
 }finally{globalThis.fetch=original;await rm(root,{recursive:true,force:true});}
});
