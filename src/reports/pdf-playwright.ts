import type { PdfRenderer } from './html.js';
import { OperationDeadline, closeWithin } from './operation-deadline.js';
import { paginateMobileReport } from './mobile.js';
import type { Browser, BrowserContext } from 'playwright';

type PdfSession = { browser?: Browser };

/** Reuse one browser for a report group, with isolated contexts and serialized
 * renders. The browser exists only inside this scope; failed operations retire
 * it so a caller that handles the error can safely render again. */
export async function withPlaywrightPdfSession<T>(operation: (renderer: PdfRenderer) => Promise<T>, options: { signal?: AbortSignal; closeTimeoutMs?: number } = {}): Promise<T> {
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) throw new Error('invalid_operation_timeout');
  const session: PdfSession = {};
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let pending = Promise.resolve();
  let closed = false;
  let failed = false;
  const renderer: PdfRenderer = (html, renderOptions) => {
    const rendered = pending.then(() => {
      if (closed) throw new Error('pdf_session_closed');
      return renderPdf(html, { ...renderOptions, signal: renderOptions?.signal ? AbortSignal.any([signal, renderOptions.signal]) : signal }, session);
    });
    pending = rendered.then(() => {}, () => {});
    return rendered;
  };
  try { return await operation(renderer); }
  catch (error) { failed = true; throw error; }
  finally {
    closed = true;
    controller.abort();
    await pending;
    try {
      if (session.browser) await closeWithin(() => session.browser!.close(), closeTimeoutMs, 'pdf_close_timeout');
    } catch (error) { if (!failed) throw error; }
  }
}

/** Optional adapter. Deadline includes launch/setup/render; cleanup uses remaining
 * time. Pre-cancelled calls never import or launch the optional runtime. */
export const playwrightPdfRenderer: PdfRenderer = (html, options) => renderPdf(html, options);

async function renderPdf(html: string, options: Parameters<PdfRenderer>[1], session?: PdfSession): Promise<Uint8Array> {
  const deadline = new OperationDeadline(options?.timeoutMs ?? 30_000, options?.signal, 'pdf_render_timeout', 'pdf_render_aborted');
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let failure: unknown;
  try {
    if (session?.browser && !session.browser.isConnected()) {
      const stale = session.browser;
      delete session.browser;
      await deadline.run(() => stale.close());
    }
    if (session?.browser) browser = session.browser;
    else {
      const { chromium } = await deadline.run(() => import('playwright'));
      browser = await deadline.run(() => chromium.launch({ headless: true, timeout: Math.max(1, deadline.remainingMs()) }), late => late.close());
      if (session) session.browser = browser;
    }
    context = await deadline.run(() => browser!.newContext({ serviceWorkers: 'block', javaScriptEnabled: false }), late => late.close());
    const activeContext = context;
    await deadline.run(() => activeContext.route('**/*', route => route.abort('blockedbyclient')));
    const page = await deadline.run(() => activeContext.newPage());
    await deadline.run(() => page.setContent(html, { waitUntil: 'load', timeout: Math.max(1, deadline.remainingMs()) }));
    if (html.includes('data-mobile-report="true"')) {
      await deadline.run(() => page.emulateMedia({ media: 'print' }));
      await deadline.run(() => page.evaluate(paginateMobileReport));
    }
    if (html.includes('data-client-ready="true"') || html.includes('data-review-layout-check="true"')) {
      await deadline.run(() => page.emulateMedia({ media: 'print' }));
      const fits = await deadline.run(() => page.evaluate(() => {
        if (document.body.dataset.clientReady !== 'true' && document.body.dataset.reviewLayoutCheck !== 'true') return true;
        if (document.body.dataset.mobileReport === 'true') {
          const sheets = Array.from(document.querySelectorAll<HTMLElement>('.mobile-sheet'));
          if (!sheets.length || document.querySelector('main.page')) return false;
          const mm = 96 / 25.4;
          return sheets.every((sheet, index) => {
            const box = sheet.getBoundingClientRect();
            const footer = sheet.querySelector<HTMLElement>('footer');
            const last = index === sheets.length - 1;
            if (Math.abs(box.width - 108 * mm) > 2 || Math.abs(box.height - 280 * mm) > 2 || (last && !footer) || (!last && footer)) return false;
            const content = sheet.querySelector<HTMLElement>('.mobile-content');
            if (!content) return false;
            const contentBox = content.getBoundingClientRect();
            if (sheet.scrollWidth > sheet.clientWidth + 1 || contentBox.left < box.left - 1 || contentBox.right > box.right + 1) return false;
            for (const child of Array.from(content.children)) {
              const childBox = child.getBoundingClientRect();
              if (childBox.left < box.left - 1 || childBox.right > box.right + 1 || childBox.top < box.top - 1) return false;
              if (footer && childBox.bottom > footer.getBoundingClientRect().top + 1) return false;
              if (!footer && childBox.bottom > box.bottom + 1) return false;
            }
            return !footer || footer.getBoundingClientRect().bottom <= box.bottom + 1;
          });
        }
        const sheet = document.querySelector('.page');
        const footer = sheet?.querySelector('footer');
        return !!sheet && !!footer && sheet.getBoundingClientRect().height <= 297 * 96 / 25.4 + 1 && footer.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().bottom;
      }));
      if (!fits) throw new Error(html.includes('data-mobile-report="true"')
        ? 'client_report_not_ready: mobile content exceeds a 108mm x 280mm page'
        : 'client_report_not_ready: content exceeds one A4 page');
    }
    return await deadline.run(() => page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } catch (error) { failure = error; throw error;
  } finally {
    let cleanupFailure: unknown;
    try {
      try {
        if (session && context) await closeWithin(() => context!.close(), deadline.remainingMs(), 'pdf_close_timeout');
        if (!session && browser) await closeWithin(() => browser!.close(), deadline.remainingMs(), 'pdf_close_timeout');
      } catch (error) { cleanupFailure = error; }
      const layoutFailure = failure instanceof Error && failure.message.startsWith('client_report_not_ready:');
      if (session && browser && (cleanupFailure || failure && !layoutFailure || !browser.isConnected())) {
        if (session.browser === browser) delete session.browser;
        try { await closeWithin(() => browser!.close(), deadline.remainingMs(), 'pdf_close_timeout'); }
        catch (error) { cleanupFailure ??= error; }
      }
      if (!failure && cleanupFailure) throw cleanupFailure;
    } finally { deadline.dispose(); }
  }
}
