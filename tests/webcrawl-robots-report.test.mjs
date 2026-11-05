import test from 'node:test';
import assert from 'node:assert/strict';
import {auditWebsite} from '@spora/webcrawl';
import {DEFAULT_CRAWL_LIMITS} from '@spora/webcrawl/core/defaults';
import {renderAuditHtml} from '../dist/reports/html.js';
function fixture(mode = 'respect', robotsStatus = 200, seed = '/') {
  const dispatched = [];
  const methods = [];
  return { dispatched, methods, config: {
    startUrl: `https://fixture.test${seed}`, pagespeed: false, checkSecurityTxt: true, includeSitemapEvidence: true,
    policy: { ...DEFAULT_CRAWL_LIMITS, allowedHosts: ['fixture.test', 'other.test'], robots: mode, maxPages: 30, maxRequests: 100, maxRuntimeMs: 10000, maxConcurrency: 5, minRequestIntervalMs: 0, maxRetries: 0, maxResponseBytes: 100000, maxTotalResponseBytes: 10000000 },
    resolveAddresses: async () => ['93.184.216.34'],
    request: async (url, _addresses, options) => {
      dispatched.push(url.href);
      methods.push({url:url.href,method:options.method});
      const path = url.pathname;
      const body = path === '/robots.txt' ? 'User-agent: *\nDisallow: /blocked\nDisallow: /*/action~*\nDisallow: /*secret=*\nDisallow: /.well-known/security.txt\nSitemap: https://fixture.test/map.xml'
        : path === '/map.xml' ? '<sitemapindex><sitemap><loc>https://fixture.test/blocked-child.xml</loc></sitemap><sitemap><loc>https://fixture.test/child.xml</loc></sitemap></sitemapindex>'
        : path === '/child.xml' ? '<urlset><url><loc>https://fixture.test/blocked-map</loc></url><url><loc>https://fixture.test/diving</loc></url><url><loc>https://fixture.test/sitemap-commercial</loc></url></urlset>'
        : path === '/' ? '<a href="/diving">Diving</a><a href="/blocked-link">x</a><a href="/calendar/action~week/">x</a><a href="/?secret=private">x</a><a href="/redirect">x</a><a href="/unknown">x</a><a href="https://other.test/foreign">Foreign</a><img src="/blocked-image"><img src="/permitted-image"><a href="/allowed-redirect">Rates</a>' : '<h1>Commercial diving</h1>';
      return { status: path === '/robots.txt' ? robotsStatus : ['/redirect','/unknown','/allowed-redirect'].includes(path) ? 302 : 200, headers: { 'content-type': path === '/permitted-image' ? 'image/png' : path.endsWith('.xml') ? 'application/xml' : 'text/html', ...(path === '/redirect' ? { location: '/blocked-hop' } : path === '/unknown' ? { location: 'https://other.test/' } : path === '/allowed-redirect' ? { location: '/rates' } : {}) }, body: Buffer.from(body) };
    }
  }};
}
test('HTML reports describe the effective robots policy in English and German', async () => {
  for (const mode of ['respect', 'observation-only']) {
    const { config } = fixture(mode);
    const audit = await auditWebsite({ ...config, contacts: false, technology: false });
    const en = renderAuditHtml(audit, { locale: 'en' });
    const de = renderAuditHtml(audit, { locale: 'de' });
    assert.ok(en.includes(`robots.txt: ${mode}`));
    assert.ok(de.includes(`robots.txt: ${mode}`));
    assert.equal(en.includes('Robots admission enforced'), mode === 'respect');
    assert.equal(de.includes('Robots-Regeln werden durchgesetzt'), mode === 'respect');
    assert.equal(de.includes('Regeln verhindern keine anderweitig zulässige Anfrage'), mode === 'observation-only');
  }
});
