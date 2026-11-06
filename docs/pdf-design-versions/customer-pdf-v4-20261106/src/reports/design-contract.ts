import { createHash } from 'node:crypto';

/** Approved Cape Town layout; changes require an explicit design revision. */
export const CUSTOMER_PDF_DESIGN = 'customer-pdf-v4-20261106' as const;
const approvedStyles = new Set([
  "0ce532ad71a8936a3b48bf41b992a88e82cb5717dd72d625921a5c86a440b11c",
  "6d227bcd932315a11107f5309fe5f0ecbb1d35735b2323ed6bcafde04d3aadb0",
  "f9af8c9a9950bd1dbb844117b93e0e6717eca65538f14b15759d57250c9e27db",
  "705923bd533b052256e2f8c7860e23e12dc773c3eb8535475931270c45055baa"
]);

/** Reject changed styles before launching a browser; factual report content stays variable. */
export function assertFrozenCustomerStyles(html: string): void {
  if (!/<body\b[^>]*data-(?:client-ready|review-layout-check)=['"](?:true|false)['"]/u.test(html)) return;
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map(m => m[1]).join('\n');
  if (/<[a-z][^>]*\sstyle\s*=/iu.test(html) || /<link\b/iu.test(html) || !approvedStyles.has(createHash('sha256').update(styles).digest('hex')))
    throw new Error(`client_report_not_ready: ${html.includes('data-mobile-report="true"') ? 'mobile ' : ''}frozen PDF design changed (${CUSTOMER_PDF_DESIGN})`);
}
