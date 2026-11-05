import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PROSPECTS = 50_000;
const SHA = (s: string) => createHash('sha256').update(s).digest('hex');
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ProspectInput = {
  /** Stable source identity supplied by the caller, e.g. a normalized hostname. */
  companyKey: string;
  /** Explicit branch key; use a stable branch ID or an explicit `main` value. */
  branchKey: string;
  companyName: string;
  branchLabel?: string | null;
  website: string;
  status: 'INTERNAL' | 'HOLD';
  evidenceFingerprint: string;
  issueCount: number;
  issueCodes: string[];
};

export type Prospect = {
  id: string;
  companyKey: string;
  branchKey: string;
  companyName: string;
  branchLabel: string | null;
  website: string;
  status: 'INTERNAL' | 'HOLD';
  evidenceFingerprint: string;
  issueCount: number;
  issueCodes: string[];
  /** Operator-owned funnel fields are preserved verbatim across generated refreshes. */
  operator: Record<string, Json>;
};

export type CRMState = { schema: 'seo-outreach-crm-v1'; prospects: Prospect[] };
export type CRMWriteResult = { state: CRMState; csv: string; jsonPath: string; csvPath: string };

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const boundedString = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const cleanKey = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en-US');

function safeOperatorValue(value: unknown, depth = 0, budget = { n: 0 }): value is Json {
  if (++budget.n > 2_000 || depth > 5) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 2_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every(v => safeOperatorValue(v, depth + 1, budget));
  if (!obj(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 100 && entries.every(([k, v]) => !['__proto__', 'prototype', 'constructor'].includes(k) && k.length <= 100 && safeOperatorValue(v, depth + 1, budget));
}

function identity(companyKey: string, branchKey: string): string {
  return SHA(`${cleanKey(companyKey)}\0${cleanKey(branchKey)}`);
}

function normalizeInput(input: ProspectInput): Omit<Prospect, 'operator'> {
  if (!obj(input)) throw new Error('invalid_prospect');
  const allowed = new Set(['companyKey','branchKey','companyName','branchLabel','website','status','evidenceFingerprint','issueCount','issueCodes']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new Error('unsupported_prospect_field');
  if (!boundedString(input.companyKey, 300) || !boundedString(input.branchKey, 300) || !boundedString(input.companyName, 300)) throw new Error('invalid_prospect_identity');
  if (input.branchLabel !== undefined && input.branchLabel !== null && (typeof input.branchLabel !== 'string' || input.branchLabel.length > 300)) throw new Error('invalid_branch_label');
  if (typeof input.website !== 'string' || input.website.length > 2_000) throw new Error('invalid_website');
  let url: URL;
  try { url = new URL(input.website); } catch { throw new Error('invalid_website'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_website');
  url.hash = ''; url.search = '';
  if (!['INTERNAL','HOLD'].includes(input.status)) throw new Error('invalid_prospect_status');
  if (!/^[a-f0-9]{64}$/.test(input.evidenceFingerprint)) throw new Error('invalid_evidence_fingerprint');
  if (!Number.isSafeInteger(input.issueCount) || input.issueCount < 0 || input.issueCount > 100_000) throw new Error('invalid_issue_count');
  if (!Array.isArray(input.issueCodes) || input.issueCodes.length > 100 || input.issueCodes.some(x => typeof x !== 'string' || !/^[a-z0-9_]{1,100}$/.test(x))) throw new Error('invalid_issue_codes');
  const companyKey = cleanKey(input.companyKey), branchKey = cleanKey(input.branchKey);
  if (!companyKey || !branchKey) throw new Error('invalid_prospect_identity');
  const issueCodes = [...new Set(input.issueCodes)].sort();
  return { id: identity(companyKey, branchKey), companyKey, branchKey, companyName: input.companyName.trim(), branchLabel: input.branchLabel?.trim() || null, website: url.href, status: input.status, evidenceFingerprint: input.evidenceFingerprint, issueCount: input.issueCount, issueCodes };
}

function validateProspect(v: unknown): Prospect {
  if (!obj(v)) throw new Error('corrupt_crm_state');
  const fields = ['id','companyKey','branchKey','companyName','branchLabel','website','status','evidenceFingerprint','issueCount','issueCodes','operator'];
  if (Object.keys(v).length !== fields.length || fields.some(k => !Object.hasOwn(v, k))) throw new Error('corrupt_crm_state');
  if (!boundedString(v.companyKey,300) || !boundedString(v.branchKey,300) || !boundedString(v.companyName,300) || (v.branchLabel !== null && !boundedString(v.branchLabel,300)) || !boundedString(v.website,2000)) throw new Error('corrupt_crm_state');
  if (v.id !== identity(v.companyKey, v.branchKey) || !['INTERNAL','HOLD'].includes(String(v.status)) || typeof v.evidenceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.evidenceFingerprint) || !Number.isSafeInteger(v.issueCount) || (v.issueCount as number) < 0 || !Array.isArray(v.issueCodes) || v.issueCodes.length > 100 || v.issueCodes.some(x => typeof x !== 'string' || !/^[a-z0-9_]{1,100}$/.test(x)) || !obj(v.operator) || !safeOperatorValue(v.operator)) throw new Error('corrupt_crm_state');
  let website: URL;
  try { website = new URL(v.website); } catch { throw new Error('corrupt_crm_state'); }
  if (!['http:','https:'].includes(website.protocol) || website.username || website.password || website.search || website.hash) throw new Error('corrupt_crm_state');
  return v as unknown as Prospect;
}

function parseState(value: unknown): CRMState {
  if (!obj(value) || value.schema !== 'seo-outreach-crm-v1' || !Array.isArray(value.prospects) || value.prospects.length > MAX_PROSPECTS) throw new Error('corrupt_crm_state');
  const prospects = value.prospects.map(validateProspect);
  const ids = new Set<string>();
  for (const p of prospects) { if (ids.has(p.id)) throw new Error('corrupt_crm_state'); ids.add(p.id); }
  return { schema: 'seo-outreach-crm-v1', prospects: prospects.sort((a,b) => a.id.localeCompare(b.id)) };
}

/** Merge current company/branch observations while retaining all previous rows and operator fields. */
export function mergeProspects(existing: unknown, incoming: ProspectInput[]): CRMState {
  if (!Array.isArray(incoming) || incoming.length > MAX_PROSPECTS) throw new Error('invalid_or_oversized_prospects');
  const state = existing === undefined ? { schema: 'seo-outreach-crm-v1', prospects: [] } as CRMState : parseState(existing);
  const byId = new Map(state.prospects.map(p => [p.id, p]));
  const seen = new Map<string, Omit<Prospect, 'operator'>>();
  for (const input of incoming) {
    const next = normalizeInput(input);
    const duplicate = seen.get(next.id);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(next)) throw new Error('conflicting_duplicate_prospect');
    seen.set(next.id, next);
  }
  for (const [id, next] of seen) {
    const previous = byId.get(id);
    byId.set(id, { ...next, operator: previous?.operator ?? {} });
  }
  if (byId.size > MAX_PROSPECTS) throw new Error('too_many_prospects');
  return { schema: 'seo-outreach-crm-v1', prospects: [...byId.values()].sort((a,b) => a.id.localeCompare(b.id)) };
}

function csvCell(value: string | number): string {
  let s = String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"','""')}"`;
}

/** Publicly safe, formula-escaped prospect projection; operator notes and contact details are omitted. */
export function prospectsCsv(state: CRMState): string {
  const parsed = parseState(state);
  const columns: (keyof Prospect)[] = ['id','companyName','branchLabel','website','status','issueCount','issueCodes'];
  const rows = [columns.map(k => csvCell(k)).join(',')];
  for (const p of parsed.prospects) rows.push([p.id,p.companyName,p.branchLabel ?? '',p.website,p.status,p.issueCount,p.issueCodes.join(';')].map(v => csvCell(v)).join(','));
  const csv = `${rows.join('\r\n')}\r\n`;
  if (Buffer.byteLength(csv) > MAX_FILE_BYTES) throw new Error('crm_csv_too_large');
  return csv;
}

async function assertSafePath(path: string, allowMissing: boolean): Promise<string> {
  const full = resolve(path);
  if (!isAbsolute(full) || full === parse(full).root) throw new Error('invalid_publication_path');
  const rel = relative(parse(full).root, dirname(full));
  let current = parse(full).root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_publication_directory');
  }
  try {
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('unsafe_publication_target');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw e;
  }
  return full;
}

async function ensureSafeParent(path: string): Promise<string> {
  const full = resolve(path);
  const rel = relative(parse(full).root, dirname(full));
  let current = parse(full).root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { await mkdir(current); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_publication_directory');
  }
  return full;
}

async function readState(path: string): Promise<CRMState | undefined> {
  let file: string;
  try { file = await assertSafePath(path, false); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('unsafe_publication_target');
    const data = await handle.readFile('utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { throw new Error('corrupt_crm_state'); }
    return parseState(parsed);
  } finally { await handle.close(); }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error('crm_output_too_large');
  const full = await ensureSafeParent(path);
  // Re-check after directory creation and create a private same-directory temp file exclusively.
  await assertSafePath(full, true);
  const temp = `${full}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(data, 'utf8'); await handle.sync(); } catch (e) { await handle.close(); await rm(temp,{force:true}); throw e; }
  await handle.close();
  try {
    await assertSafePath(full, true);
    await rename(temp, full);
    const dir = await open(dirname(full), constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
  } catch (e) { await rm(temp,{force:true}); throw e; }
}

/** Local-only merge and atomic publication. A sibling exclusive lock prevents lost operator updates. */
export async function upsertProspectFiles(args: { jsonPath: string; csvPath: string; prospects: ProspectInput[] }): Promise<CRMWriteResult> {
  if (!args || typeof args.jsonPath !== 'string' || typeof args.csvPath !== 'string' || resolve(args.jsonPath) === resolve(args.csvPath)) throw new Error('invalid_crm_paths');
  const jsonPath = await ensureSafeParent(args.jsonPath);
  const csvPath = await ensureSafeParent(args.csvPath);
  await assertSafePath(jsonPath, true); await assertSafePath(csvPath, true);
  const lockPath = `${jsonPath}.lock`;
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(e => { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('crm_state_locked'); throw e; });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() })); await lock.sync();
    const old = await readState(jsonPath);
    const state = mergeProspects(old, args.prospects);
    const json = `${JSON.stringify(state, null, 2)}\n`;
    const csv = prospectsCsv(state);
    // CSV is a derived view; publish it first, then publish authoritative JSON state.
    await writeAtomic(csvPath, csv);
    await writeAtomic(jsonPath, json);
    return { state, csv, jsonPath, csvPath };
  } finally { await lock.close(); await rm(lockPath); }
}
