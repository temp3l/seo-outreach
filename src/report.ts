import type { Decision, Finding, Locale } from './decision.js';
import type { CustomerPdfInput } from './pdf.js';

const supported = new Set(['missing_meta_description','missing_title','missing_h1','missing_canonical','noindex','image_alt_missing_or_empty','images_missing_dimensions','malformed_json_ld']);
const alias: Record<string,string> = { images_missing_alt: 'image_alt_missing_or_empty' };
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const email = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
const phone = /(?<!\w)(?:\+\d[\d ()-]{6,}\d|\(?\d{3}\)?[ -]\d{3}[ -]\d{4})(?!\w)/;

function text(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 600) throw new TypeError(`${name} must be nonempty and at most 600 characters`);
  if (/[<>\u0000-\u001f\u007f]/.test(v) || email.test(v) || phone.test(v)) throw new TypeError(`${name} contains unsafe content`);
  return v.trim().replace(/\s+/g, ' ');
}
function validate(d: unknown): asserts d is Decision {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new TypeError('Decision must be an object');
  const x = d as Record<string,unknown>;
  const keys = ['version','locale','company','materialFingerprint','coverage','findings','customerStatus','reasons'];
  if (Object.keys(x).length !== keys.length || Object.keys(x).some(k => !keys.includes(k))) throw new TypeError('Unexpected or missing decision fields');
  if (x.version !== 'decision-v1' || x.customerStatus !== 'HOLD') throw new TypeError('Only HOLD decisions can be rendered for internal review');
  if (!['en','es','de','pt-BR'].includes(x.locale as string)) throw new TypeError('Unsupported locale');
  const company = text(x.company, 'company');
  if (!hostPattern.test(company)) throw new TypeError('Decision company must be a hostname');
  if (typeof x.materialFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(x.materialFingerprint)) throw new TypeError('Invalid material fingerprint');
  if (!Array.isArray(x.reasons) || !x.reasons.length || x.reasons.some(r => typeof r !== 'string' || !/^[a-z0-9_]+$/.test(r))) throw new TypeError('Invalid HOLD reasons');
  if (!x.coverage || typeof x.coverage !== 'object' || Array.isArray(x.coverage)) throw new TypeError('Explicit crawl coverage counts are required');
  const cov = x.coverage as Record<string,unknown>;
  const coverageKeys = ['captured','failed','skipped','unattempted','exported','omitted','robots'];
  if (coverageKeys.some(k=>!Object.hasOwn(cov,k)) || Object.keys(cov).some(k => !coverageKeys.includes(k)&&k!=='truncatedPages')) throw new TypeError('Invalid crawl coverage fields');
  for (const k of coverageKeys.slice(0,6)) if (!Number.isSafeInteger(cov[k]) || (cov[k] as number) < 0) throw new TypeError(`Invalid coverage count: ${k}`);
  if ((cov.exported as number) + (cov.omitted as number) !== cov.captured) throw new TypeError('Exported and omitted counts must equal captured pages');
  if(cov.truncatedPages!==undefined&&(!Number.isSafeInteger(cov.truncatedPages)||(cov.truncatedPages as number)<0||(cov.truncatedPages as number)>(cov.captured as number)))throw new TypeError('Invalid truncated-page count');
  if (!['available','missing','unavailable','unknown'].includes(cov.robots as string)) throw new TypeError('Invalid robots coverage state');
  if (!Array.isArray(x.findings) || x.findings.length !== 6) throw new TypeError('Exactly six selected findings are required');
  const ids = new Set<string>(); const roots = new Set<string>();
  for (const raw of x.findings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid finding');
    const f = raw as Record<string,unknown>;
    const fkeys = ['id','code','observed','reference','implication','fix'];
    if (Object.keys(f).length !== fkeys.length || Object.keys(f).some(k => !fkeys.includes(k))) throw new TypeError('Unexpected or missing finding fields');
    const id = text(f.id, 'finding.id'); const code = text(f.code, 'finding.code');
    if (!/^[a-f0-9]{24}$/.test(id) || ids.has(id)) throw new TypeError('Finding IDs must be valid and distinct'); ids.add(id);
    const root = alias[code] ?? code;
    if (!supported.has(root) || roots.has(root)) throw new TypeError('Findings must have six distinct supported root causes'); roots.add(root);
    text(f.observed, 'finding.observed'); text(f.implication, 'finding.implication'); text(f.fix, 'finding.fix');
    const ref = text(f.reference, 'finding.reference');
    if (ref.startsWith(`${company} — page_`)) {
      if (!/^page_[a-f0-9]{64}$/.test(ref.slice(company.length + 3))) throw new TypeError('Invalid redacted page reference');
    } else {
      let u: URL;
      try { u = new URL(ref); } catch { throw new TypeError('Finding reference must be a same-company URL or redacted page reference'); }
      if (!['http:','https:'].includes(u.protocol) || u.hostname.toLowerCase() !== company.toLowerCase() || u.username || u.password || u.search || u.hash) throw new TypeError('Finding reference must be a safe same-company URL');
    }
  }
}

const copy: Record<Locale, {opening:string;coverage:(n:number,c:Decision['coverage'])=>string;next:string;opportunities:Record<string,string>}> = {
  en: {opening:'INTERNAL / HOLD — Internal review only; customer delivery is on hold.',coverage:(n,c)=>`${n} distinct selected findings. Captured: ${c.captured}; exported: ${c.exported}; omitted: ${c.omitted}; failed: ${c.failed}; unattempted: ${c.unattempted}; skipped: ${c.skipped}; robots: ${c.robots}; pages with truncated export fields: ${c.truncatedPages??'unknown'}. These counts do not establish site-wide coverage.`,next:'Internal next step: review the evidence, source references, and coverage counts before deciding whether to release this report.',opportunities:{search:'Improve search result clarity',page:'Make key page information clearer',index:'Confirm intended search visibility',images:'Improve image accessibility and layout stability',data:'Improve structured data interpretation'}},
  es: {opening:'INTERNO / EN ESPERA — Solo para revisión interna; la entrega al cliente está en espera.',coverage:(n,c)=>`${n} hallazgos seleccionados y distintos. Capturadas: ${c.captured}; exportadas: ${c.exported}; omitidas: ${c.omitted}; fallidas: ${c.failed}; no intentadas: ${c.unattempted}; omitidas del rastreo: ${c.skipped}; robots: ${c.robots}; páginas con campos truncados: ${c.truncatedPages??'desconocido'}. Estas cifras no demuestran una cobertura completa del sitio.`,next:'Siguiente paso interno: revisar la evidencia, las referencias y las cifras de cobertura antes de decidir si se comparte este informe.',opportunities:{search:'Mejorar la claridad en resultados de búsqueda',page:'Aclarar la información de las páginas',index:'Confirmar la visibilidad deseada en búsquedas',images:'Mejorar accesibilidad y estabilidad de imágenes',data:'Mejorar la interpretación de datos estructurados'}},
  de: {opening:'INTERN / ZURÜCKGEHALTEN — Nur zur internen Prüfung; die Weitergabe an Kunden ist zurückgestellt.',coverage:(n,c)=>`${n} ausgewählte, unterschiedliche Befunde. Erfasst: ${c.captured}; exportiert: ${c.exported}; ausgelassen: ${c.omitted}; fehlgeschlagen: ${c.failed}; nicht versucht: ${c.unattempted}; übersprungen: ${c.skipped}; Robots: ${c.robots}; Seiten mit gekürzten Exportfeldern: ${c.truncatedPages??'unbekannt'}. Diese Zahlen belegen keine vollständige Abdeckung der Website.`,next:'Interner nächster Schritt: Belege, Quellen und Abdeckungszahlen prüfen und anschließend über eine Freigabe dieses Berichts entscheiden.',opportunities:{search:'Suchergebnisse klarer gestalten',page:'Wichtige Seiteninformationen verständlicher machen',index:'Gewünschte Sichtbarkeit in der Suche prüfen',images:'Bildzugänglichkeit und Layoutstabilität verbessern',data:'Strukturierte Daten verständlicher machen'}},
  'pt-BR': {opening:'INTERNO / EM ESPERA — Somente para revisão interna; a entrega ao cliente está suspensa.',coverage:(n,c)=>`${n} constatações distintas selecionadas. Capturadas: ${c.captured}; exportadas: ${c.exported}; omitidas: ${c.omitted}; com falha: ${c.failed}; não tentadas: ${c.unattempted}; ignoradas: ${c.skipped}; robots: ${c.robots}; páginas com campos truncados: ${c.truncatedPages??'desconhecido'}. Esses números não comprovam a cobertura de todo o site.`,next:'Próxima etapa interna: revisar as evidências, referências e números de cobertura antes de decidir se este relatório pode ser compartilhado.',opportunities:{search:'Melhorar a clareza nos resultados de busca',page:'Deixar mais claras as informações das páginas',index:'Confirmar a visibilidade desejada nas buscas',images:'Melhorar acessibilidade e estabilidade das imagens',data:'Melhorar a interpretação de dados estruturados'}}
};
const customerCopy: Record<Locale,{opening:string;next:string}> = {
  en:{opening:'This review summarizes six distinct observations from captured pages. Each includes its source page, a possible implication, and a suggested next step.',next:'If useful, we can discuss a small, fixed-scope review of one of these findings. Would that be helpful?'},
  es:{opening:'Esta revisión resume seis observaciones distintas en las páginas capturadas. Cada una incluye su página de origen, una posible implicación y un siguiente paso sugerido.',next:'Si le resulta útil, podemos conversar sobre una revisión pequeña y de alcance fijo de uno de estos hallazgos. ¿Le interesaría?'},
  de:{opening:'Diese Prüfung fasst sechs unterschiedliche Beobachtungen auf erfassten Seiten zusammen. Jeder Punkt nennt die Quellseite, eine mögliche Auswirkung und einen vorgeschlagenen nächsten Schritt.',next:'Wenn es hilfreich ist, können wir eine kleine Prüfung mit festem Umfang zu einem dieser Befunde besprechen. Wäre das interessant?'},
  'pt-BR':{opening:'Esta análise resume seis observações distintas nas páginas capturadas. Cada uma inclui sua página de origem, um possível impacto e um próximo passo sugerido.',next:'Se fizer sentido, podemos conversar sobre uma pequena revisão, com escopo definido, de um desses pontos. Você teria interesse?'}
};
function opportunityGroups(findings: Finding[]): string[] {
  const codes = new Set(findings.map(f => alias[f.code] ?? f.code));
  const groups: string[] = [];
  if (codes.has('missing_meta_description')) groups.push('search');
  if (['missing_title','missing_h1','missing_canonical'].some(c => codes.has(c))) groups.push('page');
  if (codes.has('noindex')) groups.push('index');
  if (['image_alt_missing_or_empty','images_missing_dimensions'].some(c => codes.has(c))) groups.push('images');
  if (codes.has('malformed_json_ld')) groups.push('data');
  return groups;
}

/** Build internal-review PDF content from a validated six-finding Decision only. */
export function buildReportPdfInput(decision: Decision): CustomerPdfInput {
  validate(decision);
  const locale = decision.locale; const words = copy[locale];
  const findings = decision.findings.map(f => ({id:f.id, observed:f.observed, reference:f.reference, implication:f.implication, fix:f.fix}));
  const opportunities = opportunityGroups(decision.findings).slice(0,3).map(k => words.opportunities[k]!);
  if (!opportunities.length || opportunities.length > 3) throw new TypeError('Decision does not support a concise opportunity summary');
  return {company:decision.company, locale, opening:words.opening, opportunities, findings, coverage:words.coverage(findings.length, decision.coverage), nextStep:words.next};
}

/** Build customer-facing copy only after the shared pipeline gate has approved release. */
export function buildCustomerReportPdfInput(decision: Decision): CustomerPdfInput {
  validate(decision);
  for (const finding of decision.findings) {
    const reference=text(finding.reference,'finding.reference');
    let url:URL;
    try { url=new URL(reference); } catch { throw new TypeError('Customer findings require a usable same-company page URL'); }
    if (!['http:','https:'].includes(url.protocol)||url.hostname.toLowerCase()!==decision.company.toLowerCase()||url.username||url.password||url.search||url.hash)
      throw new TypeError('Customer findings require a safe same-company page URL');
  }
  const internal=buildReportPdfInput(decision); const words=customerCopy[decision.locale];
  return {...internal,opening:words.opening,nextStep:words.next};
}
