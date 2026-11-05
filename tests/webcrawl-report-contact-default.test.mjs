import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReportContact } from '../dist/reports/report-contact.js';

test('PDF publisher defaults, explicit overrides and missing-contact failures', async () => {
  const dir=await mkdtemp(join(tmpdir(),'publisher-contact-'));
  const defaultPath=join(dir,'default.json'), explicit=join(dir,'explicit.json');
  const contact={name:'Example Publisher',email:'publisher@example.test',phone:'+49 30 12345678'};
  try {
    await assert.rejects(resolveReportContact(undefined,defaultPath),/pdf_report_contact_required/);
    await writeFile(defaultPath,JSON.stringify(contact),{mode:0o600});
    assert.deepEqual(await resolveReportContact(undefined,defaultPath),contact);
    const override={name:'Other Publisher',email:'other@example.test'};
    await writeFile(explicit,JSON.stringify(override),{mode:0o600});
    assert.deepEqual(await resolveReportContact(explicit,defaultPath),override);
    await assert.rejects(resolveReportContact(join(dir,'missing.json'),defaultPath),{code:'ENOENT'});
    await writeFile(defaultPath,JSON.stringify({name:'Example Publisher',website:'https://example.test'}));
    await assert.rejects(resolveReportContact(undefined,defaultPath),/reply_channel_required/);
    await writeFile(defaultPath,'{}');
    await assert.rejects(resolveReportContact(undefined,defaultPath),/identity_required/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
