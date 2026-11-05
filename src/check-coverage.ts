/** Bounded, privacy-preserving projection of Webcrawl checker coverage metadata. */
export const CHECK_KEYS = [
  'internalLinks', 'imageSizes', 'securityHeaders', 'mixedContent',
  'sensitiveForms', 'cookieAttributes', 'securityTxt',
] as const;

export type CheckKey = typeof CHECK_KEYS[number];
export type CheckStatus = 'complete' | 'partial' | 'disabled' | 'unavailable' | 'unknown';
export type CheckCounts = Readonly<{
  discovered: number; checked: number; findings: number; failed: number;
  skipped: number; unattempted: number;
}>;
export type CheckCoverageProjection = Readonly<{
  status: CheckStatus;
  counts: CheckCounts | null;
  /** Sum of explicitly declared omission counters; null means no check record. */
  omissions: number | null;
  outOfScope?: number;
  omittedTargets?: number;
  omittedRelations?: number;
  untrackedCandidates?: number;
}>;
export type ProjectedCheckCoverage = Readonly<{
  checks: Readonly<Record<CheckKey, CheckCoverageProjection>>;
  /** Sum of known omission counters from present checker records only. */
  knownOmissionCount: number;
}>;

const COUNTERS = ['discovered', 'checked', 'findings', 'failed', 'skipped', 'unattempted'] as const;
const LINK_OMISSIONS = ['omittedTargets', 'omittedRelations', 'untrackedCandidates'] as const;
const IMAGE_OMISSIONS = ['omittedTargets', 'untrackedCandidates'] as const;
const MAX_COUNT = 1_000_000_000;
const UNKNOWN_CHECK: CheckCoverageProjection = Object.freeze({ status: 'unknown', counts: null, omissions: null });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new TypeError(`Invalid checker coverage counter: ${field}`);
  }
  return value;
}

/**
 * Projects only allowlisted checker statuses and counters. It deliberately drops
 * URLs, descriptions, source strings, finding details, and all unknown fields.
 * A missing coverage/check record is represented as `unknown` with null counts
 * and omissions;
 * a present but malformed record is rejected.
 */
export function projectCheckCoverage(input: unknown): ProjectedCheckCoverage {
  const coverage = record(input) && record(input.coverage) ? input.coverage : null;
  const rawChecks = coverage && record(coverage.checks) ? coverage.checks : null;
  const checks = {} as Record<CheckKey, CheckCoverageProjection>;
  let knownOmissionCount = 0;

  for (const key of CHECK_KEYS) {
    if (!rawChecks || !Object.hasOwn(rawChecks, key)) {
      checks[key] = UNKNOWN_CHECK;
      continue;
    }
    const raw = rawChecks[key];
    if (!record(raw)) throw new TypeError(`Invalid checker coverage record: ${key}`);
    const allowedStatuses = key === 'internalLinks' || key === 'imageSizes'
      ? ['complete', 'partial', 'disabled']
      : ['complete', 'partial', 'disabled', 'unavailable'];
    if (typeof raw.status !== 'string' || !allowedStatuses.includes(raw.status)) {
      throw new TypeError(`Invalid checker coverage status: ${key}`);
    }
    const counts = {} as Record<typeof COUNTERS[number], number>;
    for (const field of COUNTERS) counts[field] = count(raw[field], `${key}.${field}`);
    let omissions = 0;
    const omissionFields = key === 'internalLinks' ? LINK_OMISSIONS : key === 'imageSizes' ? IMAGE_OMISSIONS : [];
    const projected: {
      status: Exclude<CheckStatus, 'unknown'>; counts: CheckCounts; omissions: number;
      outOfScope?: number; omittedTargets?: number; omittedRelations?: number; untrackedCandidates?: number;
    } = {
      status: raw.status as Exclude<CheckStatus, 'unknown'>,
      counts: Object.freeze(counts),
      omissions: 0,
    };
    if (key === 'internalLinks' || key === 'imageSizes') {
      projected.outOfScope = count(raw.outOfScope, `${key}.outOfScope`);
      for (const field of omissionFields) {
        if (Object.hasOwn(raw, field)) {
          const value = count(raw[field], `${key}.${field}`);
          projected[field] = value;
          omissions += value;
        }
      }
    }
    if (knownOmissionCount + omissions > MAX_COUNT) throw new TypeError('Checker coverage omission count exceeds bound');
    knownOmissionCount += omissions;
    projected.omissions = omissions;
    checks[key] = Object.freeze({
      ...projected,
    });
  }
  return Object.freeze({ checks: Object.freeze(checks), knownOmissionCount });
}
