import { createHash } from 'node:crypto';

/** Approved Cape Town layout; changes require an explicit design revision. */
export const CUSTOMER_PDF_DESIGN = 'customer-pdf-v6-20261106' as const;
const approvedStyles = new Set([
  "3128b1e5c99ea7cce1d48a2b52b1783edd918ac5c3f67d07dc4f4a2df875dfe5",
  "395c900e9fec6c9970756bde69a2f99ebaf1a836dd4abbc81e1bd604d1bb6632",
  "c46830fd5fde8e0ab3f7a489bef2a95e7c1cdd2fcd22a3f2602ae90463bf000a",
  "a8bcedffbd2e350069cb5862e28e4426ab5d4ea5fa005f8b19f2ed9adec52faa"
]);

/** Reject changed styles before launching a browser; factual report content stays variable. */
export function assertFrozenCustomerStyles(html: string): void {
  if (!/<body\b[^>]*data-(?:client-ready|review-layout-check)=['"](?:true|false)['"]/u.test(html)) return;
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)].map(m => m[1]).join('\n');
  if (/<[a-z][^>]*\sstyle\s*=/iu.test(html) || /<link\b/iu.test(html) || !approvedStyles.has(createHash('sha256').update(styles).digest('hex')))
    throw new Error(`client_report_not_ready: ${html.includes('data-mobile-report="true"') ? 'mobile ' : ''}frozen PDF design changed (${CUSTOMER_PDF_DESIGN})`);
}
