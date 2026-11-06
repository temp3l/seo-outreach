import { createHash } from 'node:crypto';

/** Approved Cape Town layout; changes require an explicit design revision. */
export const CUSTOMER_PDF_DESIGN = 'customer-pdf-v1-20261106' as const;
const approvedStyles = new Set(
[
  "c466a373567876e63dc3deffb68c13b7902c27c678fdc5613bbf9d5b51f75cc4",
  "b992c80376c4eddc5addb148f55d57813f0c9e6ddda2193f245a8bcd66df62e3",
  "e72a7c703165e2915721dd1c37be791af1e5aa1749214553952405eecf61cc11",
  "5eecc6bdfef92863f5613e5f860b4d61f84b4ea38c7cc544cc0ac003d3bd692a"
]);

/** Reject changed styles before launching a browser; factual report content stays variable. */
export function assertFrozenCustomerStyles(html: string): void {
  if (!/<body\b[^>]*data-(?:client-ready|review-layout-check)=['"](?:true|false)['"]/u.test(html)) return;
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map(m => m[1]).join('\n');
  if (/<[a-z][^>]*\sstyle\s*=/iu.test(html) || /<link\b/iu.test(html) || !approvedStyles.has(createHash('sha256').update(styles).digest('hex')))
    throw new Error(`client_report_not_ready: ${html.includes('data-mobile-report="true"') ? 'mobile ' : ''}frozen PDF design changed (${CUSTOMER_PDF_DESIGN})`);
}
