import { createPageDataExport } from '@spora/webcrawl/analysis/page-data';
import { createEvidencePack, writeEvidencePackExclusive } from '@spora/webcrawl/reports/evidence-pack';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createEvidenceFixture(pageCount = 110) {
  const timestamp = '2026-10-29T00:00:00.000Z';
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const path = `page-${String(index).padStart(3, '0')}`;
    const url = `https://fixture.example/${path}`;
    const next = `page-${String((index + 1) % pageCount).padStart(3, '0')}`;
    const html = `<html lang="en"><head><title>Fixture ${index}</title><link rel="canonical" href="${url}"></head><body><nav><a href="/nav">Navigation</a></nav><main><h1>Fixture ${index}</h1><p>Synthetic captured evidence record ${index}.</p><a href="/${next}">Next</a></main><footer><a href="/legal">Legal</a></footer></body></html>`;
    return { requestedUrl: url, finalUrl: url, statusCode: 200, contentType: 'text/html; charset=utf-8', fetchedAt: timestamp, responseBytes: Buffer.byteLength(html), html };
  });
  const pageData = createPageDataExport(pages, { maxPages: 750, maxTotalTextChars: 1_000_000 });
  const urlOutcomes = pages.map((page) => ({ url: page.requestedUrl, finalUrl: page.finalUrl, outcome: 'captured', statusCode: page.statusCode }));
  const audit = {
    schemaVersion: '1', startedAt: timestamp, completedAt: timestamp, target: 'https://fixture.example/',
    crawlSettings: { policy: { allowedHosts: ['fixture.example'], maxPages: 750, maxRequests: 1_800, maxRuntimeMs: 1_800_000, maxResponseBytes: 20_000_000, maxTotalResponseBytes: 1_000_000_000, minRequestIntervalMs: 1_000, maxConcurrency: 2 }, userAgent: 'webcrawl-fixture', renderBrowser: false, retainHtml: false, enrichments: [] },
    crawl: { discovered: pageCount, attempted: pageCount, captured: pageCount, failed: 0, skipped: 0, unattempted: 0, limitations: [] },
    coverage: { urls: urlOutcomes, checks: fixtureChecks(pageCount), findings: { records: 0, checkCodes: 0, affectedPages: 0, evidenceOccurrences: 0, byCheck: [] } },
    capabilities: { http: 'complete', technicalSeo: 'complete' }, findings: [],
  };
  return { audit, pageData };
}

function fixtureChecks(pageCount) {
  const pageChecks = new Set(['securityHeaders', 'mixedContent', 'sensitiveForms', 'cookieAttributes']);
  return Object.fromEntries(['internalLinks', 'imageSizes', 'securityHeaders', 'mixedContent', 'sensitiveForms', 'cookieAttributes', 'securityTxt'].map((name) => [name, { ...(name === 'internalLinks' || name === 'imageSizes' ? { scope: 'same_host', outOfScope: 0 } : {}), status: 'complete', discovered: pageChecks.has(name) ? pageCount : 0, checked: pageChecks.has(name) ? pageCount : 0, findings: 0, failed: 0, skipped: 0, unattempted: 0 }]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw new Error('usage: node tests/fixtures/evidence-pack-fixture.mjs <new-output.zip>');
  const { audit, pageData } = createEvidenceFixture();
  const digest = await writeEvidencePackExclusive(output, createEvidencePack(audit, pageData));
  process.stdout.write(`${output} sha256=${digest}\n`);
}
