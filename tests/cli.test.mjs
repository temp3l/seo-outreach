import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runCli } from '../dist/cli.js';

test('parses the three explicit commands and their options',()=>{
  assert.deepEqual(parseArgs(['analyze','--input','audit.json','--out','out','--dry-run']),{command:'analyze',input:'audit.json',out:'out',locale:'en',recorded:undefined,sellerName:undefined,sellerLocation:undefined,dryRun:true});
  assert.deepEqual(parseArgs(['batch','--manifest','batch.json','--out','out','--locale','pt-BR']),{command:'batch',manifest:'batch.json',out:'out',locale:'pt-BR',dryRun:false});
  assert.deepEqual(parseArgs(['render','--analysis','analysis.json','--out','out']),{command:'render',analysis:'analysis.json',out:'out',dryRun:false});
});

test('accepts a seller name without location and validates locales',()=>{
  assert.equal(parseArgs(['analyze','--input','a','--out','b','--seller-name','Sam']).sellerName,'Sam');
  assert.throws(()=>parseArgs(['analyze','--input','a','--out','b','--seller-location','Tarifa']),/seller_name_required/);
  assert.throws(()=>parseArgs(['batch','--manifest','a','--out','b','--locale','fr']),/locale/);
  assert.deepEqual(parseArgs(['analyze','--input','a','--out','b','--seller-name','Sam','--seller-location','Tarifa']).command,'analyze');
});

test('accepts operator CRM state on analyze and batch, and rejects it on render or when malformed',()=>{
  const analyze=parseArgs(['analyze','--input','audit.json','--out','out','--crm-existing','prospects.json']);
  const batch=parseArgs(['batch','--manifest','batch.json','--out','out','--crm-existing','crm/prospects.json']);
  assert.equal(analyze.crmExisting,'prospects.json'); assert.equal(batch.crmExisting,'crm/prospects.json');
  assert.throws(()=>parseArgs(['analyze','--input','a','--out','b','--crm-existing']),/flag_value_required/);
  assert.throws(()=>parseArgs(['batch','--manifest','a','--out','b','--crm-existing','one.json','--crm-existing','two.json']),/duplicate_flag/);
  assert.throws(()=>parseArgs(['render','--analysis','a','--out','b','--crm-existing','prospects.json']),/unknown_or_inapplicable_flag/);
});

test('rejects duplicate, unknown, misplaced and incomplete flags',()=>{
  for(const argv of [
    ['analyze','--input','a','--input','b','--out','c'],
    ['analyze','--input','a','--out','b','--mystery'],
    ['render','--analysis','a','--out','b','--locale','es'],
    ['batch','--manifest'],
    ['analyze','--input','a'],
    ['render','--analysis','a','--out','b','--dry-run','--dry-run']
  ]) assert.throws(()=>parseArgs(argv));
});

test('live authorization requires the complete explicit four-flag bundle on analyze and batch',()=>{
  const common=['--paid-call','--provider-config','provider.json','--state','state.json','--batch-id','run-1'];
  const analyze=parseArgs(['analyze','--input','audit.json','--out','out',...common]);
  const batch=parseArgs(['batch','--manifest','batch.json','--out','out',...common]);
  assert.deepEqual(analyze.live,{paidCallOptIn:true,configPath:'provider.json',statePath:'state.json',batchId:'run-1'});
  assert.deepEqual(batch.live,analyze.live);
  for(const partial of [
    ['--paid-call'],['--provider-config','c'],['--state','s'],['--batch-id','b'],
    ['--paid-call','--provider-config','c'],['--paid-call','--state','s','--batch-id','b']
  ]) assert.throws(()=>parseArgs(['analyze','--input','a','--out','b',...partial]),/live_flags_must_be_provided_together/);
});

test('render rejects live flags and raw provider keys are not accepted as config arguments',()=>{
  assert.throws(()=>parseArgs(['render','--analysis','a','--out','b','--paid-call']),/unknown_or_inapplicable_flag/);
  assert.throws(()=>parseArgs(['analyze','--input','a','--out','b','--paid-call','--provider-config','sk-proj-1234567890','--state','s','--batch-id','b']),/api_keys_not_accepted/);
  assert.throws(()=>parseArgs(['analyze','--input','a','--out','b','--api-key','sk-secret']),/unknown_or_inapplicable_flag/);
});

test('help is machine-readable and does not call the pipeline',async()=>{
  const out=[],err=[]; let calls=0;
  const code=await runCli(['--help'],{analyze:async()=>{calls++;},batch:async()=>{calls++;},render:async()=>{calls++;}},{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,0); assert.equal(calls,0); assert.deepEqual(err,[]); assert.match(JSON.parse(out[0]).help,/analyze --input/); assert.match(JSON.parse(out[0]).help,/--crm-existing <prospects\.json>/);
});

test('dispatches exactly the selected command and emits machine JSON with secret fields removed',async()=>{
  const out=[],err=[],calls=[];
  const pipeline={
    analyze:async options=>{calls.push(['analyze',options]);return {status:'INTERNAL',apiKey:'private',nested:{access_token:'private',ok:true}};},
    batch:async options=>{calls.push(['batch',options]);return {status:'INTERNAL'};},
    render:async options=>{calls.push(['render',options]);return {status:'INTERNAL'};}
  };
  const code=await runCli(['analyze','--input','a','--out','b','--recorded','response.json','--crm-existing','prospects.json','--dry-run'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,0); assert.equal(calls.length,1); assert.equal(calls[0][0],'analyze'); assert.equal(calls[0][1].recorded,'response.json'); assert.equal(calls[0][1].crmExisting,'prospects.json'); assert.equal(calls[0][1].dryRun,true);
  assert.deepEqual(err,[]); const payload=JSON.parse(out[0]); assert.equal(payload.result.apiKey,undefined); assert.equal(payload.result.nested.access_token,undefined);
});

test('forwards crmExisting to the batch pipeline as a read-only state path',async()=>{
  const out=[],err=[]; let received;
  const pipeline={analyze:async()=>{},batch:async options=>{received=options;return {status:'INTERNAL'};},render:async()=>{}};
  const code=await runCli(['batch','--manifest','batch.json','--out','out','--crm-existing','prospects.json'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,0); assert.equal(received.crmExisting,'prospects.json'); assert.deepEqual(err,[]);
});

test('dry-run passes provider preview path but strips paid-call authority before pipeline dispatch',async()=>{
  const out=[],err=[];let received;
  const pipeline={analyze:async options=>{received=options;return {status:'DRY_RUN'};},batch:async()=>{},render:async()=>{}};
  const code=await runCli(['analyze','--input','a','--out','b','--dry-run','--paid-call','--provider-config','provider.json','--state','state.json','--batch-id','run-1'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,0);assert.equal(received.dryRun,true);assert.equal(received.live,undefined);assert.equal(received.providerPreview,'provider.json');assert.deepEqual(err,[]);
});

test('batch dry-run also receives provider preview without live authority',async()=>{
  const out=[],err=[];let received;
  const pipeline={analyze:async()=>{},batch:async options=>{received=options;return {status:'DRY_RUN'};},render:async()=>{}};
  const code=await runCli(['batch','--manifest','m.json','--out','out','--dry-run','--paid-call','--provider-config','provider.json','--state','state.json','--batch-id','run-1'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,0);assert.equal(received.dryRun,true);assert.equal(received.live,undefined);assert.equal(received.providerPreview,'provider.json');assert.deepEqual(err,[]);
});

test('pipeline errors are sanitized on stderr and return nonzero',async()=>{
  const out=[],err=[];
  const pipeline={analyze:async()=>{throw new Error('provider key sk-12345678901234567890 at /private/path');},batch:async()=>{},render:async()=>{}};
  const code=await runCli(['analyze','--input','a','--out','b'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,1); assert.deepEqual(out,[]); assert.deepEqual(JSON.parse(err[0]),{ok:false,command:'analyze',error:'operation_failed'});
});

test('exposes only allowlisted actionable pipeline error codes',async()=>{
  for(const internal of ['invalid_json','archive_manifest_invalid','archive_member_corrupt','unsupported_or_invalid_webcrawl_audit','source_fingerprint_changed','source_changed_after_batch_preflight','recorded_output_invalid','destination_exists']){
    const out=[],err=[];const pipeline={analyze:async()=>{throw new Error(internal);},batch:async()=>{},render:async()=>{}};
    const code=await runCli(['analyze','--input','a','--out','b'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
    assert.equal(code,1);assert.deepEqual(out,[]);assert.deepEqual(JSON.parse(err[0]),{ok:false,command:'analyze',error:internal});
  }
  for(const internal of ['archive_member_corrupt: /private/source.zip','source_changed_after_batch_preflight /home/private','provider key sk-12345678901234567890']){
    const out=[],err=[];const pipeline={analyze:async()=>{throw new Error(internal);},batch:async()=>{},render:async()=>{}};
    await runCli(['analyze','--input','a','--out','b'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
    assert.deepEqual(JSON.parse(err[0]),{ok:false,command:'analyze',error:'operation_failed'});
  }
});

test('parse failures are sanitized JSON and do not dispatch',async()=>{
  const out=[],err=[]; let calls=0;
  const pipeline={analyze:async()=>{calls++;},batch:async()=>{calls++;},render:async()=>{calls++;}};
  const code=await runCli(['analyze','--input','a','--input','b'],pipeline,{stdout:x=>out.push(x),stderr:x=>err.push(x)});
  assert.equal(code,2); assert.equal(calls,0); assert.deepEqual(out,[]); assert.equal(JSON.parse(err[0]).error,'duplicate_flag');
});


test('customer review is an explicit render-only file option',()=>{
 const approved=parseArgs(['render','--analysis','analysis.json','--out','fresh','--customer-review','review.json']);
 assert.equal(approved.customerReview,'review.json');
 assert.throws(()=>parseArgs(['analyze','--input','site.zip','--out','fresh','--customer-review','review.json']));
 assert.throws(()=>parseArgs(['batch','--manifest','batch.json','--out','fresh','--customer-review','review.json']));
 assert.throws(()=>parseArgs(['render','--analysis','analysis.json','--out','fresh','--customer-review','a','--customer-review','b']));
});
