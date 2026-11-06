# Frozen customer PDF design

The user explicitly approved and froze this exact v6 design. [docs/pdf-design-approval.json](docs/pdf-design-approval.json) binds the reviewed PDF bytes and design lock. Preserve it as the authoritative design for all shared report workflows; do not treat routine generation, content edits or bug fixes as permission to redesign.

The user requested compact “pages · SEO findings · topics” badges in one row. Preserve distinct captured-page counting. The user froze `customer-pdf-v6-20261106`, based on the corrected Cape Town reports plus the explicitly requested two-column topic cards and the SEO findings badge and a footer only on the final page; its deduplicated individual issue count remains unchanged.
Read [docs/pdf-design-contract.md](docs/pdf-design-contract.md) before working on PDF rendering.

- Preserve the approved design across the styled API, `reports prepare/release`, and `outreach-crawl`.
- Do not redesign, alter layout, update visual references, or regenerate `report-design.lock.json` without an explicit user request to change the design. Ordinary report generation, crawling, content corrections, and bug-fix requests do not authorize a redesign.
- Never update the lock or expected images just to make a failing check pass. Diagnose and restore the frozen design instead.
- Use the shared renderer. Do not introduce a second customer design or silently fall back to the legacy analysis-text PDF.
- Run `pnpm check:pdf-design`, build, the relevant layout tests, and `pnpm test:visual` for PDF work. The normal test suite also runs the visual gate.
- Review every physical page when report content changes pagination. Passing tests alone are not a visual sign-off.

Approved English closing copy: “Contact us to discuss this review.” Keep it on one mobile line at the existing font size.

Center the summary badge group horizontally within the content area on A4 and mobile. Preserve single-row fit and existing font sizes.
