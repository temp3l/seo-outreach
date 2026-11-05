import type { AuditResult } from '@spora/webcrawl';
import type { PdfRenderer } from './html.js';
import type { ReportContact } from './report-contact.js';
import { renderCustomerSummaryPdf, type SummaryLocale } from './summary.js';
import { isCustomerReleaseQualified, type CustomerReleaseQualification } from './qualification.js';

/** Internal publication boundary: both locales share one release decision. */
export async function renderCustomerPdfPair(result: AuditResult, renderer: PdfRenderer, issuer: ReportContact, qualification?: CustomerReleaseQualification): Promise<Readonly<{
  status: 'CLIENT_READY' | 'HOLD'; en: Uint8Array; de: Uint8Array;
}>> {
  const qualified = isCustomerReleaseQualified(result, qualification) && Boolean(issuer.email || issuer.phone);
  const render = (locale: SummaryLocale, release: boolean): Promise<Uint8Array> => renderCustomerSummaryPdf(result, (html, options) => {
    let marked = html;
    if (release && !marked.includes('data-publication-status="CLIENT_READY"')) throw new Error('client_report_not_ready: report evidence or layout does not meet release requirements');
    if (!release && !marked.includes('data-publication-status="HOLD"')) {
      marked = marked.replace('data-publication-status="PREVIEW"', 'data-publication-status="HOLD"');
    }
    return renderer(marked, options);
  }, { locale, issuer, ...(release && qualification ? { qualification } : {}) });
  if (!qualified) return { status: 'HOLD', en: await render('en', false), de: await render('de', false) };
  try {
    const en = await render('en', true);
    const de = await render('de', true);
    return { status: 'CLIENT_READY', en, de };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('client_report_not_ready:')) throw error;
  }
  return { status: 'HOLD', en: await render('en', false), de: await render('de', false) };
}
