import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCustomerSummaryHtml, renderCustomerSummaryPdf, renderOperatorStatusHtml, renderOperatorStatusPdf } from '../dist/reports/summary.js';
import { createEvidenceFixture } from './fixtures/evidence-pack-fixture.mjs';

const localCheck = (status = 'complete', checked = 3, findings = 0) => ({ status, discovered: 3, checked, findings, failed: 0, skipped: 0, unattempted: 0 });
const result = {
  schemaVersion: '1',
  startedAt: '2026-10-24T12:00:00.000Z',
  completedAt: '2026-10-24T12:01:00.000Z',
  target: 'https://example.test/?token=private-target',
  crawlSettings: { policy: { allowedHosts: ['example.test'], maxPages: 100, maxRequests: 200, maxRuntimeMs: 60_000, maxResponseBytes: 1_000_000, maxTotalResponseBytes: 10_000_000, minRequestIntervalMs: 0, maxConcurrency: 5 }, userAgent: 'webcrawl-test', renderBrowser: false, retainHtml: false, enrichments: [] },
  crawl: { discovered: 5, attempted: 4, captured: 4, failed: 0, skipped: 0, unattempted: 1, limitations: ['page_limit_reached'] },
  coverage: {
    urls: [],
    checks: {
      internalLinks: { status: 'complete', scope: 'same_host', discovered: 0, checked: 0, findings: 0, failed: 0, skipped: 0, unattempted: 0, outOfScope: 0 },
      imageSizes: { status: 'complete', scope: 'same_host', discovered: 0, checked: 0, findings: 0, failed: 0, skipped: 0, unattempted: 0, outOfScope: 0 },
      securityHeaders: localCheck('complete', 3, 2),
      mixedContent: localCheck('complete'),
      sensitiveForms: localCheck('complete'),
      cookieAttributes: localCheck('partial', 2, 1),
      securityTxt: localCheck('disabled', 0),
    },
    findings: { records: 0, checkCodes: 0, affectedPages: 0, evidenceOccurrences: 0, byCheck: [] },
  },
  capabilities: { pagespeed: 'disabled', technology: 'disabled' },
  findings: [
    { code: 'missing_meta_description', category: 'metadata', severity: 'medium', observed: 'Meta description missing.', evidence: [{ pageUrl: 'https://example.test/service?token=secret-query#top', observedAt: '2026-10-24T12:00:00.000Z', source: 'http' }] },
    { code: 'missing_h1', category: 'content', severity: 'medium', observed: 'No H1 found.', evidence: [{ pageUrl: 'https://example.test/service?token=secret-query#top', observedAt: '2026-10-24T12:00:00.000Z', source: 'http' }] },
    { code: 'images_missing_alt', category: 'accessibility', severity: 'low', observed: 'Some images are missing alt text.', evidence: [{ pageUrl: 'https://example.test/gallery?private=1', observedAt: '2026-10-24T12:00:00.000Z', source: 'http' }] },
    { code: 'session_cookie_missing_secure', category: 'security', severity: 'medium', observed: 'One session-like cookie omits Secure.', evidence: [{ pageUrl: 'https://example.test/?cookie_secret=hidden', observedAt: '2026-10-24T12:00:00.000Z', source: 'http', value: 'sessionid' }] },
    { code: 'csp_unsafe_eval', category: 'security', severity: 'medium', observed: 'CSP allows eval-like script execution.', evidence: [{ pageUrl: 'https://example.test/?secret=other', observedAt: '2026-10-24T12:00:00.000Z', source: 'http' }] },
  ],
};

// Explicit successful captures for these synthetic positive report fixtures.
result.coverage.urls = [...new Set([
  '/', '/offer/', '/service?token=secret-query', '/gallery?private=1', '/kite-privatunterricht-coast',
  '/courses/one', '/courses/two', '/courses/three', '/en/free-guide/', '/de/impressum-2/', '/es/politica-cookies/', '/kurse',
  '/courses/page?token=one', '/courses/page?token=two', '/courses/other', '/courses/third',
  ...Array.from({length:80},(_,i)=>`/courses/page-${i}?token=secret`),
  ...Array.from({length:53},(_,i)=>`/courses/page-${i}`),
])].map(path=>({url:`https://example.test${path}`,outcome:'captured',statusCode:200}));

test('customer briefing uses plain-language priorities and a separate developer handoff', () => {
  const html = renderCustomerSummaryHtml(result, 'en');
  assert.ok(html.indexOf('Key observations') < html.indexOf('<aside class="offer">'));
  assert.doesNotMatch(html, /Security observations|Additional observations|Routine search warnings/u);
  assert.ok(!html.includes('unique check codes'));
  assert.ok(!html.includes('affected URLs'));
  assert.ok(!html.includes('recommended tasks'));
  assert.ok(html.includes('Mobile performance was not measured in this run.'));
  assert.doesNotMatch(html, /Coverage limitations|partial coverage|Internal draft/u);
  assert.ok(!html.includes('Scores could not be retrieved'));
  assert.ok(!/stephan rebien|stephanrebien@gmail\.com|\+49 170 8854 857/iu.test(html));
  assert.ok(!html.includes('secret-query'));
  assert.ok(!html.includes('cookie_secret'));
  assert.ok(!html.includes('private-target'));
});

test('customer summary shows the selected topic count without added observation notes', () => {
  const make = category => ({ code: ({indexability:'missing_canonical',metadata:'missing_meta_description',content:'missing_h1',performance:'image_file_too_large',accessibility:'images_missing_alt',security:'csp_unsafe_eval'})[category], category, observed: 'Fixture', evidence: [{ pageUrl: 'https://example.test/', source: 'http', observedAt: result.startedAt }] });
  const findings = ['indexability', 'metadata', 'content', 'performance', 'accessibility', 'security'].map(make);
  for (const locale of ['en', 'de']) {
    const html = renderCustomerSummaryHtml({ ...result, findings }, locale);
    assert.match(html, locale === 'en' ? /<strong>3<\/strong>topics/u : /<strong>3<\/strong>Themen/u);
    assert.doesNotMatch(html, /addresses discovered|Adressen entdeckt|Additional observations|Weitere Beobachtungen|Security observations also|Sicherheitsbeobachtungen sollten|Routine search warnings|SEO-Routinehinweise/u);
  }
});

test('operator status includes security coverage and security finding details', () => {
  const html = renderOperatorStatusHtml(result, 'en');
  assert.ok(html.includes('Security check coverage'));
  assert.ok(html.includes('Cookie attributes'));
  assert.ok(html.includes('partial'));
  assert.ok(html.includes('CSP allows eval-like script execution.'));
  assert.ok(!html.includes('cookie_secret'));
  assert.ok(!html.includes('private-target'));
  assert.ok(html.includes('medium · Session cookie is missing Secure'));
  assert.ok(html.includes('PageSpeed Insights mobile: disabled'));
  assert.ok(html.includes('Crawl incomplete'));
});

test('customer copy names only observed problems and keeps priority order independent of frequency', () => {
  const make = (code, category, count = 1) => ({ code, category, observed: 'Fixture', evidence: Array.from({length: count}, (_, i) => ({pageUrl: `https://example.test/courses/page-${i}?token=secret`, source: 'http', observedAt: result.startedAt})) });
  const canonical = renderCustomerSummaryHtml({...result, findings: [make('missing_canonical', 'indexability')]});
  assert.match(canonical, /Preferred page versions/u);
  assert.doesNotMatch(canonical, /error status codes|Internal links to missing pages|declare that search engines should not index/u);
  const score = {code:'pagespeed_category_score',category:'performance',observed:'performance score: 39/100.',evidence:[{pageUrl:'https://example.test/',source:'pagespeed',observedAt:result.startedAt,value:39}]};
  const brief = renderCustomerSummaryHtml({...result, target:'https://example.test/', findings:[make('multiple_h1','content',80),make('http_status_error','indexability'),score]});
  assert.doesNotMatch(brief, /Some page responses returned error status codes/);
  assert.doesNotMatch(brief, /Some pages contain multiple main headings/);
  assert.match(brief, /laboratory score/u);
  assert.match(brief, /<aside class="offer">/u);
  assert.doesNotMatch(brief, /Example to check|See the technical report for the affected page address/u);
  assert.doesNotMatch(brief, /token=secret/u);
  assert.doesNotMatch(brief, /token=secret/u);
  const commercialHeading = make('missing_h1', 'content');
  commercialHeading.evidence[0].pageUrl = 'https://example.test/kite-privatunterricht-coast';
  const courseBrief = renderCustomerSummaryHtml({...result,findings:[make('missing_meta_description','metadata',80),commercialHeading,make('noindex','indexability')]});
  assert.ok(courseBrief.indexOf('Missing main headings') < courseBrief.indexOf('Missing search descriptions'));
  assert.match(courseBrief,/href="https:\/\/example\.test\/kite-privatunterricht-coast"/u);
});

test('customer error examples direct readers to the technical report without printing URLs', () => {
  for (const locale of ['en', 'de']) {
    const finding = { code: 'http_status_error', category: 'indexability', observed: '404', evidence: [{ pageUrl: 'https://example.test/en/?page_id=29351', source: 'http', observedAt: result.startedAt }] };
    const html = renderCustomerSummaryHtml({ ...result, findings: [finding] }, locale);
    assert.doesNotMatch(html, /href="https:\/\/example.test\/en\/"/u);
    assert.doesNotMatch(html, /page_id=29351/u);
    assert.doesNotMatch(html, /Example to check|Beispiel zum Prüfen|technical report for the affected page address|Adresse der betroffenen Seite steht im technischen Bericht/u);
  }
});

test('customer topic labels distinguish unknown legacy coverage from known zero and one', () => {
  const { audit } = createEvidenceFixture(1);
  audit.target = audit.coverage.urls[0].url;
  audit.findings = [{ code: 'missing_h1', category: 'content', observed: 'Missing H1', evidence: [{ pageUrl: audit.coverage.urls[0].url, source: 'http', observedAt: audit.startedAt }] }];
  audit.coverage.findings = { records: 1, checkCodes: 1, affectedPages: 1, evidenceOccurrences: 1, byCheck: [{ code: 'missing_h1', records: 1, affectedPages: 1, evidenceOccurrences: 1 }] };
  for (const locale of ['en', 'de']) for (const state of ['legacy', 'zero', 'one']) {
    const input = structuredClone(audit);
    if (state === 'legacy') delete input.coverage;
    if (state === 'zero') input.findings[0].evidence[0].pageUrl = 'https://fixture.example/uncaptured';
    const before = JSON.stringify(input), html = renderCustomerSummaryHtml(input, locale);
    const label = /<span class="label"[^>]*>([^<]*)<\/span>/u.exec(html)?.[1];
    const expected = state === 'one' ? (locale === 'en' ? '1 page to review' : '1 Seite prüfen') : undefined;
    assert.equal(label, expected, `${locale}: ${state}`);
    assert.doesNotMatch(html, /\b(?:null|undefined) (?:captured URL|erfasste URL)/u);
    assert.equal(JSON.stringify(input), before);
  }
});

test('report page counts preserve query identities and exclude image probe targets', () => {
  const e = pageUrl => ({ pageUrl, source: 'http', observedAt: result.startedAt });
  const errors = ['one', 'two'].map(id => ({ code: 'http_status_error', category: 'indexability', observed: '404', evidence: [{...e(`https://example.test/en/?page_id=${id}`),value:404}] }));
  const image = { code: 'image_file_too_large', category: 'performance', observed: 'Large image', evidence: [{...e('https://example.test/asset.webp'),value:2000000}, { ...e('https://example.test/en/'),value:2000000, excerpt: 'https://example.test/asset.webp' }] };
  const audit = { ...result, coverage: {...result.coverage, urls: [...errors.map(f=>({url:f.evidence[0].pageUrl,outcome:'captured',statusCode:404})),{url:'https://example.test/en/',outcome:'captured',statusCode:200}]}, findings: [...errors, image] };
  const customer = renderCustomerSummaryHtml(audit, 'en');
  const operator = renderOperatorStatusHtml(audit, 'en');
  assert.match(customer, /2 pages to review/u);
  assert.match(customer, /1 page to review/u);
  assert.match(operator, /HTTP error pages<\/strong><span>2 captured URLs/u);
  assert.match(operator, /Large image files<\/strong><span>1 captured URLs/u);
  assert.match(operator, /Exact address in the private audit/u);
  assert.doesNotMatch(customer + operator, /page_id=(?:one|two)/u);
});

test('noindex page selection keeps a useful non-administrative example count', () => {
  const evidence = ['/de/impressum-2/', '/es/politica-cookies/', '/en/free-guide/'].map(path => ({ pageUrl: `https://example.test${path}`, source: 'http', observedAt: result.startedAt }));
  const html = renderCustomerSummaryHtml({ ...result, findings: [{ code: 'noindex', category: 'indexability', observed: 'Noindex', evidence }] }, 'en');
  assert.match(html, /href="https:\/\/example\.test\/en\/free-guide\/"/u);
});

test('customer briefing localizes scope and handles empty, security-only and unavailable measurements truthfully', () => {
  const empty = renderCustomerSummaryHtml({...result, findings:[], capabilities:{pagespeed:'unavailable'}},'de');
  assert.match(empty, /Keine ausgewählten Schwerpunkte/u);
  assert.doesNotMatch(empty, /Sicherheitsbeobachtungen|Security observations/u);
  assert.match(empty, /Es lagen keine nutzbaren Werte vor/u);
  assert.doesNotMatch(empty, /NOT_CHECKED|disabled|technicalSeo|Prüfcodes/u);
  const high = renderCustomerSummaryHtml({...result, findings:[{...result.findings[3],severity:'high'}]});
  assert.doesNotMatch(high, /prompt developer review/u);
  assert.match(high, /No selected priorities/u);
  assert.doesNotMatch(high, /0 recommended tasks/u);
});

test('routine customer SEO scope excludes observed noindex without hiding safety or mutating evidence', () => {
  const evidence = path => ({pageUrl:'https://example.test'+path,source:'http',observedAt:result.startedAt});
  const all = Array.from({length:53},(_,i)=>evidence(`/courses/page-${i}`));
  const warnings={code:'duplicate_h1',category:'content',observed:'Repeated main heading text',evidence:all};
  const noindex={code:'noindex',category:'indexability',observed:'Noindex',evidence:all.slice(0,45)};
  const report={...result,findings:[warnings,noindex]};
  const before=structuredClone(report);
  const html=renderCustomerSummaryHtml(report);
  const headingPage=html.split('<article class="card">').find(s=>s.includes('<h3>Some pages repeat main-heading text.</h3>'));
  assert.equal(headingPage,undefined);
  assert.doesNotMatch(html,/Some pages repeat main-heading text/u);
  assert.deepEqual(report,before);
  const onlyNoindex={...report,findings:[{...warnings,evidence:[evidence('/kurse')]},{...noindex,evidence:[evidence('/kurse')]},{code:'broken_internal_link',category:'indexability',observed:'Missing target',evidence:[evidence('/kurse')]},result.findings[3]]};
  const filtered=renderCustomerSummaryHtml(onlyNoindex);
  assert.doesNotMatch(filtered,/Some pages repeat main-heading text/u);
  assert.match(filtered,/Pages requesting exclusion from search/u);
  assert.doesNotMatch(filtered,/Internal links to missing pages were recorded/u);
  assert.doesNotMatch(filtered,/Security observations/u);
  assert.match(renderOperatorStatusHtml(report),/Repeated main heading text/u);
});

test('noindex joins retain query identity and cross-page duplicates require two remaining pages', () => {
  const e = pageUrl => ({pageUrl,source:'http',observedAt:result.startedAt});
  const base='https://example.test/courses/page';
  const ni={code:'noindex',category:'indexability',observed:'Noindex',evidence:[e(base+'?token=one')]};
  const heading={code:'missing_h1',category:'content',observed:'No main heading',evidence:[e(base+'?token=two')]};
  assert.match(renderCustomerSummaryHtml({...result,findings:[ni,heading]}),/Missing main headings/u);
  const duplicate={code:'duplicate_title_across_pages',category:'metadata',observed:'Same title',evidence:[e(base+'?token=one'),e('https://example.test/courses/other')]};
  assert.doesNotMatch(renderCustomerSummaryHtml({...result,findings:[ni,duplicate]}),/Repeated page titles/u);
  assert.doesNotMatch(renderCustomerSummaryHtml({...result,findings:[ni,{...duplicate,evidence:[...duplicate.evidence,e('https://example.test/courses/third')]}]}),/Repeated page titles/u); // Raw duplicate records need independent source evidence.
});

test('issuer configuration is explicit, escaped, validated and absent from operator output', async () => {
  const issuer = {name:'Synthetic <Reviewer>',company:'Example & Studio',email:'reviewer@example.test',phone:'+49 30 12345678',website:'https://example.test/'};
  for (const locale of ['en','de']) {
    const html = renderCustomerSummaryHtml(result,locale,{issuer,clientReady:false});
    assert.match(html, /Synthetic &lt;Reviewer&gt;/u);
    assert.match(html, /reviewer@example.test/u);
    assert.doesNotMatch(html, /href="mailto:/u);
    assert.doesNotMatch(html, /href="https:\/\/example\.test\//u);
    const footer = /<footer class="issuer">[\s\S]*?<\/footer>/u.exec(html)?.[0] ?? '';
    assert.doesNotMatch(footer, /https:\/\/example\.test\//u);
    assert.match(html, /\+49 30 12345678/u);
    assert.equal((html.match(/<footer class="issuer">/gu)??[]).length, 1);
    assert.doesNotMatch(html, /<Reviewer>/u);
  }
  assert.match(renderCustomerSummaryHtml(result,'en',{clientReady:true}),/data-publication-status="HOLD"/u);
  assert.throws(()=>renderCustomerSummaryHtml(result,'en',{issuer:{name:'Valid Name',email:'bad\n@example.test'}}),/invalid_report_contact/u);
  assert.throws(()=>renderCustomerSummaryHtml(result,'en',{issuer:{name:'Valid Name',website:'javascript:alert(1)'}}),/invalid_report_contact_website/u);
  assert.throws(()=>renderCustomerSummaryHtml(result,'en',{issuer:{name:'https://reviewer.example',email:'reviewer@example.test'}}),/report_contact_identity_url_not_allowed/u);
  assert.throws(()=>renderCustomerSummaryHtml(result,'en',{issuer:{name:'Valid Name',company:'reviewer.example',email:'reviewer@example.test'}}),/report_contact_identity_url_not_allowed/u);
  assert.throws(()=>renderCustomerSummaryHtml(result,'en',{issuer:{name:'Valid Name'}}),/reply_channel_required/u);
  assert.doesNotMatch(renderCustomerSummaryHtml(result),/Internal draft|not for client delivery/u);
});

test('operator report keeps every check field in natural-height layout', () => {
  const findings = Array.from({ length: 50 }, (_, index) => ({
    code: `synthetic_check_${String(index).padStart(2, '0')}`, category: 'security', severity: 'low',
    observed: `Synthetic check ${index} observation.`,
    evidence: [{ pageUrl: `https://example.test/check-${index}`, observedAt: result.startedAt, source: 'derived' }],
  }));
  const html = renderOperatorStatusHtml({ ...result, findings }, 'en');
  assert.match(html, /All checks · \d+ evidence occurrences across 50 check fields/u);
  assert.equal((html.match(/class="check"/gu) ?? []).length, 50);
  assert.ok(!/\.sheet\{[^}]*;(?<!min-)height:297mm/iu.test(html));
  assert.ok(!/\.sheet\{[^}]*overflow:hidden/iu.test(html));
  assert.ok(!/\.check\{[^}]*overflow:hidden/iu.test(html));
});

test('repeated sitewide header observations stay raw per page and display as one grouped policy', () => {
  const headers = Array.from({ length: 24 }, (_, index) => ({
    code: 'missing_nosniff_header', category: 'security', severity: 'low',
    observed: 'X-Content-Type-Options is missing.',
    evidence: [{ pageUrl: `https://example.test/courses/page-${index}`, observedAt: '2026-10-24T12:00:00.000Z', source: 'http' }],
  }));
  const report = renderCustomerSummaryHtml({ ...result, findings: headers }, 'en');
  assert.equal(headers.length, 24);
  assert.doesNotMatch(report, /Security observations also need developer review/u);
  assert.doesNotMatch(report, /share one setting/u);
  assert.ok(!report.includes('finding occurrences'));
  assert.ok(!report.includes('Browser content-type protection missing'));
  assert.ok(!report.includes('recommended tasks'));
});

test('duplicate finding groups preserve category and code insertion order without mutating inputs', async () => {
  const { renderAuditHtml } = await import('../dist/reports/html.js');
  const findings = [
    { code: 'missing_meta_description', category: 'metadata', observed: 'first', evidence: [{ pageUrl: 'https://example.test/courses/one', observedAt: result.startedAt, source: 'http' }] },
    { code: 'missing_h1', category: 'content', observed: 'second', evidence: [{ pageUrl: 'https://example.test/courses/two', observedAt: result.startedAt, source: 'http' }] },
    { code: 'missing_meta_description', category: 'metadata', observed: 'third', evidence: [{ pageUrl: 'https://example.test/courses/three', observedAt: result.startedAt, source: 'http' }] },
  ];
  const before = structuredClone(findings);
  const report = { ...result, findings };
  const html = renderAuditHtml(report);
  const summary = renderCustomerSummaryHtml(report, 'en');
  assert.ok(html.indexOf('<h2>metadata</h2>') < html.indexOf('<h2>content</h2>'));
  assert.ok(html.indexOf('<h3>missing_meta_description</h3>') < html.indexOf('<h3>missing_h1</h3>'));
  assert.ok(html.indexOf('first') < html.indexOf('third'));
  assert.ok(summary.includes('Missing search descriptions'));
  assert.deepEqual(findings, before);
});

test('audit HTML links only accepted HTTP(S) URLs without credentials and leaves invalid URLs inert', async () => {
  const { renderAuditHtml } = await import('../dist/reports/html.js');
  const unsafe = ['javascript:alert(1)', 'data:text/html,unsafe', 'not a URL', 'https://user:pass@example.test/private'];
  const evidence = unsafe.map((pageUrl) => ({ pageUrl, observedAt: result.startedAt, source: 'http' }));
  const coverageUrls = unsafe.map((url) => ({ url, outcome: 'captured' }));
  const safe = { pageUrl: 'https://example.test/safe?email=private@example.test', observedAt: result.startedAt, source: 'http' };
  const report = { ...result, findings: [{ code: 'fixture', category: 'metadata', observed: 'fixture', evidence: [...evidence, safe] }], coverage: { ...result.coverage, urls: [...coverageUrls, { url: safe.pageUrl, outcome: 'captured' }] } };
  const html = renderAuditHtml(report);
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.ok(!html.includes('href="not%20a%20URL'));
  assert.ok(!html.includes('href="https://user:pass@'));
  assert.ok(html.includes('javascript:alert(1)'));
  assert.ok(html.includes('data:text/html,unsafe'));
  assert.ok(html.includes('https://user:pass@example.test/private'));
  assert.equal((html.match(/href="https:\/\/example\.test\/safe"/gu) ?? []).length, 2);
  assert.ok(!html.includes('private@example.test'));
});

test('customer and operator PDF helpers delegate localized HTML to the supplied renderer', async () => {
  const rendered = [];
  const renderer = async (html, options) => { rendered.push({ html, options }); return new Uint8Array([37, 80, 68, 70]); };
  assert.deepEqual([...await renderCustomerSummaryPdf(result, renderer, { locale: 'de' })], [37, 80, 68, 70]);
  assert.deepEqual([...await renderOperatorStatusPdf(result, renderer, { locale: 'en', timeoutMs: 1234 })], [37, 80, 68, 70]);
  assert.equal(rendered.length, 2);
  assert.ok(rendered[0].html.includes('Website-Prüfung'));
  assert.ok(rendered[1].html.includes('Internal technical SEO report'));
  assert.equal(rendered[1].options.timeoutMs, 1234);
});

test('customer SEO gauge appears only below 60; operator retains every score', () => {
  const withScores = { ...result, target: 'https://example.test/', findings: [...result.findings, ...[
    ['performance', 39], ['accessibility', 92], ['best-practices', 96], ['seo', 92],
  ].map(([name, score], index) => ({ code: 'pagespeed_category_score', category: 'performance', severity: 'informational', observed: `${name} score: ${score}/100.`, evidence: [{ pageUrl: 'https://example.test/', observedAt: `2026-10-24T12:0${index}:00.000Z`, source: 'pagespeed', value: score }] }))] };
  const customer = renderCustomerSummaryHtml(withScores, 'en');
  const operator = renderOperatorStatusHtml(withScores, 'en');
  assert.doesNotMatch(customer, /aria-label="SEO 92\/100"/);
  assert.equal((customer.match(/class="score-card"/gu) ?? []).length, 3);
  assert.ok(customer.indexOf('class="lighthouse"') < customer.indexOf('class="findings"'));
  assert.match(customer, /class="snapshots"/);
  assert.match(operator, /SEO: 92\/100/);
  for (const label of ['Performance 39/100', 'Accessibility 92/100', 'Best Practices 96/100']) assert.ok(customer.includes(`aria-label="${label}"`));
  assert.doesNotMatch(customer, /Requested:|Angefragt:|Mobile laboratory measurement, not a whole-site assessment/u);
  assert.match(customer, /Website checked/u);
  for (const value of [59, 60, 61]) {
    const targetScore = { code: 'pagespeed_category_score', category: 'performance', observed: `seo score: ${value}/100.`, evidence: [{ pageUrl: 'https://example.test/', observedAt: result.startedAt, source: 'pagespeed', value }] };
    const html = renderCustomerSummaryHtml({ ...result, target: 'https://example.test/', findings: [targetScore] }, 'en');
    assert.equal(html.includes(`aria-label="SEO ${value}/100"`), value < 60);
  }
  const page = renderCustomerSummaryHtml({ ...withScores, target: 'https://example.test/course' }, 'en');
  assert.match(page, /Tested page · Mobile/u);
  assert.doesNotMatch(page, /Homepage · Mobile/u);

});

test('PageSpeed scores require matching evidence and suppress conflicting duplicate categories', () => {
  const scoreFinding = (name, observedScore, value, path, requestedAt) => ({
    code: 'pagespeed_category_score', category: 'performance', severity: 'informational',
    observed: `${name} score: ${observedScore}/100.`,
    evidence: [{ pageUrl: `https://example.test${path}`, observedAt: requestedAt, source: 'pagespeed', value }],
  });
  const findings = [
    scoreFinding('performance', 77, 77, '/', '2026-10-30T14:40:00.000Z'),
    scoreFinding('performance', 77, 77, '/', '2026-10-30T14:51:00.000Z'),
    scoreFinding('accessibility', 90, 89, '/', '2026-10-30T14:51:00.000Z'),
    scoreFinding('best-practices', 88, 88, '/', '2026-10-30T14:51:00.000Z'),
    scoreFinding('best-practices', 89, 89, '/', '2026-10-30T14:52:00.000Z'),
    scoreFinding('seo', 91, 91, '/', '2026-10-30T14:51:00.000Z'),
  ];
  // Keep provenance admissible so this fixture isolates conflicting category scores.
  const html = renderCustomerSummaryHtml({ ...result, target: 'https://example.test/', startedAt: '2026-10-30T14:39:00.000Z', completedAt: '2026-10-30T14:53:00.000Z', findings, capabilities: { ...result.capabilities, pagespeed: 'complete' } }, 'en');
  assert.match(html, /aria-label="Performance 77\/100"/u);
  assert.doesNotMatch(html, /aria-label="SEO 91\/100"/u);
  assert.doesNotMatch(html, /aria-label="Accessibility 90\/100"|aria-label="Best Practices (?:88|89)\/100"/u);
  assert.equal((html.match(/class="score-card"/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /Requested:/u);
  assert.match(html, /Some measurements were unavailable/u);
});

test('PageSpeed panel suppresses all categories when their tested page identities differ', () => {
  const findings = [
    ['performance', 78, '/'],
    ['accessibility', 94, '/'],
    ['best-practices', 100, '/'],
    ['seo', 85, '/contact/'],
  ].map(([name, score, path]) => ({
    code: 'pagespeed_category_score', category: 'performance', severity: 'informational',
    observed: `${name} score: ${score}/100.`,
    evidence: [{ pageUrl: `https://example.test${path}`, observedAt: '2026-10-30T14:51:15.061Z', source: 'pagespeed', value: score }],
  }));
  const html = renderCustomerSummaryHtml({ ...result, target: 'https://example.test/', findings, capabilities: { ...result.capabilities, pagespeed: 'complete' } }, 'en');
  assert.equal((html.match(/class="score-card"/gu) ?? []).length, 0);
  assert.doesNotMatch(html, /aria-label="(?:Performance|Accessibility|Best Practices|SEO) \d+\/100"/u);
  assert.match(html, /refer to different pages and have been withheld/u);
});

test('PageSpeed measurements are withheld when their URL does not match the audit target', () => {
  const findings = [
    ['performance', 78], ['accessibility', 94], ['best-practices', 100], ['seo', 85],
  ].map(([name, score]) => ({
    code: 'pagespeed_category_score', category: 'performance', severity: 'informational',
    observed: `${name} score: ${score}/100.`,
    evidence: [{ pageUrl: 'https://example.test/', observedAt: '2026-10-30T14:51:15.061Z', source: 'pagespeed', value: score }],
  }));
  const html = renderCustomerSummaryHtml({ ...result, target: 'https://example.test/?token=private-target', findings }, 'en');
  assert.equal((html.match(/class="score-card"/gu) ?? []).length, 0);
  assert.match(html, /do not match the audited target page and have been withheld/u);
});

test('customer summary selects three topics by severity before editorial group priority', () => {
  const codes=['http_status_error','broken_internal_link','missing_canonical','missing_meta_description','title_long','missing_h1','heading_hierarchy_skip'];
  const findings=codes.map((code,i)=>({code,category:'content',severity:i===6?'critical':'low',observed:code,evidence:[{value:404,pageUrl:'https://example.test/offer/',source:'http',observedAt:result.startedAt}]}));
  for(const locale of ['en','de']) {
    const html=renderCustomerSummaryHtml({...result,findings},locale);
    assert.equal((html.match(/<article class="card">/g)??[]).length,3);

    const cards=html.slice(html.indexOf('<article class="card">'));
    assert.match(cards.split('</article>')[0],locale==='en'?/skip heading levels/:/überspringen Überschriftenebenen/);
  }
});
