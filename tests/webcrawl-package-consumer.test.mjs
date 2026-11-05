import test from 'node:test';import assert from 'node:assert/strict';
import * as crawl from '@spora/webcrawl';import * as reports from '../dist/reports/index.js';import * as evidence from '@spora/webcrawl/evidence';
test('crawler exports evidence while SEO outreach owns presentation exports',()=>{
 for(const n of ['auditWebsite','auditWebsiteWithPageData','createEvidencePack','verifyEvidencePack'])assert.equal(typeof crawl[n],'function',n);
 for(const n of ['renderAuditHtml','renderCustomerSummaryHtml','renderCustomerSummaryPdf','renderOperatorStatusPdf','playwrightPdfRenderer']){assert.equal(crawl[n],undefined,n);assert.equal(typeof reports[n],'function',n);}
 assert.equal(typeof evidence.isAuditResultRecord,'function');assert.equal(typeof evidence.hasIncompleteCrawl,'function');
});
