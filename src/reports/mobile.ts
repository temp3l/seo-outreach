import type { AuditResult } from '@spora/webcrawl';
import type { PdfRenderer } from './html.js';
import type { ReportContact } from './report-contact.js';
import { renderCustomerSummaryHtml, type CustomerLocale } from './summary.js';
import { isCustomerReleaseQualified, type CustomerReleaseQualification } from './qualification.js';

/** Reflow the same evidence and publication decision onto narrow PDF pages. */
export async function renderMobileCustomerPdf(result: AuditResult, renderer: PdfRenderer, issuer: ReportContact, locale: CustomerLocale, status: 'CLIENT_READY' | 'HOLD', qualification?: CustomerReleaseQualification): Promise<Uint8Array> {
  const release = status === 'CLIENT_READY' && Boolean(issuer.email || issuer.phone) && isCustomerReleaseQualified(result, qualification);
  let html = renderCustomerSummaryHtml(result, locale, { issuer, ...(release ? { qualification } : {}) });
  // Approval is carried by the manifest; review PDFs use the same clean layout.
  if (!release) html = html.replace('data-publication-status="PREVIEW"', 'data-publication-status="HOLD"');
  const css = `<style>@page{size:108mm 280mm;margin:0}body{font-size:11pt;line-height:1.3}.page{width:108mm;min-height:0;display:block;padding:6mm}.hero,.compact .hero{padding:4mm}.hero h1,.compact .hero h1{font-size:18pt}.hero-top{font-size:9pt;flex-wrap:wrap;gap:2mm}.hero-top span{display:block}.snapshots{padding:3mm 0 0}.grid{display:block}.card{margin:3mm 0;padding:3mm}.card h3{font-size:13pt;line-height:1.2}.card p{font-size:11pt;line-height:1.3}.card .example{font-size:10pt}.label,.note,.score-card strong,.score-date,.offer p,.offer strong,.issuer{font-size:10pt}.lighthouse h2,.findings h2{font-size:12pt}.score-card svg{width:12mm;height:12mm}.offer{break-inside:avoid}</style>`;
  const sheets = `<style>.mobile-sheet{width:108mm;height:280mm;padding:6mm;box-sizing:border-box;display:flex;flex-direction:column;gap:3mm;break-after:page;overflow-wrap:anywhere}.mobile-sheet:last-child{break-after:auto}.mobile-content{flex:none}.mobile-sheet .hero{margin:0;padding:4mm}.mobile-sheet .snapshots{padding:3mm 0}.mobile-sheet .scope,.mobile-sheet .lighthouse,.mobile-sheet .findings,.mobile-sheet .notes,.mobile-sheet .offer{margin-left:0;margin-right:0}.mobile-sheet .issuer{flex:none;margin:0;margin-top:auto;padding:3mm 0 0;width:auto;font-size:10pt;line-height:1.4}.mobile-sheet .card{margin:3mm 0;padding:3mm}.mobile-sheet .offer{margin-top:4mm;margin-bottom:0}.mobile-sheet .running-header{font-size:10pt;color:#49636a;padding-bottom:3mm;border-bottom:1px solid #d8e3e1}.mobile-sheet .hero h1{overflow-wrap:anywhere}</style>`;
  html = html.replace('<body ', '<body data-mobile-report="true" ').replace('</head>', `${css}${sheets}</head>`);
  return renderer(html);
}

/** Runs in the isolated PDF browser after fonts/layout are available. */
export function paginateMobileReport(): void {
  const source = document.querySelector('main.page');
  const footer = source?.querySelector('footer');
  if (!source || !footer) throw new Error('mobile_report_layout_missing');
  const footerTemplate = footer.cloneNode(true) as HTMLElement;
  footer.remove();
  const host = source.querySelector('h1')?.textContent ?? '';
  const blocks: Element[] = [];
  for (const child of Array.from(source.children)) {
    if (child.matches('.findings') && child.querySelector('.card')) {
      for (const [index, card] of Array.from(child.querySelectorAll('.card')).entries()) {
        const section = document.createElement('section');
        section.className = 'findings';
        if (index === 0 && child.querySelector('h2')) section.append(child.querySelector('h2')!.cloneNode(true));
        section.append(card);
        blocks.push(section);
      }
    } else blocks.push(child);
  }
  source.remove();
  let sheet: HTMLElement;
  let content: HTMLElement;
  let pageFooter: HTMLElement;
  const newSheet = () => {
    sheet = document.createElement('main');
    sheet.className = 'mobile-sheet';
    content = document.createElement('div');
    content.className = 'mobile-content';
    if (document.querySelector('.mobile-sheet')) {
      const running = document.createElement('div');
      running.className = 'running-header';
      running.textContent = host;
      content.append(running);
    }
    pageFooter = footerTemplate.cloneNode(true) as HTMLElement;
    sheet.append(content, pageFooter);
    document.body.append(sheet);
  };
  const fits = () => pageFooter.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().bottom - 6 * 96 / 25.4 + 1 && content.getBoundingClientRect().bottom <= pageFooter.getBoundingClientRect().top + 1;
  newSheet();
  for (const block of blocks) {
    content!.append(block);
    if (block.matches('.hero')) {
      const heading = block.querySelector('h1');
      if (heading) {
        // Fit the domain on one line when possible, so its suffix is not
        // stranded by arbitrary wrapping inside the phone-width header.
        heading.style.whiteSpace = 'nowrap';
        for (let size = 18; size >= 12; size -= 0.5) {
          heading.style.fontSize = `${size}pt`;
          if (heading.scrollWidth <= heading.clientWidth + 1) break;
        }
        if (heading.scrollWidth > heading.clientWidth + 1) heading.style.whiteSpace = 'normal';
      }
    }
    if (!fits()) {
      block.remove();
      // Keep the closing invitation with the last finding instead of making
      // a nearly empty handoff page.
      const lastFinding = block.matches('.offer') && content!.lastElementChild?.matches('.findings') ? content!.lastElementChild : null;
      lastFinding?.remove();
      newSheet();
      if (lastFinding) content!.append(lastFinding);
      content!.append(block);
      if (!fits()) throw new Error('mobile_report_block_exceeds_page');
    }
  }
  const sheets = Array.from(document.querySelectorAll('.mobile-sheet'));
  for (const previous of sheets.slice(0, -1)) previous.querySelector('footer')?.remove();
}
