import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, chmod, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { auditResultSha256 } from '../dist/reports/qualification.js';
import { createPageDataExport } from '@spora/webcrawl/analysis/page-data';
import { createCustomerReviewManifest } from '../dist/reports/review.js';
import { customerPageLabel } from '../dist/reports/customer.js';

const exec = promisify(execFile);
const script = new URL('../scripts/compat/release-customer-reports.mjs', import.meta.url).pathname;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = (files, out) => ['--audit', files.audit, '--qualification', files.qualification, '--review-manifest', files.review, '--out', out];

async function setup(root) {
  const { audit } = createEvidenceFixture(3);
  audit.target = audit.coverage.urls[0].url;
  audit.startedAt = new Date(Date.now() - 120_000).toISOString();
  audit.completedAt = new Date(Date.now() - 90_000).toISOString();
  audit.findings = [{ code: 'missing_meta_description', category: 'metadata', observed: 'Synthetic missing description', severity: 'medium', evidence: [{ pageUrl: audit.coverage.urls[0].url, source: 'http', observedAt: audit.completedAt }]}];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_meta_description', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  const files = { audit: join(root, 'audit.json'), qualification: join(root, 'qualification.json'), review: join(root, 'review.json') };
  const a4 = join(root, 'a4.pdf'), mobile = join(root, 'mobile.pdf');
  const pdf1 = Buffer.from('%PDF-1.4\nsynthetic A4 bytes\n'); const pdf2 = Buffer.from('%PDF-1.4\nsynthetic mobile bytes\n');
  await writeFile(files.audit, JSON.stringify(audit), { mode: 0o600 });
  const review = {...createCustomerReviewManifest(audit,'en',[{role:'a4',path:a4,content:pdf1},{role:'mobile',path:mobile,content:pdf2}]),sourceAuditFileSha256:digest(Buffer.from(JSON.stringify(audit)))};
  const reviewBytes = Buffer.from(`${JSON.stringify(review)}\n`);
  await writeFile(files.review, reviewBytes, { mode: 0o600 });
  const qualification = { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED', reviewedManifestSha256: digest(reviewBytes) };
  await writeFile(files.qualification, JSON.stringify(qualification), { mode: 0o600 });
  await writeFile(a4, pdf1, { mode: 0o600 }); await writeFile(mobile, pdf2, { mode: 0o600 });
  const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
  const extracted = `Synthetic report fixture.example 1 check observation Key observations ${review.selectedTopics.map(t=>[t.pageLabel,t.title,t.urls?.[0] ? `Example page: ${customerPageLabel(t.urls[0].url,'en')}` : '',t.observed,t.explanation,t.nextStep].filter(Boolean).join(' ')).join(' ')} Let’s get in touch`;
  await writeFile(join(bin, 'pdftotext'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(extracted)});\n`, { mode: 0o700 });
  const escapeXml = v => String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('\"','&quot;');
  const xml = `<pdf2xml><page><text>Key observations</text>${review.selectedTopics.map(t=>`<text>${escapeXml(t.title)}</text>${t.urls?.[0] && !t.urls[0].redacted ? `<text>Example page: <a href=\"${escapeXml(t.urls[0].url)}\">${escapeXml(customerPageLabel(t.urls[0].url,'en'))}</a></text>` : ''}`).join('')}<text>Let’s get in touch</text></page></pdf2xml>`;
  await writeFile(join(bin, 'pdftohtml'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(xml)});\n`, { mode: 0o700 });
  await writeFile(join(bin, 'pdfinfo'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(['https://fixture.example/',...review.selectedTopics.flatMap(t=>t.urls?.[0]&&!t.urls[0].redacted?[t.urls[0].url]:[])].join('\n'))});\n`, { mode: 0o700 });
  return { files, review, a4, mobile, bin, audit };
}

test('direct release script rejects the unreviewed branch before rendering', async () => {
  const root=await mkdtemp('/tmp/webcrawl-unreviewed-release-');await chmod(root,0o700);
  try { const data=await setup(root);await assert.rejects(exec(process.execPath,[script,'--audit',data.files.audit,'--qualification',data.files.qualification,'--report-contact-file',join(root,'missing'),'--out',join(root,'out')]),e=>/reviewed_manifest_required/u.test(e.stderr));await assert.rejects(readFile(join(root,'out.release.json')),{code:'ENOENT'}); }
  finally { await rm(root,{recursive:true,force:true}); }
});

function qualification(audit, reviewBytes, changes = {}) {
  return { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED', reviewedManifestSha256: digest(reviewBytes), ...changes };
}

test('promotes exact reviewed PDF bytes and replays deterministically without rendering', async () => {
  const root = await mkdtemp('/tmp/webcrawl-reviewed-pdf-'); await chmod(root, 0o700);
  try {
    const data = await setup(root); const out = join(root, 'release');
    const env = { ...process.env, PATH: `${data.bin}:${process.env.PATH}` };
    await exec(process.execPath, [script, ...options(data.files, out)], { env });
    const first = await readFile(`${out}.release.json`); const manifest = JSON.parse(first);
    assert.equal(manifest.reportStatus, 'CLIENT_READY'); assert.equal(manifest.outboundApproval, false);
    assert.equal(manifest.reviewedManifestSha256, digest(await readFile(data.files.review)));
    assert.deepEqual(manifest.artifacts.map(item => item.role), ['a4', 'mobile']);
    assert.equal(digest(await readFile(data.a4)), data.review.artifacts[0].sha256);
    assert.equal(digest(await readFile(data.mobile)), data.review.artifacts[1].sha256);
    await exec(process.execPath, [script, ...options(data.files, out)], { env });
    assert.deepEqual(await readFile(`${out}.release.json`), first);
    await writeFile(`${out}.release.json`, '{"preserve":"collision"}\n', { mode: 0o600 });
    await assert.rejects(exec(process.execPath, [script, ...options(data.files, out)], { env }), error => /output_collision/u.test(error.stderr));
    assert.equal(await readFile(`${out}.release.json`, 'utf8'), '{"preserve":"collision"}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fails closed for mismatched review hash, changed PDF, missing or unsafe qualification, and unsafe PDF mode', async () => {
  for (const mode of ['wrong-hash', 'changed-pdf', 'missing-qualification', 'unsafe-mode', 'audit-mismatch', 'security-failed', 'audit-file-digest', 'triage-tamper', 'selected-topic-tamper']) {
    const root = await mkdtemp('/tmp/webcrawl-reviewed-pdf-negative-'); await chmod(root, 0o700);
    try {
      const data = await setup(root);
      if (mode === 'wrong-hash') {
        const q = JSON.parse(await readFile(data.files.qualification)); q.reviewedManifestSha256 = '0'.repeat(64);
        await writeFile(data.files.qualification, JSON.stringify(q), { mode: 0o600 });
      }
      if (mode === 'audit-mismatch' || mode === 'security-failed') {
        const reviewBytes = await readFile(data.files.review);
        const q = qualification(data.audit, reviewBytes, mode === 'audit-mismatch' ? { auditSha256: '0'.repeat(64) } : { security: 'NOT_CLEARED' });
        await writeFile(data.files.qualification, JSON.stringify(q), { mode: 0o600 });
      }
      if (mode === 'changed-pdf') await writeFile(data.a4, '%PDF-1.4 changed\n', { mode: 0o600 });
      if (mode === 'audit-file-digest') {const review={...data.review,sourceAuditFileSha256:'0'.repeat(64)};const bytes=Buffer.from(JSON.stringify(review));await writeFile(data.files.review,bytes,{mode:0o600});await writeFile(data.files.qualification,JSON.stringify(qualification(data.audit,bytes)),{mode:0o600});}
      if (mode === 'triage-tamper') {const review={...data.review,evidenceTriage:[{findingIndex:0,evidenceClassification:'eligible',inCount:true}]};const bytes=Buffer.from(JSON.stringify(review));await writeFile(data.files.review,bytes,{mode:0o600});await writeFile(data.files.qualification,JSON.stringify(qualification(data.audit,bytes)),{mode:0o600});}
      if (mode === 'selected-topic-tamper') {const review={...data.review,selectedTopics:[{...data.review.selectedTopics[0],findingCodes:[]}]};const bytes=Buffer.from(JSON.stringify(review));await writeFile(data.files.review,bytes,{mode:0o600});await writeFile(data.files.qualification,JSON.stringify(qualification(data.audit,bytes)),{mode:0o600});}
      if (mode === 'missing-qualification') await rm(data.files.qualification);
      if (mode === 'unsafe-mode') await chmod(data.mobile, 0o644);
      await assert.rejects(exec(process.execPath, [script, ...options(data.files, join(root, 'release'))], { env: { ...process.env, PATH: `${data.bin}:${process.env.PATH}` } }));
      await assert.rejects(readFile(join(root, 'release.release.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('real Chromium review PDFs promote byte-for-byte without launching a renderer during finalization', async () => {
  const root = await mkdtemp('/tmp/webcrawl-reviewed-pdf-chromium-'); await chmod(root, 0o700);
  try {
    const data = await setup(root);
    const issuer = join(root, 'issuer.json');
    await writeFile(issuer, JSON.stringify({ name: 'Synthetic Issuer', email: 'issuer@example.test' }), { mode: 0o600 });
    const prefix = join(root, 'prepared');
    const prepareScript = new URL('../scripts/compat/prepare-customer-review.mjs', import.meta.url).pathname;
    await exec(process.execPath, [prepareScript, '--audit', data.files.audit, '--report-contact-file', issuer, '--out', prefix, '--pdf-locale', 'en']);
    const reviewPath = `${prefix}.review.json`;
    const reviewBytes = await readFile(reviewPath); const review = JSON.parse(reviewBytes);
    const before = await Promise.all(review.artifacts.map(item => readFile(item.path)));
    const qPath = join(root, 'qualification.json');
    await writeFile(qPath, JSON.stringify(qualification(data.audit, reviewBytes)), { mode: 0o600 });
    const files = { audit: data.files.audit, qualification: qPath, review: reviewPath };
    const out = join(root, 'released');
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(root, 'missing-browser'), PATH: process.env.PATH };
    await exec(process.execPath, [script, ...options(files, out)], { env, timeout: 60_000 });
    const released = JSON.parse(await readFile(`${out}.release.json`));
    assert.equal(released.reportStatus, 'CLIENT_READY'); assert.equal(released.outboundApproval, false);
    for (const [index, artifact] of released.artifacts.entries()) {
      const bytes = await readFile(artifact.path);
      assert.deepEqual(bytes, before[index]);
      assert.equal(digest(bytes), review.artifacts[index].sha256);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reviewed release binds page evidence and rejects changed evidence', async () => {
  const root=await mkdtemp('/tmp/webcrawl-reviewed-evidence-');await chmod(root,0o700);
  try {
    const data=await setup(root), audit=data.audit;
    audit.findings=[{code:'image_alt_missing_or_empty',category:'accessibility',observed:'Image inventory',evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.completedAt,value:1}]}];
    audit.coverage.findings={records:1,checkCodes:1,affectedPages:1,evidenceOccurrences:1,byCheck:[{code:'image_alt_missing_or_empty',records:1,affectedPages:1,evidenceOccurrences:1}]};
    await writeFile(data.files.audit,JSON.stringify(audit),{mode:0o600});
    const pages=audit.coverage.urls.map(row=>({requestedUrl:row.url,finalUrl:row.finalUrl,statusCode:200,contentType:'text/html',fetchedAt:audit.startedAt,responseBytes:50,html:'<main><a href="/next"><img src="/x.png" alt=""></a></main>'}));
    const pd={...createPageDataExport(pages),target:audit.target,auditStartedAt:audit.startedAt,auditCompletedAt:audit.completedAt,auditSha256:auditResultSha256(audit)};
    const pagePath=join(root,'page-data.json');await writeFile(pagePath,JSON.stringify(pd),{mode:0o600});
    const issuer=join(root,'issuer.json');await writeFile(issuer,JSON.stringify({name:'Synthetic Issuer',email:'issuer@example.test'}),{mode:0o600});
    const prefix=join(root,'prepared'), prepare=new URL('../scripts/compat/prepare-customer-review.mjs',import.meta.url).pathname;
    await exec(process.execPath,[prepare,'--audit',data.files.audit,'--page-data',pagePath,'--report-contact-file',issuer,'--out',prefix,'--pdf-locale','en']);
    const reviewPath=prefix+'.review.json', reviewBytes=await readFile(reviewPath),review=JSON.parse(reviewBytes);
    assert.equal(review.customerObservationCount,1);assert.equal(review.pageEvidencePath,pagePath);
    await writeFile(data.files.qualification,JSON.stringify(qualification(audit,reviewBytes)),{mode:0o600});
    await exec(process.execPath,[script,...options({audit:data.files.audit,qualification:data.files.qualification,review:reviewPath},join(root,'approved'))]);
    await writeFile(pagePath,JSON.stringify({...pd,generatedAt:'2001-01-01T00:00:00.000Z'}),{mode:0o600});
    await assert.rejects(exec(process.execPath,[script,...options({audit:data.files.audit,qualification:data.files.qualification,review:reviewPath},join(root,'tampered'))]),e=>/review_manifest_mismatch/u.test(e.stderr));
    await assert.rejects(readFile(join(root,'tampered.release.json')),{code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('release rejects missing card fields and an incidental count after the summary', async () => {
 for (const field of ['title','pageLabel','explanation','nextStep','observed','badge']) {
  const root=await mkdtemp('/tmp/webcrawl-card-content-'); await chmod(root,0o700);
  try {
   const data=await setup(root), t=data.review.selectedTopics[0];
   const fields=[t.pageLabel,t.title,t.urls?.[0] ? `Example page: ${customerPageLabel(t.urls[0].url,'en')}` : '',t.observed,t.explanation,t.nextStep].filter(Boolean);
   if(field==='observed' && !t.observed) continue;
   const text=`Synthetic fixture.example ${field==='badge'?'0 check observations':'1 check observation'} Key observations ${fields.filter(x=>x!==t[field]).join(' ')} ${field==='badge'?'1 check observation':''} Let’s get in touch`;
   await writeFile(join(data.bin,'pdftotext'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(text)});\n`,{mode:0o700});
   await assert.rejects(exec(process.execPath,[script,...options(data.files,join(root,'out'))],{env:{...process.env,PATH:`${data.bin}:${process.env.PATH}`}}),e=>/review_pdf_content_invalid/u.test(e.stderr),field);
  } finally { await rm(root,{recursive:true,force:true}); }
 }
});

test('a repeated label inside the previous card cannot replace the next card label',async()=>{
 const root=await mkdtemp('/tmp/webcrawl-card-label-');await chmod(root,0o700);
 try{
  const data=await setup(root),audit=data.audit;
  audit.findings.push({code:'missing_canonical',category:'metadata',observed:'Synthetic',severity:'medium',evidence:[{pageUrl:audit.target,source:'http',observedAt:audit.completedAt}]});
  audit.coverage.findings={records:2,checkCodes:2,affectedPages:1,evidenceOccurrences:2,byCheck:['missing_canonical','missing_meta_description'].map(code=>({code,records:1,affectedPages:1,evidenceOccurrences:1}))};
  const auditBytes=Buffer.from(JSON.stringify(audit));await writeFile(data.files.audit,auditBytes,{mode:0o600});
  const review={...createCustomerReviewManifest(audit,'en',[{role:'a4',path:data.a4,content:await readFile(data.a4)},{role:'mobile',path:data.mobile,content:await readFile(data.mobile)}]),sourceAuditFileSha256:digest(auditBytes)};assert.equal(review.selectedTopics.length,2);
  const reviewBytes=Buffer.from(JSON.stringify(review));await writeFile(data.files.review,reviewBytes,{mode:0o600});await writeFile(data.files.qualification,JSON.stringify(qualification(audit,reviewBytes)),{mode:0o600});
  const [a,b]=review.selectedTopics,parts=t=>[t.title,t.urls?.[0]?`Example page: ${customerPageLabel(t.urls[0].url,'en')}`:'',t.observed,t.explanation,t.nextStep].filter(Boolean).join(' ');
  const text=`Synthetic fixture.example ${review.customerObservationCount} check observations Key observations ${a.pageLabel} ${parts(a)} ${b.pageLabel} unrelated trailing words ${parts(b)} Let’s get in touch`;
  await writeFile(join(data.bin,'pdftotext'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(text)});\n`,{mode:0o700});
  await assert.rejects(exec(process.execPath,[script,...options(data.files,join(root,'out'))],{env:{...process.env,PATH:`${data.bin}:${process.env.PATH}`}}),e=>/review_pdf_content_invalid/u.test(e.stderr));
 }finally{await rm(root,{recursive:true,force:true});}
});
