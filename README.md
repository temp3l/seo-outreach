# SEO Outreach

A local TypeScript CLI that reads existing Webcrawl audit JSON or evidence ZIPs and writes review artifacts. Its analysis/report commands use saved evidence. The explicitly selected `outreach-crawl` compatibility command retains the former bounded crawler/report workflow. It does not send outreach messages or write to a CRM service. Reports start as **INTERNAL / HOLD**. Customer PDFs use the frozen styled `reports prepare/release` workflow; message drafts remain on hold for recipient and channel review.

## Frozen styled reports

The corrected A4/mobile design is frozen as `customer-pdf-v6-20261106`. Its renderer, pagination and reviewed references are protected by build, runtime and visual checks. See the [design contract](docs/pdf-design-contract.md). The shared implementation lives in `src/reports`. Use `reports prepare`, review both PDFs, then `reports release` to release the exact reviewed bytes. Use `reports handoff` with an explicitly reviewed caption to import one document into WhatsApp as NEEDS_REVIEW. Full commands and compatibility migration are in the [workspace README](../../README.md). The analysis-text PDF described below remains a separate legacy format and is not a styled-report fallback.

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

`--input` may be a Webcrawl `report.json` or an evidence ZIP. `--locale` accepts `en`, `es`, `de`, or `pt-BR`. Seller identity defaults to the existing private `.report-contact.json` publisher profile (name and email); `--report-contact-file` selects another profile. A seller name can also be supplied explicitly. Location is optional. If no seller identity is configured, draft text uses a name placeholder and is held for review.

A JSON-only audit has no corroborating page export. It is labeled `AUDIT_ONLY`; the CLI will not invent page evidence or produce a customer PDF from it. An evidence ZIP is marked `STRUCTURAL_ONLY`: the loader checks its fixed member order/names, local and central ZIP records, CRCs, member hashes, target identity, and exported/captured/omitted count consistency. This proves archive structure and integrity, not that every producer observation is semantically correct or that the crawl represents the whole site.

A standard PDF is emitted when one to six supported, distinct findings can be cross-referenced to the supplied page export. Aim for four to six meaningful findings; shorter supported reports are allowed without padding. The initial `report.pdf` remains marked **INTERNAL / HOLD**. A separate verifier reads its cross-reference table, page tree, content streams and complete localized text sequence before publication and again from the published bytes. `manifest.json` records the artifact hash and page count; this verifies the file, not customer readiness. An empty supported finding set produces no `report.pdf`. Partial crawl coverage and unrelated export truncation are recorded limitations. They do not invalidate a selected observation that is independently corroborated.

The `reportAssessment` field separates report preparation from approval: `READY_FOR_REVIEW` means a supported report can be reviewed; `APPROVED_WITH_LIMITATIONS` records an exact reviewed customer artifact with disclosed scope gaps; `BLOCKED` includes a specific reason. These states do not authorize outbound messages. `CUSTOMER_READY` remains HOLD until factual/coverage review and customer artifact verification complete; `OUTREACH_READY` is assessed separately.

## Outreach copy and buyer context

The existing optional provider request also produces the opener, after-interest reply and internal sales suggestions. There is no extra generation call. PDFs continue to use corroborated observations and fixed localized finding copy. The model aims for four to six relevant findings, with fewer allowed when evidence or relevance is insufficient.

Reuse the configured PDF publisher identity, or supply a seller name, and optionally `--outreach-context ./private/outreach-context.json` on `analyze` or `batch`. The context file is keyed by exact website hostname. Each entry accepts `buyerRole`, `businessType`, optional `businessName` (120 characters), and up to five `services` (120 characters each). A missing hostname or role stays unknown. Context is supplied by the operator; the package does not establish a prospect’s identity or business facts. See [the example](docs/outreach-context.example.json) for the format.

Supported roles: `unknown`, `owner`, `marketing_manager`, `ecommerce_manager`, `developer_agency`, `general_inbox`. Supported business types: `unknown`, `local_service`, `booking_business`, `ecommerce`, `b2b_service`, `multi_location`. Set only facts you know. Context is included in the provider request, saved analysis, and cache identity; avoid personal or confidential information. Seller/profile flags also work in batches; no location is required.

Generated openers must contain the supplied seller name, an exact supported observation and its selected page URL. Length, contact/markup, unselected-URL, pricing/quote, obvious guarantee and premature attachment checks can reject copy in favor of existing templates. These structural checks **do not prove the remaining prose is factual or suitable**. Review the complete message before use. Messages invite a discussion of findings or implementation and do not propose prices or quotes.

`outreach-review.json` records draft source (`LLM` or `TEMPLATE`), fallback reasons, supporting observation, context and unverified model sales suggestions. Generated content survives `render` without a new provider request. Analysis drafts have no customer attachment. Use the frozen styled release and document handoff to bind an approved attachment by byte count and checksum. The current WhatsApp sender automatically uploads the PDF carried by its approved document handoff; a person does not attach it in WhatsApp. Analysis review metadata is not itself a sender-importable handoff; the supported sender bundle uses the separate styled-report release contract. PDF approval does not approve the message. The initial report and every message remain internal and held for review.

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

The response must match the strict schema, locale, and issue IDs for this digest. Issue selections are independently validated and report findings use built-in localized copy. Generated message copy can be used in internal drafts after structural checks; it remains subject to factual and audience review. Recorded selections require the ZIP page export for corroboration; JSON-only audits cannot be upgraded by a recorded response.

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

When findings exist, the run also includes `whatsapp-opener.txt` and `whatsapp-after-interest.txt`, both labeled **INTERNAL / HOLD — DO NOT SEND**. They are drafts only; there is no recipient, consent, suppression, or sending integration. `report.pdf` is conditional on one to six cross-referenced findings and remains internal/held. A run with usable page URLs also includes an unapproved `customer-review.json` template. Legacy `render --customer-review` is rejected: customer PDFs must use the frozen styled workflow.

## Re-render

```sh
node dist/cli.js render \
  --analysis ./runs/site/analysis.json \
  --out ./runs/site-rerender
```

`render` reads the published analysis and original source again, checks the source fingerprint, then regenerates the artifacts in a new output directory. It accepts no provider flags or CRM snapshot path. Add `--dry-run` to inspect gates without writing.

## Review a customer report

The legacy `analyze` and `render` text PDFs are **internal review only**. Even an approved old `customer-review.json` cannot promote them; `render --customer-review` fails before creating output.

For customer documents, use the saved original audit JSON and the existing private publisher profile:

```sh
node dist/cli.js reports prepare \
  --audit /absolute/path/report.json \
  --report-contact-file /absolute/path/.report-contact.json \
  --out /absolute/private/directory/report
```

Review the resulting A4/mobile PDFs, complete the factual qualification and exact-byte review manifest, then use `reports release`. This is the same frozen renderer used for the Cape Town reports. See the [workspace workflow](../../README.md) and [design contract](docs/pdf-design-contract.md). Release never silently falls back to text PDFs. Customer approval does not approve sending.

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
- Initial reports stay INTERNAL/HOLD. A checksum-bound review of every selected finding is required for a customer PDF; schema validity or model output cannot approve it.
- No WhatsApp/email sending, contact eligibility decision, CRM network write, deployment or sales conversion is performed. `LIVE` readiness describes a validated completed provider receipt (including a zero-dispatch cache hit), independently of customer and outreach readiness.

Provider digests use `digest-v2` and prompt v6 so export omissions, field truncation and checker gaps participate in cache identity. Historical receipts retain their original keys; they are not migrated into the new prompt. Changed settings may require a new explicitly authorized generation, still subject to all existing caps. No historical ambiguous or accepted call is automatically retried.

Normalized evidence v2 also retains upstream contact confidence and unresolved-source provenance for internal review. Upstream suggestions never establish contact eligibility. Provider digest v2 excludes contact values and raw source text. The same request also includes fixed localized finding descriptions, supplied seller identity, and optional operator-supplied business context; these participate in cache identity.
