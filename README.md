# SEO Outreach

A local TypeScript CLI that reads existing Webcrawl audit JSON or evidence ZIPs and writes review artifacts. Its analysis/report commands use saved evidence. The explicitly selected `outreach-crawl` compatibility command retains the former bounded crawler/report workflow. It does not send outreach messages or write to a CRM service. Reports start as **INTERNAL / HOLD**. An explicit local review can authorize a separately verified customer PDF; message drafts remain on hold for recipient and channel review.

## Preserved styled reports

The current Webcrawl A4/mobile renderers, styles, assets and pagination now live in `src/reports`. Use `reports prepare`, review both PDFs, then `reports release` to release the exact reviewed bytes. Use `reports handoff` with an explicitly reviewed caption to import one document into WhatsApp as NEEDS_REVIEW. Full commands and compatibility migration are in the [workspace README](../../README.md). The analysis-text PDF described below remains a separate legacy format and is not a styled-report fallback.

New analysis artifacts include their hashed source snapshot (`seo-outreach-analysis-v2`), so a whole artifact directory can move without retaining the external input path. Existing v1 artifacts keep their previous behavior.

## Requirements and build

This repository tracks only the SEO outreach package. Keep it at `packages/seo-outreach` in the existing Spora workspace. The `@spora/webcrawl` dependency remains `workspace:*`; sibling packages, the shared lockfile and workspace tooling are managed outside this repository.

Requires Node.js 24.18.0 and pnpm 10.29.3. Install/build from the workspace root.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @spora/seo-outreach exec node dist/cli.js --help
```

The compiled CLI is `dist/cli.js`. Commands below assume they run from this package directory.

## Analyze one export

```sh
node dist/cli.js analyze \
  --input /data/crawl/site-evidence.zip \
  --out ./runs/site \
  --locale pt-BR \
  --seller-name "Your name" \
  --seller-location "Cumbuco"
```

`--input` may be a Webcrawl `report.json` or an evidence ZIP. `--locale` accepts `en`, `es`, `de`, or `pt-BR`. Seller identity is optional, but name and location must be supplied together. If omitted, draft text uses placeholders and is held for review.

A JSON-only audit has no corroborating page export. It is labeled `AUDIT_ONLY`; the CLI will not invent page evidence or produce a customer PDF from it. An evidence ZIP is marked `STRUCTURAL_ONLY`: the loader checks its fixed member order/names, local and central ZIP records, CRCs, member hashes, target identity, and exported/captured/omitted count consistency. This proves archive structure and integrity, not that every producer observation is semantically correct or that the crawl represents the whole site.

A standard PDF is emitted only when six supported, distinct findings can be cross-referenced to the supplied page export. The initial `report.pdf` remains marked **INTERNAL / HOLD**. A separate verifier reads its cross-reference table, page tree, content streams and complete localized text sequence before publication and again from the published bytes. `manifest.json` records the artifact hash and page count; this verifies the file, not customer readiness. Fewer findings means no `report.pdf`; it does not mean the site has no issues.

## Dry-run

```sh
node dist/cli.js analyze \
  --input /data/crawl/site-report.json \
  --out ./runs/dry-run \
  --locale en \
  --dry-run
```

Dry-run parses and summarizes the input, digest, gates, and provider state. It creates no output directory or artifacts and makes no network or provider calls. `batch` and `render` also accept `--dry-run`.

## Recorded output

A validated recorded provider response can be supplied offline:

```sh
node dist/cli.js analyze \
  --input /data/crawl/site-evidence.zip \
  --out ./runs/recorded \
  --locale en \
  --recorded /data/recorded-response.json
```

The response must match the strict schema, locale, and issue IDs for this digest. Independently validated issue selections and built-in localized finding copy are used; model prose is not treated as verified evidence. Recorded selections require the ZIP page export for corroboration; JSON-only audits cannot be upgraded by a recorded response.

## Batch

Create a manifest whose `inputs` are paths relative to the manifest file (absolute paths are also accepted):

```json
{"inputs":["./kite-school.zip","./dive-school/report.json"]}
```

Then run:

```sh
node dist/cli.js batch \
  --manifest /data/crawl/batch.json \
  --out ./runs/batch \
  --locale en \
  --crm-existing ./state/prospects.json
```

Batch preflights inputs and skips duplicate target identities with identical source bytes; conflicting sources for one identity are rejected. Each target gets a subdirectory under the output directory. Dry-run performs preflight without publishing artifacts.

## CRM snapshot input

`--crm-existing <prospects.json>` is optional on `analyze` and `batch` only. It supplies a local, read-only prior snapshot to merge with generated prospect records. The input is not modified; fresh `prospects.json` and `prospects.csv` are written under the output directory. The snapshot is not uploaded and no CRM API is called. `render` does not accept this flag.

## Outputs

A published run always includes:

- `analysis.json` — replay metadata and selected issue IDs.
- `manifest.json` — source/readiness gates, artifacts, and provider usage status.
- `sales-brief.md` — internal findings and limitations.
- `prospects.json` and `prospects.csv` — local CRM-oriented snapshot files.

When findings exist, the run also includes `whatsapp-opener.txt` and `whatsapp-after-interest.txt`, both labeled **INTERNAL / HOLD — DO NOT SEND**. They are drafts only; there is no recipient, consent, suppression, or sending integration. `report.pdf` is conditional on six cross-referenced findings and remains internal/held. A six-finding run with usable page URLs also includes an unapproved `customer-review.json` template. An approved render adds `customer-report.pdf`.

## Re-render

```sh
node dist/cli.js render \
  --analysis ./runs/site/analysis.json \
  --out ./runs/site-rerender
```

`render` reads the published analysis and original source again, checks the source fingerprint, then regenerates the artifacts in a new output directory. It accepts no provider flags or CRM snapshot path. Add `--dry-run` to inspect gates without writing.

## Review a customer report

Review the six findings and coverage in `report.pdf`. Copy `customer-review.json` outside its published directory before editing it; published files are immutable.

```sh
cp ./runs/site/customer-review.json ./runs/site-review.json
```

The template names each finding and its page. Set `coverageReviewed` to `true` after reviewing the stated limits, and set each finding's `approved` to `true` only when its factual observation, relevance and suggested action are suitable for the customer. A `noindex` finding also requires `indexingIntended: true`, meaning that page should appear in search. If its purpose is unknown or noindex is deliberate, leave the review unapproved; do not pad a six-finding report.

Then render to a fresh directory:

```sh
node dist/cli.js render \
  --analysis ./runs/site/analysis.json \
  --customer-review ./runs/site-review.json \
  --out ./runs/site-reviewed
```

The review is bound to the exact analysis and held PDF hashes. Rendering re-reads the original source, rechecks all selected observations and the held artifact, validates all six approvals, then independently verifies `customer-report.pdf` before marking `CUSTOMER_READY` as `READY`. The internal report retains its HOLD label. The review is a local operator assertion, not authenticated reviewer identity or automatic verification of business intent. Keep the completed review file with your records.

`--customer-review` works only on `render`. Without that explicit option, even replaying a reviewed output produces held artifacts. A dry-run validates the review but keeps customer readiness on HOLD until the customer artifact is rendered and verified. Customer readiness does not authorize sending; both WhatsApp files and prospect status stay HOLD. Approved-report drafts offer the reviewed report for manual attachment after interest.

## Optional provider call

Paid provider use is opt-in. It requires `--paid-call` together with all three flags below, plus `OPENAI_API_KEY` already set in the process environment or a secret manager:

```sh
node dist/cli.js analyze \
  --input /data/crawl/site-evidence.zip \
  --out ./runs/live \
  --locale en \
  --paid-call \
  --provider-config ./private/provider-config.json \
  --state ./private/provider-state.json \
  --batch-id review-2026-11-02
```

Never put an API credential in `--provider-config`, in a command-line argument, or in the config file. The config file contains exactly these fields:

- `model` (operator-verified model identifier), `timeoutMs`, `maxInputTokens`, `maxOutputTokens`.
- `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens`.
- `companyRequestCap`, `companyTokenCap`, `companyUsdCap`.
- `batchRequestCap`, `batchTokenCap`, `batchUsdCap`.
- `pricingConfirmedAt` (recent ISO timestamp) and `pricingSource`, exactly `https://developers.openai.com/api/docs/pricing`.
- `maxAttempts`, `overallDeadlineMs`, `maxRetryAfterMs`.

Pricing confirmation must be no more than seven days old. Caps, timeouts, tokens, and retry settings are validated before dispatch. The state file records reservations, outcomes, and validated cache entries. Ambiguous provider outcomes are not assumed to be safely replayable. `--dry-run` makes no provider call and strips paid-call authority before pipeline dispatch. A provider call does not authorize or send outreach. The current LIVE gate remains **HOLD** where evidence, configuration, budget, or other readiness requirements are not met; cost is `UNKNOWN` when usage cannot be verified. A token-usage cost calculated at standard rates is an estimate, not an invoice; cached-token pricing or billing adjustments may differ.

## Current limits

- Evidence coverage is limited to the supplied crawl/export. A successful crawl response does not establish a complete site inventory or search-engine behavior.
- Browser rendering is not enabled by this package. Some exports and checks are partial or omitted; inspect coverage counts and references.
- ZIP integrity checks are structural. They do not independently prove all upstream crawler semantics.
- Initial reports stay INTERNAL/HOLD. A checksum-bound six-finding review is required for a customer PDF; schema validity or model output cannot approve it.
- No WhatsApp/email sending, contact eligibility decision, CRM network write, deployment or sales conversion is performed. `LIVE` readiness describes a validated completed provider receipt (including a zero-dispatch cache hit), independently of customer and outreach readiness.

Provider digests use `digest-v2` and prompt v3 so export omissions, field truncation and checker gaps participate in cache identity. Historical receipts retain their original keys; they are not migrated into the new prompt. Changed settings may require a new explicitly authorized generation, still subject to all existing caps. No historical ambiguous or accepted call is automatically retried.

Normalized evidence v2 also retains upstream contact confidence and unresolved-source provenance for internal review. Upstream suggestions never establish contact eligibility. Provider digest v2 contains only fixed, bounded numeric checker/export summaries; it excludes contact values and raw source text.
