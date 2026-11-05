import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { auditWebsite } from '@spora/webcrawl/core/audit';
import { renderCustomerSummaryHtml, renderOperatorStatusHtml } from '../dist/reports/summary.js';

const { chromium } = createRequire(new URL('../package.json', import.meta.url))('playwright');

async function fixture(enrichments = []) {
  return auditWebsite({
    startUrl: 'https://fixture.example/', contacts: false, pagespeed: false, checkSecurityTxt: false,
    policy: {
      allowedHosts: ['fixture.example'], maxPages: 2, maxRequests: 5,
      maxRuntimeMs: 2_000, maxResponseBytes: 100_000, maxTotalResponseBytes: 500_000,
      minRequestIntervalMs: 0, maxConcurrency: 1, maxRetries: 0, maxImageChecks: 0,
    },
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url) => url.pathname === '/'
      ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>Fixture</title><meta name="description" content="Fixture"><h1>Fixture</h1>') }
      : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') },
  }, enrichments);
}

const manyChecks = {
  name: 'many-checks',
  async run(context) {
    return {
      status: 'complete',
      findings: Array.from({ length: 50 }, (_, index) => ({
        code: `synthetic_check_${String(index).padStart(2, '0')}`,
        category: 'security', severity: 'low',
        observed: `Synthetic check ${index} has a concise observation.`,
        evidence: [{ pageUrl: context.target, observedAt: context.capturedAt, source: 'derived' }],
      })),
    };
  },
};

const audit = await fixture([manyChecks]);
const assertSnapshot = (html, value, label, locale) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert.match(html, new RegExp(`<div class="snapshot"><strong>${value}</strong>${escaped}</div>`, 'u'), `${locale} snapshot badge: ${value} ${label}`);
};
assert.equal(audit.capabilities.pagespeed, 'disabled');
const english = renderCustomerSummaryHtml(audit, 'en');
const german = renderCustomerSummaryHtml(audit, 'de');
assert.match(english, /Not run for this audit\./u);
assert.match(german, /Für diesen Lauf nicht durchgeführt\./u);
assert.doesNotMatch(english, /Scores could not be retrieved/u);
assert.doesNotMatch(english, /stephan rebien|stephanrebien@gmail\.com|\+49 170/u);
assert.match(english, /captured response/u);
assert.match(renderOperatorStatusHtml(audit, 'en'), /Crawl complete/u);
const singular = structuredClone(audit);
singular.findings = [{ code: 'missing_h1', category: 'content', observed: 'Missing H1', evidence: [{ pageUrl: singular.target, observedAt: singular.startedAt, source: 'http' }] }];
for (const [locale, labels] of [['en', ['captured response', 'topic to review</div>', '1 page to review']], ['de', ['erfasste Antwort', 'Thema zum Prüfen</div>', '1 Seite prüfen']]]) {
  const html = renderCustomerSummaryHtml(singular, locale);
  assertSnapshot(html, 1, labels[0], locale);
  assert.ok(html.includes(labels[1]), `${locale} singular priority label`);
  assert.ok(html.includes(labels[2]), `${locale} singular evidence count`);
}
singular.crawl.captured = 2;
assertSnapshot(renderCustomerSummaryHtml(singular, 'en'), 2, 'captured responses', 'en');
assertSnapshot(renderCustomerSummaryHtml(singular, 'de'), 2, 'erfasste Antworten', 'de');
const completeStaticRun = structuredClone(audit);
completeStaticRun.capabilities = Object.fromEntries(Object.keys(completeStaticRun.capabilities).map((name) => [name, 'complete']));
assert.match(renderOperatorStatusHtml(completeStaticRun, 'en'), /Crawl complete/u, 'optional check statuses do not determine page crawl completion');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const issuer = { name: 'Synthetic Reviewer', company: 'Example Studio', email: 'reviewer@example.test', phone: '+49 30 12345678', website: 'https://example.test/' };
  for (const locale of ['en', 'de']) {
    const customerHtml = renderCustomerSummaryHtml(audit, locale, { issuer: {...issuer,name:'Synthetic Reviewer '.repeat(5).trim(),company:'Example Studio '.repeat(6).trim()}, clientReady: false });
    const body = customerHtml.split('<header class="hero">')[1]?.split('</header>')[1] ?? '';
    assert.ok(customerHtml.includes('<h1>fixture.example</h1>'), 'header retains the site domain');
    const homeLabel = locale === 'de' ? 'Startseite' : 'Homepage';
    assert.ok(body.includes(`<a href="https://fixture.example/">${homeLabel}</a>`), 'customer PDF retains the exact affected-page URL behind a readable label');
    assert.doesNotMatch(body.replace(/<[^>]*>/gu, ''), /https:\/\/fixture\.example\//u, 'customer PDF avoids displaying a raw URL as link text');
    assert.doesNotMatch(body, /PRIVATE_QUERY|token=/u, 'query values stay redacted');
    assert.doesNotMatch(customerHtml, /href="https:\/\/example\.test\//u, 'issuer website is not a PDF link');
    assert.match(customerHtml, /reviewer@example\.test/u);
    assert.match(customerHtml, /\+49 30 12345678/u);
    await page.setContent(customerHtml);
    await page.emulateMedia({media: 'print'});
    const layout = await page.evaluate(() => {
      const pages = [...document.querySelectorAll('.page')];
      return {
        pages: pages.length,
        heights: pages.map(p => p.getBoundingClientRect().height),
        width: pages[0].getBoundingClientRect().width,
        footers: document.querySelectorAll('footer.issuer').length,
        smallest: Math.min(...[...document.querySelectorAll('p,li,a,footer')].map(e=>parseFloat(getComputedStyle(e).fontSize))),
        footerOverlap: pages.some(p => {const foot=p.querySelector('footer');const prev=foot.previousElementSibling;return prev && foot.getBoundingClientRect().top < prev.getBoundingClientRect().bottom;})
      };
    });
    assert.equal(layout.footers, layout.pages);
    assert.ok(layout.heights.every(h => h <= 297 * 96 / 25.4 + 1), `${locale} content must fit each physical PDF page: ${layout.heights}`);
    assert.ok(Math.abs(layout.width - 210 * 96 / 25.4) < 1, 'PDF uses A4 width');
    assert.ok(layout.smallest >= 12, 'essential notes must be at least 9pt');
    assert.equal(layout.footerOverlap, false);
    await page.emulateMedia({media:'screen'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), true);
  }
  for (const [locale, html] of [['en', renderOperatorStatusHtml(audit, 'en')], ['de', renderOperatorStatusHtml(audit, 'de')]]) {
    await page.setContent(html, { waitUntil: 'load' });
    const layout = await page.evaluate(() => {
      const sheet = document.querySelector('.sheet');
      const cards = [...document.querySelectorAll('.check')];
      return {
        cards: cards.length,
        allCardsWithinSheet: cards.every((card) => card.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().bottom),
        overflow: getComputedStyle(sheet).overflow,
        sheetHeight: sheet.getBoundingClientRect().height,
      };
    });
    assert.ok(layout.cards >= 50);
    assert.equal(layout.allCardsWithinSheet, true, `${locale} check cards should flow within the natural report height`);
    assert.notEqual(layout.overflow, 'hidden');
    assert.ok(layout.sheetHeight > 1123, `${locale} report should grow beyond one A4 page`);
  }
} finally {
  await browser.close();
}

console.log('Production report truthfulness and overflow checks passed.');
