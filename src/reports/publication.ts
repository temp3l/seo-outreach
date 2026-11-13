import type { AuditResult } from '@spora/webcrawl';
import type { PdfRenderer } from './html.js';
import type { ReportContact } from './report-contact.js';
import { renderCustomerSummaryPdf, type SummaryLocale } from './summary.js';
import type { CustomerReleaseQualification } from './qualification.js';

/** Internal publication boundary: both locales share one release decision. */
export async function renderCustomerPdfPair(result: AuditResult, renderer: PdfRenderer, issuer: ReportContact, qualification?: CustomerReleaseQualification): Promise<Readonly<{
  status: 'CLIENT_READY' | 'HOLD'; en: Uint8Array; de: Uint8Array;
}>> {
  const render = (locale: SummaryLocale): Promise<Uint8Array> => renderCustomerSummaryPdf(result, (html, options) => {
    let marked = html;
    if (!marked.includes('data-publication-status="HOLD"')) {
      marked = marked.replace('data-publication-status="PREVIEW"', 'data-publication-status="HOLD"');
    }
    return renderer(marked, options);
  }, { locale, issuer });
  return { status: 'HOLD', en: await render('en'), de: await render('de') };
}
