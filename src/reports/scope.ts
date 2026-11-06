import type { AuditResult } from '@spora/webcrawl';
import { hasIncompleteCrawl } from '@spora/webcrawl/evidence';

/** A bounded scope statement; optional checks never imply a full-site audit. */
export function customerScopeDisclosure(result: AuditResult, locale: 'en' | 'de' | 'pt-BR'): string {
  const partial = hasIncompleteCrawl(result.crawl, result.findings, result.coverage?.urls)
    || Object.values(result.coverage?.checks ?? {}).some(check => check.status !== 'complete' && check.status !== 'disabled');
  if (!partial) return '';
  const unattempted = result.crawl.unattempted;
  const robots = result.coverage?.urls.filter(row => row.outcome === 'robots_blocked').length ?? 0;
  const counts = [
    unattempted ? (locale === 'de' ? `${unattempted} URLs nicht abgerufen.` : locale === 'pt-BR' ? `${unattempted} URLs não tentadas.` : `${unattempted} URLs unattempted.`) : '',
    robots ? (locale === 'de' ? `${robots} URLs durch Robots ausgeschlossen.` : locale === 'pt-BR' ? `${robots} URLs excluídas por robots.` : `${robots} URLs excluded by robots.`) : '',
  ].filter(Boolean).join(' ');
  const text = locale === 'de'
    ? 'Basierend auf erfassten Seiten und aufgezeichneten Beispielen; einige Seiten oder Prüfungen wurden nicht untersucht.'
    : locale === 'pt-BR'
    ? 'Baseada nas páginas capturadas e exemplos registrados; algumas páginas ou verificações não foram inspecionadas.'
    : 'Based on captured pages and recorded examples; some pages or checks were not inspected.';
  return [text, counts].filter(Boolean).join(' ');
}
