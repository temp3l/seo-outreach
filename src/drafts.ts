export type DraftInput = {
  company: string;
  locale: 'en' | 'es' | 'de' | 'pt-BR';
  seller: { name: string; location: string } | null;
  finding: { code: string; observed: string; reference: string; implication: string; fix: string };
  reportAvailable: boolean;
};
export type DraftStatus = 'READY_FOR_REVIEW' | 'HOLD';
export type Drafts = {
  status: DraftStatus;
  holdReasons: string[];
  opener: string;
  afterInterest: string;
  reviewNotes: { company: string; code: string; observed: string; reference: string; implication: string; fix: string };
  limits: { openerMaxChars: 450; afterInterestMaxChars: 700 };
};

const MAX_FIELD = 600;
const email = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/;
const phone = /(?<!\w)(?:\+\d[\d ()-]{6,}\d|\(?\d{3}\)?[ -]\d{3}[ -]\d{4})(?!\w)/;
function checkedText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_FIELD) throw new TypeError(`${name} must be a nonempty string of at most ${MAX_FIELD} characters`);
  if (/[<>\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} contains markup or control characters`);
  if (email.test(value) || phone.test(value)) throw new TypeError(`${name} contains contact information`);
  return value.trim().replace(/\s+/g, ' ');
}
/** Validate optional seller identity before any paid generation or publication. */
export function validateSellerIdentity(name:unknown,location:unknown):DraftInput['seller'] {
  if(name===undefined&&location===undefined)return null;
  if(name===undefined||location===undefined)throw new Error('seller_identity_incomplete');
  try{return {name:checkedText(name,'seller.name'),location:checkedText(location,'seller.location')};}
  catch{throw new Error('invalid_seller_identity');}
}
function sentence(value: string): string { return /[.!?]$/.test(value) ? value : `${value}.`; }
function validate(input: unknown): asserts input is DraftInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Draft input must be an object');
  const x = input as Record<string, unknown>;
  const fields = ['company','locale','seller','finding','reportAvailable'];
  if (Object.keys(x).length !== fields.length || Object.keys(x).some(k => !fields.includes(k))) throw new TypeError('Draft input has unexpected or missing fields');
  checkedText(x.company, 'company');
  if (typeof x.reportAvailable !== 'boolean') throw new TypeError('reportAvailable must be a boolean');
  if (!['en','es','de','pt-BR'].includes(x.locale as string)) throw new TypeError('Unsupported locale');
  if (x.seller !== null) {
    if (!x.seller || typeof x.seller !== 'object' || Array.isArray(x.seller)) throw new TypeError('seller must be an object or null');
    const s = x.seller as Record<string, unknown>;
    if (Object.keys(s).length !== 2 || !('name' in s) || !('location' in s)) throw new TypeError('seller must contain only name and location');
    checkedText(s.name, 'seller.name'); checkedText(s.location, 'seller.location');
  }
  if (!x.finding || typeof x.finding !== 'object' || Array.isArray(x.finding)) throw new TypeError('finding must be an object');
  const f = x.finding as Record<string, unknown>;
  const findingFields = ['code','observed','reference','implication','fix'];
  if (Object.keys(f).length !== findingFields.length || Object.keys(f).some(k => !findingFields.includes(k))) throw new TypeError('finding has unexpected or missing fields');
  for (const key of findingFields) checkedText(f[key], `finding.${key}`);
}

const templates = {
  en: {
    opener: (name: string, location: string, observed: string, reference: string, implication: string, available: boolean) => `Hello, I’m ${name}, and I’m based in ${location}. On ${reference}: ${sentence(observed)} ${sentence(implication)} ${available ? 'May I send the reviewed report?' : 'May I share the notes?'}`,
    after: (company: string, available: boolean) => available ? `Thanks for your interest. Here is the reviewed report for ${company}, with page references, possible implications and suggested fixes. If useful, we can discuss a small, fixed-scope implementation for one finding. No obligation.` : `Thanks for your interest. I can share the observed details and source page references here. If useful, we can discuss a small, fixed-scope implementation for one finding. No obligation.`
  },
  es: {
    opener: (name: string, location: string, observed: string, reference: string, implication: string, available: boolean) => `Hola, soy ${name} y estoy en ${location}. En ${reference}: ${sentence(observed)} ${sentence(implication)} ${available ? '¿Le envío el informe revisado?' : '¿Le comparto las notas?'}`,
    after: (company: string, available: boolean) => available ? `Gracias por su interés. Aquí tiene el informe revisado de ${company}, con referencias de páginas, posibles implicaciones y mejoras sugeridas. Si le resulta útil, podemos conversar sobre una implementación pequeña y de alcance fijo para un hallazgo. Sin compromiso.` : `Gracias por su interés. Puedo compartir aquí los detalles observados y las referencias de las páginas. Si le resulta útil, podemos conversar sobre una implementación pequeña y de alcance fijo para un hallazgo. Sin compromiso.`
  },
  de: {
    opener: (name: string, location: string, observed: string, reference: string, implication: string, available: boolean) => `Guten Tag, ich bin ${name}. Mein Standort ist ${location}. Auf ${reference}: ${sentence(observed)} ${sentence(implication)} ${available ? 'Soll ich den geprüften Bericht senden?' : 'Soll ich die Notizen teilen?'}`,
    after: (company: string, available: boolean) => available ? `Vielen Dank für Ihr Interesse. Hier ist der geprüfte Bericht zu ${company} mit Seitenbelegen, möglichen Auswirkungen und Lösungsvorschlägen. Bei Interesse können wir über eine kleine Umsetzung mit festem Umfang für einen Befund sprechen. Unverbindlich.` : `Vielen Dank für Ihr Interesse. Ich kann die beobachteten Details und Quellenangaben hier teilen. Bei Interesse können wir über eine kleine Umsetzung mit festem Umfang für einen Befund sprechen. Unverbindlich.`
  },
  'pt-BR': {
    opener: (name: string, location: string, observed: string, reference: string, implication: string, available: boolean) => `Olá, sou ${name} e estou em ${location}. Em ${reference}: ${sentence(observed)} ${sentence(implication)} ${available ? 'Posso enviar o relatório revisado?' : 'Posso compartilhar as notas?'}`,
    after: (company: string, available: boolean) => available ? `Obrigado pelo interesse. Aqui está o relatório revisado de ${company}, com referências das páginas, possíveis impactos e melhorias sugeridas. Se fizer sentido, podemos conversar sobre uma implementação pequena e de escopo fixo para um dos pontos. Sem compromisso.` : `Obrigado pelo interesse. Posso compartilhar os detalhes observados e as referências das páginas por aqui. Se fizer sentido, podemos conversar sobre uma implementação pequena e de escopo fixo para um dos pontos. Sem compromisso.`
  }
} as const;

/** Build unsent, reviewable message drafts. This function performs no I/O. */
export function buildDrafts(input: DraftInput): Drafts {
  validate(input);
  const locale = input.locale;
  const company = checkedText(input.company, 'company');
  const observed = checkedText(input.finding.observed, 'finding.observed');
  const implication = checkedText(input.finding.implication, 'finding.implication');
  const reference = checkedText(input.finding.reference, 'finding.reference');
  const seller = input.seller;
  const name = seller ? checkedText(seller.name, 'seller.name') : '[YOUR NAME]';
  const location = seller ? checkedText(seller.location, 'seller.location') : '[YOUR LOCATION]';
  let sourceReference = reference;
  if (reference.startsWith(`${company} — page_`) || reference.length > 90) sourceReference = company;
  let opener = templates[locale].opener(name, location, observed, sourceReference, implication, input.reportAvailable);
  let afterInterest = templates[locale].after(company, input.reportAvailable);
  const holdReasons: string[] = [];
  if (!seller) holdReasons.push('Seller name and location are missing; replace the identity placeholders before review or use.');
  const reviewNotes = {company, code:checkedText(input.finding.code, 'finding.code'), observed, reference, implication, fix:checkedText(input.finding.fix, 'finding.fix')};
  if (opener.length > 450) {
    opener = '';
    holdReasons.push('Finding wording exceeds the opener limit; review the complete finding in reviewNotes before drafting a message.');
  }
  if (afterInterest.length > 700) {
    afterInterest = '';
    holdReasons.push('Company name exceeds the after-interest limit; review and shorten the message manually.');
  }
  return { status: holdReasons.length ? 'HOLD' : 'READY_FOR_REVIEW', holdReasons, opener, afterInterest, reviewNotes, limits: { openerMaxChars: 450, afterInterestMaxChars: 700 } };
}
