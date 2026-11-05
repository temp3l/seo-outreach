# Historical crawl-and-report workflow

The following is the pre-extraction Webcrawl documentation. Report imports now use `@spora/seo-outreach/reports`; combined commands are `outreach-crawl` / `outreach-sites`; campaign scripts are in `scripts/compat`. Paths and commands below describe the old layout. Follow the workspace README for the current reviewed release/handoff workflow.

# @spora/webcrawl

A modular Node.js toolkit for bounded website crawling, SEO analysis, optional enrichment, capture recording, and localized HTML/PDF reports.

> **Private alpha:** the package provides an HTTP crawler, robots/sitemap analysis, optional safe browser rendering, PSI and deterministic enrichments, English/German HTML/PDF reports, batch/resume CLI, and hash-validated recordings with offline replay. Robots rules are collected as observation-only evidence and never restrict crawling. Run scans only against targets you are authorized to audit; robots.txt is not authorization. Keep it private until a real external project validates adoption requirements and the licensing/support model is decided. PDF generation requires the optional Playwright package and Chromium runtime.

## Recommended support policy

- Node.js 24.x is the supported runtime; newer major versions require CI coverage before support is promised.
- One package with optional subpath exports; optional capabilities must not become mandatory runtime dependencies.
- Private distribution until a non-Spora project validates the API and licensing/support ownership are approved.
- Robots directives and retrieval outcomes are observed for reporting only; no robots mode gates requests. Operators are responsible for establishing authority to scan each target. Scope, request, response, total-byte, time, and concurrency limits remain explicit and bounded.
- PageSpeed Insights enrichment and PDF reports are enabled by default for single-site CLI runs; use `--no-pagespeed` and `--no-pdf` to disable them. Browser rendering remains opt-in. Batch remains findings-only and does not generate PDFs.
- Captures and reports are caller-owned artifacts. Contact observations are sensitive and must have explicit retention and deletion handling.

## Included capability areas

- HTTP and optional Playwright-rendered crawling; robots, sitemap, URL/DNS/redirect safety; bounded frontier, progress, partial-coverage accounting, and resume.
- Deterministic technical SEO and passive security analysis (response headers, mixed content, and sensitive form transport), robots analysis, technology detection, image checks, and provenance-bearing public-contact observations.
- Same-host broken-link detection and bounded image asset size checks; exact visited URL outcomes and per-check coverage counts are recorded in the JSON audit manifest.
- PageSpeed Insights enrichment, with an explicit opt-out.
- Versioned audit result and capture recording/replay, with in-memory and filesystem stores.
- Localized audit HTML and PDF reports, one-page customer briefings, internal operator status PDFs, WhatsApp outreach draft Markdown, and optional CLI/batch workflows.
- Adapters for caller storage, transport, browser, PSI credentials, report branding, and run persistence.

## API contract direction

The root and subpath exports are intentionally stable boundaries. Core results carry schema version, timestamps, capability status, evidence provenance, and explicit coverage limitations. A finding describes an observation; severity and recommendations are optional policy projections.

The package will not include campaign host allowlists, CRM behavior, or Spora database/provider integration. Those belong in consumer adapters. By default, robots.txt is observation-only: its bounded retrieval and rule observations are recorded without gating requests. Library callers may omit `policy.robots` or set it to `observation-only`; the compatible legacy `ignore` value is an alias. For HTTP/static crawls, use `--respect-robots` or `policy.robots: 'respect'` to enforce rules before requests, including redirect hops and optional probes. Unavailable robots policies and origins without an evaluated policy withhold requests; missing robots files permit otherwise admitted requests. Enforcement requires browser rendering OFF. Observation-only mode does not authorize requesting known prohibited paths. Valid operator authorization for a bounded public-page audit is sufficient without a universal website-owner permission-document requirement; applicable legal, robots and host-specific access restrictions still apply. Robots retrieval uses the normal bounded request and byte budgets, and may be unavailable or partial when scan budgets must be preserved. Crawls can also be partial because of access errors, server denials, budgets, rendering, discovery limits, or blocked resources. Robots directives can still help identify SEO configuration issues. With `renderBrowser: true`, every captured page is rendered in an isolated browser context and links discovered in its rendered DOM join the bounded crawl frontier. `renderBrowser: 'auto'` renders pages that have scripts, no HTTP-discovered anchors, and under 500 characters of visible HTTP text. Auto mode is a heuristic: it can miss applications that render links later or produce more initial text. Host scope, URL validation, SSRF/DNS/redirect containment, and request/resource limits apply in either mode.

## CLI

```sh
webcrawl https://example.com --browser --images
webcrawl https://example.com --browser=auto
webcrawl https://example.com --page-data ./page-data.json
webcrawl https://example.com --page-data ./page-data.json --page-data-html
webcrawl https://example.com --pages 300 --requests 900 --concurrency 3 --interval-ms 500 --total-bytes 500000000 --image-checks 100
webcrawl https://example.com
webcrawl --batch sites.csv --out ./audit-results --resume
```

For concurrent scans with the usual single-site reports, use `webcrawl-sites`.
It defaults to **four site jobs and one shared PDF worker**. Create a `jobs.json`
file containing ordinary CLI argument arrays, each starting with its URL and
including an `--out` prefix inside a separate directory for each site:

```json
[
  ["https://example.com/", "--out", "./private/example-com/crawl"],
  ["https://example.org/", "--out", "./private/example-org/crawl", "--profile", "fast"]
]
```

Create the output parent first, then run:

```sh
mkdir -m 700 ./private ./private/example-com ./private/example-org
webcrawl-sites ./jobs.json --site-concurrency 4 --pdf-concurrency 1
# From this checkout, after pnpm build:
node dist/cli/sites.js ./jobs.json --site-concurrency 4 --pdf-concurrency 1
```

Before starting any workers, the launcher resolves every job's profile and
checks all enabled output destinations together, including explicit exports
and aliases through symbolic links. Conflicting destinations, existing files,
and unsafe private export directories fail before crawling or publication.
Multi-site jobs also reject shared or nested site directories, symbolic-link
aliases of the same directory, and exports outside their site's directory.
Distinct flat prefixes such as `results/site-01` and `results/site-02` are
rejected; changing filenames alone does not isolate sites.

For programmatic runs, use the shared builder to create a fresh run directory
and private site folders. Pass the existing campaign index's `site_folder`
values so business slugs and candidate IDs remain stable across runs:

```js
import { createSiteJobs, runSiteJobs } from '@spora/webcrawl';
const jobs = await createSiteJobs(index.targets.map(target => ({
  url: target.seed_url, siteFolder: target.site_folder,
})), {
  outputRoot: './results/20261101T153605Z', // new directory; ./results exists
  args: ['--concurrency', '5', '--pdf', '--pagespeed'],
  pageData: true,
  evidencePack: true,
});
await runSiteJobs(jobs, { siteConcurrency: 10, pdfConcurrency: 1 });
```

Each site writes `crawl.json`, `crawl.pdf`, `crawl.run.log` and all other
enabled artifacts inside `results/<run-id>/<site_folder>/`. Existing run
directories are rejected rather than reused. Single-site CLI path behavior
is unchanged.

Both concurrency options accept integers from 1 to 32. The launcher starts
separate CLI processes and coordinates a FIFO PDF queue over IPC. Browser
preflight and each complete PDF group, including cleanup, share that queue.
Failed jobs release their permits and the remaining sites continue; the launcher
exits unsuccessfully if any job fails. Ctrl-C stops active workers and queued
sites. Every worker termination escalates from SIGTERM to SIGKILL after a
five-second grace period if needed; its PDF permit remains held until exit.
Workers also terminate if their launcher disappears during a crawl.
Site profiles, PageSpeed, image checks and report publication rules apply
normally. Waiting for a PDF permit does not consume crawl or render deadlines.
The limits apply to one launcher invocation; use it in place of independently
starting many single-site commands. Opt-in browser crawling is bounded by the
site-job limit and its crawl policy, separately from the PDF queue. The existing
CSV `--batch` mode remains a sequential, findings-only workflow.

Single-site PDF generation now reuses one Chromium browser for the report group,
with a fresh context for each render and bounded shutdown. Preflight still
launches separately and fails before crawling if Chromium is unavailable. A
successful default run uses two browser launches instead of five, preserving the
English/German publication checks and all three saved PDFs. Library consumers
can use the exported `withPlaywrightPdfSession(async renderer => { ... })` to
reuse a browser across their own report group; await all renders inside the
callback. The standalone `playwrightPdfRenderer` retains one browser per call.

For the offline-verified static single-site profile, use `--pages 250 --requests 500 --runtime-ms 900000 --response-bytes 20000000 --total-bytes 100000000 --concurrency 2 --interval-ms 1200 --retries 0`; PageSpeed Insights and PDF generation are enabled by default for single-site runs; use `--no-pagespeed` and `--no-pdf` to disable them. Browser rendering remains opt-in. The selected profile controls same-host image `HEAD` probes; use `--image-checks 50` to allow up to 50 probes or `--image-checks 0` to disable them. Batch mode uses its own fixed preset; single-site CLI flags do not configure batch runs. Any response-header latency warning is a crawler-vantage network heuristic, not user-perceived TTFB, CrUX p75, LCP, or a ranking signal. Offline engineering verification does not establish live production acceptance.

The single-site CLI reads `defaultProfile` from [`profiles.json`](./profiles.json) on every invocation. When `--profile` is omitted, that named profile supplies the crawl limits, pacing, retries, user agent, feature switches, and output choices. Edit the file and use `webcrawl --show-config` to inspect the current settings; no rebuild is needed. Retries count toward the same request, runtime, and response-byte budgets; three retries means at most four attempts per eligible request. The bundled `fast` profile inherits `default` and changes only the request-start interval; inspect `--profile fast --show-config` for its current value. Existing library and batch defaults are independent of CLI profiles.

```sh
webcrawl --list-profiles
webcrawl --profile fast --show-config
webcrawl https://example.com --profile default --out ./private/school
webcrawl --profile fast https://example.com --out ./private/school --pages 100
webcrawl --profiles-file ./my-profiles.json --profile research --show-config
```

Create the output parent first (use mode 0700 for private captures). The default profile produces `<out>.json`, `<out>.html`, and three PDFs; it does not create an evidence ZIP. Add `--evidence-pack <path.zip>` to opt in to an evidence ZIP for a run. Existing files are never overwritten. `--no-evidence-pack` disables a ZIP inherited from a custom profile. `--page-data <path.json>` requests a separate content artifact; setting `"page-data": true` in a profile uses `<out>.page-data.json`. `"page-data-html": true` adds bounded raw HTML only to that separate private artifact. PDF reports require the existing private publisher-contact configuration and Chromium. `--show-config` resolves profiles and CLI overrides without crawling, writing files, loading publisher details or launching Chromium.

The third PDF is a narrow, single-column customer report for phone reading: `<out>.mobile.pdf` in English or `<out>.mobile-de.pdf` in German. It carries the same evidence as the A4 report. PDFs have a clean customer layout; `<out>.review.json` holds the private HOLD decision and hashes of both customer PDFs. Review crawl coverage separately before distribution.

Add a profile directly to `profiles.json`, or use a separate file to avoid changing the package defaults:

```json
{
  "version": 1,
  "defaultProfile": "research",
  "profiles": {
    "research": {
      "extends": "fast",
      "description": "Smaller capture with separate page evidence",
      "pages": 100,
      "requests": 500,
      "page-data": true
    }
  }
}
```

Use `--profiles-file ./my-profiles.json` to load it. Custom entries are merged with the bundled profiles; profiles inherit the bundled default settings unless `extends` names another profile. `defaultProfile` chooses the profile when `--profile` is omitted. Unknown keys, invalid values, missing parents and inheritance cycles fail before crawling. Keys mirror CLI option names without `--`; see `profiles.json` for every supported option. `browser` accepts `false`, `true`, or `"auto"`; other feature switches use booleans. Numeric options retain the CLI's existing bounds. Profiles contain settings, not credentials; keep the PSI API key in `.env` and publisher details in the private contact file.

Explicit CLI flags override profile settings regardless of their position relative to the URL. Use `--no-pdf`, `--no-pagespeed`, `--no-contacts`, `--no-technology`, `--no-browser`, `--no-images`, `--no-security-txt`, `--no-evidence-pack`, `--no-progress`, `--no-page-data`, and `--no-page-data-html` to disable inherited features. `--no-page-data` also disables inherited raw HTML capture. PSI enabled through a profile does not permit sending query parameters by default; set `"pagespeed-include-query": true` or explicitly pass `--pagespeed` to opt in, and use `--no-pagespeed-include-query` to opt out. Profiles apply to single-site runs; batch rejects profile flags and retains its own fixed policy. The audit records the actual effective crawl policy and enabled checks.

For additional profiles, start by changing pacing, page limits, and output features. Use `--show-config` to review the effective settings before a run. The library API's `createDefaultCrawlPolicy(url, overrides)` continues to support independent policy overrides.
Passive security findings check common response headers, HTTP resources embedded in HTTPS pages, HTTP pages that remain on HTTP, and sensitive forms served or submitted over HTTP or to another origin. CSP checks also flag risky script sources and missing `object-src`/`base-uri` restrictions as review hints. Cookie checks retain only cookie names and security attributes; cookie values are discarded. `coverage.checks` reports checked, skipped, failed, and unattempted counts for security headers, mixed content, sensitive forms, cookies, and security.txt. These are static observations, not penetration tests; external form destinations may be expected and are marked low severity for review. Missing CSP is informational because a policy needs application-specific tuning. The optional `--security-txt` flag checks `/.well-known/security.txt` over HTTPS using the crawl's host and bounded request, time, and byte budgets; it is disabled by default so ordinary crawls make no extra request. It validates the response media type, UTF-8 encoding, Contact URI presence, and Expires date without storing the contact value.

`auditWebsite` discards captured HTML by default when no caller-supplied enrichment needs it; default contact extraction and seed-page CMS signal detection run as pages are captured and do not retain full HTML. It examines at most 2 MB of the captured HTTP seed page, without an extra request. Interior seed URLs are supported. A failed or oversized seed page leaves the check unavailable. Squarespace, GoDaddy Website Builder and Duda-family runtime signatures are supported; tracking scripts and isolated CDN images alone do not establish these platforms. CMS signals are not proof of the underlying platform; no signal means unknown. Use `--no-technology` to disable the seed-page check in single-site CLI runs, or `technology: false` in the API. Supplying another enrichment retains HTML during the enrichment call. The `AuditResult` still does not return page objects. Direct `crawlSite` calls retain HTML unless `retainHtml: false` is selected; when page-data collection is enabled, HTML is omitted from returned page objects by default. Setting `retainHtml: true` explicitly opts back in. Use `auditWebsiteWithPageData(config, options, enrichments)` for a separate content artifact from the same crawl.

The JSON result includes `coverage.urls` with each discovered page's outcome and HTTP status, `coverage.checks` with check-specific checked/failed/skipped counts, and `coverage.findings` with record, code, affected-page, evidence-occurrence, and per-code totals. `crawl.attempted` counts attempted page URLs; `crawl.physicalRequests` counts robots, sitemap, page, redirect, retry, and asset-probe requests. Finding record totals from different auditors are only comparable after aligning their check definitions and grouping semantics.

`robotsObservation` records the effective `observation-only` or `respect` policy and revision, robots retrieval state and sanitized error category, crawler user-agent evaluation scope, advisory allowed/disallowed/unknown counts over known discovered URLs, captured disallowed URL samples, and omitted sample count. It does not claim complete site discovery. Googlebot-specific evaluation is `NOT_VERIFIED` unless separately established from the fetched file.

The scan-status sidecar reports `executionStatus` separately from `coverageStatus`.
`executionStatus: COMPLETED` means eligible page work reached terminal outcomes; intentional robots exclusions do not prevent it when the seed was processed. Failed requests, unavailable robots policy, a withheld seed, unfinished URLs, and crawl limits still prevent completion. `coverageStatus: PARTIAL` records page coverage gaps, including robots exclusions and content that was intentionally not inspected. Optional checks, PageSpeed, and page-data export retain their own statuses. The existing `status` field keeps its legacy aggregate meaning for compatibility. Customer qualification continues to use audit coverage and does not accept execution completion as release approval.

Public audit APIs and both CLI modes collect bounded contact candidates by default from captured HTML and rendered DOM. Use `contacts: false` in the library or `--no-contacts` in the CLI to disable the capability; disabled runs have no contact inventory. Candidate values and evidence are private operator data in audit JSON and evidence ZIP. `contacts.status` describes inspection of captured HTML only, not complete site discovery or ownership verification. For future CRM use, derive CSV from JSON: select explicit inventory fields, quote each field by doubling embedded quotes and enclosing it in quotes, and prefix spreadsheet-formula-leading values (`=`, `+`, `-`, `@`, tab, or carriage return) with an apostrophe before quoting. Review the file before import; no CSV export or contact verification is provided here.

Request a bounded structured page-data artifact with `--page-data <json>` or a profile setting of `"page-data": true`; use `--no-page-data` to disable the separate artifact. An optional evidence ZIP can be combined with `--page-data <json>` to write both from the same capture. When an evidence ZIP is explicitly requested, `--page-data-html` keeps bounded raw HTML only in the separate private JSON and enables the default `<out>.page-data.json` path when no explicit path is supplied; raw page fields are forbidden in the five-member evidence ZIP. `auditWebsiteWithPageData` returns `{ audit, pageData }` for API consumers, while `crawlSite` accepts `pageData` options and returns the separate artifact. The corpus contains bounded visible text, page metadata, heading outline, anchor text/URLs, image alt and dimensions, JSON-LD types, capture modality, and SHA-256 source digests. Text (including body, title, description, headings, anchor text, image alt, and structured-data type names), headings, links, images, structured-data types, source bytes, and page counts have explicit limits; truncation is recorded per page and in the manifest. Its manifest binds to the audit with a digest and timestamps and is labelled `REVIEW_BEFORE_UPLOAD`. Defaults cap the export at 100 pages, 20,000 body-text characters per page, 1,000,000 total exported text characters, 5 MB per source page, and 100 MB total source bytes. Raw HTML is excluded by default; `includeRawHtml: true` or CLI `--page-data-html` opts into separately bounded HTML. Sensitive query parameters are removed from exported links and page URLs; invalid page URLs are omitted. Treat page content as untrusted input and page-data artifacts as private: public pages can still contain personal information. Files are published mode 0600, but callers must choose an operator-owned private directory. The recording stores accept generic JSON payloads, validate audit-shaped payloads, and have a 2 MB cap; page data remains a separate file under the caller's retention and deletion policy. Batch mode remains findings-only; use the single-site CLI or `auditWebsiteWithPageData` when page content is required.

The single-site CLI generates PDFs by default and requires publisher contact before crawling: use `--report-contact-file` or a private package-local `.report-contact.json` (0600). Ordinary crawls remain HOLD preview producers. Every single-site run also writes `<out>.whatsapp-draft.md`; batch runs write a matching draft beside each JSON result. Drafts use traceable archived observations where eligible, keep recipient review required and select no recipient or send target. The default draft may name the preview artifact; a released report still does not approve a message. The customer PDF body includes safe evidence links with query values withheld. Client-facing issuer details are explicitly configured, never copied from website contacts. The exported `renderCustomerSummaryPdf` and `renderOperatorStatusPdf` APIs accept a caller-supplied renderer. PDF output requires Playwright and Chromium. PageSpeed Insights runs by default; use `--no-pagespeed` to disable it. For query-bearing targets, the default reports PageSpeed as unavailable rather than transmitting the query. `--pagespeed` enables the provider, while the separate `--pagespeed-include-query` flag is required to send a query-bearing target to Google. The CLI loads its package-local `.env`; `PAGESPEED_API_KEY` is optional. Existing report files are never overwritten. Browser requests remain subject to the crawler URL, DNS, host and byte safety checks.

### Offline customer report release

Normal scans and batch runs never release customer reports. An operator can create a local report set from a saved, reviewed audit and an explicit qualification file after business identity, coverage and security have been reviewed. The declaration is trusted operator input; the package checks that it names and hashes this exact audit but does not independently verify business identity.

The qualification JSON has exactly these fields:

```json
{"decision":"RELEASE","target":"https://example.test/","auditSha256":"<audit hash>","qualifiedAt":"2026-11-01T12:00:00.000Z","qualifiedBy":"Reviewer name","businessIdentity":"VERIFIED","coverage":"ACCEPTED","security":"CLEARED"}
```

For a synthetic example, use the exported helper to hash the saved audit object before writing the qualification. Keep the audit, qualification, issuer file and destination in operator-owned private storage:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { auditResultSha256 } from './dist/reports/qualification.js';
const audit = JSON.parse(await readFile('/private/synthetic/audit.json', 'utf8'));
const qualification = {
  decision: 'RELEASE', target: audit.target, auditSha256: auditResultSha256(audit),
  qualifiedAt: new Date().toISOString(), qualifiedBy: 'Synthetic reviewer',
  businessIdentity: 'VERIFIED', coverage: 'ACCEPTED', security: 'CLEARED',
};
await writeFile('/private/synthetic/qualification.json', JSON.stringify(qualification), { mode: 0o600 });
```

For clean saved PDFs, use the [prepare and exact-byte review workflow](docs/customer-review-preparation.md). The following compatibility command renders a new set after qualification. Run the offline publisher after building. Local PDF verification requires `pdftotext` in addition to Playwright and Chromium. It reads local files only, creates both A4 locales and one selected mobile locale, and writes a manifest last. Every destination must be new; nothing is overwritten:

```sh
node scripts/release-customer-reports.mjs \
  --audit /private/synthetic/audit.json \
  --qualification /private/synthetic/qualification.json \
  --report-contact-file /private/synthetic/issuer.json \
  --out /private/synthetic/customer-review \
  --pdf-locale en
```

Outputs are `<out>.en.pdf`, `<out>.de.pdf`, `<out>.mobile-en.pdf` (or `<out>.mobile-de.pdf`), `<out>.whatsapp-draft.md`, and `<out>.release.json`, all created exclusively with private file permissions. `CLIENT_READY` in the manifest describes only local report artifact release. The draft still has a null recipient and outbound approval false. Sending requires a separate consumer to verify the recipient, confirm opt-in and a permitted channel, apply suppression and opt-out, prevent duplicate sends, track provider delivery, and provide a stop control. See the [WhatsApp Business policy](https://business.whatsapp.com/policy) for business-initiated messaging requirements, including verified opt-in, opt-out and approved templates.

If qualification expires during rendering, publication fails before creating artifacts. A later write or verification failure can leave a partial set; stderr lists already-created paths using safe error categories. No success manifest is written for an incomplete set. Preserve those files for review and use a new output prefix when retrying.

## Development

Customer reports select up to three supported discussion priorities in full-width rows on a readable A4 page. Default output is
always HOLD; release requires a matching explicit qualification and validated
evidence. The operator PDF retains its A4 technical layout. Topics are ordered
by severity, then editorial priority and affected-page count.
This review sequence is not a claim about
rankings, Google indexation, revenue or booking impact.

Routine heading, title, description and missing-canonical observations on pages
with an observed noindex directive are excluded from customer SEO counts,
and priorities. The audit and operator report retain the complete evidence;
the original audit, evidence ZIP and technical operator report retain all findings.
Noindex itself remains a review item, particularly on important offer pages.
Security, broken links, image accessibility and performance checks are not
suppressed by this rule. Remaining pages are not claimed to be Google-indexed.

The static content profile parses HTML media types only. `application/xhtml+xml`
is retained as captured response evidence where requested, but its DOM checks
and extracted fields are marked uninspected because this tool does not implement
XML parsing. Responsive image candidates declared through `srcset` or `picture`
are likewise not selected or fetched; image coverage reports that limitation
instead of treating those images as invalid. Ordinary HTML and `img src`
observations remain available.

`--pdf` uses the private package-local `.report-contact.json` by default. To override
the publisher details, add `--report-contact-file /private/issuer.json`. The owned,
non-symlink JSON file must be private (0600), at most 8 KiB, and contain
`{"name":"Your verified name","company":"Your business","email":"your verified reply email"}`
using your own verified values. Optional fields are `phone` and an HTTPS `website`.
A meaningful name/company and at least one valid reply channel are required.
Invalid contact input fails preflight before crawling. Contact settings apply
only to the customer PDFs, never to the audit JSON or evidence ZIP. No website
contact is substituted for the publisher. The library accepts the same `issuer`
object in `renderCustomerSummaryHtml(audit, locale, {issuer, qualification})`
and `renderCustomerSummaryPdf(audit, renderer, {locale, issuer, qualification})`.
The qualification must match the exact audit using `auditResultSha256` and pass
the evidence, freshness, coverage and security checks described above. The legacy
`clientReady` boolean is ignored; it cannot authorize release. Without a valid
qualification, library output remains HOLD. The regular CLI preserves audit outputs and renders clean private review PDFs. Approval status is recorded in `<out>.review.json`, not printed on the customer pages. A positive review can release those exact bytes using `--review-manifest`, without another render. Changed PDF bytes invalidate the review binding. Unreadable layouts fail the layout check. Publisher details and all
evidence still need operator review. A report release is not recipient or send
approval.

Explicit `--page-data <path>` and raw `--page-data-html` exports require an
operator-owned private output parent (normally mode 0700, with owner write/search
access and no group/other permissions). Preflight rejects unsafe parents before
crawling; every single-site output parent is also checked for write/search access.
The default non-raw page-data output keeps its existing directory behavior.
These checks do not change the crawl request trace or enable browser/PageSpeed.
Evidence ZIPs use a closed page-field schema, including nested evidence records;
unknown private fields cannot be carried through that projection. Existing safe
schema-1 ZIPs without the newer `rawSource` declaration remain verifiable.
Private JSON readback checks its full prepared-content digest as well as audit
binding and counts.

```sh
pnpm install
pnpm test
```

`pnpm test` builds `dist` before running the test suite. Use `pnpm typecheck` or `pnpm build` separately when you only need that check or build.

HTTP text interpretation supports identity and gzip Content-Encoding, with a streaming
decoded-byte limit equal to the consumer's response-byte cap, independently of wire
and total transfer budgets. Other codings, malformed streams and decoded overflows
are explicitly uninspected: HTML becomes a failed page outcome (and limited audit
coverage), robots becomes unavailable advisory evidence, and sitemaps carry a failed
observation. UTF-8 remains the text charset assumption. Raw SafeResponse bodies and
wire-byte accounting are unchanged; HEAD/image probes are not decompressed.

Each safeGet physical attempt starts its timeout before DNS, after scheduler pacing,
and dispatch receives only the remaining time. Retry attempts and redirect hops get
their own deadline. Built-in HTTP requests are destroyed on timeout. Noncooperative
injected resolver/transport work may continue internally, but the wrapper settles and
late DNS completion cannot dispatch. Sitemap candidates and robots sitemap references
pass URL admission before discovery or persistence; rejected values are never retained,
and rejection counts are separate from URL-count truncation.

Optional browser rendering uses Chromium request interception for every redirect
hop; URL/DNS admission, GET-only method policy and shared physical-request/byte
budgets still apply. Module imports and navigation resolve against the redirected
URL. Blocked, failed or pending resources make browser/content coverage partial;
pending transport work is cancelled after the bounded snapshot. The raw transport
body is decoded with the shared bounded identity/gzip decoder before browser
fulfillment. Browser and PDF setup, capture and cleanup have owned deadlines.
Noncooperative injected work can outlive a settled wrapper; late resource
acquisitions are closed, and late rejections are handled. These are offline
engineering controls, not blanket browser/PDF production certification.

Custom enrichments may optionally declare `requirements`: `input: 'target' | 'html'`,
`source: 'selected' | 'http'`, `timeoutMs`, and `maxInputBytes`. Legacy adapters
default to selected HTML. Target-only adapters receive no retained page HTML.
HTML inputs carry `source: 'http' | 'rendered-dom'`; an aggregate input-byte cap
omits whole page inputs and records partial/unavailable coverage. Adapter deadlines
default to 60 seconds and are capped by the remaining configured runtime.
Cancellation is cooperative for synchronous JavaScript: a deadline cannot preempt
a blocking adapter, but a late result is rejected. Use process isolation for
untrusted executable adapters. Public `inspectPage`/`analyzePage` select
`renderedHtml` when present (including an empty rendered snapshot); HTTP-only
analysis can be requested by omitting that property.

### Run logs and progress

Every single-site CLI run writes `<out>.run.log` beside its audit and reports.
The default profile also mirrors progress to stderr; `--progress` enables console
progress explicitly and `--no-progress` silences it without disabling the saved log.
Logs are written incrementally with private permissions (`0600`) and include a
heartbeat every 10 seconds, phase timing, captured/discovered/failed page counts,
physical request counts, HTTP error statuses, retry attempts, cooldown deadlines,
PageSpeed/image enrichment progress, PDF/ZIP phases, and the final complete,
partial, or failure status. Output paths are printed to stdout after publication.

For example, `webcrawl https://example.test --out ./review/site --progress`
writes `./review/site.run.log`; the `./review` directory must already exist.
Follow it with `tail -f ./review/site.run.log`. Use a new output prefix for each
single-site run, including after a failed run that already created a log.
Preflight validation errors before the output paths are accepted remain on stderr.

Scan completion describes whether URL requests reached recorded outcomes. Received
HTTP 401 responses and captured 403, 404 and 410 responses do not by themselves make a scan incomplete.
Authentication challenges (401), including non-HTML responses, remain captured
HTTP findings and are counted as `authenticationRequiredUrls` in
`<out>.scan-status.json` and `authentication_required` in the run log. Protected
content remains uninspected, with partial content/check coverage reported separately.
Transport failures, rate limits and unattempted URLs still make scans incomplete;
a failed seed fetch produces `FAILED`. Saved audit and status files retain their
original classifications until explicitly re-evaluated.

Batch runs support console progress by default and write `batch.run.log` plus
`<site-output-stem>.run.log` inside the batch output directory. `--no-progress`
suppresses batch console progress too. Resumed batches append a new run and mark
verified saved results as reused, without crawling them again. Batch completion counts CSV rows, including duplicate rows that reuse one saved audit. Logs omit page
URLs, query values, response bodies, extracted contacts, issuer details, and raw
exception messages. No additional website requests are made for logging. If a
log write fails after opening, the run continues and warns on the console.

Generic JSON capture recordings remain supported by MemoryRecordingStore and FileRecordingStore, within their existing size and digest limits. Audit-shaped payloads additionally require valid audit structure, target and completion-time identity; audit replay accepts only audit payloads. Contact observations and provenance are retained privately by default even when full HTML is omitted. Use `contacts: false` or `--no-contacts` to opt out, and apply access, retention and deletion policies to saved artifacts.

Built-in cross-page link, image and duplicate-metadata findings admit up to 10,003 evidence rows for the supported 10,000-page crawl ceiling and origin/target overhead. Custom enrichment results remain capped at 1,000 rows per finding. Structural audit admission does not guarantee storage eligibility: the 2 MB recording limit and evidence ZIP byte limits apply independently, and oversized artifacts fail explicitly without truncating identities or splitting findings.
