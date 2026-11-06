import {createHash} from 'node:crypto';
import {buildDigest, type Digest} from './digest.js';
import {corroborateArchive} from './corroboration.js';
import type {Normalized} from './evidence.js';
export type Locale='en'|'es'|'de'|'pt-BR';
export type Finding={id:string;code:string;observed:string;reference:string;implication:string;fix:string};
export type Decision={version:'decision-v1'; locale:Locale; company:string; materialFingerprint:string; coverage:{captured:number;failed:number;skipped:number;unattempted:number;exported:number;omitted:number;robots:string;truncatedPages?:number}; findings:Finding[]; customerStatus:'HOLD'; reasons:string[]};
type Copy={observed:string;implication:string;fix:string};
const copy:Record<Locale,Record<string,Copy>>={
 en:{
  missing_meta_description:{observed:'The captured page had no meta description.',implication:'Search engines may choose their own snippet, which can make the page less clear in search results.',fix:'Write a concise description that accurately explains this page.'},
  missing_title:{observed:'The captured page had no title element.',implication:'The page may be harder to identify in browser tabs and search results.',fix:'Add a descriptive title that reflects the page content.'},
  missing_h1:{observed:'No main heading was found in the captured page content.',implication:'Visitors may have less context when scanning the page.',fix:'Review the page structure and add a clear main heading where appropriate.'},
  missing_canonical:{observed:'No canonical link was found on the captured page.',implication:'If similar URLs exist, search engines have less explicit guidance about the preferred version.',fix:'Review the preferred URL and add a canonical link if appropriate.'},
  noindex:{observed:'The captured page included a noindex directive.',implication:'If the page is meant to appear in search, this directive may prevent that.',fix:'Confirm the page’s purpose and remove the directive only if indexing is intended.'},
  image_alt_missing_or_empty:{observed:'At least one captured image had missing or empty alternative text.',implication:'People using assistive technology may miss information in an informative image.',fix:'Review the image and add useful alternative text if it is informative; decorative images can remain empty.'},
  images_missing_dimensions:{observed:'At least one captured image lacked a valid width or height attribute.',implication:'Depending on the layout, images may cause content to move while loading.',fix:'Set appropriate image dimensions or reserve space in the layout.'},
  malformed_json_ld:{observed:'The captured page had invalid structured data.',implication:'Search engines may be unable to interpret that markup.',fix:'Correct the structured data and validate it against the intended page content.'}
 },es:{
  missing_meta_description:{observed:'La página capturada no tenía meta descripción.',implication:'Los buscadores pueden elegir su propio fragmento y la página puede resultar menos clara.',fix:'Escriba una descripción breve y fiel al contenido de la página.'},
  missing_title:{observed:'La página capturada no tenía un título HTML.',implication:'Puede ser más difícil identificar la página en pestañas y resultados.',fix:'Añada un título descriptivo que refleje el contenido.'},
  missing_h1:{observed:'No se encontró un encabezado principal en la página capturada.',implication:'Los visitantes pueden tener menos contexto al revisar la página.',fix:'Revise la estructura y añada un encabezado principal claro si corresponde.'},
  missing_canonical:{observed:'No se encontró un enlace canónico en la página capturada.',implication:'Si hay URL similares, los buscadores tienen menos orientación explícita sobre la versión preferida.',fix:'Revise la URL preferida y añada un enlace canónico si corresponde.'},
  noindex:{observed:'La página capturada incluía una directiva noindex.',implication:'Si debe aparecer en búsquedas, esta directiva puede impedirlo.',fix:'Confirme el propósito de la página y quite la directiva solo si desea indexarla.'},
  image_alt_missing_or_empty:{observed:'Al menos una imagen capturada tenía texto alternativo ausente o vacío.',implication:'Si la imagen aporta información, quienes usan tecnología de asistencia pueden perderla.',fix:'Revise la imagen y describa las informativas; las decorativas pueden quedar vacías.'},
  images_missing_dimensions:{observed:'Al menos una imagen capturada carecía de anchura o altura válida.',implication:'Según el diseño, el contenido puede moverse durante la carga.',fix:'Defina dimensiones adecuadas o reserve espacio en el diseño.'},
  malformed_json_ld:{observed:'La página capturada tenía datos estructurados inválidos.',implication:'Los buscadores podrían no interpretar ese marcado.',fix:'Corrija los datos y valídelos frente al contenido de la página.'}
 },de:{
  missing_meta_description:{observed:'Auf der erfassten Seite fehlte eine Meta-Beschreibung.',implication:'Suchmaschinen können einen eigenen Ausschnitt wählen, der weniger klar ist.',fix:'Eine kurze, zum Seiteninhalt passende Beschreibung erstellen.'},
  missing_title:{observed:'Auf der erfassten Seite fehlte ein HTML-Titel.',implication:'Die Seite kann in Tabs und Suchergebnissen schwerer zu erkennen sein.',fix:'Einen aussagekräftigen Titel passend zum Inhalt ergänzen.'},
  missing_h1:{observed:'Auf der erfassten Seite wurde keine Hauptüberschrift gefunden.',implication:'Besucher haben beim Überfliegen möglicherweise weniger Orientierung.',fix:'Seitenstruktur prüfen und gegebenenfalls eine klare Hauptüberschrift ergänzen.'},
  missing_canonical:{observed:'Auf der erfassten Seite wurde kein Canonical-Link gefunden.',implication:'Bei ähnlichen URLs erhalten Suchmaschinen weniger klare Hinweise auf die bevorzugte Version.',fix:'Bevorzugte URL prüfen und gegebenenfalls einen Canonical-Link setzen.'},
  noindex:{observed:'Die erfasste Seite enthielt eine Noindex-Anweisung.',implication:'Falls die Seite in der Suche erscheinen soll, kann dies die Aufnahme verhindern.',fix:'Zweck der Seite prüfen und die Anweisung nur bei gewünschter Indexierung entfernen.'},
  image_alt_missing_or_empty:{observed:'Mindestens ein erfasstes Bild hatte keinen oder einen leeren Alternativtext.',implication:'Nutzern assistiver Technik können Informationen eines wichtigen Bildes fehlen.',fix:'Bild prüfen und informative Bilder beschreiben; dekorative Bilder dürfen leer bleiben.'},
  images_missing_dimensions:{observed:'Mindestens einem erfassten Bild fehlte eine gültige Breite oder Höhe.',implication:'Je nach Layout kann sich Inhalt beim Laden verschieben.',fix:'Passende Bildmaße setzen oder im Layout Platz reservieren.'},
  malformed_json_ld:{observed:'Die erfasste Seite enthielt ungültige strukturierte Daten.',implication:'Suchmaschinen können die Auszeichnung möglicherweise nicht auswerten.',fix:'Strukturierte Daten korrigieren und mit dem Seiteninhalt abgleichen.'}
 },'pt-BR':{
  missing_meta_description:{observed:'A página capturada não tinha meta descrição.',implication:'Os buscadores podem escolher outro trecho, que pode ser menos claro.',fix:'Escreva uma descrição curta e fiel ao conteúdo da página.'},
  missing_title:{observed:'A página capturada não tinha um título HTML.',implication:'A página pode ser mais difícil de identificar em abas e resultados.',fix:'Adicione um título descritivo que reflita o conteúdo.'},
  missing_h1:{observed:'Não foi encontrado um título principal na página capturada.',implication:'Visitantes podem ter menos contexto ao ler a página.',fix:'Revise a estrutura e adicione um título principal claro quando adequado.'},
  missing_canonical:{observed:'Não foi encontrado um link canônico na página capturada.',implication:'Se houver URLs semelhantes, os buscadores têm menos orientação explícita sobre a versão preferida.',fix:'Revise a URL preferida e adicione um link canônico quando adequado.'},
  noindex:{observed:'A página capturada incluía uma diretiva noindex.',implication:'Se a página deve aparecer na busca, essa diretiva pode impedir sua indexação.',fix:'Confirme a finalidade da página e remova a diretiva somente se a indexação for desejada.'},
  image_alt_missing_or_empty:{observed:'Pelo menos uma imagem capturada tinha texto alternativo ausente ou vazio.',implication:'Pessoas que usam tecnologia assistiva podem perder informações de uma imagem importante.',fix:'Revise a imagem e descreva as informativas; imagens decorativas podem ficar vazias.'},
  images_missing_dimensions:{observed:'Pelo menos uma imagem capturada não tinha largura ou altura válida.',implication:'Dependendo do layout, o conteúdo pode se mover durante o carregamento.',fix:'Defina dimensões adequadas ou reserve espaço no layout.'},
  malformed_json_ld:{observed:'A página capturada tinha dados estruturados inválidos.',implication:'Os buscadores podem não conseguir interpretar essa marcação.',fix:'Corrija os dados e valide-os em relação ao conteúdo da página.'}
 }
};
/** Fixed localized observations supplied to generation and used independently in reports. */
export function findingWording(code:string,locale:Locale):Readonly<Copy>|undefined {
 const wording=Object.hasOwn(copy,locale)&&Object.hasOwn(copy[locale],code)?copy[locale][code]:undefined;
 return wording?{...wording}:undefined;
}
function reviewableReference(page:string):boolean {
  try {
    const u=new URL(page);if(u.search||u.hash||u.username||u.password)return false;
    const generic=new Set(['en','es','de','pt','fr','it','nl','course','courses','lesson','lessons','aulas','curso','cursos','dive','diving','kite','kitesurf','kiteboarding','booking','book','contact','contacto','contato','about','services','service','schools','school','activities','activity','category','page','tag','fishing','tour','tours','archive']);
    return decodeURIComponent(u.pathname).toLowerCase().split('/').filter(Boolean).every(part=>part.split(/[-_]/).every(token=>generic.has(token)||/^\d{1,4}$/.test(token)));
  } catch { return false; }
}
/** Provider input uses only independently cross-referenced page observations. */
export function qualifiedDigest(evidence:Normalized,pages:unknown[]):Digest {
 const proof=new Set(corroborateArchive(evidence,pages).map(p=>p.groupId));
 const material=buildDigest(evidence).materialFingerprint;
 const digest=buildDigest({...evidence,groups:evidence.groups.filter(g=>proof.has(g.id))});
 digest.limits.corroboratedGroups=proof.size;
 digest.limits.uncorroboratedGroups=evidence.groups.length-proof.size;
 digest.materialFingerprint=createHash('sha256').update(JSON.stringify({version:'qualified-v2',material,limits:digest.limits,corroboratedIds:[...proof].sort()})).digest('hex');
 digest.overflow.sourceGroups=evidence.groups.length;
 digest.overflow.excluded.not_corroborated=evidence.groups.length-proof.size;
 // Recompute the exact serialized size after replacing the identity.
 for(let i=0;i<4;i++){const n=Buffer.byteLength(JSON.stringify(digest));if(n===digest.bytes)break;digest.bytes=n;}
 if(digest.bytes>16000)throw new Error('digest_cap_exceeded');
 return digest;
}
/** Model prose never crosses this boundary; only issue selections are accepted. */
export function validateSelection(evidence:Normalized,pages:unknown[],selection:unknown,locale:Locale):Decision {
 if(!Object.hasOwn(copy,locale))throw new Error('unsupported_locale');
 if(!Array.isArray(selection)||selection.length>6||selection.some(id=>typeof id!=='string'||!/^[a-f0-9]{24}$/.test(id))||new Set(selection).size!==selection.length)throw new Error('invalid_selection');
 const digest=qualifiedDigest(evidence,pages);const proof=new Set(corroborateArchive(evidence,pages).map(p=>p.groupId));
 if(pages.length>evidence.crawl.captured)throw new Error('page_count_exceeds_captured');
 const findings:Finding[]=[];const roots=new Set<string>();
 for(const id of selection){
  const issue=digest.issues.find(i=>i.id===id);if(!issue)throw new Error('unknown_issue_id');
  const text=copy[locale][issue.code];if(!text)throw new Error('unsupported_issue_copy');
  const root=issue.code==='images_missing_alt'?'image_alt_missing_or_empty':issue.code;
  if(roots.has(root))throw new Error('duplicate_root_cause');roots.add(root);
  const ref=issue.pages.find(p=>proof.has(p.id)&&!p.url.includes('[path-redacted]')) ?? issue.pages.find(p=>proof.has(p.id));if(!ref)throw new Error('issue_evidence_missing');
  const group=evidence.groups.find(g=>g.id===ref.id);if(!group||group.code!==issue.code||!group.pageId)throw new Error('issue_attribution_invalid');
  const reference=reviewableReference(group.page)?group.page:ref.url.includes('[path-redacted]')?`${evidence.hostname} — ${group.pageId}`:ref.url;
  findings.push({id:issue.id,code:issue.code,reference,...text});
 }
 return {version:'decision-v1',locale,company:evidence.hostname,materialFingerprint:digest.materialFingerprint,coverage:{captured:evidence.crawl.captured,failed:evidence.crawl.failed,skipped:evidence.crawl.skipped,unattempted:evidence.crawl.unattempted,exported:pages.length,omitted:evidence.crawl.captured-pages.length,robots:evidence.robots,...(evidence.exportCoverage?{truncatedPages:evidence.exportCoverage.truncatedPages}:{})},findings,customerStatus:'HOLD',reasons:findings.length>=1&&findings.length<=6?['customer_review_and_artifact_verification_required']:['no_supported_findings','customer_review_and_artifact_verification_required']};
}
/** Audit-only observations are private review material and never confer customer readiness. */
export function auditReviewFindings(evidence:Normalized,locale:Locale):Finding[] {
 if(!Object.hasOwn(copy,locale))throw new Error('unsupported_locale');
 const expected:Record<string,string>={missing_meta_description:'No meta description was found.',missing_title:'No title element was found.',missing_h1:'No H1 heading was found.'};
 const result:Finding[]=[];const roots=new Set<string>();
 for(const g of evidence.groups){
  const text=copy[locale][g.code]; const at=Date.parse(g.representative.observedAt??'');
  if(!text || !Object.hasOwn(expected,g.code) || g.representative.observed!==expected[g.code] || g.capture!=='CAPTURED_2XX' || !['http','rendered-dom'].includes(g.source) || g.referenceRedacted || g.representative.truncated || !Number.isFinite(at) || at<Date.parse(evidence.startedAt)-600000 || at>Date.parse(evidence.completedAt)+600000 || roots.has(g.code))continue;
  roots.add(g.code);
  const u=new URL(g.page); const reference=u.pathname==='/' ? u.href : `${evidence.hostname} — ${g.sourceIds[0]}`;
  result.push({id:g.id,code:g.code,reference,...text});
 }
 return result;
}
