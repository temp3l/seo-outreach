import { pdfFontTextWidth } from './pdf-font-metrics.js';

export type CustomerPdfInput = {
  company: string;
  locale: 'en' | 'es' | 'de' | 'pt-BR';
  opening: string;
  opportunities: string[];
  findings: { id: string; observed: string; reference: string; implication: string; fix: string }[];
  coverage: string;
  nextStep: string;
};

const clean = (s: string) => s
  .replace(/<[^>]*>/g, ' ')
  .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[contact removed]')
  // Require phone-like formatting so page IDs and other numeric evidence stay intact.
  .replace(/(?<!\w)(?:\+\d[\d ()-]{6,}\d|\(?\d{3}\)?[ -]\d{3}[ -]\d{4})(?!\w)/g, '[contact removed]')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ').trim();

function validate(v: unknown): asserts v is CustomerPdfInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('PDF input must be an object');
  const x = v as Record<string, unknown>;
  const keys = ['company','locale','opening','opportunities','findings','coverage','nextStep'];
  if (Object.keys(x).some(k => !keys.includes(k)) || keys.some(k => !(k in x))) throw new TypeError('Unexpected or missing PDF fields');
  for (const k of ['company','opening','coverage','nextStep']) if (typeof x[k] !== 'string' || !(x[k] as string).trim()) throw new TypeError(`${k} must be a nonempty string`);
  if (!['en','es','de','pt-BR'].includes(x.locale as string)) throw new TypeError('Unsupported locale');
  if (!Array.isArray(x.opportunities) || x.opportunities.length < 1 || x.opportunities.length > 3 || x.opportunities.some(s => typeof s !== 'string' || !s.trim())) throw new TypeError('Provide one to three opportunities');
  if (!Array.isArray(x.findings) || (x.findings.length < 1 || x.findings.length > 6)) throw new TypeError('One to six findings are required');
  const ids = new Set<string>();
  for (const f of x.findings) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new TypeError('Invalid finding');
    const z = f as Record<string, unknown>;
    if (Object.keys(z).some(k => !['id','observed','reference','implication','fix'].includes(k)) || Object.keys(z).length !== 5) throw new TypeError('Finding has unexpected or missing fields');
    for (const k of ['id','observed','reference','implication','fix']) if (typeof z[k] !== 'string' || !(z[k] as string).trim()) throw new TypeError(`Finding ${k} must be nonempty`);
    if (ids.has(z.id as string)) throw new TypeError('Finding IDs must be distinct');
    ids.add(z.id as string);
  }
  const allText = [x.company, x.opening, x.coverage, x.nextStep, ...(x.opportunities as unknown[]), ...(x.findings as unknown[]).flatMap(f => Object.values(f as object))];
  if (allText.some(s => typeof s !== 'string') || allText.reduce((n, s) => n + (s as string).length, 0) > 24000) throw new TypeError('PDF text exceeds the 24,000 character limit');
}

// PDF strings use PDFDocEncoding-compatible WinAnsi bytes; unsupported glyphs become '?'.
function pdfText(s: string): string {
  const bytes: number[] = [];
  const normalized = s.replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/\u00a0/g, ' ');
  for (const ch of normalized) {
    const n = ch.codePointAt(0)!;
    if (n >= 32 && n <= 126 || n >= 160 && n <= 255) bytes.push(n);
    else if (n === 10) bytes.push(32);
    else bytes.push(63);
  }
  return '(' + bytes.map(n => n === 40 || n === 41 || n === 92 ? `\\${String.fromCharCode(n)}` : String.fromCharCode(n)).join('') + ')';
}
function lineWidth(s: string, size: number, bold: boolean): number {
  return pdfFontTextWidth(s, size, bold);
}
// 300pt leaves a 4pt safety margin inside the 304pt usable line width.
function wrap(s: string, maxWidth = 300, size = 11, bold = false): string[] {
  const words = clean(s).split(' '); const out: string[] = []; let line = '';
  for (const word of words) {
    if (!word) continue;
    const candidate = line ? `${line} ${word}` : word;
    if (lineWidth(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
    if (line) out.push(line), line = '';
    let part = '';
    for (const ch of word) {
      if (part && lineWidth(part + ch, size, bold) > maxWidth) { out.push(part); part = ch; }
      else part += ch;
    }
    line = part;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Render validated customer-facing material to a self-contained PDF byte buffer. No I/O occurs. */
export function renderCustomerPdf(input: CustomerPdfInput): Buffer {
  validate(input);
  const labels = {
    en: {opportunities:'Opportunities', findings:'Findings', source:'Source', impact:'Potential impact', fix:'Suggested fix', coverage:'Coverage', next:'Next step'},
    es: {opportunities:'Oportunidades', findings:'Hallazgos', source:'Referencia', impact:'Posible impacto', fix:'Mejora propuesta', coverage:'Cobertura', next:'Siguiente paso'},
    de: {opportunities:'Möglichkeiten', findings:'Befunde', source:'Referenz', impact:'Mögliche Auswirkung', fix:'Vorgeschlagene Lösung', coverage:'Abdeckung', next:'Nächster Schritt'},
    'pt-BR': {opportunities:'Oportunidades', findings:'Constatações', source:'Referência', impact:'Possível impacto', fix:'Correção sugerida', coverage:'Cobertura', next:'Próximo passo'}
  }[input.locale];
  const pages: string[][] = [[]]; let y = 604;
  const add = (text: string, size = 11, bold = false, gap = 4) => {
    for (const line of wrap(text, 300, size, bold)) {
      if (y < 42) { pages.push([]); y = 604; }
      pages[pages.length - 1]!.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 28 ${y} Td ${pdfText(line)} Tj ET`);
      y -= size + 4;
    }
    y -= gap;
  };
  add(clean(input.company), 21, true, 8);
  add(clean(input.opening), 12, false, 10);
  add(labels.opportunities, 15, true, 2);
  input.opportunities.forEach((op, i) => add(`${i + 1}. ${clean(op)}`, 12, false, 2));
  add(labels.findings, 17, true, 4);
  const findingHeight = (f: CustomerPdfInput['findings'][number]) =>
    wrap(`${input.findings.indexOf(f) + 1}. ${clean(f.observed)}`, 300, 13, true).length * 17 + 1 +
    wrap(`${labels.source}: ${clean(f.reference)}`, 300, 11, false).length * 15 + 4 +
    wrap(`${labels.impact}: ${clean(f.implication)}`, 300, 11, false).length * 15 + 4 +
    wrap(`${labels.fix}: ${clean(f.fix)}`, 300, 11, false).length * 15 + 9;
  input.findings.forEach((f, i) => {
    const needed = findingHeight(f);
    if (needed <= 562 && y - needed < 42) { pages.push([]); y = 604; }
    add(`${i + 1}. ${clean(f.observed)}`, 13, true, 1);
    add(`${labels.source}: ${clean(f.reference)}`);
    add(`${labels.impact}: ${clean(f.implication)}`);
    add(`${labels.fix}: ${clean(f.fix)}`, 11, false, 9);
  });
  // Keep coverage counts and the closing next step together when the block fits a page.
  const closingHeight = wrap(labels.coverage,300,14,true).length*18+2 +
    wrap(clean(input.coverage),300,11,false).length*15+8 +
    wrap(labels.next,300,14,true).length*18+2 +
    wrap(clean(input.nextStep),300,11,false).length*15+4;
  if(closingHeight<=562 && y-closingHeight<42){pages.push([]);y=604;}
  add(labels.coverage, 14, true, 2); add(clean(input.coverage), 11, false, 8);
  add(labels.next, 14, true, 2); add(clean(input.nextStep), 11, false, 4);

  const objs: string[] = [];
  const push = (s: string) => { objs.push(s); return objs.length; };
  const catalog = push('');
  const pagesObj = push('');
  const f1 = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  for (const lines of pages) {
    const stream = lines.join('\n');
    const content = push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(push(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 360 640] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /Lang (${input.locale}) >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [0];
  objs.forEach((obj, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1'); out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const result = Buffer.from(out, 'latin1');
  if (result.length > 262144) throw new TypeError('Rendered PDF exceeds the 256 KiB limit');
  return result;
}
