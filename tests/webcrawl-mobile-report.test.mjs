import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { renderMobileCustomerPdf, paginateMobileReport } from '../dist/reports/mobile.js';
import { playwrightPdfRenderer, withPlaywrightPdfSession } from '../dist/reports/pdf-playwright.js';
import { renderCustomerPdfPair } from '../dist/reports/publication.js';
import { auditResultSha256, isCustomerReleaseQualified } from '../dist/reports/qualification.js';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';

test('mobile report uses narrow print pages and retains a publication hold', async () => {
  const { audit } = createEvidenceFixture(1);
  let html = '';
  await renderMobileCustomerPdf(audit, async value => { html = value; return new Uint8Array([1]); }, { name: 'Test Publisher', email: 'test@example.com' }, 'en', 'HOLD');
  assert.match(html, /@page\{size:108mm 280mm/);
  assert.match(html, /\.grid\{display:block\}/);
  assert.doesNotMatch(html, /HOLD \/ NOT FOR CUSTOMER DISTRIBUTION/);
  assert.match(html, /data-publication-status="HOLD"/);
  assert.match(html, /Test Publisher/);
});

test('mobile pages keep padded headers and bottom footers without losing findings', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const locale of ['en', 'de']) for (const count of [1, 4, 5, 6]) {
      const { audit } = createEvidenceFixture(1);
      const url = audit.coverage.urls[0].url;
      audit.target = 'https://www.kitesurfadventure.com.br/';
      audit.crawlSettings.policy.allowedHosts.push('www.kitesurfadventure.com.br');
      audit.coverage.urls[0].url = audit.target; audit.coverage.urls[0].finalUrl = audit.target;
      audit.findings = ['missing_canonical', 'missing_meta_description', 'title_long', 'images_missing_dimensions', 'missing_h1', 'heading_hierarchy_skip'].slice(0, count).map(code => ({ code, category: 'content', severity: 'low', observed: code, evidence: [{ pageUrl: audit.target, source: 'http', observedAt: audit.startedAt }] }));
      let html;
      await renderMobileCustomerPdf(audit, async value => { html = value; return new Uint8Array(); }, { name: 'Test Publisher', email: 'test@example.com' }, locale, count === 1 ? 'HOLD' : 'CLIENT_READY');
      const page = await browser.newPage();
      await page.setContent(html);
      await page.emulateMedia({ media: 'print' });
      const cardsBefore = await page.locator('.card').count();
      await page.evaluate(paginateMobileReport);
      const header = await page.locator('.hero').evaluate(hero => {
        const title = hero.querySelector('h1');
        const sheet = hero.closest('.mobile-sheet').getBoundingClientRect();
        return { width: hero.getBoundingClientRect().width, inset: title.getBoundingClientRect().left - sheet.left, overflows: title.scrollWidth > title.clientWidth + 1, wraps: getComputedStyle(title).whiteSpace !== 'nowrap' };
      });
      assert.ok(Math.abs(header.width - 96 * 96 / 25.4) < 1);
      assert.ok(Math.abs(header.inset - 10 * 96 / 25.4) < 1);
      assert.equal(header.overflows, false);
      assert.equal(header.wraps, false);
      assert.equal(await page.locator('.card').count(), cardsBefore);
      assert.equal(await page.locator('.mobile-sheet:last-child .card').count() > 0, true, 'closing page retains a finding with the invitation');
      assert.equal(await page.locator('footer').count(), 1);
      assert.equal(await page.locator('.mobile-sheet:last-child footer').count(), 1);
      const layouts = await page.evaluate(() => Array.from(document.querySelectorAll('.mobile-sheet')).map(sheet => {
        const box = sheet.getBoundingClientRect();
        const footer = sheet.querySelector('footer')?.getBoundingClientRect();
        const content = sheet.querySelector('.mobile-content').getBoundingClientRect();
        return { footerGap: footer ? box.bottom - footer.bottom : null, leftGap: content.left - box.left, rightGap: box.right - content.right, overlap: footer ? content.bottom > footer.top : content.bottom > box.bottom, height: box.height, footerLeft: footer ? footer.left - box.left : null, footerWidth: footer?.width };
      }));
      for (const layout of layouts) {
        assert.ok(Math.abs(layout.height - 280 * 96 / 25.4) < 1);
        if (layout.footerGap !== null) {
        assert.ok(Math.abs(layout.footerGap - 6 * 96 / 25.4) < 1);
        assert.ok(layout.footerLeft > 0);
        assert.ok(Math.abs(layout.footerWidth - 96 * 96 / 25.4) < 1);
        }
        for (const gap of [layout.leftGap, layout.rightGap]) assert.ok(Math.abs(gap - 6 * 96 / 25.4) < 1, JSON.stringify(layout));
        assert.equal(layout.overlap, false);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});

test('real Chromium releases one-topic EN/DE A4 and en/de/pt-BR mobile PDFs with evidence and issuer', async () => {
  const root = await mkdtemp('/tmp/webcrawl-qualified-mobile-');
  try {
    const { audit } = createEvidenceFixture(1);
    audit.startedAt = new Date(Date.now() - 120_000).toISOString(); audit.completedAt = new Date(Date.now() - 90_000).toISOString();
    const url = audit.target; audit.coverage.urls[0].url = url; audit.coverage.urls[0].finalUrl = url;
    audit.findings = [{ code: 'missing_meta_description', category: 'metadata', observed: 'Missing description', evidence: [{ pageUrl: url, source: 'http', observedAt: audit.completedAt }] }];
    audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_meta_description', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
    const issuer = { name: 'Synthetic Mobile Issuer', email: 'issuer@example.test', phone: '+31 20 123 4567' };
    const qualification = { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED' };
    assert.equal(isCustomerReleaseQualified(audit, qualification), true);
    await withPlaywrightPdfSession(async renderer => {
      const pair = await renderCustomerPdfPair(audit, renderer, issuer, qualification);
      assert.equal(pair.status, 'CLIENT_READY');
      for (const locale of ['en', 'de']) {
        const path = join(root, `${locale}.pdf`); await writeFile(path, pair[locale]);
        const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
        assert.match(text, /issuer@example\.test/u); assert.match(text,/2026|20\d\d/u); assert.doesNotMatch(text, /HOLD|NOT FOR CUSTOMER DISTRIBUTION/u);
        assert.match(text,/Missing search descriptions|Fehlende Suchbeschreibungen/u);
        assert.match(execFileSync('pdfinfo',['-url',path],{encoding:'utf8'}),/https:\/\/fixture\.example\//u);
        assert.match(execFileSync('pdfinfo', [path], { encoding: 'utf8' }), /594(?:\.96)? x 841\.92/u);
      }
      for (const locale of ['en', 'de', 'pt-BR']) {
        const actualIssuer = locale === 'pt-BR' ? { ...issuer } : issuer;
        const bytes = await renderMobileCustomerPdf(audit, renderer, actualIssuer, locale, pair.status, qualification);
        const path = join(root, `mobile-${locale}.pdf`); await writeFile(path, bytes);
        const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
        assert.match(text, /issuer@example\.test/u); assert.match(text,/2026|20\d\d/u); assert.doesNotMatch(text, /HOLD|NOT FOR CUSTOMER DISTRIBUTION/u);
        if (locale === 'pt-BR') assert.match(text,/Descrição da oferta|descrição da oferta/u);
        else assert.match(text,/Missing search descriptions|Fehlende Suchbeschreibungen/u);
        assert.match(execFileSync('pdfinfo',['-url',path],{encoding:'utf8'}),/https:\/\/fixture\.example\//u);
        assert.match(execFileSync('pdfinfo', [path], { encoding: 'utf8' }), /Page size:\s+306 x 793\.92 pts/u);
      }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('qualified mobile pagination keeps the final footer and rejects an overflowing real Chromium layout', async () => {
  const root = await mkdtemp('/tmp/webcrawl-qualified-mobile-pages-');
  try {
    const { audit } = createEvidenceFixture(1);
    audit.startedAt = new Date(Date.now() - 120_000).toISOString(); audit.completedAt = new Date(Date.now() - 90_000).toISOString();
    const url = audit.target; audit.coverage.urls[0].url = url; audit.coverage.urls[0].finalUrl = url;
    const codes = ['missing_canonical', 'missing_meta_description', 'title_long', 'images_missing_dimensions', 'missing_h1', 'heading_hierarchy_skip'];
    audit.findings = codes.map(code => ({ code, category: 'content', observed: code, evidence: [{ pageUrl: url, source: 'http', observedAt: audit.completedAt }] }));
    audit.coverage.findings = { records: 6, checkCodes: 6, affectedPages: 1, evidenceOccurrences: 6, byCheck: codes.map(code => ({ code, records: 1, affectedPages: 1, evidenceOccurrences: 1 })) };
    const issuer = { name: 'Synthetic Multi Page Issuer', email: 'issuer@example.test' };
    const qualification = { decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit), qualifiedAt: new Date(Date.now() - 20_000).toISOString(), qualifiedBy: 'Synthetic operator reviewer', businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED' };
    await withPlaywrightPdfSession(async renderer => {
      const bytes = await renderMobileCustomerPdf(audit, renderer, issuer, 'en', 'CLIENT_READY', qualification);
      const path = join(root, 'multi.pdf'); await writeFile(path, bytes);
      const info = execFileSync('pdfinfo', [path], { encoding: 'utf8' });
      assert.match(info, /Pages:\s+[2-9]/u); assert.match(info, /Page size:\s+306 x 793\.92 pts/u);
      const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' }); assert.match(text, /issuer@example\.test/u); assert.match(text,/Missing search descriptions/u); assert.doesNotMatch(text, /HOLD/u);
      await assert.rejects(renderMobileCustomerPdf(audit, async (html, options) => playwrightPdfRenderer(html.replace('</head>', '<style>.mobile-sheet .card{height:500mm!important}</style></head>'), options), issuer, 'en', 'CLIENT_READY', qualification), /mobile_report_block_exceeds_page|client_report_not_ready/u);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
