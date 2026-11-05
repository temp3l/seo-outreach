import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPage } from '@spora/webcrawl/analysis/technical';
import { observeSetCookieHeaders } from '@spora/webcrawl/core/cookie-observation';
import { renderAuditHtml } from '../dist/reports/html.js';

function page(html, overrides = {}) {
  return {
    requestedUrl: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    statusCode: 200,
    contentType: 'text/html',
    fetchedAt: '2026-10-29T00:00:00.000Z',
    responseBytes: Buffer.byteLength(html),
    html,
    ...overrides,
  };
}

function codes(result) { return result.findings.map((finding) => finding.code); }

test('security response header checks accept effective baseline protections', () => {
  const result = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: {
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      contentSecurityPolicy: "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'",
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'strict-origin-when-cross-origin',
    },
  }));
  assert.deepEqual(result.findings.filter((finding) => finding.category === 'security'), []);
});

test('sensitive forms include external form-associated controls and only submitter overrides', () => {
  const html = '<form id="profile" action="/save"></form><input form="profile" type="email" name="email"><button form="profile" type="submit" formaction="https://payments.example/submit">Pay</button><button form="profile" type="button" formaction="http://irrelevant.example/">No submit</button>';
  const findings = inspectPage(page(html)).findings;
  const offsite = findings.find((item) => item.code === 'sensitive_form_to_external_origin');
  assert.equal(offsite?.evidence[0]?.value, 1);
  assert.equal(findings.some((item) => item.code === 'sensitive_form_over_http'), false);
});

test('security response header checks report missing, inactive, and unsafe values with evidence', () => {
  const result = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: {
      strictTransportSecurity: 'max-age=0',
      contentSecurityPolicyReportOnly: "default-src 'self'",
      xContentTypeOptions: 'nosniff, invalid',
      referrerPolicy: 'unsafe-url',
    },
  }));
  const findingByCode = new Map(result.findings.map((finding) => [finding.code, finding]));
  assert.ok(findingByCode.has('hsts_missing_or_inactive'));
  assert.ok(findingByCode.has('missing_nosniff_header'));
  assert.ok(findingByCode.has('unsafe_referrer_policy'));
  assert.ok(findingByCode.has('csp_report_only'));
  assert.ok(findingByCode.has('missing_frame_protection'));
  assert.equal(findingByCode.get('unsafe_referrer_policy')?.evidence[0]?.pageUrl, 'https://example.com/page');
});

test('HTTP request URLs that remain on HTTP are reported', () => {
  const result = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    requestedUrl: 'http://example.com/page',
    finalUrl: 'http://example.com/page',
  }));
  assert.ok(codes(result).includes('http_page_not_upgraded'));
  assert.ok(!codes(result).includes('hsts_missing_or_inactive'));
});

test('Referrer-Policy fallback lists are assessed by their effective last recognized value', () => {
  const safeFallback = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: { referrerPolicy: 'unsafe-url, strict-origin-when-cross-origin', contentSecurityPolicy: "frame-ancestors 'self'" },
  }));
  assert.ok(!codes(safeFallback).includes('unsafe_referrer_policy'));
  const unsafeEffective = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: { referrerPolicy: 'strict-origin-when-cross-origin, unsafe-url', contentSecurityPolicy: "frame-ancestors 'self'" },
  }));
  assert.ok(codes(unsafeEffective).includes('unsafe_referrer_policy'));
});

test('CSP quality hints cover inline/eval sources and missing base/object restrictions', () => {
  const unsafe = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: { contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:" },
  }));
  for (const code of ['csp_unsafe_inline_script', 'csp_unsafe_eval', 'csp_broad_script_sources', 'csp_object_src_not_disabled', 'csp_base_uri_not_restricted']) assert.ok(codes(unsafe).includes(code), code);
  const nonce = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: { contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline' 'nonce-abcd'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" },
  }));
  assert.ok(!codes(nonce).includes('csp_unsafe_inline_script'));
});

test('combined enforced CSP policies account for their intersection before reporting quality hints', () => {
  const result = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    securityHeaders: { contentSecurityPolicy: "default-src *; script-src * 'unsafe-inline' 'unsafe-eval' https:; object-src https:; base-uri *\ndefault-src 'self'; script-src 'self' 'nonce-abcd'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" },
  }));
  for (const code of ['csp_unsafe_inline_script', 'csp_unsafe_eval', 'csp_broad_script_sources', 'csp_object_src_not_disabled', 'csp_base_uri_not_restricted', 'missing_frame_protection']) assert.ok(!codes(result).includes(code), code);
});

test('mixed active and passive HTTP resources are found without flagging ordinary links', () => {
  const html = '<html><head><script src="http://cdn.example/script.js"></script><link rel="stylesheet" href="http://cdn.example/site.css"></head><body><img src="http://cdn.example/image.jpg"><div style="background:url(http://cdn.example/background.jpg)"></div><a href="http://external.example/">External link</a><img src="data:image/png;base64,abc"></body></html>';
  const result = inspectPage(page(html, { securityHeaders: {
    strictTransportSecurity: 'max-age=31536000', contentSecurityPolicy: "frame-ancestors 'none'", xContentTypeOptions: 'nosniff', referrerPolicy: 'no-referrer',
  } }));
  const mixedActive = result.findings.find((finding) => finding.code === 'mixed_active_content');
  const mixedPassive = result.findings.find((finding) => finding.code === 'mixed_passive_content');
  assert.equal(mixedActive?.evidence[0]?.value, 2);
  assert.equal(mixedPassive?.evidence[0]?.value, 2);
  assert.ok(!codes(result).includes('mixed_content_link'));
});

test('sensitive forms are flagged for HTTP transport and off-site submission', () => {
  const insecure = inspectPage(page('<html><body><form action="/submit"><input type="password" name="password"></form></body></html>', {
    finalUrl: 'http://example.com/login',
  }));
  assert.ok(codes(insecure).includes('password_form_on_http'));
  assert.ok(codes(insecure).includes('sensitive_form_over_http'));
  assert.ok(!codes(insecure).includes('hsts_missing_or_inactive'));

  const external = inspectPage(page('<html><body><form action="https://forms.example/submit?token=do-not-log"><input name="card_number"></form></body></html>', {
    securityHeaders: {
      strictTransportSecurity: 'max-age=31536000', contentSecurityPolicy: "frame-ancestors 'self'", xContentTypeOptions: 'nosniff', referrerPolicy: 'same-origin',
    },
  }));
  assert.ok(codes(external).includes('sensitive_form_to_external_origin'));
  assert.ok(!external.findings.some((finding) => JSON.stringify(finding).includes('do-not-log')));
});

test('cookie attribute findings use name and flags without retaining cookie values', () => {
  const result = inspectPage(page('<html><body><h1>Page</h1></body></html>', {
    cookieObservations: [
      { name: 'sessionid', secure: false, httpOnly: false, sameSite: 'none', sessionLike: true },
      { name: 'analytics', secure: false, httpOnly: false, sameSite: undefined, sessionLike: false },
    ],
  }));
  const findings = result.findings.filter((finding) => finding.code.startsWith('session_cookie_') || finding.code.startsWith('cookie_'));
  assert.deepEqual(findings.map((finding) => finding.code).sort(), ['cookie_samesite_none_without_secure', 'session_cookie_missing_httponly', 'session_cookie_missing_secure'].sort());
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes('secret-cookie-value')));
});

test('cookie observer recognizes common session names and reports bounded omissions', () => {
  const observed = observeSetCookieHeaders(['sessionid=private; Secure; HttpOnly', 'analytics=ignored', `${'x'.repeat(5_000)}=large`]);
  assert.equal(observed.observations[0]?.sessionLike, true);
  assert.deepEqual(observed.observations.map((cookie) => cookie.name), ['sessionid', 'analytics']);
  assert.equal(observed.truncated, true);
  assert.ok(!JSON.stringify(observed).includes('private'));
});

test('HTML reports render check status and checked/skipped security coverage', () => {
  const local = { status: 'complete', discovered: 1, checked: 1, findings: 0, failed: 0, skipped: 0, unattempted: 0 };
  const sameHost = { ...local, scope: 'same_host', outOfScope: 0 };
  const html = renderAuditHtml({
    schemaVersion: '1', startedAt: 'start', completedAt: 'done', target: 'https://example.com/',
    crawl: { discovered: 1, attempted: 1, captured: 1, failed: 0, skipped: 0, unattempted: 0, limitations: [] }, capabilities: {}, findings: [],
    coverage: { urls: [], checks: { internalLinks: sameHost, imageSizes: sameHost, securityHeaders: local, mixedContent: local, sensitiveForms: local, cookieAttributes: local, securityTxt: { ...local, status: 'disabled', discovered: 0, checked: 0 } }, findings: { records: 0, checkCodes: 0, affectedPages: 0, evidenceOccurrences: 0, byCheck: [] } },
  });
  assert.match(html, /Security headers: complete; 1\/1 checked/u);
  assert.match(html, /Cookie attributes: complete; 1\/1 checked/u);
  assert.match(html, /security\.txt: disabled; 0\/0 checked/u);
});
