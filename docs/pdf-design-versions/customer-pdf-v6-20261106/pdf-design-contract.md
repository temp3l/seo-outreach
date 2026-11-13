# Frozen customer PDF design — customer-pdf-v6-20261106

**Status: approved and frozen by the user.** The [approval record](pdf-design-approval.json) binds the exact reviewed A4/mobile PDFs and design lock by SHA-256. These are the authoritative v6 references; future design changes require an explicit user request.

This v6 revision implements the user’s explicit request to center the summary badge group on A4 and mobile. Single-row fit, font sizes, copy, counts, card layout and final-page-only footer are preserved. The full previous contract and inputs are preserved in [the v5 archive](pdf-design-versions/customer-pdf-v5-20261106/README.md). The current reference PDFs and PNGs live in [tests/fixtures/report-golden](../tests/fixtures/report-golden).

## Fixed presentation

- A4 is 210 × 297 mm. Mobile is 108 × 280 mm.
- Dark blue headers and footers reach the horizontal page edges. The first header meets the top; the final footer meets the bottom. No outer vertical padding.
- Body gutters are 12 mm on A4 and 6 mm on mobile.
- Use two equal-width A4 card columns for two to six selected topics, and one full-width card for a single topic. Mobile cards remain stacked.
- Show “pages”, “SEO findings”, and “topics” as three compact summary badges centered together within the content area. Keep their existing readable font sizes, allow a natural wrap only when values cannot fit, and never force overflow. “SEO findings” keeps the deduplicated customer-reportable individual issue count.
- Preserve fonts, colors, finding cards, spacing and score gauges from the references.
- Every mobile page has a domain header. The publisher contact footer appears only on the final page; earlier pages have no footer.
- The closing invitation and contact details appear once, inside the final footer, above its contact strip. Keep a finding on the closing page.
- Findings must not disappear, overlap the footer, or be clipped to make content fit. Reject oversized content.

## One styled implementation

`src/reports/customer.ts`, `customer-pt.ts`, `mobile.ts`, `summary.ts`, and `pdf-playwright.ts` own the design. `reports prepare`, `reports release`, `outreach-crawl`, and the `@spora/seo-outreach/reports` API share it. The legacy `analyze/render` text PDF stays internal; its customer-review promotion is rejected with instructions to use `reports prepare/release`. Existing publication and evidence requirements still apply; a design ID grants no factual or outbound approval.

## Enforcement

`report-design.lock.json` binds customer CSS/footer templates, pagination and render-guard sources, the visual checker, references, and design tests by SHA-256. Builds, typechecking and packing reject changed files. There is no update or bypass flag. A runtime style fingerprint rejects alternate colors, padding or injected styles before rendering. Chromium checks page edges, footer placement and containment for the actual content. The normal test suite compares rendered pixels, text, fonts, links, page count and geometry against the reviewed references; it also proves an intentional color change fails. The visual environment is pinned in the reference manifest; an environment mismatch fails instead of silently accepting new images.

Factual content, dates, website identities, supported findings, PSI results and publisher details vary per report. The design is fixed. The synthetic visual fixture pins the scope paragraph to its reviewed wording while exercising the current template, styles and pagination. This isolates design comparisons from editorial scope-copy changes; the reference images remain fixed. Customer finding selection and factual copy can change independently: the customer modules lock their CSS and footer template, while the pagination and render guards are locked in full. Any layout change still requires an explicitly approved new design revision.

## Deliberate future revision

Only an explicit request from the user to change the design authorizes a revision. Preserve this version and its references, make the requested change separately, render and visually inspect every page of the fixtures and representative real reports, run the complete checks, and publish a new versioned contract. Never replace references merely because current output differs.

## Counting individual issues

The badge counts customer-reportable individual issues before the six-topic selection limit. Repeated finding records, evidence sources and timestamps do not increase the count. The same check on five distinct affected pages counts as five issues. Alias codes share an identity. Broken links use referring page plus destination; confirmation evidence for that destination is not an additional issue. Asset probe findings count one per affected asset. Query variants retain their identities; URL fragments do not. Aggregate image findings without individual asset identities count once per affected page; the numeric aggregate is not expanded into invented unique issues. Internal-only and unsupported findings are excluded by the same customer projection that prepares the topic cards. Different reportable checks can be consolidated into one selected topic; their separate individual issues still contribute to the total.

Examples from the saved 5 November crawls: Bella Fiss has 27 deduplicated customer-reportable issues and six selected topics; Good Vibes has 25 issues and three selected topics. These are counts of issues in the captured scope, not counts of issue types or claims of complete site coverage.

## Page badge

“Pages” refers to distinct captured final page URLs in the saved crawl coverage, with URL fragments removed. Redirect aliases to the same final page are counted once; failed or skipped requests are excluded. This is not a count of websites or a claim that every page on the site was crawled or fully analyzed. Missing coverage displays an unknown count. The shorter labels fit one mobile row for all ten latest Cape Town saved crawls, including the largest crawl.

## Closing copy

English: “Contact us to discuss this review.” German: “Kontaktieren Sie uns zu dieser Prüfung.” These sentences fit one mobile line without reducing the font size or forcing text outside the footer. They remain above the publisher contact details, only on the final page.

## Badge alignment

Use the same centered flex group for A4 and mobile, including localized reports. The combined badge bounds must have equal left and right gaps within the summary row (one-pixel tolerance). The ten latest Cape Town saved crawls retain all three badges on one centered mobile row.
