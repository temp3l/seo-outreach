import type { Finding, Locale } from './decision.js';
import type { DraftInput, Drafts } from './drafts.js';
import type { SalesOutput } from './provider.js';

export const BUYER_ROLES = ['unknown', 'owner', 'marketing_manager', 'ecommerce_manager', 'developer_agency', 'general_inbox'] as const;
export const BUSINESS_TYPES = ['unknown', 'local_service', 'booking_business', 'ecommerce', 'b2b_service', 'multi_location'] as const;
export type OutreachContext = {
  buyerRole: typeof BUYER_ROLES[number];
  businessType: typeof BUSINESS_TYPES[number];
  businessName?: string;
  services?: string[];
};
export type SalesContext = { business: OutreachContext; seller: DraftInput['seller'] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const contact = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|(?<!\w)(?:\+\d[\d ()-]{6,}\d|\d{3}[ -]\d{3}[ -]\d{4})(?!\w)/;
function contextText(v: unknown): v is string {
  return typeof v === 'string' && !!v.trim() && v.length <= 120 && !/[<>\x00-\x1f\x7f]|https?:\/\/|\bsk-[\w-]+/i.test(v) && !contact.test(v);
}

/** Only operator-supplied business context; unknown roles are never inferred as facts. */
export function validateOutreachContext(value: unknown): OutreachContext {
  if (!object(value) || Object.keys(value).some(k => !['buyerRole', 'businessType', 'businessName', 'services'].includes(k)) ||
      value.buyerRole !== undefined && !BUYER_ROLES.includes(value.buyerRole as OutreachContext['buyerRole']) ||
      value.businessType !== undefined && !BUSINESS_TYPES.includes(value.businessType as OutreachContext['businessType']) ||
      value.businessName !== undefined && !contextText(value.businessName) ||
      value.services !== undefined && (!Array.isArray(value.services) || value.services.length > 5 || !value.services.every(contextText))) throw new Error('invalid_outreach_context');
  return {
    buyerRole: (value.buyerRole ?? 'unknown') as OutreachContext['buyerRole'],
    businessType: (value.businessType ?? 'unknown') as OutreachContext['businessType'],
    ...(value.businessName !== undefined ? { businessName: (value.businessName as string).trim() } : {}),
    ...(value.services !== undefined ? { services: (value.services as string[]).map(s => s.trim()) } : {}),
  };
}

/** Context files are keyed by exact hostname so a batch cannot reuse another business's facts. */
export function contextForCompany(value: unknown, company: string): OutreachContext {
  if (!object(value) || Object.keys(value).length > 1000) throw new Error('invalid_outreach_context');
  const contexts = new Map<string, OutreachContext>();
  for (const [host, entry] of Object.entries(value)) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host.length > 253) throw new Error('invalid_outreach_context');
    contexts.set(host, validateOutreachContext(entry));
  }
  return contexts.get(company) ?? validateOutreachContext({});
}

export const OUTREACH_INSTRUCTIONS = `Help a freelance SEO specialist start a useful business conversation. Select four to six distinct supported findings when relevant; fewer are acceptable when evidence or relevance is insufficient. Never add weak findings just to fill a PDF. Rank selections by relevance to important customer-facing pages, then evidence and practical actionability. A missing canonical alone does not establish a duplicate-content problem; noindex may be intentional; empty alt text may be appropriate for decorative images.
Use supplied business context as operator-provided data. Never infer a recipient's identity, role, services or location. With unknown context, use neutral wording. For owners emphasize clear priorities, manageable scope and saved effort; marketing managers need priorities and coordination; ecommerce managers need product/category discoverability; developers/agencies need reproducible evidence and collaboration; general inboxes need a short, easy-to-forward note. Adapt to local-service enquiries, booking-page clarity, ecommerce product discovery, B2B service enquiries or multi-location consistency only when that business type is supplied. These are possible goals, never measured outcomes.
The opener must be at most 450 characters: introduce the supplied seller by name (or use [YOUR NAME]), mention ONE selected finding using its exact supplied observed sentence and one exact supplied usable page URL, then ask one easy question. Use plain language, a helpful tone and no pressure. Avoid noindex in the opener because indexing intent needs confirmation. The after-interest reply must be at most 700 characters and ask whether discussing implementation of the top one or two findings would be helpful, or ask to forward to the responsible person for a general inbox. Do not propose prices, quotes, pricing packages or commercial terms. Do not invent credentials, customer results, business urgency or outcome estimates. No fabricated losses, revenue/traffic/ranking promises or guarantees. Do not claim a PDF is attached, reviewed or approved: the sender automatically attaches the approved PDF when it sends an approved document. Do not include other URLs or prospect contact details. A supplied seller email is an allowed reply address; seller location is optional and must never be invented. Return salesAngle, opportunities, salesBrief and uncertainties for internal review; they are suggestions, not verified facts.`;

export type OutreachDraftReview = {
  source: 'LLM' | 'TEMPLATE';
  status: 'REQUIRES_HUMAN_REVIEW';
  reasons: string[];
  drafts: Drafts;
};

/** Structural safeguards are not semantic verification; all generated prose needs human review. */
export function reviewGeneratedDrafts(output: SalesOutput | undefined, findings: Finding[], seller: DraftInput['seller'], fallback: Drafts, locale: Locale): OutreachDraftReview {
  const reasons: string[] = [];
  if (!output) return { source: 'TEMPLATE', status: 'REQUIRES_HUMAN_REVIEW', reasons: ['no_generated_copy'], drafts: fallback };
  if (output.locale !== locale) reasons.push('locale_mismatch');
  const personalize=(text:string)=>text.trim().replaceAll('[YOUR NAME]',seller?.name??'[YOUR NAME]').replaceAll('[YOUR EMAIL]',seller?.email??'[YOUR EMAIL]');
  const opener = personalize(output.whatsappOpener), afterInterest = personalize(output.afterInterestReply);
  const combined = `${opener}\n${afterInterest}`;
  if (/\[YOUR (?:NAME|EMAIL|LOCATION)\]/.test(combined)) reasons.push('unresolved_identity_placeholder');
  if (!seller || !opener.includes(seller.name)) reasons.push('seller_identity_missing');
  if (!opener || opener.length > 450 || !afterInterest || afterInterest.length > 700) reasons.push('copy_length_invalid');
  if (/[<>\x00-\x08\x0b-\x1f\x7f]|\bsk-[\w-]+/i.test(combined) || contact.test(seller?.email?combined.replaceAll(seller.email,''):combined)) reasons.push('unsafe_copy');
  const anchor = findings.find(f => f.code !== 'noindex' && /^https?:\/\//.test(f.reference) && opener.includes(f.reference) && opener.includes(f.observed));
  if (!anchor) reasons.push('exact_observation_and_page_missing');
  const urls = combined.match(/https?:\/\/[^\s<>"\])]+/gi) ?? [];
  if (urls.some(url => !findings.some(f => f.reference === url.replace(/[.,;!?:]+$/, '')))) reasons.push('unselected_url');
  // Deliberately conservative filters; they do not establish truth in arbitrary model prose.
  if (/\b(?:quote|quotation|pricing|prices?|fixed.price|orçamento|cotización|cotação|presupuesto|Kostenvoranschlag|Festpreis|Angebot|Preise?|precios?|preços?)\b/iu.test(combined)) reasons.push('pricing_or_quote_not_requested');
  if (/\b(?:guarantee\w*|garantiz\w*|garanti\w*|garantiert\w*|verdoppel\w*|double your|lost revenue|losing money|number one|rank #?1|first place)\b|\d\s*%|[$€£]/iu.test(combined)) reasons.push('unsupported_commercial_claim');
  if (/\b(?:attached|attachment|anexo|anexado|adjunto|angehängt|beigefügt)\b|(?:reviewed|approved|geprüft\w*|revisado|aprobado)\s+(?:report|PDF|Bericht|relatório|informe)/iu.test(combined)) reasons.push('premature_attachment_or_release_claim');
  if (reasons.length) return { source: 'TEMPLATE', status: 'REQUIRES_HUMAN_REVIEW', reasons, drafts: fallback };
  const { id: _id, ...finding } = anchor!;
  return { source: 'LLM', status: 'REQUIRES_HUMAN_REVIEW', reasons: ['model_prose_requires_factual_and_audience_review',...(opener!==output.whatsappOpener.trim()||afterInterest!==output.afterInterestReply.trim()?['seller_placeholders_filled_from_verified_profile']:[])], drafts: {
    ...fallback, status: 'READY_FOR_REVIEW', holdReasons: [], opener, afterInterest,
    reviewNotes: { company: fallback.reviewNotes.company, ...finding },
  } };
}
