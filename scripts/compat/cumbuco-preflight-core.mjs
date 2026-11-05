// Shared read-only inventory implementation. The CLI wrapper enforces the production root.
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isAuditResultRecord } from '@spora/webcrawl/core/audit-validation';
import { classifyScanCompletion } from '@spora/webcrawl/core/scan-completion';
import { portugueseOpportunities } from '../../dist/reports/customer-pt.js';
import { scoreRun, compareRuns, sameBusinessTarget, businessTargetKey } from './cumbuco-run-selection.mjs';

const inside = (base, p) => { const r = relative(base, p); return r && r !== '..' && !r.startsWith(`..${sep}`) && !r.startsWith(sep); };
const noLink = async p => { const s = await lstat(p); if (s.isSymbolicLink()) throw Error('symlink_not_allowed'); return s; };

/** Build the same read-only inventory used by the guarded campaign CLI. */
export async function buildCumbucoPreflight(root) {
  if (await realpath(root) !== root) throw Error('unexpected_campaign_path');
  const input = async p => { await noLink(p); const resolved = await realpath(p); if (!inside(root, resolved)) throw Error('path_outside_campaign'); const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); try { const stat=await file.stat(); if(!stat.isFile()||stat.nlink!==1)throw Error('unsafe_input_file'); return await file.readFile(); } finally { await file.close(); } };
  await noLink(join(root, 'discovery-2'));
  await noLink(join(root, 'scraped'));
  const discovery = JSON.parse(await input(join(root, 'discovery-2/cumbuco-schools-expanded-21.json')));
  const summary = JSON.parse(await input(join(root, 'scraped/run-summary.json')));
  if (!Array.isArray(discovery) || !Array.isArray(summary)) throw Error('invalid_inventory');
  const ids = new Set();
  const targetCounts = new Map();
  for (const b of discovery) { const key = businessTargetKey(b.official_site); if (key) targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1); }
  const relevant = raw => { try { return /(?:^|\/)(?:[^/?]*(?:kite|aula|curso|lesson|course|contato|contact|booking|reserva)[^/?]*)(?:\/|$)/iu.test(new URL(raw).pathname); } catch { return false; } };
  const hash = b => createHash('sha256').update(b).digest('hex');
  const results = [];
  for (const business of discovery) {
    const id = business.candidate_id;
    if (typeof id !== 'string' || !/^CB-(?:EXT-)?[A-F0-9]{10}$/u.test(id) || ids.has(id)) throw Error('invalid_or_duplicate_business_id');
    ids.add(id);
    const matching = summary.filter(x => x.id === id);
    const row = { id, business: business.business_name, advertised_site: business.official_site, selection: null, alternatives: [], report: 'REVIEW', recipient: 'HOLD', recipient_review_required: true, selected_send_target: null, reason: 'Customer evidence and publication remain unverified.', changed_paths: [] };
    const targetKey = businessTargetKey(business.official_site);
    if (!targetKey || targetCounts.get(targetKey) !== 1) { row.reason = 'Advertised target is invalid or belongs to multiple business IDs.'; row.report = 'HOLD'; results.push(row); continue; }
    if (matching.length !== 1 || typeof matching[0].folder !== 'string' || matching[0].url !== business.official_site) { row.reason = 'Discovery and run summary identity do not match uniquely.'; row.report = 'HOLD'; results.push(row); continue; }
    try {
      const folder = matching[0].folder;
      const scraped = join(root, 'scraped');
      if (!inside(scraped, folder) || !inside(scraped, await realpath(folder)) || (await realpath(folder)) !== folder) throw Error('unsafe_business_folder');
      await noLink(folder);
      const entries = await readdir(folder, { withFileTypes: true });
      if (entries.some(x => x.isSymbolicLink())) throw Error('symlink_in_business_folder');
      const subdirs = entries.filter(x => x.isDirectory()).map(x => x.name).sort();
      const candidates = [];
      for (const sub of ['', ...subdirs]) {
        const dir = join(folder, sub); if (sub) { await noLink(dir); if ((await realpath(dir)) !== dir) throw Error('unsafe_run_directory'); }
        const p = join(dir, 'report.json');
        let data; try { data = await input(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        let audit; try { audit = JSON.parse(data); } catch { throw Error('corrupt_audit'); }
        if (!isAuditResultRecord(audit)) throw Error('audit_identity_or_schema_invalid');
        const seed = audit.coverage.urls.find(x => x.url === audit.target);
        if (!sameBusinessTarget(business.official_site, business.canonical_domain, matching[0].url, audit.target, seed?.finalUrl)) throw Error('audit_identity_or_schema_invalid');
        const usefulPages = new Set(audit.coverage.urls.filter(x => x.outcome === 'captured' && x.statusCode >= 200 && x.statusCode < 300 && (x.url === audit.target || relevant(x.url))).map(x => x.finalUrl ?? x.url));
        const usefulFindings = audit.findings.filter(f => ['noindex', 'missing_meta_description', 'missing_h1', 'title_long', 'broken_internal_link'].includes(f.code) && f.evidence.some(e => usefulPages.has(e.pageUrl)));
        const evidenceUrls = [...new Set(usefulFindings.flatMap(f => f.evidence.map(e => e.pageUrl)).filter(u => usefulPages.has(u) && !new URL(u).search))].sort().slice(0, 3);
        const inspect = classifyScanCompletion(audit);
        const score = scoreRun({ seedUsable: seed?.outcome === 'captured' && seed.statusCode >= 200 && seed.statusCode < 300, relevantFindings: usefulFindings.length, unattempted: audit.crawl.unattempted, technicalSeo: audit.capabilities.technicalSeo, relevantPages: usefulPages.size, failed: audit.crawl.failed, pageSpeed: audit.capabilities.pagespeed, startedAt: audit.startedAt });
        const opportunities = portugueseOpportunities(audit);
        candidates.push({ run: sub || 'base', audit: relative(root, p), sha256: hash(data), inspection: inspect, http: audit.capabilities.http, technical_seo: audit.capabilities.technicalSeo, images: audit.capabilities.images, captured_responses: audit.crawl.captured, relevant_captured_urls: usefulPages.size, relevant_finding_records: usefulFindings.length, evidence_urls: evidenceUrls, opportunities, limitations: audit.crawl.limitations, score });
      }
      candidates.sort(compareRuns);
      if (!candidates.length) { row.report = 'HOLD'; row.reason = 'No valid audit found.'; }
      else { row.selection = candidates[0]; row.alternatives = candidates.slice(1); row.report = row.selection.opportunities.length ? 'REVIEW' : 'HOLD'; row.reason = row.selection.opportunities.length ? 'Selected by validated identity, coverage and check quality; customer evidence requires review.' : 'Selected by validated identity, coverage and check quality; no qualifying opportunity was selected.'; }
    } catch (e) { row.report = 'HOLD'; row.reason = `Inventory validation failed: ${e.message}`; }
    results.push(row);
  }
  if (summary.some(x => !ids.has(x.id)) || new Set(summary.map(x => x.id)).size !== summary.length) throw Error('unmatched_or_duplicate_run_summary');
  return { schema: 'cumbuco-preflight-v1', mode: 'read-only', selected_are_provisional: false, businesses: results };
}
