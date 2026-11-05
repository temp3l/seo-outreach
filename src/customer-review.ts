import { createHash } from 'node:crypto';
import type { Finding } from './decision.js';

const SCHEMA = 'seo-outreach-customer-review-v1' as const;
const MAX_BYTES = 16 * 1024;
const ID = /^[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROOT_ALIASES: Readonly<Record<string, string>> = Object.freeze({ images_missing_alt: 'image_alt_missing_or_empty' });
const SUPPORTED = new Set([
  'missing_meta_description', 'missing_title', 'missing_h1', 'missing_canonical',
  'noindex', 'image_alt_missing_or_empty', 'images_missing_alt',
  'images_missing_dimensions', 'malformed_json_ld',
]);

export type CustomerReviewContext = Readonly<{
  company: string;
  analysisSha256: string;
  reportPdfSha256: string;
  findings: readonly Finding[];
}>;
export type CustomerReviewTemplate = Readonly<{
  schema: typeof SCHEMA;
  analysisSha256: string;
  reportPdfSha256: string;
  coverageReviewed: false;
  findings: readonly Readonly<{
    issueId: string;
    code: string;
    observed: string;
    reference: string;
    approved: false;
    indexingIntended: null;
  }>[];
}>;
export type CustomerReviewReceipt = Readonly<{ sha256: string; approvedFindings: 6 }>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(): never { throw new Error('customer_review_invalid'); }
function mismatch(): never { throw new Error('customer_review_mismatch'); }

function validateContext(context: CustomerReviewContext): void {
  if (!obj(context) || Object.keys(context).length !== 4 ||
      typeof context.company !== 'string' || context.company.length > 253 ||
      !SHA256.test(context.analysisSha256) || !SHA256.test(context.reportPdfSha256) ||
      !Array.isArray(context.findings) || context.findings.length !== 6) invalid();
  let companyUrl: URL;
  try { companyUrl = new URL(`https://${context.company}/`); } catch { invalid(); }
  if (companyUrl.hostname !== context.company.toLowerCase() || companyUrl.host !== companyUrl.hostname ||
      companyUrl.username || companyUrl.password) invalid();

  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const finding of context.findings) {
    if (!obj(finding) || typeof finding.id !== 'string' || !ID.test(finding.id) || ids.has(finding.id) ||
        typeof finding.code !== 'string' || !SUPPORTED.has(finding.code) ||
        typeof finding.observed !== 'string' || !finding.observed.trim() || finding.observed.length > 600 ||
        typeof finding.reference !== 'string' || finding.reference.length > 4096) invalid();
    let ref: URL;
    try { ref = new URL(finding.reference); } catch { invalid(); }
    if (!['http:', 'https:'].includes(ref.protocol) || ref.username || ref.password || ref.search || ref.hash ||
        ref.hostname !== companyUrl.hostname || ref.href !== finding.reference) invalid();
    const root = ROOT_ALIASES[finding.code] ?? finding.code;
    if (roots.has(root)) invalid();
    ids.add(finding.id); roots.add(root);
  }
}

/** Creates an editable, non-authoritative review template for exactly six findings. */
export function customerReviewTemplate(context: CustomerReviewContext): CustomerReviewTemplate {
  try { validateContext(context); } catch { return invalid(); }
  return Object.freeze({
    schema: SCHEMA,
    analysisSha256: context.analysisSha256,
    reportPdfSha256: context.reportPdfSha256,
    coverageReviewed: false,
    findings: Object.freeze(context.findings.map(f => Object.freeze({
      issueId: f.id,
      code: f.code,
      observed: f.observed,
      reference: f.reference,
      approved: false,
      indexingIntended: null,
    }))),
  });
}

/**
 * Validates an operator-completed review against its exact analysis/PDF and
 * six-finding context. The receipt contains no reviewer identity and carries no
 * publication or outreach authority by itself.
 */
export function validateCustomerReview(bytes: Uint8Array, context: CustomerReviewContext): CustomerReviewReceipt {
  try { validateContext(context); } catch { return invalid(); }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); }
  if (!obj(value) || Object.keys(value).length !== 5 ||
      value.schema !== SCHEMA || value.coverageReviewed !== true ||
      !SHA256.test(String(value.analysisSha256)) || !SHA256.test(String(value.reportPdfSha256)) ||
      !Array.isArray(value.findings) || value.findings.length !== 6) invalid();
  if (value.analysisSha256 !== context.analysisSha256 || value.reportPdfSha256 !== context.reportPdfSha256) mismatch();

  const expected = new Map(context.findings.map(f => [f.id, f]));
  const seen = new Set<string>();
  for (const item of value.findings) {
    if (!obj(item) || Object.keys(item).length !== 6 || typeof item.issueId !== 'string' ||
        typeof item.code !== 'string' || typeof item.observed !== 'string' ||
        typeof item.reference !== 'string' || typeof item.approved !== 'boolean' ||
        !(item.indexingIntended === null || typeof item.indexingIntended === 'boolean')) invalid();
    const expectedFinding = expected.get(item.issueId);
    if (!expectedFinding || seen.has(item.issueId) || item.code !== expectedFinding.code ||
        item.observed !== expectedFinding.observed || item.reference !== expectedFinding.reference) mismatch();
    if (item.approved !== true) mismatch();
    const code = expectedFinding.code;
    if (code === 'noindex' ? item.indexingIntended !== true : item.indexingIntended !== null) mismatch();
    seen.add(item.issueId);
  }
  if (seen.size !== expected.size) mismatch();
  return Object.freeze({ sha256: createHash('sha256').update(bytes).digest('hex'), approvedFindings: 6 });
}
