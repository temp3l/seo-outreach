import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, link, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { buildCumbucoPreflight } from '../scripts/compat/cumbuco-preflight-core.mjs';
import { runCumbucoPublisher } from '../scripts/compat/cumbuco-publish.mjs';

const idA = 'CB-0123456789';
const idB = 'CB-ABCDEF0123';
const siteA = 'https://school-a.fixture.test/';
const siteB = 'https://school-b.fixture.test/';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const syntheticIssuer = { name: 'Synthetic Reviewer', email: 'reviewer@fixture.test', phone: '+15555550100' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function syntheticAudit(site) {
  const { audit } = createEvidenceFixture(1);
  const hostname = new URL(site).hostname;
  audit.target = site;
  audit.crawlSettings.policy.allowedHosts = [hostname];
  audit.coverage.urls[0].url = site;
  audit.coverage.urls[0].finalUrl = site;
  assert.equal(isAuditResultRecord(audit), true);
  return audit;
}

function addSyntheticOpportunity(audit, site) {
  audit.findings = [{ code: 'missing_meta_description', category: 'metadata', observed: 'Synthetic missing description', evidence: [{ pageUrl: site, source: 'http', observedAt: audit.startedAt }] }];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_meta_description', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  assert.equal(isAuditResultRecord(audit), true);
}

async function fixture({ businesses = [{ id: idA, site: siteA, canonical: 'school-a.fixture.test', runs: ['base'] }], summaryPatch, auditPatch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cumbuco-preflight-fixture-'));
  await mkdir(join(root, 'discovery-2'));
  await mkdir(join(root, 'scraped'));
  const discovery = [];
  const summary = [];
  for (const [businessIndex, business] of businesses.entries()) {
    const folder = join(root, 'scraped', `synthetic-${businessIndex}-${business.id}`);
    await mkdir(folder);
    discovery.push({ candidate_id: business.id, business_name: `Synthetic ${business.id}`, official_site: business.site, canonical_domain: business.canonical });
    for (const run of business.runs) {
      const dir = run === 'base' ? folder : join(folder, run);
      await mkdir(dir, { recursive: true });
      const audit = syntheticAudit(business.site);
      const patched = auditPatch?.(audit, business, run);
      await writeFile(join(dir, 'report.json'), typeof patched === 'string' ? patched : JSON.stringify(patched ?? audit));
    }
    summary.push({ id: business.id, folder, url: business.site, ...(summaryPatch?.(business) ?? {}) });
  }
  await writeFile(join(root, 'discovery-2/cumbuco-schools-expanded-21.json'), JSON.stringify(discovery));
  await writeFile(join(root, 'scraped/run-summary.json'), JSON.stringify(summary));
  return { root, discovery, summary };
}

test('shared preflight core selects one valid run and retains an alternative without changing inputs', async () => {
  const { root } = await fixture({ businesses: [{ id: idA, site: siteA, canonical: 'school-a.fixture.test', runs: ['base', 'retry'] }] });
  try {
    const folder = join(root, 'scraped/synthetic-0-' + idA);
    const before = await readdir(folder);
    const result = await buildCumbucoPreflight(root);
    assert.equal(result.businesses.length, 1);
    assert.equal(result.businesses[0].selection.run, 'base');
    assert.deepEqual(result.businesses[0].alternatives.map(x => x.run), ['retry']);
    assert.equal(result.businesses[0].recipient_review_required, true);
    assert.equal(result.businesses[0].selected_send_target, null);
    assert.deepEqual(await readdir(folder), before);
    assert.deepEqual((await readdir(root)).sort(), ['discovery-2', 'scraped']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [name, contents, expectedReason] of [
  ['corrupt', '{not-json', 'corrupt_audit'],
  ['schema-invalid JSON', JSON.stringify({ schemaVersion: 'invalid' }), 'audit_identity_or_schema_invalid'],
]) test(`shared preflight core holds corrupt or ${name} audit without selecting or merging runs`, async () => {
  const { root } = await fixture({
    businesses: [{ id: idA, site: siteA, canonical: 'school-a.fixture.test', runs: ['base', 'retry'] }],
    auditPatch: (_audit, _business, run) => run === 'retry' ? contents : undefined,
  });
  try {
    const auditPath = join(root, 'scraped/synthetic-0-' + idA + '/retry/report.json');
    const before = await readFile(auditPath);
    const result = await buildCumbucoPreflight(root);
    const row = result.businesses[0];
    assert.equal(row.report, 'HOLD');
    assert.equal(row.selection, null);
    assert.deepEqual(row.alternatives, []);
    assert.match(row.reason, new RegExp(expectedReason));
    assert.deepEqual(await readFile(auditPath), before);
    assert.deepEqual((await readdir(join(root, 'scraped/synthetic-0-' + idA))).sort(), ['report.json', 'retry']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared preflight core holds a valid-schema audit whose target domain mismatches discovery', async () => {
  const { root } = await fixture({
    auditPatch: audit => { audit.target = 'https://other.fixture.test/'; audit.coverage.urls[0].url = audit.target; audit.coverage.urls[0].finalUrl = audit.target; audit.crawlSettings.policy.allowedHosts = ['other.fixture.test']; },
  });
  try {
    const result = await buildCumbucoPreflight(root);
    assert.equal(result.businesses[0].report, 'HOLD');
    assert.equal(result.businesses[0].selection, null);
    assert.match(result.businesses[0].reason, /audit_identity_or_schema_invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared preflight core holds mismatched summary identity instead of merging it', async () => {
  const { root } = await fixture({ summaryPatch: () => ({ url: 'https://different.fixture.test/' }) });
  try {
    const result = await buildCumbucoPreflight(root);
    assert.equal(result.businesses[0].report, 'HOLD');
    assert.equal(result.businesses[0].selection, null);
    assert.match(result.businesses[0].reason, /do not match uniquely/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared preflight core holds a symlinked audit input and leaves its target unchanged', async () => {
  const { root } = await fixture();
  try {
    const auditPath = join(root, 'scraped/synthetic-0-' + idA + '/report.json');
    const target = join(root, 'protected-audit.json');
    const original = await readFile(auditPath);
    await writeFile(target, original);
    await rm(auditPath);
    await symlink(target, auditPath);
    const result = await buildCumbucoPreflight(root);
    assert.equal(result.businesses[0].report, 'HOLD');
    assert.equal(result.businesses[0].selection, null);
    assert.match(result.businesses[0].reason, /symlink_in_business_folder/u);
    assert.deepEqual(await readFile(target), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared preflight core holds duplicate advertised targets and rejects duplicate discovery IDs', async () => {
  const sameTarget = await fixture({ businesses: [
    { id: idA, site: siteA, canonical: 'school-a.fixture.test', runs: ['base'] },
    { id: idB, site: siteA, canonical: 'school-a.fixture.test', runs: ['base'] },
  ] });
  try {
    const result = await buildCumbucoPreflight(sameTarget.root);
    assert.equal(result.businesses.length, 2);
    assert.ok(result.businesses.every(row => row.report === 'HOLD' && row.selection === null));
    assert.ok(result.businesses.every(row => /multiple business IDs/u.test(row.reason)));
  } finally { await rm(sameTarget.root, { recursive: true, force: true }); }

  const duplicateId = await fixture({ businesses: [
    { id: idA, site: siteA, canonical: 'school-a.fixture.test', runs: ['base'] },
    { id: idA, site: siteB, canonical: 'school-b.fixture.test', runs: ['base'] },
  ] });
  try { await assert.rejects(buildCumbucoPreflight(duplicateId.root), /invalid_or_duplicate_business_id/u); }
  finally { await rm(duplicateId.root, { recursive: true, force: true }); }
});

test('shared preflight core rejects duplicate run-summary identities globally', async () => {
  const { root, summary } = await fixture();
  try {
    await writeFile(join(root, 'scraped/run-summary.json'), JSON.stringify([...summary, summary[0]]));
    await assert.rejects(buildCumbucoPreflight(root), /unmatched_or_duplicate_run_summary/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production preflight CLI and fixed-root publisher CLI reject synthetic roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumbuco-cli-guard-'));
  try {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/compat/cumbuco-preflight.mjs');
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected_campaign_path/u);
    const publisher=resolve(dirname(fileURLToPath(import.meta.url)),'../scripts/compat/cumbuco-publish.mjs');const rejected=spawnSync(process.execPath,[publisher,'--dry-run',root],{encoding:'utf8'});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/usage:/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared publisher workflow dry-runs, applies HOLD records, then returns a no-churn repeat no-op', async () => {
  const { root } = await fixture();
  try {
    const args = { root, source: sourceRoot, issuer: syntheticIssuer };
    const dryRun = await runCumbucoPublisher({ ...args, mode: '--dry-run' });
    assert.equal(dryRun.result, 'PLAN');
    assert.deepEqual(dryRun.changed_paths, ['scraped/qualification.current.csv', 'scraped/qualification.current.json']);
    await assert.rejects(readFile(join(root, 'scraped/qualification.current.json')), { code: 'ENOENT' });

    const applied = await runCumbucoPublisher({ ...args, mode: '--apply' });
    assert.equal(applied.result, 'PUBLISHED_HOLD');
    assert.equal(applied.files, 2);
    assert.deepEqual(applied.backups, []);
    const manifestPath = join(root, 'scraped/qualification.current.json');
    const csvPath = join(root, 'scraped/qualification.current.csv');
    const manifestBytes = await readFile(manifestPath);
    const csvBytes = await readFile(csvPath);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.publication_status, 'HOLD');
    assert.equal(manifest.businesses[0].report_disposition, 'HOLD');
    assert.equal(manifest.businesses[0].recipient_disposition, 'HOLD');
    assert.equal(manifest.businesses[0].recipient_review_required, true);
    assert.equal(manifest.businesses[0].selected_send_target, null);
    assert.equal(sha(csvBytes), manifest.files.find(file => file.path.endsWith('.csv')).sha256);
    const manifestStat = await stat(manifestPath), csvStat = await stat(csvPath);
    const filesBeforeRepeat = (await readdir(join(root, 'scraped'))).sort();

    const repeated = await runCumbucoPublisher({ ...args, mode: '--apply' });
    assert.equal(repeated.result, 'NO_OP');
    assert.deepEqual((await readdir(join(root, 'scraped'))).sort(), filesBeforeRepeat);
    assert.equal(sha(await readFile(manifestPath)), sha(manifestBytes));
    assert.equal(sha(await readFile(csvPath)), sha(csvBytes));
    assert.equal((await stat(manifestPath)).mtimeMs, manifestStat.mtimeMs);
    assert.equal((await stat(csvPath)).mtimeMs, csvStat.mtimeMs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared publisher workflow keeps corrupt run history HOLD without generating report artifacts', async () => {
  const { root } = await fixture({
    businesses: [{ id: idA, site: siteA, canonical: 'school-a.fixture.test', runs: ['base', 'retry'] }],
    auditPatch: (_audit, _business, run) => run === 'retry' ? '{broken' : undefined,
  });
  try {
    const result = await runCumbucoPublisher({ root, source: sourceRoot, mode: '--apply', issuer: syntheticIssuer });
    assert.equal(result.result, 'PUBLISHED_HOLD');
    const manifest = JSON.parse(await readFile(join(root, 'scraped/qualification.current.json')));
    const row = manifest.businesses[0];
    assert.equal(row.selected_run, null);
    assert.deepEqual(row.alternatives, []);
    assert.equal(row.report_disposition, 'HOLD');
    assert.equal(row.recipient_disposition, 'HOLD');
    assert.equal(row.selected_send_target, null);
    assert.deepEqual(row.artifact_paths, []);
    assert.deepEqual(manifest.files.map(file => file.path), ['scraped/qualification.current.csv']);
    assert.deepEqual((await readdir(join(root, 'scraped/synthetic-0-' + idA))).sort(), ['report.json', 'retry']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared publisher workflow renders and reads back synthetic HOLD PDFs and a gated draft', async () => {
  const { root } = await fixture({ auditPatch: audit => addSyntheticOpportunity(audit, siteA) });
  try {
    const result = await runCumbucoPublisher({ root, source: sourceRoot, mode: '--apply', issuer: syntheticIssuer });
    assert.equal(result.result, 'PUBLISHED_HOLD');
    const manifest = JSON.parse(await readFile(join(root, 'scraped/qualification.current.json')));
    const row = manifest.businesses[0];
    assert.equal(row.report_disposition, 'HOLD');
    assert.equal(row.recipient_disposition, 'HOLD');
    assert.equal(row.selected_send_target, null);
    assert.deepEqual(row.artifact_paths, [
      'scraped/synthetic-0-' + idA + '/report.pt-review.pdf',
      'scraped/synthetic-0-' + idA + '/report.mobile-pt-review.pdf',
      'scraped/synthetic-0-' + idA + '/report.whatsapp-pt-review.md',
    ]);
    const selectedAudit = await readFile(join(root, row.audit_path));
    assert.equal(sha(selectedAudit), row.source_sha256);
    for (const path of row.artifact_paths.filter(path => path.endsWith('.pdf'))) {
      const pdfPath = join(root, path);
      const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
      assert.doesNotMatch(text, /\bHOLD\b/u);
      assert.match(text, /REVISÃO DO SITE/u);
      assert.match(text, /reviewer@fixture\.test/u);
      assert.match(text, /\+15555550100/u);
      const urls = execFileSync('pdfinfo', ['-url', pdfPath], { encoding: 'utf8' });
      const annotations = [...urls.matchAll(/https?:\/\/[^\s)<>"']+/giu)].map(match => new URL(match[0]).href);
      for (const evidenceUrl of row.evidence_urls) assert.ok(annotations.includes(evidenceUrl), `missing URL annotation ${evidenceUrl}`);
    }
    const draft = await readFile(join(root, row.artifact_paths[2]), 'utf8');
    assert.match(draft, /recipient_review_required:\*\* true/u);
    assert.match(draft, /selected_send_target:\*\* null/u);
    for (const artifact of row.artifact_paths) assert.equal(sha(await readFile(join(root, artifact))), manifest.files.find(file => file.path === artifact).sha256);
    const csv = await readFile(join(root, 'scraped/qualification.current.csv'), 'utf8');
    assert.match(csv, new RegExp(row.source_sha256, 'u'));
    for (const path of row.artifact_paths) assert.match(csv, new RegExp(path.replaceAll('.', '\\.'), 'u'));
    const args={root,source:sourceRoot,issuer:syntheticIssuer};const filesBefore=await Promise.all(manifest.businesses[0].artifact_paths.map(async p=>({p,bytes:await readFile(join(root,p)),mtime:(await stat(join(root,p))).mtimeMs})));let renders=0;const repeat=await runCumbucoPublisher({...args,mode:'--apply',onRender:()=>renders++});assert.equal(repeat.result,'NO_OP');assert.equal(renders,1);for(const f of filesBefore){assert.deepEqual(await readFile(join(root,f.p)),f.bytes);assert.equal((await stat(join(root,f.p))).mtimeMs,f.mtime);}
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared publisher workflow refuses a colliding output and a tampered prior artifact without overwriting it', async () => {
  const collision = await fixture();
  try {
    const path = join(collision.root, 'scraped/qualification.current.csv');
    await writeFile(path, 'unowned fixture bytes');
    await assert.rejects(runCumbucoPublisher({ root: collision.root, source: sourceRoot, mode: '--apply', issuer: syntheticIssuer }), /output_already_exists/u);
    assert.equal(await readFile(path, 'utf8'), 'unowned fixture bytes');
    await assert.rejects(readFile(join(collision.root, 'scraped/qualification.current.json')), { code: 'ENOENT' });
  } finally { await rm(collision.root, { recursive: true, force: true }); }

  const symlinked = await fixture();
  try {
    const target = join(symlinked.root, 'protected-output');
    const output = join(symlinked.root, 'scraped/qualification.current.csv');
    await writeFile(target, 'protected synthetic bytes');
    await symlink(target, output);
    await assert.rejects(runCumbucoPublisher({ root: symlinked.root, source: sourceRoot, mode: '--apply', issuer: syntheticIssuer }), /output_already_exists/u);
    assert.equal(await readFile(target, 'utf8'), 'protected synthetic bytes');
    await assert.rejects(readFile(join(symlinked.root, 'scraped/qualification.current.json')), { code: 'ENOENT' });
  } finally { await rm(symlinked.root, { recursive: true, force: true }); }

  const tampered = await fixture();
  try {
    const args = { root: tampered.root, source: sourceRoot, issuer: syntheticIssuer };
    await runCumbucoPublisher({ ...args, mode: '--apply' });
    const manifestPath = join(tampered.root, 'scraped/qualification.current.json');
    const manifestBefore = await readFile(manifestPath);
    const csvPath = join(tampered.root, 'scraped/qualification.current.csv');
    await writeFile(csvPath, 'tampered fixture bytes');
    await assert.rejects(runCumbucoPublisher({ ...args, mode: '--apply' }), /existing_artifact_changed/u);
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
    assert.equal(await readFile(csvPath, 'utf8'), 'tampered fixture bytes');
  } finally { await rm(tampered.root, { recursive: true, force: true }); }
});


test('publisher retires artifacts for no-opportunity and corrupt-history HOLD, then regenerates on valid evidence',async()=>{
 const {root}=await fixture({auditPatch:audit=>addSyntheticOpportunity(audit,siteA)});try{const args={root,source:sourceRoot,issuer:syntheticIssuer,mode:'--apply'};await runCumbucoPublisher(args);const folder=join(root,'scraped/synthetic-0-'+idA),manifestPath=join(root,'scraped/qualification.current.json');let manifest=JSON.parse(await readFile(manifestPath));const paths=manifest.businesses[0].artifact_paths;const auditPath=join(root,'scraped/synthetic-0-'+idA+'/report.json');const audit=JSON.parse(await readFile(auditPath));audit.findings=[];audit.coverage.findings={records:0,checkCodes:0,affectedPages:0,evidenceOccurrences:0,byCheck:[]};await writeFile(auditPath,JSON.stringify(audit));const retired=await runCumbucoPublisher(args);assert.deepEqual(retired.retired_paths,paths);for(const p of paths)await assert.rejects(readFile(join(root,p)),{code:'ENOENT'});assert.ok(retired.backups.length>=3);manifest=JSON.parse(await readFile(manifestPath));assert.deepEqual(manifest.businesses[0].artifact_paths,[]);audit.findings=[{code:'missing_meta_description',category:'metadata',observed:'Synthetic missing description',evidence:[{pageUrl:siteA,source:'http',observedAt:audit.startedAt}]}];audit.coverage.findings={records:1,checkCodes:1,affectedPages:1,evidenceOccurrences:1,byCheck:[{code:'missing_meta_description',records:1,affectedPages:1,evidenceOccurrences:1}]};await writeFile(auditPath,JSON.stringify(audit));assert.equal((await runCumbucoPublisher(args)).result,'PUBLISHED_HOLD');manifest=JSON.parse(await readFile(manifestPath));for(const p of manifest.businesses[0].artifact_paths)assert.ok((await readFile(join(root,p))).length>0);await mkdir(join(folder,'retry'));await writeFile(join(folder,'retry/report.json'),'{corrupt');const held=await runCumbucoPublisher(args);assert.deepEqual(held.retired_paths,paths);manifest=JSON.parse(await readFile(manifestPath));assert.deepEqual(manifest.businesses[0].artifact_paths,[]);assert.match(manifest.businesses[0].reason,/corrupt_audit/u);await rm(join(folder,'retry'),{recursive:true,force:true});await runCumbucoPublisher(args);manifest=JSON.parse(await readFile(manifestPath));assert.equal(manifest.businesses[0].artifact_paths.length,3);}finally{await rm(root,{recursive:true,force:true});}
});

test('preflight rejects hardlinked selected and alternative audits and hardlinked inventory files',async()=>{
 for(const run of ['base','retry']){const {root}=await fixture({businesses:[{id:idA,site:siteA,canonical:'school-a.fixture.test',runs:['base','retry']}]});try{const folder=join(root,'scraped/synthetic-0-'+idA);const source=join(folder,run==='base'?'report.json':'retry/report.json');const protectedCopy=join(root,`protected-${run}.json`);await link(source,protectedCopy);const result=await buildCumbucoPreflight(root);assert.equal(result.businesses[0].report,'HOLD');assert.equal(result.businesses[0].selection,null);assert.match(result.businesses[0].reason,/unsafe_input_file/u);assert.ok((await readFile(protectedCopy)).length>0);}finally{await rm(root,{recursive:true,force:true});}}
 const {root}=await fixture();try{const p=join(root,'scraped/run-summary.json');await link(p,join(root,'summary-protected.json'));await assert.rejects(buildCumbucoPreflight(root),/unsafe_input_file/u);}finally{await rm(root,{recursive:true,force:true});}
});

test('preflight rejects a FIFO audit promptly without reading it or selecting evidence',async()=>{
 const {root}=await fixture();try{const path=join(root,'scraped/synthetic-0-'+idA+'/report.json');await rm(path);execFileSync('mkfifo',[path]);const script=`import {buildCumbucoPreflight} from ${JSON.stringify(new URL('../scripts/compat/cumbuco-preflight-core.mjs',import.meta.url).href)}; console.log(JSON.stringify(await buildCumbucoPreflight(process.argv[1])))`;const result=spawnSync(process.execPath,['--input-type=module','-e',script,root],{encoding:'utf8',timeout:3000});assert.equal(result.status,0,result.stderr);const preflight=JSON.parse(result.stdout);assert.equal(preflight.businesses[0].selection,null);assert.match(preflight.businesses[0].reason,/unsafe_input_file/u);}finally{await rm(root,{recursive:true,force:true});}
});

test('publisher initial publication removes new outputs after final manifest creation fails, then retries',async()=>{
 const {root}=await fixture();try{const args={root,source:sourceRoot,issuer:syntheticIssuer,mode:'--apply'};const manifestPath=join(root,'scraped/qualification.current.json');let failed=false;const {link}=await import('node:fs/promises');const filesystemOperations={link:async(a,b)=>{if(b===manifestPath&&!failed){failed=true;throw Error('injected_manifest_create_failure');}return link(a,b);}};await assert.rejects(runCumbucoPublisher({...args,filesystemOperations}),/injected_manifest_create_failure/u);const listing=await readdir(join(root,'scraped'));assert.ok(listing.includes('run-summary.json'));assert.ok(!listing.includes('qualification.current.csv')&&!listing.includes('qualification.current.json'));assert.equal(listing.some(x=>x.includes('.tmp')||x.includes('.lock')),false);assert.equal((await runCumbucoPublisher(args)).result,'PUBLISHED_HOLD');}finally{await rm(root,{recursive:true,force:true});}
});

test('publisher rolls back a failed final manifest promotion and a normal retry succeeds',async()=>{
 const {root}=await fixture();try{const args={root,source:sourceRoot,issuer:syntheticIssuer,mode:'--apply'};await runCumbucoPublisher(args);const manifestPath=join(root,'scraped/qualification.current.json'),csvPath=join(root,'scraped/qualification.current.csv');const before=await readFile(manifestPath);let failed=false;const {rename}=await import('node:fs/promises');const filesystemOperations={rename:async(a,b)=>{if(b===manifestPath&&!failed){failed=true;throw Error('injected_final_manifest_failure');}return rename(a,b);}};await writeFile(join(root,'discovery-2/cumbuco-schools-expanded-21.json'),JSON.stringify([{...((await readFile(join(root,'discovery-2/cumbuco-schools-expanded-21.json')).then(JSON.parse))[0]),business_name:'Changed synthetic name'}]));await assert.rejects(runCumbucoPublisher({...args,filesystemOperations}),/injected_final_manifest_failure/u);assert.deepEqual(await readFile(manifestPath),before);assert.equal(JSON.parse(await readFile(manifestPath)).files.find(x=>x.path.endsWith('.csv')).sha256,sha(await readFile(csvPath)));assert.equal((await readdir(join(root,'scraped'))).some(x=>x.includes('.tmp')||x.includes('.lock')),false);const retry=await runCumbucoPublisher(args);assert.equal(retry.result,'PUBLISHED_HOLD');assert.equal((await runCumbucoPublisher(args)).result,'NO_OP');}finally{await rm(root,{recursive:true,force:true});}
});

for(const failedOutput of ['qualification.current.csv','qualification.current.json'])test(`publisher rolls back a one-shot staging cleanup failure for ${failedOutput} and retries without churn`,async()=>{
 const {root}=await fixture();
 try {
  const args={root,source:sourceRoot,issuer:syntheticIssuer,mode:'--apply'};
  let stage,failed=false;
  const filesystemOperations={
   link:async(a,b)=>{await link(a,b);if(b===join(root,'scraped',failedOutput))stage=a;},
   unlink:async path=>{if(path===stage&&!failed){failed=true;throw Error('injected_stage_unlink_failure');}return unlink(path);}
  };
  await assert.rejects(runCumbucoPublisher({...args,filesystemOperations}),/injected_stage_unlink_failure/u);
  assert.equal(failed,true);
  assert.deepEqual((await readdir(join(root,'scraped'))).sort(),['run-summary.json','synthetic-0-'+idA]);
  assert.equal((await runCumbucoPublisher(args)).result,'PUBLISHED_HOLD');
  const paths=['qualification.current.csv','qualification.current.json'];
  const before=await Promise.all(paths.map(async p=>({p,bytes:await readFile(join(root,'scraped',p)),mtime:(await stat(join(root,'scraped',p))).mtimeMs})));
  const listing=(await readdir(join(root,'scraped'))).sort();
  assert.equal((await runCumbucoPublisher(args)).result,'NO_OP');
  assert.deepEqual((await readdir(join(root,'scraped'))).sort(),listing);
  for(const file of before){assert.deepEqual(await readFile(join(root,'scraped',file.p)),file.bytes);assert.equal((await stat(join(root,'scraped',file.p))).mtimeMs,file.mtime);}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('publisher rejects malformed or cross-business prior ownership before any mutation',async()=>{
 const {root}=await fixture();
 try {
  const args={root,source:sourceRoot,issuer:syntheticIssuer,mode:'--apply'};
  await runCumbucoPublisher(args);
  const manifestPath=join(root,'scraped/qualification.current.json');
  const original=JSON.parse(await readFile(manifestPath));
  const artifact='scraped/synthetic-0-'+idA+'/report.pt-review.pdf';
  await writeFile(join(root,artifact),'protected synthetic report');
  const row={...original.businesses[0],artifact_paths:[artifact]};
  const cases=[
   [{...row,id:''}],
   [{...row,id:'3456789'}],
   [{...row,id:undefined}],
   [{...row,id:idB}],
   [row,{...row,artifact_paths:[]}],
  ];
  const csvBefore=await readFile(join(root,'scraped/qualification.current.csv'));
  for(const businesses of cases){
   const manifest={...original,businesses,files:[...original.files,{path:artifact,sha256:sha('protected synthetic report')}]};
   const bytes=JSON.stringify(manifest);
   await writeFile(manifestPath,bytes);
   const listing=(await readdir(join(root,'scraped'))).sort();
   const filesystemOperations={link:()=>assert.fail('unexpected link'),rename:()=>assert.fail('unexpected rename'),unlink:()=>assert.fail('unexpected unlink')};
   await assert.rejects(runCumbucoPublisher({...args,filesystemOperations}),/existing_manifest_invalid/u);
   assert.equal(await readFile(manifestPath,'utf8'),bytes);
   assert.equal(await readFile(join(root,artifact),'utf8'),'protected synthetic report');
   assert.deepEqual(await readFile(join(root,'scraped/qualification.current.csv')),csvBefore);
   assert.deepEqual((await readdir(join(root,'scraped'))).sort(),listing);
   assert.deepEqual((await readdir(join(root,'scraped/synthetic-0-'+idA))).sort(),['report.json','report.pt-review.pdf']);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
