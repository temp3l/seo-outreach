import { createHash } from 'node:crypto';
import type { CustomerPdfInput } from './pdf.js';
import {pdfFontTextWidth} from './pdf-font-metrics.js';

const MAX_PDF_BYTES=262144;
const clean=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,'[contact removed]')
  .replace(/(?<!\w)(?:\+\d[\d ()-]{6,}\d|\(?\d{3}\)?[ -]\d{3}[ -]\d{4})(?!\w)/g,'[contact removed]')
  .replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
function pdfVisible(s:string):string {
  return [...s.replace(/[—–]/g,'-').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/…/g,'...').replace(/\u00a0/g,' ')]
    .map(ch=>{const n=ch.codePointAt(0)!;return n>=32&&n<=126||n>=160&&n<=255?ch:n===10?' ':'?';}).join('');
}
type Op={font:'F1'|'F2';size:number;x:number;y:number;text:string};
type Fragment={text:string;font:Op['font'];size:number};
function expectedFragments(input:CustomerPdfInput):Fragment[] {
  const labels={en:{opportunities:'Opportunities',findings:'Findings',source:'Source',impact:'Potential impact',fix:'Suggested fix',coverage:'Coverage',next:'Next step'},
    es:{opportunities:'Oportunidades',findings:'Hallazgos',source:'Referencia',impact:'Posible impacto',fix:'Mejora propuesta',coverage:'Cobertura',next:'Siguiente paso'},
    de:{opportunities:'Möglichkeiten',findings:'Befunde',source:'Referenz',impact:'Mögliche Auswirkung',fix:'Vorgeschlagene Lösung',coverage:'Abdeckung',next:'Nächster Schritt'},
    'pt-BR':{opportunities:'Oportunidades',findings:'Constatações',source:'Referência',impact:'Possível impacto',fix:'Correção sugerida',coverage:'Cobertura',next:'Próximo passo'}}[input.locale];
  const fragment=(text:string,size:number,bold=false):Fragment=>({text:pdfVisible(clean(text)),size,font:bold?'F2':'F1'});
  const values=[fragment(input.company,21,true),fragment(input.opening,12),fragment(labels.opportunities,15,true),...input.opportunities.map((op,i)=>fragment(`${i+1}. ${clean(op)}`,12)),fragment(labels.findings,17,true)];
  input.findings.forEach((f,i)=>values.push(fragment(`${i+1}. ${clean(f.observed)}`,13,true),fragment(`${labels.source}: ${clean(f.reference)}`,11),fragment(`${labels.impact}: ${clean(f.implication)}`,11),fragment(`${labels.fix}: ${clean(f.fix)}`,11)));
  values.push(fragment(labels.coverage,14,true),fragment(input.coverage,11),fragment(labels.next,14,true),fragment(input.nextStep,11));
  return values;
}
function fail():never{throw new TypeError('PDF artifact verification failed');}
function unescapeLiteral(s:string):string {
  let out='';for(let i=0;i<s.length;i++){const c=s[i]!;if(c!=='\\'){out+=c;continue;}if(++i>=s.length)fail();const e=s[i]!;if(e==='('||e===')'||e==='\\')out+=e;else fail();}return out;
}
function readObject(doc:string,offset:number,id:number):string {
  const prefix=`${id} 0 obj\n`;if(!doc.startsWith(prefix,offset))return fail();const end=doc.indexOf('\nendobj\n',offset+prefix.length);if(end<0)return fail();return doc.slice(offset+prefix.length,end);
}
function matchLogicalText(ops:Op[],fragments:Fragment[]):void {
  let at=0;
  for(const fragment of fragments){
    const expected=fragment.text;let pos=0,started=false;
    while(pos<expected.length){
      const op=ops[at++];if(!op||op.font!==fragment.font||op.size!==fragment.size)return fail();
      if(started&&expected[pos]===' ')pos++;
      if(op.text.length>expected.length-pos||!expected.startsWith(op.text,pos))return fail();
      pos+=op.text.length;started=true;
    }
  }
  if(at!==ops.length)return fail();
}

/** Verify only the bounded PDF 1.4 subset emitted by this package's renderer. */
export function verifyRenderedPdf(expected:CustomerPdfInput,bytes:Uint8Array):{status:'ARTIFACT_VERIFIED_ONLY';sha256:string;pageCount:number;findings:6} {
  if(!expected||!Array.isArray(expected.findings)||expected.findings.length!==6||!(bytes instanceof Uint8Array)||bytes.length<64||bytes.length>MAX_PDF_BYTES) return fail();
  const doc=Buffer.from(bytes).toString('latin1');
  if(!doc.startsWith('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')||!doc.endsWith('%%EOF\n')||/\/(?:JS|JavaScript|OpenAction|AA|Launch|EmbeddedFile|Filespec|URI|SubmitForm|ImportData|GoToR)\b/i.test(doc))return fail();
  if(!Array.isArray(expected.findings)||new Set(expected.findings.map(f=>f.id)).size!==6||expected.findings.some(f=>typeof f.id!=='string'||!f.id))return fail();
  const startAt=doc.lastIndexOf('startxref\n');if(startAt<0)return fail();
  const startMatch=/^startxref\n(\d+)\n%%EOF\n$/.exec(doc.slice(startAt));if(!startMatch)return fail();
  const xrefOffset=Number(startMatch[1]);if(!Number.isSafeInteger(xrefOffset)||xrefOffset!==doc.indexOf('xref\n'))return fail();
  const tail=doc.slice(xrefOffset);const xref=/^xref\n0 (\d+)\n0000000000 65535 f \n((?:\d{10} 00000 n \n)+)trailer\n<< \/Size (\d+) \/Root 1 0 R >>\nstartxref\n(\d+)\n%%EOF\n$/.exec(tail);
  if(!xref)return fail();const size=Number(xref[1]);if(size!==Number(xref[3])||Number(xref[4])!==xrefOffset)return fail();
  const offsets=[...xref[2]!.matchAll(/(\d{10}) 00000 n \n/g)].map(m=>Number(m[1]));if(offsets.length!==size-1)return fail();
  const objects:string[]=[''];for(let id=1;id<size;id++)objects.push(readObject(doc,offsets[id-1]!,id));
  for(let id=1;id<size;id++)if(offsets[id-1]!<=0||offsets[id-1]!>=xrefOffset||id>1&&offsets[id-1]!<=offsets[id-2]!)return fail();
  if(objects[1]!==`<< /Type /Catalog /Pages 2 0 R /Lang (${expected.locale}) >>`)return fail();
  const tree=/^<< \/Type \/Pages \/Kids \[((?:\d+ 0 R)(?: \d+ 0 R)*)\] \/Count (\d+) >>$/.exec(objects[2]!);if(!tree)return fail();
  const pageIds=[...tree[1]!.matchAll(/(\d+) 0 R/g)].map(m=>Number(m[1]));const pageCount=Number(tree[2]);
  if(pageCount<1||pageIds.length!==pageCount||new Set(pageIds).size!==pageCount||size!==5+2*pageCount)return fail();
  if(objects[3]!=='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'||objects[4]!=='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')return fail();
  const pageSet=new Set(pageIds),contentSet=new Set<number>();let extracted:Op[]=[];
  for(const pageId of pageIds){
    if(!Number.isSafeInteger(pageId)||pageId<5||pageId>=size)return fail();
    const pageObject=objects[pageId]!;
    const pageMatch=/^<< \/Type \/Page \/Parent 2 0 R \/MediaBox \[0 0 360 640\] \/Resources << \/Font << \/F1 3 0 R \/F2 4 0 R >> >> \/Contents (\d+) 0 R >>$/.exec(pageObject);if(!pageMatch)return fail();
    const contentId=Number(pageMatch[1]);if(!Number.isSafeInteger(contentId)||contentId<5||contentId>=size||pageSet.has(contentId)||contentSet.has(contentId))return fail();contentSet.add(contentId);
    const streamObj=objects[contentId]!;
    const head=/^<< \/Length (\d+) >>\nstream\n/.exec(streamObj);if(!head)return fail();const n=Number(head[1]);const body=streamObj.slice(head[0].length);
    if(!body.endsWith('\nendstream')||Buffer.byteLength(body.slice(0,-'\nendstream'.length),'latin1')!==n)return fail();
    const content=body.slice(0,-'\nendstream'.length);const ops=content?content.split('\n'):[];if(!ops.length)return fail();
    const actual:Op[]=[];let previous:number|null=null,previousSize=0;
    for(const line of ops){const m=/^BT \/(F1|F2) (\d+) Tf (\d+) (\d+) Td \(((?:\\.|[^\\)])*)\) Tj ET$/.exec(line);if(!m)return fail();const sizeValue=Number(m[2]),y=Number(m[4]);if(Number(m[3])!==28||![11,12,13,14,15,17,21].includes(sizeValue)||y<42||y>604||previous!==null&&(y>=previous||previous-y<previousSize+4))return fail();previous=y;previousSize=sizeValue;actual.push({font:m[1] as Op['font'],size:sizeValue,x:Number(m[3]),y,text:unescapeLiteral(m[5]!)});}
    extracted.push(...actual);
  }
  if(contentSet.size!==pageCount||pageSet.size!==pageCount||[...pageSet,...contentSet].length!==pageCount*2||new Set([...pageSet,...contentSet]).size!==pageCount*2)return fail();
  for(const op of extracted){const width=pdfFontTextWidth(op.text,op.size,op.font==='F2');if(!Number.isFinite(width)||op.x+width>332.01)return fail();}
  const logical=expectedFragments(expected);matchLogicalText(extracted,logical);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  return {status:'ARTIFACT_VERIFIED_ONLY',sha256,pageCount,findings:6};
}
