import { countDeduplicatedIssues } from './issue-counts.js';
import { isReportableEvidenceAdmissible } from './qualification.js';
import type { AuditFinding, AuditResult, FindingEvidence } from '@spora/webcrawl';
import { validateReportContact, type ReportContact } from './report-contact.js';
import { reportCapturedUrlCount, reportPageReference, reportPageReferences, type ReportPageReference } from './references.js';

type Locale = 'en' | 'de';
const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const urlLikeIssuerIdentity = (value: string): boolean => /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)www\.[^\s]+|(?:^|\s)[\p{L}\d](?:[\p{L}\d-]*\.)+[\p{L}\d-]{2,}(?:\/[^\s]*)?)/iu.test(value);
const commercial = (url: string): boolean => /\/(?:kurse|kurs|courses?|lessons?|shop|products?|collections?|rentals?|hire|booking|buchen)(?:\/|$)|\/[^/]*(?:kurs|unterricht|training|lesson|course|product|collection|rental|booking)[^/]*(?:\/|$)/iu.test(new URL(url).pathname);
// These exact route segments identify transactional endpoints even below an offer directory.
const transactional = (url: string): boolean => /\/(?:checkout|cart|payment(?:-form)?|order-confirmation|thank-you)(?:\/|$)/iu.test(new URL(url).pathname);
const archive = (url: string): boolean => { try { const path = new URL(url).pathname; return /\/(?:category|tag|author|archive|archives)(?:\/|$)/iu.test(path) || /^\/(?:19|20)\d{2}(?:\/(?:0?[1-9]|1[0-2])(?:\/(?:0?[1-9]|[12]\d|3[01]))?)?(?:\/page\/\d+)?\/?$/iu.test(path); } catch { return false; } };
const legal = (url: string): boolean => /\/(?:impressum(?:-\d+)?|imprint|privacy(?:-policy)?|datenschutz(?:richtlinie)?|cookie(?:-policy|-richtlinie)?|legal-notice|affiliate-disclaimer|disclaimer|terms(?:-and-conditions|-of-service|-of-use)?|refund-policy|returns-policy|aviso-legal|politica-(?:privacidad|cookies))(?:\/|$)/iu.test(new URL(url).pathname);
const nonOffer = (url: string): boolean => legal(url) || archive(url) || /\/attachment(?:\/|$)/iu.test(new URL(url).pathname) || /\/(?:accessibility|accesibilidad|zuganglichkeit|web-map|mapa-web|webkarte)(?:\/|$)/iu.test(new URL(url).pathname);
// Routine search/headings advice is limited to recognizable main site routes.
// Unknown slugs remain operator review material rather than filling a quota.
function routineCustomerPage(raw: string, target: string, seedFinal?: string): boolean {
  try {
    const path = new URL(raw).pathname;
    if (nonOffer(raw) || transactional(raw) || /\/(?:blog|news|posts?|demo|sample-page|hello-world|lorem-ipsum|policies)(?:\/|$)/iu.test(path)) return false;
    if (captureKey(raw) === captureKey(target) || seedFinal !== undefined && captureKey(raw) === captureKey(seedFinal) || /^\/(?:(?:[a-z]{2}(?:-[a-z]{2})?)\/?)?$/iu.test(path)) return true;
    return commercial(raw) || /\/(?:contact(?:-us)?|kontakt|contacto|contato|about(?:-us)?|team|our-team|locations?|schools?|services?|offers?|pricing|prices?|rates?|accommod?ation|activities|appointments?|kite|kitesurfing|wing(?:-foil)?|wingfoiling|foil)(?:\/|$)/iu.test(path);
  } catch { return false; }
}
const pages = (findings: readonly AuditFinding[]): ReportPageReference[] => reportPageReferences(findings).sort((a,b) => Number(commercial(b.url)) - Number(commercial(a.url)) || Number(nonOffer(a.url)) - Number(nonOffer(b.url)) || new URL(a.url).pathname.split('/').filter(Boolean).length - new URL(b.url).pathname.split('/').filter(Boolean).length || a.url.localeCompare(b.url));
export type CustomerPriority = { code: string; measurement?: 'performance'; title: string; observed: string; why: string; action: string; owner: string; urls: ReportPageReference[]; rank: number; group: number; severity?: number };

/** Resolve the exact selected example once for reports, drafts and handoff. */
export function customerPriorityObservation(findings: readonly AuditFinding[], topic: CustomerPriority): { finding: AuditFinding; evidence: FindingEvidence } | undefined {
  const ref = topic.urls[0];
  return findings.filter(f => f.code === topic.code && (!topic.measurement || f.observed.toLowerCase().startsWith(`${topic.measurement} score:`)))
    .flatMap(finding => finding.evidence.filter(e => reportPageReference(e.pageUrl)?.identity === ref?.identity).map(evidence => {
      if (finding.code === 'broken_internal_link' && !evidence.anchorHref) {
        const identity = reportPageReference(evidence.requestedUrl ?? evidence.pageUrl)?.identity;
        const referring = finding.evidence.find(item => {
          try { return item.anchorHref && item.value === evidence.value && item.observedAt === evidence.observedAt && reportPageReference(new URL(item.anchorHref, item.pageUrl).href)?.identity === identity; } catch { return false; }
        });
        if (referring) return { finding, evidence: referring };
      }
      return { finding, evidence };
    }))
    .sort((a,b) => (topic.measurement ? -1 : 1) * (Date.parse(a.evidence.observedAt) - Date.parse(b.evidence.observedAt)) || JSON.stringify(a).localeCompare(JSON.stringify(b)))[0];
}

// Join original captured URL identities before share-safe query redaction.
// Otherwise distinct pages can collapse to one URL and suppress valid evidence.
function captureKey(raw: string): string | undefined {
  try {const url=new URL(raw);if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;url.hash='';return url.href;} catch {return;}
}
const ROUTINE_SEARCH_CODES = new Set(['missing_canonical', 'missing_meta_description', 'meta_description_length', 'duplicate_meta_description_across_pages', 'duplicate_title_across_pages', 'title_long', 'missing_h1', 'heading_hierarchy_skip', 'multiple_h1', 'duplicate_h1']);
const administrativePage = (raw: string | undefined): boolean => {
  if (!raw) return false;
  try { return /\/(?:wp-login\.php|wp-admin|wp-signup\.php|wp-register\.php)(?:\/|$)/iu.test(new URL(raw).pathname); } catch { return false; }
};
// This Cloudflare route decodes protected email links in the browser; a crawl
// response alone does not establish a visitor-facing broken link.
const emailProtectionPage = (raw: string | undefined): boolean => {
  if (!raw) return false;
  try { return /^\/cdn-cgi\/l\/email-protection(?:\/|$)/iu.test(new URL(raw).pathname); } catch { return false; }
};
const CROSS_PAGE_DUPLICATES = new Set(['duplicate_meta_description_across_pages', 'duplicate_title_across_pages']);

/** A display label only; the link retains the exact admitted evidence URL. */
export function customerPageLabel(raw: string, locale: Locale | 'pt-BR'): string {
  try {
    const path = new URL(raw).pathname;
    if (path === '/') return locale === 'de' ? 'Startseite' : locale === 'pt-BR' ? 'Página inicial' : 'Homepage';
    const segments = path.split('/').filter(Boolean).map(segment => {
      try { segment = decodeURIComponent(segment); } catch { /* Keep the encoded segment if malformed. */ }
      return segment.replace(/\.(?:html?|php|aspx?)$/iu, '').replace(/[-_]+/gu, ' ').trim();
    });
    const last = segments.at(-1)!;
    let label: string;
    if (/^\d+$/u.test(last)) {
      const penultimate = segments.at(-2)?.toLocaleLowerCase();
      const pageMarker = penultimate === 'page' || penultimate === 'pages' || penultimate === 'seite' || penultimate === 'seiten' || penultimate === 'página' || penultimate === 'páginas';
      const context = segments.slice(0, pageMarker ? -2 : -1).filter(Boolean).join(' ');
      const suffix = pageMarker
        ? locale === 'de' ? `Seite ${last}` : locale === 'pt-BR' ? `página ${last}` : `page ${last}`
        : last;
      label = context ? `${context} — ${suffix}` : suffix;
    } else {
      label = last;
    }
    label = label.trim();
    if (!label) return locale === 'de' ? 'Beispielseite' : locale === 'pt-BR' ? 'Página de exemplo' : 'Example page';
    label = label.charAt(0).toLocaleUpperCase() + label.slice(1);
    if (label.length <= 72) return label;
    const numericTail = / — ((?:(?:page|Seite|página) )?\d+)$/u.exec(label)?.[1];
    if (numericTail) {
      const tail = ` — ${numericTail}`;
      return `${label.slice(0, -(tail.length)).slice(0, 72 - tail.length - 1).trimEnd()}…${tail}`;
    }
    return `${label.slice(0, 69).trimEnd()}…`;
  } catch { return locale === 'de' ? 'Beispielseite' : locale === 'pt-BR' ? 'Página de exemplo' : 'Example page'; }
}

const CUSTOMER_TITLES: Readonly<Record<string, readonly [string, string]>> = {
  missing_meta_description: ['Missing search descriptions', 'Fehlende Suchbeschreibungen'],
  meta_description_length: ['Search descriptions to review', 'Suchbeschreibungen prüfen'],
  duplicate_meta_description_across_pages: ['Repeated search descriptions', 'Wiederholte Suchbeschreibungen'],
  duplicate_title_across_pages: ['Repeated page titles', 'Wiederholte Seitentitel'],
  image_file_too_large: ['Large image files', 'Große Bilddateien'],
  images_missing_alt: ['Missing image descriptions', 'Fehlende Bildbeschreibungen'],
  missing_image_alt: ['Missing image descriptions', 'Fehlende Bildbeschreibungen'],
  image_alt_missing_or_empty: ['Image descriptions to review', 'Bildbeschreibungen prüfen'],
  images_missing_dimensions: ['Missing image dimensions', 'Fehlende Bildmaße'],
  broken_internal_link: ['Broken internal links', 'Defekte interne Links'],
  http_status_error: ['Pages returning errors', 'Seiten mit Fehlermeldungen'],
  missing_h1: ['Missing main headings', 'Fehlende Hauptüberschriften'],
  missing_canonical: ['Preferred page versions', 'Bevorzugte Seitenversionen'],
  noindex: ['Pages requesting exclusion from search', 'Seiten mit Anweisung zum Suchausschluss'],
  pagespeed_category_score: ['Mobile loading performance', 'Mobile Ladeleistung'],
};

/** A4 customer PDF and responsive HTML share the same bounded briefing. */
export function customerBriefing(result: AuditResult, locale: Locale, options: Readonly<{ issuer?: ReportContact; clientReady?: boolean }> = {}): string {
  const issuer = options.issuer === undefined ? undefined : validateReportContact(options.issuer);
  if (issuer && [issuer.name, issuer.company].some(value => value !== undefined && urlLikeIssuerIdentity(value))) throw new Error('report_contact_identity_url_not_allowed');
  const de = locale === 'de';
  const t = (en: string, german: string): string => de ? german : en;
  const host = (() => { try { return new URL(result.target).hostname; } catch { return t('Website', 'Website'); } })();
  const date = new Intl.DateTimeFormat(de ? 'de-DE' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(result.startedAt));
  const capturedCount = result.crawl.captured;
  const { selected, scores, scoreUrlConflict, scoreTargetConflict, customerFindings, deduplicatedIssues } = customerPriorityProjection(result, locale);
  const compact = host.length > 100 || !!issuer && Object.values(issuer).join('').length > 220;

  const labels: Record<string, string> = { performance: t('Performance', 'Leistung'), accessibility: t('Accessibility', 'Barrierefreiheit'), 'best-practices': t('Best Practices', 'Best Practices'), seo: t('SEO', 'SEO') };
  // Keep all scores in the audit; show the customer SEO gauge and score only at 59 or below.
  const visibleScores = scores.filter(s => s.name !== 'seo' || s.score < 60);
  const psi = scores.length ? `<div class="scores">${visibleScores.map(s => {
    const color = s.score >= 90 ? '#16876b' : s.score >= 50 ? '#c98224' : '#c94f4f';
    const circumference = 2 * Math.PI * 27;
    return `<div class="score-card"><svg viewBox="0 0 64 64" role="img" aria-label="${esc(labels[s.name]!)} ${s.score}/100"><circle cx="32" cy="32" r="27" fill="none" stroke="#e7eeec" stroke-width="5"/><circle cx="32" cy="32" r="27" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(circumference * s.score / 100).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="#183b45">${s.score}</text></svg><strong>${esc(labels[s.name]!)}</strong></div>`;
  }).join('')}</div>${result.capabilities.pagespeed === 'partial' || scores.length < 4 ? `<p class="note">${t('Some measurements were unavailable.', 'Einige Messwerte waren nicht verfügbar.')}</p>` : ''}` : `<p>${scoreUrlConflict ? t('PageSpeed category scores refer to different pages and have been withheld. Request a fresh set for one page.', 'Die PageSpeed-Kategoriewerte beziehen sich auf unterschiedliche Seiten und werden deshalb nicht angezeigt. Lassen Sie eine neue Messung für eine einzelne Seite durchführen.') : scoreTargetConflict ? t('PageSpeed measurements do not match the audited target page and have been withheld. Request a fresh set for the audited page.', 'Die PageSpeed-Messungen stimmen nicht mit der geprüften Zielseite überein und werden deshalb nicht angezeigt. Lassen Sie eine neue Messung für die geprüfte Seite durchführen.') : result.capabilities.pagespeed === 'disabled' ? t('Not run for this audit.', 'Für diesen Lauf nicht durchgeführt.') : t('No usable scores were available. Ask your website provider to repeat the mobile measurement before drawing conclusions about speed.', 'Es lagen keine nutzbaren Werte vor. Lassen Sie die mobile Messung wiederholen, bevor Sie Rückschlüsse zur Geschwindigkeit ziehen.')}</p>`;
  const homepageMeasurement = (() => { try { const u = new URL(result.target); return u.pathname === '/' && !u.search && scores.every(score => score.url && captureKey(score.url.url) === captureKey(result.target)); } catch { return false; } })();
  // Website is accepted as issuer metadata for compatibility, but is omitted
  // from this PDF so the only site address remains the domain in the header.
  const publisherName = issuer ? [issuer.name, issuer.company].filter(Boolean).map(value => esc(value!)).join(' · ') : '';
  const publisherChannels = issuer ? [issuer.email, issuer.phone].filter(Boolean).map(value => esc(value!)).join(' · ') : '';
  const footer = `<footer class="issuer"><aside class="offer"><strong>${t('Let’s get in touch', 'Lassen Sie uns sprechen')}</strong><p>${t('Contact us using the reply details below to discuss this archived review.', 'Kontaktieren Sie uns über die unten stehenden Angaben, um diese archivierte Prüfung zu besprechen.')}</p></aside><div class="issuer-details">${publisherName ? `<strong>${publisherName}</strong>` : ''}${publisherChannels ? `<span>${publisherChannels}</span>` : ''}</div></footer>`;
  const hold = selected.length === 0 || compact;
  const cards = selected.map(topic => {
    const count = reportCapturedUrlCount(result, topic.urls);
    const broken = customerFindings.filter(f => f.code === 'broken_internal_link').flatMap(f => f.evidence);
    const destinations = new Set(broken.flatMap(e => { try { return e.anchorHref ? [reportPageReference(new URL(e.anchorHref, e.pageUrl).href)?.identity].filter(Boolean) : []; } catch { return []; } })).size;
    const referring = new Set(broken.filter(e => e.anchorHref).map(e => reportPageReference(e.pageUrl)?.identity).filter(Boolean)).size;
    const pageLabel = topic.code === 'broken_internal_link' ? t(`${destinations} distinct broken ${destinations === 1 ? 'destination' : 'destinations'} · ${referring} referring ${referring === 1 ? 'page' : 'pages'}`, `${destinations} verschiedene fehlerhafte Ziele · ${referring} verweisende Seiten`) : topic.measurement ? t('Tested page', 'Geprüfte Seite') : count === null ? t('Page review', 'Seitenprüfung') : `${count} ${count === 1 ? t('page to review', 'Seite prüfen') : t('pages to review', 'Seiten prüfen')}`;
    const example = topic.urls[0];
    const observation = customerPriorityObservation(customerFindings, topic);
    const selectedEvidence = observation?.evidence;
    const exampleFinding = selectedEvidence ? result.findings.findIndex(f => f.code === topic.code && f.evidence.includes(selectedEvidence)) : -1;
    const exampleEvidence = exampleFinding < 0 || !selectedEvidence ? -1 : result.findings[exampleFinding]!.evidence.indexOf(selectedEvidence);
    const affectedPage = example ? `<p class="example">${t('Example page', 'Beispielseite')}: ${example.redacted ? `<span>${esc(customerPageLabel(example.url, locale))} (${t('query values withheld', 'Abfragewerte entfernt')})</span>` : `<a href="${esc(example.url)}">${esc(customerPageLabel(example.url, locale))}</a>`}</p>` : '';
    const title = CUSTOMER_TITLES[topic.code]?.[de ? 1 : 0] ?? topic.title;
    return `<article class="card"><span class="label" data-issue-code="${esc(topic.code)}" data-example-finding="${exampleFinding}" data-example-evidence="${exampleEvidence}">${pageLabel}</span><h3>${esc(title)}</h3>${affectedPage}${topic.observed ? `<p class="note">${esc(topic.observed)}</p>` : ''}<p>${esc(topic.why)}</p><p class="action"><strong>${t('Next step', 'Nächster Schritt')}:</strong> ${esc(topic.action)}</p></article>`;
  }).join('');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t('Website review', 'Website-Prüfung')}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;color:#183640;font:10pt/1.3 Arial,Helvetica,sans-serif}.page{width:210mm;min-height:297mm;margin:auto;padding:0 12mm;display:flex;flex-direction:column;overflow-wrap:anywhere}.hero{background:#102d3a;color:white;padding:5mm 12mm;margin:0 -12mm;border-radius:0}.hero-top{display:flex;justify-content:space-between;gap:4mm;font-size:9pt;color:#c4ddda}.hero h1{font-size:21pt;line-height:1.12;margin:3mm 0 1mm}.hero p{margin:1mm 0;font-size:10pt}.snapshots{display:flex;justify-content:flex-start;gap:3mm;padding:4mm 0 0;flex-wrap:wrap}.snapshot{padding:1.5mm 3mm;border:1px solid #d8e3e1;border-radius:2mm;background:#f5f8f7;color:#49636a;font-size:9pt}.snapshot strong{color:#155e66;font-size:11pt;margin-right:2mm}.scope{margin-top:3mm;padding:3mm;background:#f4f8f7;border-left:1mm solid #16858a}.lighthouse{margin-top:4mm;padding:3mm 4mm;border:1px solid #d8e3e1;border-radius:2mm;background:#f5f8f7}.lighthouse h2,.findings h2{font-size:10pt;margin:0 0 2mm}.scores{display:flex;gap:3mm}.score-card{flex:1;min-width:0;text-align:center;background:white;border:1px solid #d8e3e1;border-radius:2mm;padding:2mm}.score-card svg{display:block;width:12mm;height:12mm;margin:auto}.score-card strong,.score-date{display:block;font-size:9pt}.findings{margin-top:4mm}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3mm}.one-topic .grid{grid-template-columns:1fr}.four-topics .grid,.six-topics .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card{padding:3mm 4mm;border:1px solid #d8e3e1;border-left:.8mm solid #17858a;border-radius:2mm;break-inside:avoid}.card h3{font-size:12pt;line-height:1.2;margin:1mm 0}.card p{font-size:10pt;line-height:1.3;margin:0}.card p+p{margin-top:1.5mm}p{margin:1mm 0}.label{font-size:9pt;font-weight:bold;color:#49636a}.card .example{margin:1mm 0 2mm;font-size:9.5pt;color:#49636a}.example a{display:inline;color:#145c6a;text-decoration:underline;overflow-wrap:anywhere}.note{font-size:9pt}.notes{margin-top:2mm}.alert{color:#8e4b1d;font-weight:bold}.offer{margin-top:4mm;margin-bottom:4mm;break-inside:avoid}.offer strong{font-size:10pt}.offer p{font-size:9.5pt;line-height:1.3;margin:1mm 0}.issuer{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:1mm 4mm;margin:auto -12mm 0;padding:4mm 12mm;background:#102d3a;border:0;font-size:9.5pt;line-height:1.4;color:#c4ddda;overflow-wrap:anywhere}.issuer strong{color:white}.issuer span{display:inline}.compact .hero h1{font-size:15pt}@media screen and (max-width:700px){.page{width:100%;min-height:0;padding:20px}.hero{padding:16px}.hero-top{flex-wrap:wrap}.scores{flex-wrap:wrap}.issuer{margin-top:24px}}@media print{.six-topics .hero{padding-top:3mm;padding-bottom:3mm}.six-topics .hero h1{font-size:18pt}.six-topics .snapshots{padding-top:2mm}.six-topics .lighthouse{padding:2mm 3mm}.six-topics .score-card{padding:1mm}.six-topics .score-card svg{width:10mm;height:10mm}.six-topics .grid{gap:1.5mm}.six-topics .card{padding:1.5mm 2mm}.six-topics .card h3{font-size:11pt}.six-topics .card p{line-height:1.2}.six-topics .card p+p{margin-top:1mm}.page{margin:0}.hero{padding-top:4mm;padding-bottom:4mm}.scope{padding:2mm}.lighthouse,.findings{margin-top:3mm}.grid{gap:2mm}.card{padding:2mm 3mm}.offer{margin-top:3mm;margin-bottom:3mm}.issuer{padding-top:3mm;padding-bottom:3mm}}
.issuer{display:block;flex:none;margin:auto -12mm 0;padding:0;width:auto;background:#102d3a;color:#c4ddda}.issuer .offer{margin:0;padding:3mm 12mm 2mm}.issuer-details{display:flex;align-items:center;flex-wrap:wrap;gap:1mm 4mm;padding:2mm 12mm 3mm;border-top:1px solid #3b5660}.issuer .offer strong{color:white}</style></head><body data-publication-status="${hold ? 'HOLD' : 'PREVIEW'}" data-client-ready="false" data-review-layout-check="true"><main class="page${hold ? ' hold-preview' : ''}${selected.length === 1 ? ' one-topic' : ''}${compact ? ' compact' : selected.length === 4 ? ' four-topics' : selected.length > 4 ? (selected.length === 5 ? ' six-topics five-topics' : ' six-topics') : ''}"><header class="hero"><div class="hero-top"><strong>${t('WEBSITE REVIEW', 'WEBSITE-PRÜFUNG')}</strong><span>${t('Website checked', 'Website geprüft')} · <time datetime="${esc(result.startedAt)}">${esc(date)}</time></span></div><h1>${esc(host)}</h1><p><strong>${t('What deserves attention', 'Was Aufmerksamkeit verdient')}</strong></p></header><div class="snapshots"><div class="snapshot"><strong>${capturedCount}</strong>${t(capturedCount === 1 ? 'captured response' : 'captured responses', capturedCount === 1 ? 'erfasste Antwort' : 'erfasste Antworten')}</div><div class="snapshot" data-summary="deduplicated-issues"><strong>${deduplicatedIssues}</strong>${t(deduplicatedIssues === 1 ? 'SEO finding' : 'SEO findings', deduplicatedIssues === 1 ? 'SEO-Befund' : 'SEO-Befunde')}</div><div class="snapshot"><strong>${selected.length}</strong>${t(selected.length === 1 ? 'topic to review' : 'topics to review', selected.length === 1 ? 'Thema zum Prüfen' : 'Themen zum Prüfen')}</div></div><section class="lighthouse"><h2>${homepageMeasurement || !scores.length && (() => { try { const u = new URL(result.target); return u.pathname === '/' && !u.search; } catch { return false; } })() ? t('Homepage · Mobile lab page', 'Startseite · Mobile Labormessung') : t('Tested page · Mobile lab page', 'Geprüfte Seite · Mobile Labormessung')}</h2>${psi}</section><section class="findings"><h2>${selected.length ? t('Key observations', 'Wichtige Beobachtungen') : t('No selected priorities', 'Keine ausgewählten Schwerpunkte')}</h2>${selected.length ? `<div class="grid${selected.length === 5 ? ' five-topics' : ''}">${cards}</div>` : `<p>${t('No specific priority was selected; this does not establish that the website is problem-free.', 'Es wurde kein Schwerpunkt ausgewählt; das belegt keine Fehlerfreiheit der Website.')}</p>`}</section>${footer}</main></body></html>`;
}

export function customerPriorityProjection(result: AuditResult, locale: Locale = 'en') {
  const de = locale === 'de';
  const t = (en: string, german: string): string => de ? german : en;
  const topics: CustomerPriority[] = [];
  const orderedFindings = result.findings.map(f => ({ ...f, evidence: f.code === 'image_file_too_large' && f.evidence.length ? [f.evidence[0]!, ...f.evidence.slice(1).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))] : [...f.evidence].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const noindex = new Set(orderedFindings.filter(f=>f.code==='noindex' && isReportableEvidenceAdmissible(result,f)).flatMap(f=>f.evidence.map(e=>captureKey(e.pageUrl)).filter((key): key is string=>key!==undefined)));
  const errorPageKeys = new Set(result.coverage?.urls.filter(item => item.outcome === 'captured' && (item.statusCode === 404 || item.statusCode === 410)).flatMap(item => [item.url, item.finalUrl].filter((url): url is string => Boolean(url)).map(url => captureKey(url)).filter((key): key is string => key !== undefined)) ?? []);

  const customerFindings = orderedFindings.flatMap(f=>{
    // Historical H1 counts are document-wide, not counts of main headings.
    if (['multiple_h1', 'duplicate_h1', 'title_long'].includes(f.code)) return [];
    const safeEvidence = f.evidence.filter(e => {
      if (!reportPageReference(e.pageUrl)) return false;
      // Administrative WordPress pages and links to them are not public offers.
      // Preserve their observations in the audit and operator reports.
      if (administrativePage(e.pageUrl) || emailProtectionPage(e.pageUrl)) return false;
      if (f.code === 'broken_internal_link' && (administrativePage(e.anchorHref) || administrativePage(e.requestedUrl) || administrativePage(e.finalUrl) || emailProtectionPage(e.anchorHref) || emailProtectionPage(e.requestedUrl) || emailProtectionPage(e.finalUrl))) return false;
      if (!['http_status_error', 'broken_internal_link'].includes(f.code) && errorPageKeys.has(captureKey(e.pageUrl) ?? '')) return false;
      if (f.code === 'noindex' && transactional(e.pageUrl)) return false;
      if (f.code === 'noindex' && (archive(e.pageUrl) || legal(e.pageUrl) || /\/(?:search|legal)(?:\/|$)/iu.test(new URL(e.pageUrl).pathname))) return false;
      // Policy availability is retained in the technical audit, rather than
      // outranking an observed failure on an enquiry or offer route.
      if (f.code === 'http_status_error' && legal(e.pageUrl)) return false;
      if (['http_status_error', 'broken_internal_link'].includes(f.code))
        return typeof e.value === 'number' && (e.value === 404 || e.value === 410 || e.value >= 500 && e.value <= 599);
      return !orderedFindings.some(other => other.code === 'http_status_error' && other.evidence.some(status => status.value === 429 && captureKey(status.pageUrl) === captureKey(e.pageUrl) && status.observedAt === e.observedAt));
    });
    if (!safeEvidence.length) return [];
    f = {...f, evidence: safeEvidence};
    if (!isReportableEvidenceAdmissible(result, f)) return [];
    if (!ROUTINE_SEARCH_CODES.has(f.code)) return [f];
    const evidence=f.evidence.filter(e=>{
      const seedFinal = result.coverage?.urls.find(row => captureKey(row.url) === captureKey(result.target) && row.outcome === 'captured')?.finalUrl;
      if (!routineCustomerPage(e.pageUrl, result.target, seedFinal)) return false;
      const key=captureKey(e.pageUrl);
      if (key && noindex.has(key)) {return false;}
      return true;
    });
    if (!evidence.length) return [];
    // A duplicate involving only one remaining page is no longer a customer
    // search duplicate, although the original observation stays in the audit.
    if (CROSS_PAGE_DUPLICATES.has(f.code) && new Set(evidence.map(e=>captureKey(e.pageUrl)).filter(Boolean)).size<2) return [];
    return [{...f,evidence}];
  });
  const linkedErrorTargets = new Set(customerFindings.filter(f => f.code === 'broken_internal_link').flatMap(f => f.evidence.map(e => captureKey(e.anchorHref ?? e.finalUrl ?? e.requestedUrl ?? e.pageUrl)).filter((key): key is string => key !== undefined)));
  const reviewFindings = customerFindings.flatMap(f => {
    if (f.code !== 'http_status_error') return [f];
    const evidence = f.evidence.filter(e => !linkedErrorTargets.has(captureKey(e.finalUrl ?? e.requestedUrl ?? e.pageUrl) ?? ''));
    return evidence.length ? [{ ...f, evidence }] : [];
  });
  const add = (codes: readonly string[], rank: number, title: string, descriptions: Record<string, string>, why: string, action: string, owner: string): void => {
    for (const code of codes) {
      const findings = reviewFindings.filter(f => f.code === code);
      if (!findings.length || !descriptions[code]) continue;
      const urls = pages(findings);
      if (!urls.length) continue;
      const adjustedRank = code === 'meta_description_length' ? 70 : code === 'noindex' && urls.length && urls.every(ref => legal(ref.url)) ? 65 : code === 'missing_h1' && urls.some(ref => commercial(ref.url)) ? 35 : rank;
      const legalNote = code === 'noindex' && urls.some(ref => legal(ref.url)) ? t(' Legal or privacy pages may intentionally be excluded.', ' Impressum oder Datenschutz können absichtlich ausgeschlossen sein.') : '';
      const relevanceReview = ['missing_meta_description', 'title_long'].includes(code) && !urls.some(ref => commercial(ref.url) || new URL(ref.url).pathname === '/');
      const explanation = code === 'title_long' && relevanceReview ? t('Clear titles help people understand a page’s content. Search engines may choose different text.', 'Klare Titel helfen Menschen, den Seiteninhalt zu verstehen. Suchmaschinen können andere Texte anzeigen.') : code === 'images_missing_dimensions' ? t('Check whether image dimensions are set to help avoid unexpected layout shifts.', 'Prüfen Sie Bildmaße, um unerwartete Layoutverschiebungen zu vermeiden.') : code === 'image_file_too_large' ? t('Large image files may slow loading; check whether they can be optimized.', 'Große Bilddateien können das Laden verlangsamen; prüfen Sie eine Optimierung.') : why;
      const relevanceAction = code === 'title_long' ? t('Review whether the flagged pages belong with the current offers before editing their titles. Confirm their purpose with the owner; retain intentional archives.', 'Prüfen Sie vor Titeländerungen, ob die gemeldeten Seiten zum aktuellen Angebot gehören. Klären Sie ihren Zweck mit dem Betrieb; behalten Sie beabsichtigte Archive.') : t('Review whether these pages belong with the current offers before editing descriptions. Confirm their purpose with the owner; retain intentional archives.', 'Prüfen Sie vor Textänderungen, ob diese Seiten zum aktuellen Angebot gehören. Klären Sie ihren Zweck mit dem Betrieb; behalten Sie beabsichtigte Archive.');
      const nextAction = relevanceReview ? relevanceAction : code === 'duplicate_title_across_pages' ? t('Check the preferred canonical relationship, including the homepage, before deciding whether these pages need distinct titles.', 'Prüfen Sie zuerst die bevorzugte Canonical-Beziehung einschließlich der Startseite, bevor Sie unterschiedliche Seitentitel festlegen.') : code === 'image_file_too_large' ? t('Ask your developer to inspect and optimize the flagged image files, then compare the page on a phone.', 'Lassen Sie die gemeldeten Bilddateien prüfen und optimieren. Vergleichen Sie danach die Seite auf einem Smartphone.') : code === 'images_missing_dimensions' ? t('Ask your developer to check the image dimensions and layout on the affected pages.', 'Lassen Sie Bildmaße und Layout auf den betroffenen Seiten technisch prüfen.') : action;
      const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
      const severity = Math.min(...findings.map(f => severityOrder[f.severity ?? ''] ?? 5));
      topics.push({ code, severity, title: descriptions[code]!, observed: legalNote.trim(), why: explanation, action: nextAction, owner, urls, rank: adjustedRank, group: rank });
    }
  };
  add(['http_status_error', 'broken_internal_link'], 10, t('Check pages and links that returned errors', 'Seiten und Links mit Fehlermeldungen prüfen'), {
    http_status_error: t('Some page responses returned error status codes.', 'Einige Seitenantworten lieferten Fehlercodes.'),
    broken_internal_link: t('Some internal links point to missing pages or files.', 'Einige interne Links führen zu nicht vorhandenen Seiten oder Dateien.'),
  }, t('An error on an important product, course or booking page can interrupt a visitor’s next step.', 'Ein Fehler auf einer wichtigen Produkt-, Kurs- oder Buchungsseite kann Besucher beim nächsten Schritt aufhalten.'), t('Check the affected address, confirm the error, then ask your developer to repair the page or link. Check the route from offer to enquiry or booking.', 'Prüfen Sie die betroffene Adresse, bestätigen Sie den Fehler und lassen Sie Seite oder Link korrigieren. Prüfen Sie den Weg vom Angebot zur Anfrage oder Buchung.'), t('Website developer', 'Webentwicklung'));
  add(['noindex', 'missing_canonical', 'robots_policy_unavailable'], 30, t('Confirm which pages should appear in search', 'Gewünschte Seiten für die Suche bestätigen'), {
    noindex: t('Some pages declare that search engines should not index them.', 'Einige Seiten weisen Suchmaschinen an, sie nicht zu indexieren.'),
    missing_canonical: t('Some pages do not declare a preferred version for search engines.', 'Einige Seiten nennen keine bevorzugte Version für Suchmaschinen.'),
    robots_policy_unavailable: t('The crawler instructions could not be inspected.', 'Die Anweisungen für Suchmaschinen konnten nicht geprüft werden.'),
  }, t('These settings can be intentional. The crawl does not establish whether Google lists a page.', 'Diese Einstellungen können beabsichtigt sein. Die Prüfung zeigt nicht, ob Google eine Seite listet.'), t('Tell your website provider which offers should be found in search. Have them check these settings before changing anything.', 'Teilen Sie Ihrer Website-Betreuung mit, welche Angebote in der Suche erscheinen sollen. Lassen Sie die Einstellungen vor Änderungen prüfen.'), t('Owner + website provider', 'Inhaber/in + Website-Betreuung'));
  add(['missing_meta_description', 'meta_description_length', 'duplicate_meta_description_across_pages', 'duplicate_title_across_pages', 'title_long'], 40, t('Make search listings describe the right offer', 'Angebote in Suchergebnissen verständlich beschreiben'), {
    missing_meta_description: t('Some pages have no search description.', 'Einigen Seiten fehlt eine Suchbeschreibung.'),
    meta_description_length: t('Some search descriptions fall outside an editorial length guideline; this is not a Google penalty.', 'Einige Suchbeschreibungen liegen außerhalb einer redaktionellen Längenempfehlung; dies ist keine Google-Strafe.'),
    duplicate_meta_description_across_pages: t('Some pages share the same search description.', 'Einige Seiten verwenden dieselbe Suchbeschreibung.'),
    duplicate_title_across_pages: t('Some pages share the same page title.', 'Einige Seiten verwenden denselben Seitentitel.'),
    title_long: t('Some page titles exceeded the length check.', 'Einige Seitentitel überschreiten den geprüften Längenbereich.'),
  }, t('Clear wording can help people distinguish your offers. Search engines may choose different text.', 'Klare Texte helfen Menschen, Angebote zu unterscheiden. Suchmaschinen können andere Texte anzeigen.'), t('Start with a main offer page. Check that its title and description match the offer, location and audience; ask your website editor to adjust wording where useful.', 'Beginnen Sie mit einer wichtigen Angebotsseite. Prüfen Sie, ob Titel und Beschreibung zu Angebot, Ort und Zielgruppe passen. Lassen Sie sinnvolle Textänderungen einpflegen.'), t('Owner + website editor', 'Inhaber/in + Website-Redaktion'));
  add(['image_file_too_large', 'images_missing_alt', 'missing_image_alt', 'image_alt_missing_or_empty', 'images_missing_dimensions'], 50, t('Review images visitors rely on', 'Wichtige Bilder prüfen'), {
    image_file_too_large: t('Some image responses declared sizes above the configured threshold.', 'Einige Bildantworten meldeten Dateigrößen über dem eingestellten Grenzwert.'),
    images_missing_alt: t('Some images have no alternative text.', 'Einigen Bildern fehlt ein Alternativtext.'),
    image_alt_missing_or_empty: t('Some images have missing or empty alternative text; decorative images may intentionally use empty text.', 'Einige Bilder haben fehlenden oder leeren Alternativtext; bei dekorativen Bildern kann leerer Text beabsichtigt sein.'),
    missing_image_alt: t('Some images have no alternative text.', 'Einigen Bildern fehlt ein Alternativtext.'),
    images_missing_dimensions: t('Some images have no valid width and height declarations.', 'Einigen Bildern fehlen gültige Angaben zu Breite und Höhe.'),
  }, t('Useful image descriptions support visitors using screen readers. Image delivery and layout also deserve a check on a phone.', 'Sinnvolle Bildbeschreibungen helfen Menschen mit Screenreader. Bildübertragung und Layout sollten auch auf einem Smartphone geprüft werden.'), t('Ask your editor to describe informative images; decorative images may need empty descriptions. Ask your developer to check image sizes and layout where flagged.', 'Lassen Sie informative Bilder beschreiben; dekorative Bilder dürfen leere Beschreibungen haben. Lassen Sie gemeldete Bildgrößen und das Layout technisch prüfen.'), t('Website editor + developer', 'Website-Redaktion + Webentwicklung'));
  add(['missing_h1', 'heading_hierarchy_skip', 'multiple_h1', 'duplicate_h1'], 60, t('Help visitors scan the page', 'Seiten leichter überblicken'), {
    missing_h1: t('Some documents contain no H1 heading.', 'Einige Dokumente enthalten keine H1-Überschrift.'),
    heading_hierarchy_skip: t('Some pages skip heading levels.', 'Einige Seiten überspringen Überschriftenebenen.'),
    multiple_h1: t('Some pages contain multiple main headings.', 'Einige Seiten enthalten mehrere Hauptüberschriften.'),
    duplicate_h1: t('Some pages repeat main-heading text.', 'Einige Seiten wiederholen den Text der Hauptüberschrift.'),
  }, t('Headings help visitors and screen-reader users understand the offer. These observations do not prove a ranking problem.', 'Überschriften helfen beim Verstehen des Angebots und bei der Nutzung mit Screenreader. Diese Beobachtungen belegen kein Rankingproblem.'), t('Ask your editor to check the affected pages. Make the main offer clear and arrange headings in a useful reading order.', 'Lassen Sie die betroffenen Seiten redaktionell prüfen. Benennen Sie das Hauptangebot klar und ordnen Sie Überschriften sinnvoll.'), t('Website editor', 'Website-Redaktion'));
  const scoreGroups = new Map<string, { candidates: Array<{ score: number; url: ReportPageReference; observedAt: string }>; invalid: boolean }>();
  for (const finding of orderedFindings) {
    if (finding.code !== 'pagespeed_category_score') continue;
    const name = /^(performance|accessibility|best-practices|seo)\b/iu.exec(finding.observed)?.[1]?.toLowerCase();
    if (!name) continue;
    let group = scoreGroups.get(name);
    if (!group) { group = { candidates: [], invalid: false }; scoreGroups.set(name, group); }
    if (!isReportableEvidenceAdmissible(result, finding)) group.invalid = true;
    const parsedScore = /^(?:performance|accessibility|best-practices|seo) score:\s*(\d+(?:\.\d+)?)\/100(?:\.|$)/iu.exec(finding.observed)?.[1];
    const evidence = finding.evidence.filter(item => item.source === 'pagespeed');
    if (!parsedScore || !evidence.length) { group.invalid = true; continue; }
    for (const item of evidence) {
      const score = Number(parsedScore);
      const ref = reportPageReference(item.pageUrl);
      if (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0 || item.value > 100 || item.value !== score || !ref) {
        group.invalid = true;
        continue;
      }
      group.candidates.push({ score: item.value, url: ref, observedAt: item.observedAt });
    }
  }
  const scoreCandidates = [...scoreGroups].flatMap(([name, group]) => {
    if (group.invalid || !group.candidates.length) return [];
    const first = group.candidates[0]!;
    if (group.candidates.some(item => item.score !== first.score || item.url.identity !== first.url.identity)) return [];
    // Duplicate identical observations can occur during enrichment retries;
    // use the latest request timestamp while retaining one category card.
    const latest = group.candidates.reduce((a, b) => Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a);
    return [{ name, score: latest.score, url: latest.url, observedAt: latest.observedAt }];
  });
  const auditTargetIdentity = captureKey(result.target);
  const observedScoreCandidates = [...scoreGroups.values()].flatMap(group => group.candidates);
  const scoreTargetConflict = observedScoreCandidates.length > 0 && (auditTargetIdentity === undefined || observedScoreCandidates.some(score => score.url.identity !== auditTargetIdentity));
  const scoreUrlConflict = new Set(observedScoreCandidates.map(score => score.url.identity)).size > 1;
  const scores = scoreTargetConflict || scoreUrlConflict ? [] : scoreCandidates;
  const performance = scores.find(s => s.name === 'performance');
  // Inclusive editorial review boundary; 50 is not claimed to be a failing PSI category.
  // Give this measured loading concern medium editorial priority so low-severity
  // metadata checks cannot crowd it out of the customer briefing's six-topic cap.
  if (performance && performance.score <= 50 && result.findings.some(f => f.code === 'pagespeed_category_score' && f.evidence.some(e => e.value === performance.score && e.observedAt === performance.observedAt) && isReportableEvidenceAdmissible(result, f))) topics.push({ code: 'pagespeed_category_score', measurement: 'performance', severity: 2, rank: 20, title: t('Investigate mobile loading performance', 'Ladeleistung auf Smartphones untersuchen'), observed: t(`The tested page scored ${performance.score}/100 for mobile performance in PageSpeed Insights.`, `Die getestete Seite erreicht bei PageSpeed Insights ${performance.score}/100 für mobile Ladeleistung.`), why: t('This laboratory score is a reason to investigate, not a measurement of lost enquiries or bookings.', 'Dieser Laborwert ist ein Anlass zur Prüfung, keine Messung verlorener Anfragen oder Buchungen.'), action: t('Ask your developer to inspect the main loading bottlenecks. Check the journey from your main offer to enquiry or booking on a phone.', 'Lassen Sie die größten Ladeprobleme untersuchen. Prüfen Sie auf einem Smartphone den Weg vom Hauptangebot zur Anfrage oder Buchung.'), owner: t('Website developer', 'Webentwicklung'), urls: performance.url ? [performance.url] : [], group: 20 });
  const reportableCodes = new Set(topics.map(topic => topic.code));
  const duplicateTitle = topics.find(topic => topic.code === 'duplicate_title_across_pages');
  const duplicateDescription = topics.find(topic => topic.code === 'duplicate_meta_description_across_pages');
  if (duplicateTitle && duplicateDescription) {
    const aliasSet = (topic: CustomerPriority) => topic.urls.map(ref => (captureKey(ref.url) ?? ref.url).replace(/\/$/u, '')).sort().join('\n');
    if (aliasSet(duplicateTitle) === aliasSet(duplicateDescription)) {
      duplicateTitle.title = t('Review repeated page titles and descriptions', 'Wiederholte Seitentitel und Beschreibungen prüfen');
      duplicateTitle.observed = `${duplicateTitle.observed} ${duplicateDescription.observed}`;
      duplicateTitle.urls = [...new Map([...duplicateTitle.urls, ...duplicateDescription.urls].map(ref => [ref.identity, ref])).values()];
      duplicateTitle.rank = Math.min(duplicateTitle.rank, duplicateDescription.rank);
      topics.splice(topics.indexOf(duplicateDescription), 1);
    }
  }
  // Severity comes first; editorial priority and affected-page count break ties.
  // Alias codes describe one topic, never extra cards to meet publication count.
  const preferredHeading = topics.filter(t => ['missing_h1', 'heading_hierarchy_skip'].includes(t.code)).sort((a,b) => (a.severity ?? 5) - (b.severity ?? 5) || (a.code === 'missing_h1' ? -1 : 1))[0]?.code;
  const distinctTopics = topics.filter((topic, index) => !(['missing_h1', 'heading_hierarchy_skip'].includes(topic.code) && topic.code !== preferredHeading) && !topics.slice(0, index).some(other => other.title === topic.title || topic.group === 50 && /alternative text|Alternativtext/iu.test(topic.title) && /alternative text|Alternativtext/iu.test(other.title)));
  const ranked = distinctTopics.sort((a, b) => (a.severity ?? 5) - (b.severity ?? 5) || a.rank - b.rank || Number(b.urls.some(ref => commercial(ref.url))) - Number(a.urls.some(ref => commercial(ref.url))) || b.urls.length - a.urls.length || a.code.localeCompare(b.code));
  const selected = ranked.slice(0, 6);
  const deduplicatedIssues = countDeduplicatedIssues(reviewFindings.filter(finding => reportableCodes.has(finding.code)
    && (finding.code !== 'pagespeed_category_score' || /^performance score:/iu.test(finding.observed))));
  return { selected, scores, scoreUrlConflict, scoreTargetConflict, customerFindings, deduplicatedIssues };

}
