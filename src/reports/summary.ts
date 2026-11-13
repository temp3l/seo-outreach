import { reportEvidenceCounts } from './references.js';
import type { AuditFinding, AuditResult } from '@spora/webcrawl';
import type { PdfRenderer } from './html.js';
import { customerBriefing } from './customer.js';
import { portugueseCustomerBriefing } from './customer-pt.js';
import type { ReportContact } from './report-contact.js';
import { reportPageReferences, type ReportPageReference } from './references.js';
import { hasIncompleteCrawl } from '@spora/webcrawl/evidence';
import type { CustomerReleaseQualification } from './qualification.js';
export type { ReportContact } from './report-contact.js';

export type SummaryLocale = 'en' | 'de';
export type CustomerLocale = SummaryLocale | 'pt-BR';

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const uniquePages = reportPageReferences;

function issueOccurrences(findings: readonly AuditFinding[]): number {
  return findings.reduce((sum, finding) => sum + finding.evidence.length, 0);
}

function pageSpeedScores(result: AuditResult): Array<{ name: string; score: number }> {
  const labels: Readonly<Record<string, string>> = { performance: 'Performance', accessibility: 'Accessibility', 'best-practices': 'Best Practices', seo: 'SEO' };
  return result.findings.flatMap((finding) => {
    if (finding.code !== 'pagespeed_category_score') return [];
    const match = finding.observed.match(/^([^:]+) score: (\d+)\/100\.?$/iu);
    const rawName = match?.[1]?.toLowerCase();
    const score = finding.evidence.find((evidence) => evidence.source === 'pagespeed' && typeof evidence.value === 'number')?.value;
    if (!rawName || typeof score !== 'number') return [];
    if (!['performance', 'accessibility', 'best-practices', 'seo'].includes(rawName)) return [];
    return [{ name: labels[rawName]!, score }];
  });
}

function dateLabel(value: string, locale: SummaryLocale): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function hostLabel(target: string): string {
  try { return new URL(target).hostname; } catch { return target; }
}

function findingGroups(result: AuditResult): Array<{ code: string; findings: AuditFinding[]; pages: ReportPageReference[] }> {
  const grouped = new Map<string, AuditFinding[]>();
  for (const finding of result.findings) {
    let bucket = grouped.get(finding.code);
    if (!bucket) grouped.set(finding.code, bucket = []);
    bucket.push(finding);
  }
  return [...grouped].map(([code, findings]) => ({ code, findings, pages: uniquePages(findings) }));
}


const SECURITY_LABELS: Readonly<Record<string, Readonly<{ en: string; de: string }>>> = {
  http_page_not_upgraded: { en: 'Pages did not redirect to HTTPS', de: 'Seiten wurden nicht auf HTTPS umgeleitet' },
  hsts_missing_or_inactive: { en: 'Transport security policy missing or inactive', de: 'Transportsicherheitsrichtlinie fehlt oder ist inaktiv' },
  missing_frame_protection: { en: 'Frame protection missing', de: 'Einbettungsschutz fehlt' },
  missing_nosniff_header: { en: 'Browser content-type protection missing', de: 'Browser-Schutz für Inhaltstypen fehlt' },
  missing_referrer_policy: { en: 'Referrer policy missing', de: 'Referrer-Richtlinie fehlt' },
  unsafe_referrer_policy: { en: 'Referrer policy may disclose too much', de: 'Referrer-Richtlinie kann zu viele Informationen preisgeben' },
  weak_referrer_policy: { en: 'Referrer policy could be stricter', de: 'Referrer-Richtlinie könnte strenger sein' },
  csp_unsafe_inline_script: { en: 'Content policy allows inline scripts', de: 'Inhaltsrichtlinie erlaubt Inline-Skripte' },
  csp_unsafe_eval: { en: 'Content policy allows eval-like scripts', de: 'Inhaltsrichtlinie erlaubt eval-ähnliche Skripte' },
  csp_broad_script_sources: { en: 'Content policy allows broad script sources', de: 'Inhaltsrichtlinie erlaubt weit gefasste Skriptquellen' },
  csp_object_src_not_disabled: { en: 'Content policy does not disable embedded objects', de: 'Inhaltsrichtlinie deaktiviert eingebettete Objekte nicht' },
  csp_base_uri_not_restricted: { en: 'Content policy does not restrict the base URL', de: 'Inhaltsrichtlinie schränkt die Basis-URL nicht ein' },
  mixed_active_content: { en: 'Insecure active resources found', de: 'Unsichere aktive Ressourcen gefunden' },
  mixed_passive_content: { en: 'Insecure media resources found', de: 'Unsichere Medienressourcen gefunden' },
  sensitive_form_over_http: { en: 'Sensitive form uses unencrypted transport', de: 'Sensibles Formular nutzt unverschlüsselte Übertragung' },
  sensitive_form_to_external_origin: { en: 'Sensitive form submits to another site', de: 'Sensibles Formular sendet an eine andere Website' },
  password_form_on_http: { en: 'Password form uses HTTP', de: 'Passwortformular nutzt HTTP' },
  session_cookie_missing_secure: { en: 'Session cookie is missing Secure', de: 'Session-Cookie ohne Secure-Attribut' },
  session_cookie_missing_httponly: { en: 'Session cookie is missing HttpOnly', de: 'Session-Cookie ohne HttpOnly-Attribut' },
  session_cookie_missing_samesite: { en: 'Session cookie is missing SameSite', de: 'Session-Cookie ohne SameSite-Attribut' },
  cookie_samesite_none_without_secure: { en: 'SameSite=None cookie is missing Secure', de: 'SameSite=None-Cookie ohne Secure-Attribut' },
  security_txt_missing: { en: 'security.txt was not found', de: 'security.txt wurde nicht gefunden' },
  security_txt_missing_contact: { en: 'security.txt has no contact method', de: 'security.txt enthält keine Kontaktmöglichkeit' },
  security_txt_missing_expires: { en: 'security.txt has no expiry date', de: 'security.txt enthält kein Ablaufdatum' },
};

function publicationHtml(result: AuditResult, locale: CustomerLocale, options: Readonly<{ issuer?: ReportContact; qualification?: CustomerReleaseQualification }>): string {
  let html = locale === 'pt-BR' ? portugueseCustomerBriefing(result, options) : customerBriefing(result, locale, options);
  // Rendering never grants release: only the reviewed exact-byte workflow can.
  if (html.includes('data-publication-status="PREVIEW"')) {
    html = html.replace('data-publication-status="PREVIEW"', 'data-publication-status="HOLD"');

  }
  return html;
}

export function renderCustomerSummaryHtml(result: AuditResult, locale: CustomerLocale = 'en', options: Readonly<{ issuer?: ReportContact; clientReady?: boolean; qualification?: CustomerReleaseQualification }> = {}): string { return publicationHtml(result, locale, options); }

export async function renderCustomerSummaryPdf(result: AuditResult, renderer: PdfRenderer, options: Readonly<{ locale?: CustomerLocale; timeoutMs?: number; signal?: AbortSignal; issuer?: ReportContact; clientReady?: boolean; qualification?: CustomerReleaseQualification }> = {}): Promise<Uint8Array> {
  const html = renderCustomerSummaryHtml(result, options.locale ?? 'en', options);
  return renderer(html, { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
}

const CODE_LABELS: Readonly<Record<string, Readonly<{ en: string; de: string }>>> = {
  broken_internal_link: { en: 'Broken internal links', de: 'Defekte interne Links' },
  pagespeed_category_score: { en: 'PageSpeed category scores', de: 'PageSpeed-Kategoriewerte' },
  duplicate_h1: { en: 'Duplicate main heading', de: 'Doppelte Hauptüberschrift' },
  duplicate_meta_description_across_pages: { en: 'Duplicate meta descriptions', de: 'Doppelte Meta-Beschreibungen' },
  duplicate_title_across_pages: { en: 'Duplicate page titles', de: 'Doppelte Seitentitel' },
  heading_hierarchy_skip: { en: 'Heading levels skipped', de: 'Überschriftenebenen übersprungen' },
  hsts_missing_or_inactive: { en: 'HSTS missing or inactive', de: 'HSTS fehlt oder ist inaktiv' },
  http_status_error: { en: 'HTTP error pages', de: 'HTTP-Fehlerseiten' },
  image_file_too_large: { en: 'Large image files', de: 'Große Bilddateien' },
  images_missing_dimensions: { en: 'Images missing dimensions', de: 'Bilder ohne Abmessungen' },
  meta_description_length: { en: 'Meta description length', de: 'Länge der Meta-Beschreibung' },
  missing_canonical: { en: 'Canonical link missing', de: 'Canonical-Link fehlt' },
  missing_frame_protection: { en: 'Frame protection missing', de: 'Schutz vor Einbettung fehlt' },
  missing_meta_description: { en: 'Meta description missing', de: 'Meta-Beschreibung fehlt' },
  missing_nosniff_header: { en: 'nosniff header missing', de: 'nosniff-Header fehlt' },
  missing_referrer_policy: { en: 'Referrer Policy missing', de: 'Referrer Policy fehlt' },
  multiple_h1: { en: 'Multiple main headings', de: 'Mehrere Hauptüberschriften' },
  noindex: { en: 'Pages marked noindex', de: 'Seiten mit noindex' },
  title_long: { en: 'Long page titles', de: 'Lange Seitentitel' },
};

function labelFor(code: string, locale: SummaryLocale): string {
  return CODE_LABELS[code]?.[locale] ?? SECURITY_LABELS[code]?.[locale] ?? code.replaceAll('_', ' ');
}

function operatorFindingCard(group: { code: string; findings: AuditFinding[]; pages: ReportPageReference[] }, locale: SummaryLocale, result: AuditResult): string {
  const category = group.findings[0]?.category ?? 'content';
  const example = group.pages[0];
  const scoreNames: Readonly<Record<string, Readonly<{ en: string; de: string }>>> = {
    performance: { en: 'Performance', de: 'Leistung' },
    accessibility: { en: 'Accessibility', de: 'Barrierefreiheit' },
    'best-practices': { en: 'Best Practices', de: 'Best Practices' },
    seo: { en: 'SEO', de: 'SEO' },
  };
  const pageSpeedDetails = group.findings.flatMap((finding) => {
    if (group.code !== 'pagespeed_category_score') return [];
    const match = finding.observed.match(/^([^:]+) score: (\d+)\/100\.?$/iu);
    const score = Number(match?.[2]);
    const name = match?.[1]?.toLowerCase();
    if (!match || !name || !['performance', 'accessibility', 'best-practices', 'seo'].includes(name)) return [];
    return [`${scoreNames[name]![locale]}: ${score}/100`];
  });
  const headerNeeds: Readonly<Record<string, readonly string[]>> = {
    hsts_missing_or_inactive: ['strictTransportSecurity'], missing_nosniff_header: ['xContentTypeOptions'],
    missing_referrer_policy: ['referrerPolicy'], invalid_referrer_policy: ['referrerPolicy'], unsafe_referrer_policy: ['referrerPolicy'], weak_referrer_policy: ['referrerPolicy'],
    missing_content_security_policy: ['contentSecurityPolicy', 'contentSecurityPolicyReportOnly'], csp_report_only: ['contentSecurityPolicy', 'contentSecurityPolicyReportOnly'],
    missing_frame_protection: ['contentSecurityPolicy', 'xFrameOptions'], csp_unsafe_inline_script: ['contentSecurityPolicy'], csp_unsafe_eval: ['contentSecurityPolicy'], csp_broad_script_sources: ['contentSecurityPolicy'], csp_object_src_not_disabled: ['contentSecurityPolicy'], csp_base_uri_not_restricted: ['contentSecurityPolicy'],
  };
  const needs = headerNeeds[group.code];
  const unverifiedHeader = Boolean(needs && group.findings.some(f => f.evidence.some(e => needs.some(name => { const h = e.securityHeaderEvidence?.find(item => item.name === name); return !h || h.status === 'not_captured'; }))));
  const observed = group.code === 'pagespeed_category_score' ? pageSpeedDetails.join(' · ') : group.findings[0]?.observed ?? '';
  const detail = unverifiedHeader ? `${observed} ${locale === 'de' ? 'Einige Headerwerte wurden nicht aufbewahrt; diese historischen Ergebnisse sind nicht unabhängig überprüfbar.' : 'Some header values were not retained; those historical observations are independently unverified.'}` : observed;
  const severityRank: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  const severity = group.findings.map((finding) => finding.severity ?? 'informational').sort((a, b) => (severityRank[a] ?? 4) - (severityRank[b] ?? 4))[0] ?? 'informational';
  const severityLabel = locale === 'de'
    ? ({ critical: 'Kritisch', high: 'Hoch', medium: 'Mittel', low: 'Niedrig', informational: 'Hinweis' } as const)[severity as 'critical' | 'high' | 'medium' | 'low' | 'informational']
    : severity;
  return `<article class="check"><header><strong>${escape(severityLabel)} · ${unverifiedHeader ? (locale === 'de' ? 'Unbestätigt: ' : 'Unverified: ') : ''}${escape(labelFor(group.code, locale))}</strong><span>${reportEvidenceCounts(result, group.findings).affectedCapturedUrls ?? '?'} ${locale === 'de' ? 'erfasste URLs' : 'captured URLs'} · ${reportEvidenceCounts(result, group.findings).affectedAssets} ${locale === 'de' ? 'Bilddateien' : 'image/assets'}</span></header><p class="category">${escape(locale === 'de' ? ({ indexability: 'Indexierbarkeit', metadata: 'Metadaten', content: 'Inhalt', performance: 'Leistung', accessibility: 'Barrierefreiheit', security: 'Sicherheit', contacts: 'Kontakte' } as const)[category] : category)}</p><p>${escape(detail)}</p>${example ? example.redacted ? `<p class="example">${locale === 'de' ? 'Genaue Adresse im privaten Audit (Abfrageparameter entfernt).' : 'Exact address in the private audit (query parameters removed).'}</p>` : `<p class="example">${locale === 'de' ? 'Beispiel' : 'Example'}: <a href="${escape(example.url)}">${escape(example.url)}</a></p>` : ''}</article>`;
}

function operatorSecurityCoverage(result: AuditResult, locale: SummaryLocale): string {
  const checks = result.coverage?.checks;
  if (!checks) return '';
  const rows: ReadonlyArray<Readonly<{ label: string; check: typeof checks.securityHeaders }>> = [
    { label: locale === 'de' ? 'Sicherheitsheader' : 'Security headers', check: checks.securityHeaders },
    { label: locale === 'de' ? 'Gemischte Inhalte' : 'Mixed content', check: checks.mixedContent },
    { label: locale === 'de' ? 'Sensible Formulare' : 'Sensitive forms', check: checks.sensitiveForms },
    { label: locale === 'de' ? 'Cookie-Attribute' : 'Cookie attributes', check: checks.cookieAttributes },
    { label: 'security.txt', check: checks.securityTxt },
  ];
  return `<section class="section"><h2>${locale === 'de' ? 'Sicherheitsprüfungen' : 'Security check coverage'}</h2><div class="security-coverage">${rows.map(({ label, check }) => `<span><strong>${escape(label)}</strong> · ${escape(check.status)} · ${check.checked}/${check.discovered}${locale === 'de' ? ' geprüft' : ' checked'} · ${check.findings} ${locale === 'de' ? 'Befunde' : 'findings'}${check.failed ? ` · ${check.failed} ${locale === 'de' ? 'fehlgeschlagen' : 'failed'}` : ''}${check.skipped ? ` · ${check.skipped} ${locale === 'de' ? 'übersprungen' : 'skipped'}` : ''}${check.unattempted ? ` · ${check.unattempted} ${locale === 'de' ? 'nicht versucht' : 'unattempted'}` : ''}</span>`).join('')}</div></section>`;
}

/** Compact technical status summary with German localization to match the operator report. */
export function renderOperatorStatusHtml(result: AuditResult, locale: SummaryLocale = 'de'): string {
  const groups = findingGroups(result).sort((a, b) => b.pages.length - a.pages.length || a.code.localeCompare(b.code));
  const date = dateLabel(result.startedAt, locale);
  const partial = hasIncompleteCrawl(result.crawl, result.findings, result.coverage?.urls) || result.crawl.limitations.includes('content_inspection_incomplete');
  const state = locale === 'de' ? partial ? 'Crawl unvollständig' : 'Crawl abgeschlossen' : partial ? 'Crawl incomplete' : 'Crawl complete';
  const counts = reportEvidenceCounts(result);
  const coverageText = locale === 'de'
    ? `${result.crawl.captured} erfasste Antworten (${counts.successfulResponses ?? 'UNBEKANNT'} erfolgreiche Antworten; abgeschlossene HTML-Analysen: ${counts.analyzedHtmlPages ?? 'UNBEKANNT'}) aus ${result.crawl.discovered} entdeckten URLs · ${result.crawl.failed} fehlgeschlagen · ${result.crawl.unattempted} nicht versucht · Seitenlimit ${result.crawlSettings.policy.maxPages}.`
    : `${result.crawl.captured} captured responses (${counts.successfulResponses ?? 'UNKNOWN'} successful responses; completed HTML analyses: ${counts.analyzedHtmlPages ?? 'UNKNOWN'}) from ${result.crawl.discovered} discovered URLs · ${result.crawl.failed} failed · ${result.crawl.unattempted} unattempted · page limit ${result.crawlSettings.policy.maxPages}.`;
  const finish = partial
    ? (locale === 'de' ? 'Crawl mit Lücken abgeschlossen; ausgewiesene Prüfungsumfänge beachten.' : 'Crawl finished with gaps; review the recorded scope and check coverage statuses.')
    : (locale === 'de' ? 'Crawl abgeschlossen; Umfang und Status einzelner Prüfungen separat beachten.' : 'Crawl finished; review individual check coverage separately.');
  const notRun = result.capabilities.technology === 'disabled'
    ? (locale === 'de' ? 'Technologie-Erkennung nicht ausgeführt' : 'Technology detection not run')
    : result.capabilities.technology === 'unavailable' || result.capabilities.technology === 'failed' ? (locale === 'de' ? 'Technologieprüfung der Start-URL nicht verfügbar' : 'Seed-page technology check unavailable') : result.findings.some(f => f.code === 'technology_detected') ? (locale === 'de' ? 'Technologiesignale auf der geprüften Start-URL; nicht bestätigt' : 'Seed-page technology signals; not confirmed') : (locale === 'de' ? 'Kein Technologiesignal auf der geprüften Start-URL; CMS unbekannt' : 'No seed-page technology signal; CMS unknown');
  const title = locale === 'de' ? 'Interner technischer SEO-Bericht' : 'Internal technical SEO report';
  const visibleGroups = groups.flatMap((group) => {
    if (group.code !== 'pagespeed_category_score') return [group];
    const findings = group.findings.filter((finding) => {
      const match = finding.observed.match(/^([^:]+) score: (\d+)\/100\.?$/iu);
      const name = match?.[1]?.toLowerCase();
      return Boolean(match && name && ['performance', 'accessibility', 'best-practices', 'seo'].includes(name));
    });
    return findings.length ? [{ ...group, findings, pages: uniquePages(findings) }] : [];
  });
  const findingsTotal = visibleGroups.reduce((sum, group) => sum + issueOccurrences(group.findings), 0);
  const findingsGrid = visibleGroups.length
    ? visibleGroups.map((group) => operatorFindingCard(group, locale, result)).join('')
    : `<article class="check empty"><strong>${locale === 'de' ? 'Keine Beobachtungen erfasst' : 'No observations recorded'}</strong></article>`;
  const limitationParts = result.crawl.limitations.map((value) => value.replaceAll('_', ' '));
  for (const [name, status] of Object.entries(result.capabilities)) if (status !== 'complete') limitationParts.push(`${name}: ${status}`);
  for (const [name, reason] of Object.entries(result.enrichmentLimitations ?? {})) limitationParts.push(`${name}: ${typeof reason === 'string' ? reason.replaceAll('_', ' ') : 'invalid limitation value'}`);
  if (result.coverage) for (const [name, check] of Object.entries(result.coverage.checks)) if (check.status !== 'complete') limitationParts.push(`${name}: ${check.status}`);
  if (result.contacts && result.contacts.status !== 'complete') limitationParts.push(`contacts: ${result.contacts.status}`);
  if (result.sitemap && result.sitemap.status !== 'complete') limitationParts.push(`sitemap: ${result.sitemap.status}`);
  const limitations = limitationParts.length ? limitationParts.map(escape).join(', ') : locale === 'de' ? 'keine' : 'none';
  const securityCoverage = operatorSecurityCoverage(result, locale);
  const pageSpeedReason = result.enrichmentLimitations?.pagespeed;
  const readablePageSpeedReason = pageSpeedReason === 'pagespeed_http_429'
    ? (locale === 'de' ? 'Tageskontingent überschritten (HTTP 429)' : 'daily quota exceeded (HTTP 429)')
    : pageSpeedReason === 'pagespeed_request_failed'
      ? (locale === 'de' ? 'API-Anfrage fehlgeschlagen' : 'API request failed')
      : pageSpeedReason;
  const capabilityPageSpeed = result.capabilities.pagespeed ?? 'unavailable';
  const localizedPageSpeedStatus = locale === 'de'
    ? ({ complete: 'verfügbar', partial: 'teilweise verfügbar', unavailable: 'nicht verfügbar', disabled: 'deaktiviert', failed: 'fehlgeschlagen' } as const)[capabilityPageSpeed]
    : capabilityPageSpeed;
  const pageSpeedStatus = locale === 'de'
    ? `PageSpeed Insights Mobil: ${localizedPageSpeedStatus}${readablePageSpeedReason ? ` · ${readablePageSpeedReason}` : ''}`
    : `PageSpeed Insights mobile: ${localizedPageSpeedStatus}${readablePageSpeedReason ? ` · ${readablePageSpeedReason}` : ''}`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>
@page{size:A4;margin:7mm 0}*{box-sizing:border-box}html,body{margin:0;padding:0;color:#172a35;font:9pt/1.25 Arial,Helvetica,sans-serif}.sheet{width:210mm;padding:0 8mm}.topline{height:1.4mm;margin:0 -8mm 4mm;background:#168e91}.header h1{font-size:15pt;margin:0 0 1mm}.meta{margin:0;color:#34444c;font-size:8pt}.section{margin-top:3mm}.section h2{font-size:9pt;color:#176c75;margin:0 0 1mm}.assessment{padding:1.5mm 2mm;background:#f1f6f6;border-left:1.2mm solid #168e91}.assessment strong{font-size:9pt}.assessment p{margin:1mm 0 0}.grid-head{font-size:9pt;margin:3mm 0 1.5mm}.grid{display:grid;grid-template-columns:1fr 1fr;gap:1mm 1.5mm}.check{border:1px solid #d1dfe0;border-left:1mm solid #168e91;border-radius:1.2mm;padding:1mm;min-height:13mm;break-inside:avoid}.check header{display:flex;justify-content:space-between;gap:2mm;align-items:baseline}.check header strong{font-size:8.5pt}.check header span{white-space:nowrap;font-weight:bold;color:#176c75}.check p{margin:.4mm 0 0}.check .category{color:#176c75;font-weight:bold;font-size:8pt}.check .example{font-size:8pt;color:#445b62;overflow-wrap:anywhere}.check a{color:#286c75;text-decoration:none}.empty{min-height:12mm}.security-coverage{display:grid;grid-template-columns:1fr 1fr;gap:1mm 3mm;padding:1.5mm 2mm;border:1px solid #d1dfe0;background:#f8fbfb;font-size:8pt}.security-coverage span{overflow-wrap:anywhere}.foot{margin-top:2mm;padding-top:1.3mm;border-top:1px solid #d1dfe0;color:#51666d;font-size:8pt;break-before:avoid}@media(max-width:600px){.sheet{width:100%;padding:7mm 4mm}.topline{margin-left:-4mm;margin-right:-4mm}.grid,.security-coverage{grid-template-columns:1fr}.check header{flex-wrap:wrap}}
</style></head><body><main class="sheet"><div class="topline"></div><header class="header"><h1>${escape(title)}</h1><p class="meta">Website: ${escape(hostLabel(result.target))} · ${locale === 'de' ? 'Erfasst' : 'Captured'}: ${escape(result.startedAt)}</p></header><section class="section"><h2>${locale === 'de' ? 'Erfassungsumfang' : 'Crawl coverage'}</h2><div class="assessment"><strong>${escape(state)}</strong><p>${escape(coverageText)}</p><p>${escape(finish)}</p><p>${escape(pageSpeedStatus)}</p></div></section>${securityCoverage}<h2 class="grid-head">${locale === 'de' ? `Alle Prüfergebnisse · ${findingsTotal} Vorkommen in ${visibleGroups.length} Prüffeldern` : `All checks · ${findingsTotal} evidence occurrences across ${visibleGroups.length} check fields`}</h2><section class="grid">${findingsGrid}</section><footer class="foot">${locale === 'de' ? `Technologie: ${escape(notRun)} · Einschränkungen: ${escape(limitations)} · Stichprobe öffentlicher Seiten; Befunde benötigen fachliche Prüfung.` : `Technology: ${escape(notRun)} · Limitations: ${escape(limitations)} · Public-page sample; findings require human review.`}</footer></main></body></html>`;
}

export async function renderOperatorStatusPdf(result: AuditResult, renderer: PdfRenderer, options: Readonly<{ locale?: SummaryLocale; timeoutMs?: number; signal?: AbortSignal }> = {}): Promise<Uint8Array> {
  const html = renderOperatorStatusHtml(result, options.locale ?? 'de');
  return renderer(html, { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
}
