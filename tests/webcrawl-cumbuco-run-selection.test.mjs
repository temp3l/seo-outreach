import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreRun,compareRuns,sameBusinessTarget,businessTargetKey} from '../scripts/compat/cumbuco-run-selection.mjs';
const run=(name,patch={})=>({run:name,score:scoreRun({seedUsable:true,relevantFindings:1,unattempted:0,technicalSeo:'complete',relevantPages:3,failed:0,pageSpeed:'complete',startedAt:'2026-01-01T00:00:00Z',...patch})});
test('identity joins require the advertised target, matching canonical host and same-host final URL',()=>{
 const site='https://www.fixture.example/course';assert.equal(sameBusinessTarget(site,'fixture.example',site,site,'https://fixture.example/course/'),true);assert.equal(sameBusinessTarget(site,'other.example',site,site,site),false);assert.equal(sameBusinessTarget(site,'fixture.example',site,'https://fixture.example/other',site),false);assert.equal(sameBusinessTarget(site,'fixture.example',site,site,'https://other.example/'),false);assert.equal(sameBusinessTarget(site,'fixture.example',site,site,'https://fixture.example/other'),false);
});
test('duplicate target identities normalize www and trailing slash without merging distinct paths',()=>{
 assert.equal(businessTargetKey('https://www.fixture.example/course/'),businessTargetKey('http://fixture.example/course'));assert.notEqual(businessTargetKey('https://fixture.example/course'),businessTargetKey('https://fixture.example/other'));assert.equal(businessTargetKey('file:///tmp/data'),null);
});
test('useful complete base beats more pages from a partial expansion',()=>{
 const base=run('base');const expanded=run('expanded',{technicalSeo:'partial',relevantPages:100,startedAt:'2026-02-01T00:00:00Z'});for(const rows of [[expanded,base],[base,expanded]])assert.equal([...rows].sort(compareRuns)[0].run,'base');
});
test('complete coverage can improve a limited base even when optional images failed',()=>{
 const base=run('base',{unattempted:8});const expanded=run('expanded',{images:'failed',relevantPages:5});assert.equal([base,expanded].sort(compareRuns)[0].run,'expanded');
});
test('recency breaks equivalent ties and sorting is stable across input order',()=>{
 const a=run('base');const b=run('retry',{startedAt:'2026-02-01T00:00:00Z'});assert.equal([a,b].sort(compareRuns)[0].run,'retry');assert.equal([b,a].sort(compareRuns)[0].run,'retry');
});
