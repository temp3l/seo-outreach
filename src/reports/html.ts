import { reportEvidenceCounts } from './references.js';
import type { AuditFinding, AuditResult, CrawlLocalCheckCoverage } from '@spora/webcrawl';
import { sanitizeEvidenceUrl } from '@spora/webcrawl/evidence';

function escape(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

function auditUrl(value: string): string {
  const safe = sanitizeEvidenceUrl(value);
  return safe ? `<a href="${escape(safe)}">${escape(safe)}</a>` : escape(value);
}

export function renderAuditHtml(result: AuditResult, options: Readonly<{ title?: string; brand?: string; locale?: 'en' | 'de' }> = {}): string {
  const locale = options.locale ?? 'en';
  const coverageLabel = locale === 'de' ? 'Abdeckung' : 'Coverage';
  const title = options.title ?? (locale === 'de' ? 'Website-Analyse' : 'Website audit');
  const grouped = new Map<string, AuditFinding[]>();
  for (const finding of result.findings) {
    let bucket = grouped.get(finding.category);
    if (!bucket) grouped.set(finding.category, bucket = []);
    bucket.push(finding);
  }
  const sections = [...grouped].map(([category, findings]) => `<section><h2>${escape(category)}</h2><ul>${findings.map((finding) => `<li><h3>${escape(finding.code)}</h3><p>${escape(finding.observed)}</p><ul>${finding.evidence.map((evidence) => `<li>${auditUrl(evidence.pageUrl)} <time>${escape(evidence.observedAt)}</time></li>`).join('')}</ul></li>`).join('')}</ul></section>`).join('');
  const limits = result.crawl.limitations.map((item) => `<li>${escape(item)}</li>`).join('');
  const manifest = result.coverage;
  const counts = reportEvidenceCounts(result);
  const checkRows = manifest ? [
    { label: 'Same-host broken links', check: manifest.checks.internalLinks },
    { label: 'Same-host image sizes', check: manifest.checks.imageSizes },
  ].map(({ label, check }) => `<li>${escape(label)}: ${check.checked}/${check.discovered} checked; ${check.findings} finding(s), ${check.failed} failed, ${check.skipped} skipped, ${check.unattempted} unattempted${check.omittedTargets ? `, ${check.omittedTargets} known target(s) omitted by cap` : ''}${check.omittedRelations ? `, ${check.omittedRelations} link relation(s) omitted` : ''}${check.untrackedCandidates ? `, ${check.untrackedCandidates} candidate reference(s) beyond tracking cap` : ''}.</li>`).join('') : '';
  const securityChecks: readonly Readonly<{ label: string; check: CrawlLocalCheckCoverage }>[] = manifest ? [
    { label: 'Security headers', check: manifest.checks.securityHeaders },
    { label: 'Mixed content', check: manifest.checks.mixedContent },
    { label: 'Sensitive forms', check: manifest.checks.sensitiveForms },
    { label: 'Cookie attributes', check: manifest.checks.cookieAttributes },
    { label: 'security.txt', check: manifest.checks.securityTxt },
  ] : [];
  const securityCheckRows = securityChecks.map(({ label, check }) => `<li>${escape(label)}: ${escape(check.status)}; ${check.checked}/${check.discovered} checked; ${check.findings} finding(s), ${check.failed} failed, ${check.skipped} skipped, ${check.unattempted} unattempted.</li>`).join('');
  const urlRows = manifest?.urls.slice(0, 50).map((item) => `<li>${auditUrl(item.url)} — ${escape(item.outcome)}${item.statusCode === undefined ? '' : ` (${item.statusCode})`}${item.reason ? `, ${escape(item.reason)}` : ''}</li>`).join('') ?? '';
  const manifestHtml = manifest ? `<p>Findings: ${manifest.findings.records} records across ${manifest.findings.checkCodes} check codes, affecting ${counts.affectedCapturedUrls ?? 'UNKNOWN'} captured URLs and ${counts.affectedAssets} image/assets (${counts.occurrences} evidence occurrences; historical affectedPages: ${manifest.findings.affectedPages} evidence URL identities).</p><ul>${checkRows}${securityCheckRows}</ul><details><summary>URL coverage (${manifest.urls.length}; showing first ${Math.min(50, manifest.urls.length)})</summary><ol>${urlRows}</ol></details>` : '';
  const physicalRequests = result.crawl.physicalRequests === undefined ? '' : locale === 'de' ? ` Insgesamt ${result.crawl.physicalRequests} physische HTTP-Anfragen.` : ` ${result.crawl.physicalRequests} physical HTTP requests total.`;
  const robotsSummary = result.robotsObservation ? locale === 'de'
    ? `<p>robots.txt: ${escape(result.robotsObservation.policy)} (${escape(result.robotsObservation.retrieval)}); ${escape(String(result.robotsObservation.advisoryDisallowed))} bekannte URL(s) laut Regeln nicht erlaubt. ${result.robotsObservation.policy === 'respect' ? 'Robots-Regeln werden durchgesetzt; bei nicht verfügbarer Richtlinie werden Anfragen zurückgehalten.' : 'Regeln verhindern keine anderweitig zulässige Anfrage.'} Scannen Sie nur Ziele, für die Sie autorisiert sind.</p>`
    : `<p>robots.txt: ${escape(result.robotsObservation.policy)} (${escape(result.robotsObservation.retrieval)}); ${escape(String(result.robotsObservation.advisoryDisallowed))} known URL(s) advisory-disallowed. ${result.robotsObservation.policy === 'respect' ? 'Robots admission enforced; unavailable policies withhold requests.' : 'Robots rules do not prevent otherwise permitted requests.'} Scan only targets you are authorized to audit.</p>` : '';
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#18212b}h1,h2{line-height:1.2}section{border-top:1px solid #ccd3da;padding:1rem 0}li{margin:.5rem 0}time{color:#5c6874;font-size:.85em}</style><header><p>${escape(options.brand ?? 'Website audit')}</p><h1>${escape(title)}</h1><p>${escape(result.target)}</p><p>${escape(result.startedAt)} — ${escape(result.completedAt)}</p></header><section><h2>${coverageLabel}</h2><p>${result.crawl.captured} ${locale === 'de' ? 'Antworten erfasst aus' : 'responses captured from'} ${result.crawl.attempted} ${locale === 'de' ? 'Seitenversuchen' : 'page attempts'}; ${result.crawl.skipped} ${locale === 'de' ? 'übersprungen' : 'skipped'}, ${result.crawl.failed} ${locale === 'de' ? 'fehlgeschlagen' : 'failed'}, ${result.crawl.unattempted} ${locale === 'de' ? 'nicht versucht' : 'unattempted'}.${physicalRequests}</p>${robotsSummary}<p>Successful responses: ${counts.successfulResponses ?? 'UNKNOWN'}; completed HTML analyses: ${counts.analyzedHtmlPages ?? 'UNKNOWN'}; Final URL outcomes with HTTP 429: ${counts.rateLimitedResponses ?? 'UNKNOWN'} (total retry responses: UNKNOWN); non-HTML skips: ${counts.nonHtmlSkips ?? 'UNKNOWN'}; duplicate final URLs: ${counts.duplicateFinalUrls ?? 'UNKNOWN'}. Unmeasured images: UNKNOWN; text, image inventory and source-sample caps remain separate in private page data.</p><ul>${limits}</ul>${manifestHtml}</section>${sections}</html>`;
}

export type PdfRenderer = (html: string, options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>) => Promise<Uint8Array>;
export async function renderAuditPdf(result: AuditResult, renderer: PdfRenderer, options?: Readonly<{ title?: string; brand?: string; locale?: 'en' | 'de'; timeoutMs?: number; signal?: AbortSignal }>): Promise<Uint8Array> {
  const html = renderAuditHtml(result, options);
  return renderer(html, { ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options?.signal ? { signal: options.signal } : {}) });
}
