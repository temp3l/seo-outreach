import { reportEvidenceCounts } from './references.js';
import { isReportableEvidenceAdmissible } from './qualification.js';
import { customerPageLabel } from './customer.js';
import type { AuditResult } from '@spora/webcrawl';
import { validateReportContact, type ReportContact } from './report-contact.js';

export type PortugueseOpportunity = Readonly<{ code: string; url: string; observed: string; observedAt: string; action: string; target?: string }>;
const esc = (s: string): string => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const safeUrl = (raw: string): URL | undefined => {
  try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash ? u : undefined; } catch { return undefined; }
};
const businessPage = (url: URL, target: URL): boolean => {
  const path = url.pathname.toLowerCase();
  if (/\/(?:privacy|privacidade|politica|cookie|legal|impressum|cart|carrinho|checkout|account|conta|category|tag|author|blog|post_galeria|hashtags|wp-admin|cdn-cgi)(?:\/|$)/u.test(path)) return false;
  // A shared hotel/store site may also offer unrelated services. A generic
  // booking or product path alone does not identify the kite-school offer.
  return url.href === target.href || path === '/' && target.pathname === '/' || /(?:kite|wing|foil)/u.test(path) && /(?:aulas?|cursos?|courses?|lessons?|booking|reserva|contato|contact|escola|school|training|instruction)/u.test(path);
};

/** A bounded customer projection from archived findings, not a new analysis. */
export function portugueseOpportunities(result: AuditResult): PortugueseOpportunity[] { return portugueseOpportunityProjection(result).selected; }
function portugueseOpportunityProjection(result: AuditResult): { selected: PortugueseOpportunity[]; deduplicatedIssues: number } {
  const target = safeUrl(result.target);
  if (!target || !result.coverage?.urls) return { selected: [], deduplicatedIssues: 0 };
  const host = target.hostname.replace(/^www\./iu, '').toLowerCase();
  const eligible = (raw: string): boolean => { const u = safeUrl(raw); return !!u && u.hostname.replace(/^www\./iu, '').toLowerCase() === host && businessPage(u, target); };
  const captured = new Set(result.coverage.urls.filter(x => x.outcome === 'captured' && x.statusCode !== undefined && x.statusCode >= 200 && x.statusCode < 300).flatMap(x => [x.url, x.finalUrl].filter((u): u is string => !!u)));
  const noindex = new Set(result.findings.filter(f => f.code === 'noindex' && isReportableEvidenceAdmissible(result, f)).flatMap(f => f.evidence.map(e => e.pageUrl)));
  const candidates: PortugueseOpportunity[] = [];
  for (const finding of result.findings) {
    if (!isReportableEvidenceAdmissible(result, finding)) continue;
    if (finding.code === 'noindex' || finding.code === 'missing_meta_description') {
      for (const e of finding.evidence) {
        if (!['http','rendered-dom'].includes(e.source) || !eligible(e.pageUrl) || !captured.has(e.pageUrl)) continue;
        if (finding.code === 'missing_meta_description' && noindex.has(e.pageUrl)) continue;
        candidates.push(finding.code === 'noindex'
          ? { code: finding.code, url: e.pageUrl, observedAt: e.observedAt, observed: 'A página foi registrada com uma instrução noindex para buscadores.', action: 'Confirme se esta página de oferta deve aparecer nas buscas. Se sim, peça à equipe do site para revisar a instrução; ela pode ser intencional.' }
          : { code: finding.code, url: e.pageUrl, observedAt: e.observedAt, observed: 'Não foi encontrada uma meta descrição nesta página.', action: 'Peça à equipe do site para revisar uma descrição clara da oferta. Buscadores podem escolher outro texto para exibir.' });
      }
    }
    if (finding.code === 'broken_internal_link') {
      for (const source of finding.evidence) {
        if ((source.value !== 404 && source.value !== 410) || !source.anchorHref || !eligible(source.pageUrl) || !captured.has(source.pageUrl)) continue;
        let destination: URL; try { destination = new URL(source.anchorHref, source.pageUrl); } catch { continue; }
        if (!safeUrl(destination.href) || destination.hostname.replace(/^www\./iu,'').toLowerCase() !== host || /\/cdn-cgi\/l\/email-protection/iu.test(destination.pathname) || (source.pageUrl !== target.href && !businessPage(destination, target))) continue;
        const confirmed = finding.evidence.some(e => e.value === source.value && !e.anchorHref && (e.requestedUrl === destination.href || e.pageUrl === destination.href));
        if (confirmed) candidates.push({ code: finding.code, url: source.pageUrl, target: destination.href, observedAt: source.observedAt, observed: `Um link desta página levou a um endereço que respondeu HTTP ${source.value} na coleta.`, action: 'Confirme o destino atual e peça à equipe do site para corrigir o link ou restaurar a página.' });
      }
    }
  }
  const rank: Record<string, number> = { noindex: 0, broken_internal_link: 1, missing_meta_description: 2 };
  candidates.sort((a,b) => (rank[a.code] ?? 9) - (rank[b.code] ?? 9) || Number(b.url === target.href) - Number(a.url === target.href) || a.url.localeCompare(b.url));
  const seen = new Set<string>();
  const deduplicatedIssues = new Set(candidates.map(x => JSON.stringify([x.code, x.url, x.target ?? null]))).size;
  const selected = candidates.filter(x => { const key = x.code === 'broken_internal_link' ? `${x.code}:${x.target}` : x.code; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0,6);
  return { selected, deduplicatedIssues };
}

/** PT-BR presentation uses the existing PDF renderer and its readiness marker. */
export function portugueseCustomerBriefing(result: AuditResult, options: Readonly<{ issuer?: ReportContact; clientReady?: boolean }> = {}): string {
  const issuer = options.issuer === undefined ? undefined : validateReportContact(options.issuer);
  const { selected: topics, deduplicatedIssues } = portugueseOpportunityProjection(result);
  const hold = !topics.length || !issuer?.email || !issuer.phone;
  const capturedCount = reportEvidenceCounts(result).capturedUrls;
  const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(result.startedAt));
  const footer = `<footer class="issuer"><aside class="offer"><p>Confirme cada observação antes de fazer alterações ou compartilhar esta revisão.</p></aside><div class="issuer-details">${issuer ? [issuer.name,issuer.company,issuer.email,issuer.phone].filter((x): x is string => !!x).map(x=>`<span${x === issuer.phone && x.length <= 24 ? ' class="phone"' : ''}>${esc(x!)}</span>`).join('') : 'Contato do responsável não configurado'}</div></footer>`;
  const cards = topics.map(t => `<article class="card"><h3>${t.code === 'noindex' ? 'Visibilidade da página' : t.code === 'broken_internal_link' ? 'Caminho para o cliente' : 'Descrição da oferta'}</h3><p>${esc(t.observed)}</p><p class="example">Página: <a href="${esc(t.url)}">${esc(customerPageLabel(t.url, 'pt-BR'))}</a></p>${t.target ? `<p class="example">Destino observado: <a href="${esc(t.target)}">${esc(customerPageLabel(t.target, 'pt-BR'))}</a></p>` : ''}<p>${esc(t.action)}</p></article>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revisão do site</title><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;color:#183640;font:11pt/1.35 Arial,sans-serif}.page{width:210mm;min-height:297mm;padding:0 12mm;display:flex;flex-direction:column;overflow-wrap:anywhere}.hero{background:#102d3a;color:white;padding:5mm 12mm;margin:0 -12mm;border-radius:0}.hero h1{font-size:20pt;margin:2mm 0}.scope,.findings,.offer{margin:4mm 0}.scope{padding:3mm;background:#f4f8f7}.alert{color:#8e4b1d;font-weight:bold}.card{border:1px solid #d8e3e1;border-left:1mm solid #16858a;border-radius:2mm;padding:3mm;margin:3mm 0;break-inside:avoid}.card h3{margin:0;font-size:13pt}.card p{margin:1mm 0}.example{overflow-wrap:anywhere;font-size:10pt}.offer{margin-top:4mm;margin-bottom:4mm}.issuer{margin:auto -12mm 0;background:#102d3a;border:0;color:#c4ddda;padding:4mm 12mm;font-size:9.5pt;text-align:left;display:flex;flex-wrap:wrap;justify-content:flex-start;gap:1mm 3mm;overflow-wrap:anywhere}.issuer span{display:inline-block;max-width:100%;overflow-wrap:anywhere}.issuer .phone{white-space:nowrap}@media screen and (max-width:700px){.page{width:100%;min-height:0}.hero{padding:20px}.scope,.findings,.offer{margin:16px 20px}}.issuer{display:block;flex:none;margin:auto -12mm 0;padding:0;width:auto;background:#102d3a;color:#c4ddda}.issuer .offer{margin:0;padding:3mm 12mm 2mm}.issuer-details{display:flex;align-items:center;flex-wrap:wrap;gap:1mm 4mm;padding:2mm 12mm 3mm;border-top:1px solid #3b5660}.issuer .offer strong{color:white}.snapshots{display:flex;justify-content:center;gap:3mm;flex-wrap:wrap;padding:4mm 0 0}.snapshot{padding:1.5mm 3mm;border:1px solid #d8e3e1;border-radius:2mm;background:#f5f8f7;color:#49636a;font-size:9pt}.snapshot strong{color:#155e66;font-size:11pt;margin-right:2mm}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2mm}.one-topic .grid{grid-template-columns:1fr}.grid .card{margin:0}</style></head><body data-publication-status="${hold ? 'HOLD' : 'PREVIEW'}" data-client-ready="false" data-review-layout-check="true"><main class="page${topics.length === 1 ? ' one-topic' : ''}"><header class="hero"><strong>REVISÃO DO SITE</strong><h1>${esc(targetHost(result.target))}</h1><p>Observação arquivada em <time datetime="${esc(result.startedAt)}">${esc(date)}</time></p></header><div class="snapshots"><div class="snapshot"><strong>${capturedCount ?? '?'}</strong>${capturedCount === 1 ? 'página' : 'páginas'}</div><div class="snapshot" data-summary="deduplicated-issues"><strong>${deduplicatedIssues}</strong>${deduplicatedIssues === 1 ? 'constatação de SEO' : 'constatações de SEO'}</div><div class="snapshot"><strong>${topics.length}</strong>${topics.length === 1 ? 'tópico' : 'tópicos'}</div></div><section class="findings"><h2>Oportunidades para revisar</h2>${cards ? `<div class="grid">${cards}</div>` : '<p>Não há uma oportunidade específica suficientemente comprovada para apresentar.</p>'}</section>${footer}</main></body></html>`;
}
function targetHost(raw: string): string { try { return new URL(raw).hostname; } catch { return 'Site'; } }
