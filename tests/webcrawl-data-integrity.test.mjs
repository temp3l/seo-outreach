import {CUSTOMER_REPORT_FRESHNESS_MS} from '../dist/reports/freshness.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createEvidenceFixture} from './fixtures/evidence-pack-fixture.mjs';
import {createEvidencePack} from '@spora/webcrawl/reports/evidence-pack';
import {auditResultSha256} from '../dist/reports/qualification.js';
import {TECHNOLOGY_PROFILE} from '@spora/webcrawl/enrichments/technology';
import {reviewRow,HANDOFF_SCHEMA} from '../scripts/compat/no-send-handoff-core.mjs';
import {checkEntry,digest} from '../scripts/compat/data-integrity-core.mjs';
async function fixture(){
 const root=await mkdtemp('/tmp/webcrawl-integrity-test-');const {audit:a,pageData}=createEvidenceFixture(1);a.target=a.coverage.urls[0].url;a.crawlSettings.technologyProfile=TECHNOLOGY_PROFILE;
 a.findings=[{code:'missing_meta_description',category:'metadata',observed:'Synthetic missing description',evidence:[{pageUrl:a.coverage.urls[0].url,source:'http',observedAt:a.completedAt}]}];
 a.coverage.findings={records:1,checkCodes:1,affectedPages:1,evidenceOccurrences:1,byCheck:[{code:'missing_meta_description',records:1,affectedPages:1,evidenceOccurrences:1}]};
 const now=Date.parse(a.completedAt)+60000;
 const q={decision:'RELEASE',target:a.target,auditSha256:auditResultSha256(a),qualifiedAt:new Date(now-30000).toISOString(),qualifiedBy:'Synthetic integrity test only',businessIdentity:'VERIFIED',coverage:'ACCEPTED',security:'CLEARED'};
 const entry={id:'synthetic',audit:`${root}/audit.json`,qualification:`${root}/qualification.json`,evidencePack:`${root}/pack.zip`,release:`${root}/report.release.json`,handoff:`${root}/handoff.json`};
 const put=async(p,v)=>writeFile(p,JSON.stringify(v),{mode:0o600});await put(entry.audit,a);await put(entry.qualification,q);
 await writeFile(entry.evidencePack,createEvidencePack(a,{...pageData,target:a.target,auditStartedAt:a.startedAt,auditCompletedAt:a.completedAt,auditSha256:auditResultSha256(a)}));
 const artifacts=[];for(const suffix of ['en.pdf','de.pdf','mobile-en.pdf','whatsapp-draft.md']){const path=`${root}/report.${suffix}`,bytes=Buffer.from(suffix.endsWith('.pdf')?'%PDF- synthetic hash-chain fixture':'Synthetic draft');await writeFile(path,bytes,{mode:0o600});artifacts.push({path,sha256:digest(bytes)});}
 const manifest={schema:'webcrawl-customer-release-v1',target:a.target,auditSha256:auditResultSha256(a),qualificationSha256:digest(await readFile(entry.qualification)),reviewer:q.qualifiedBy,qualifiedAt:q.qualifiedAt,reportStatus:'CLIENT_READY',outboundApproval:false,mobileLocale:'en',artifacts};await put(entry.release,manifest);await put(entry.handoff,{schema:HANDOFF_SCHEMA,rows:[reviewRow(a)]});
 return {root,a,q,now,entry,manifest,put};
}
const withFixture=fn=>async()=>{const f=await fixture();try{await fn(f);}finally{await rm(f.root,{recursive:true,force:true});}};
test('complete synthetic hash chain passes at its explicit observation clock; stale qualification holds',withFixture(async f=>{
 const before=await readFile(f.entry.audit);const result=await checkEntry(f.entry,f.now);assert.equal(result.decision,'PASS',JSON.stringify(result.checks));assert.deepEqual(await readFile(f.entry.audit),before);assert.equal(result.release.status,'CURRENT_QUALIFICATION_VERIFIED');
 const stale=await checkEntry(f.entry,f.now+CUSTOMER_REPORT_FRESHNESS_MS + 1);assert.equal(stale.decision,'HOLD');assert.equal(stale.release.status,'ARCHIVED_OR_UNQUALIFIED');
}));
test('missing provenance and approval remain HOLD; no retrospective profile is minted',withFixture(async f=>{
 delete f.a.crawlSettings.technologyProfile;await f.put(f.entry.audit,f.a);
 const result=await checkEntry({id:'legacy',audit:f.entry.audit},f.now);assert.equal(result.decision,'HOLD');assert.equal(result.detectorProfile,null);assert.equal(result.release,null);
}));
test('misbound qualification, forged approval fields, corrupt artifacts and injected manifest paths fail',withFixture(async f=>{
 await f.put(f.entry.qualification,{...f.q,auditSha256:'0'.repeat(64)});assert.equal((await checkEntry(f.entry,f.now)).decision,'ERROR');
 await f.put(f.entry.qualification,{...f.q,recipientVerified:true});assert.equal((await checkEntry(f.entry,f.now)).decision,'ERROR');await f.put(f.entry.qualification,f.q);
 await writeFile(f.manifest.artifacts[0].path,'%PDF- modified');assert.equal((await checkEntry(f.entry,f.now)).decision,'ERROR');
 f.manifest.artifacts[0].path='/outside/must-not-read.pdf';await f.put(f.entry.release,f.manifest);const result=await checkEntry(f.entry,f.now);assert.ok(result.checks.some(c=>c.code==='release_artifact_path_invalid'));assert.ok(!result.files.some(f=>f.path==='/outside/must-not-read.pdf'));
}));
test('handoff claim changes, duplicate rows and forged promotions cannot pass',withFixture(async f=>{
 const row=reviewRow(f.a);
 for(const changed of [{...row,sendEligible:true},{...row,selectedEvidence:[]},{...row,reportSha256:'0'.repeat(64)}]){await f.put(f.entry.handoff,{schema:HANDOFF_SCHEMA,rows:[changed]});assert.equal((await checkEntry(f.entry,f.now)).decision,'ERROR');}
 await f.put(f.entry.handoff,{schema:HANDOFF_SCHEMA,rows:[row,row]});assert.equal((await checkEntry(f.entry,f.now)).decision,'ERROR');
}));
test('query redaction does not merge target identities; shared business grouping remains stable',()=>{
 const {audit:a}=createEvidenceFixture(1);const b=structuredClone(a);a.target='https://fixture.example/?campaign=one';b.target='https://fixture.example/?campaign=two';const x=reviewRow(a),y=reviewRow(b);assert.equal(x.canonicalUrl,y.canonicalUrl);assert.equal(x.candidateId,y.candidateId);assert.notEqual(x.targetIdentitySha256,y.targetIdentitySha256);assert.notEqual(x.id,y.id);
});
test('checker rejects symlinks and malformed inputs without leaking private input text',withFixture(async f=>{
 const path=`${f.root}/link.json`;await symlink(f.entry.audit,path);assert.equal((await checkEntry({id:'link',audit:path},f.now)).decision,'ERROR');
 await writeFile(f.entry.audit,'PRIVATE_SENTINEL');const r=await checkEntry(f.entry,f.now);assert.equal(r.decision,'ERROR');assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
}));
test('CLI is deterministic apart from checkedAt, rejects duplicate IDs and returns no-write HOLD',withFixture(async f=>{
 const path=`${f.root}/input.json`;await f.put(path,{schema:'webcrawl-integrity-input-v1',entries:[{id:'one',audit:f.entry.audit}]});
 const run=()=>JSON.parse(execFileSync(process.execPath,['scripts/compat/check-data-integrity.mjs','--input',path],{encoding:'utf8'}));const a=run(),b=run();delete a.checkedAt;delete b.checkedAt;assert.deepEqual(a,b);assert.equal(a.summary.HOLD,1);
 await f.put(path,{schema:'webcrawl-integrity-input-v1',entries:[{id:'one',audit:f.entry.audit},{id:'one',audit:f.entry.audit}]});assert.throws(run);
}));

test('a structurally valid pack bound to another audit fails; missing release and invalid profile fail',withFixture(async f=>{
 const {audit:b,pageData}=createEvidenceFixture(1);b.target='https://fixture.example/another';
 await writeFile(f.entry.evidencePack,createEvidencePack(b,{...pageData,target:b.target,auditStartedAt:b.startedAt,auditCompletedAt:b.completedAt,auditSha256:auditResultSha256(b)}));
 const result=await checkEntry(f.entry,f.now);assert.ok(result.checks.some(c=>c.code==='evidence_pack_audit_mismatch'));
 const missing=await checkEntry({id:'missing',audit:f.entry.audit,release:`${f.root}/missing.release.json`},f.now);assert.equal(missing.decision,'ERROR');
 f.a.crawlSettings.technologyProfile={forged:'seed-cms-v3'};await f.put(f.entry.audit,f.a);assert.ok((await checkEntry({id:'profile',audit:f.entry.audit},f.now)).checks.some(c=>c.code==='audit_schema_invalid'));
}));

test('profile provenance survives evidence-pack projection',withFixture(async f=>{
 const {verifyEvidencePack}=await import('@spora/webcrawl/reports/evidence-pack');const pack=verifyEvidencePack(await readFile(f.entry.evidencePack));
 assert.equal(pack.manifest.crawlSettings.technologyProfile,TECHNOLOGY_PROFILE);
 assert.equal(JSON.parse(pack.members.find(m=>m.name==='audit.json').content).crawlSettings.technologyProfile,TECHNOLOGY_PROFILE);
}));
test('a forged original digest cannot hide inconsistent embedded audit claims',withFixture(async f=>{
 const {verifyEvidencePack}=await import('@spora/webcrawl/reports/evidence-pack');const {packMembers}=await import('./fixtures/integrity-zip.mjs');
 const b=structuredClone(f.a);b.findings[0].observed='A different captured claim';const {pageData}=createEvidenceFixture(1);
 const pack=verifyEvidencePack(createEvidencePack(b,{...pageData,target:b.target,auditStartedAt:b.startedAt,auditCompletedAt:b.completedAt,auditSha256:auditResultSha256(b)}));
 const entries=pack.members.map(m=>({name:m.name,bytes:Buffer.from(m.content)}));const manifest=entries.find(m=>m.name==='manifest.json');const value=JSON.parse(manifest.bytes);value.originalAuditSha256=auditResultSha256(f.a);manifest.bytes=Buffer.from(JSON.stringify(value));
 const forged=packMembers(entries);verifyEvidencePack(forged);await writeFile(f.entry.evidencePack,forged);
 assert.equal((await checkEntry(f.entry,f.now)).decision,'ERROR');
}));
test('supplied malformed optional inputs are errors, not omitted HOLD links',withFixture(async f=>{
 for(const key of ['qualification','release','evidencePack','handoff','reports'])for(const value of [null,false,'']){
  const result=await checkEntry({id:'bad',audit:f.entry.audit,[key]:value},f.now);assert.equal(result.decision,'ERROR',key+':'+String(value));
 }
}));
