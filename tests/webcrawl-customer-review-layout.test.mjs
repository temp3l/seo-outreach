import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';
import { renderCustomerSummaryHtml } from '../dist/reports/summary.js';
import { customerPageLabel } from '../dist/reports/customer.js';

test('customer review keeps exact long evidence links, labels them readably, and dates only the report header', () => {
  const { audit } = createEvidenceFixture(1);
  const longPath = `/services/${'very-long-offer-name-'.repeat(6)}final`;
  const pageUrl = `https://fixture.example${longPath}`;
  const observedAt = '2026-10-24T12:00:00.000Z';
  audit.startedAt = observedAt;
  audit.findings = [{ code: 'missing_h1', category: 'content', observed: 'Missing main heading', evidence: [{ pageUrl, source: 'http', observedAt }] }];
  audit.coverage.urls = [{ url: pageUrl, outcome: 'captured', statusCode: 200 }];

  const html = renderCustomerSummaryHtml(audit, 'en', { clientReady: false });
  const card = /<article class="card">([\s\S]*?)<\/article>/u.exec(html)?.[1];
  assert.ok(card, 'one selected topic should render one card');
  assert.match(html, new RegExp(`<a href="${pageUrl.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}">[^<…]{1,72}…<\\/a>`, 'u'));
  assert.doesNotMatch(card, /<time\b|2026-10-24|24 Oct 2026/u, 'issue cards do not repeat observation timestamps');
  assert.equal((html.match(/<time\b/gu) ?? []).length, 1, 'the report header carries the single review date');
  assert.match(html, /<time datetime="2026-10-24T12:00:00\.000Z">/u);
  assert.match(html, /data-publication-status="HOLD"/u);
  assert.doesNotMatch(html.replace(/<body\b[^>]*>/u, '<body>'), /\bHOLD\b|NOT FOR CUSTOMER DISTRIBUTION/u, 'publication state stays in the internal attribute');
});

test('numeric pagination examples retain route context in English, German, and Portuguese', () => {
  const paginated = 'https://ambergrisdivers.com/ambergris-divers-tour-search/page/2/';
  assert.equal(customerPageLabel(paginated, 'en'), 'Ambergris divers tour search — page 2');
  assert.equal(customerPageLabel(paginated, 'de'), 'Ambergris divers tour search — Seite 2');
  assert.equal(customerPageLabel(paginated, 'pt-BR'), 'Ambergris divers tour search — página 2');
  assert.equal(customerPageLabel('https://fixture.example/products/foil/2/', 'en'), 'Products foil — 2');
  const longContext = customerPageLabel(`https://fixture.example/${'very-long-context-'.repeat(8)}/page/2/`, 'en');
  assert.ok(longContext.length <= 72);
  assert.match(longContext, /… — page 2$/u, 'long context is shortened without dropping the pagination marker');

  const { audit } = createEvidenceFixture(1);
  const renderUrl = 'https://fixture.example/ambergris-divers-tour-search/page/2/';
  audit.target = renderUrl;
  audit.findings = [{ code: 'missing_h1', category: 'content', observed: 'Missing main heading', evidence: [{ pageUrl: renderUrl, source: 'http', observedAt: audit.startedAt }] }];
  audit.coverage.urls = [{ url: renderUrl, outcome: 'captured', statusCode: 200 }];
  const html = renderCustomerSummaryHtml(audit, 'en');
  assert.match(html, /<a href="https:\/\/fixture\.example\/ambergris-divers-tour-search\/page\/2\/">Ambergris divers tour search — page 2<\/a>/u);
});
