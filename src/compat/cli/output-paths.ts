import type { ProfileOptions } from './profiles.js';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export function resolvePageDataOutputPath(out: string, packMode: boolean, disabled: boolean, explicitPath?: string, includeRawHtml = false): string | undefined {
  if (disabled) return undefined;
  if (explicitPath) return explicitPath;
  if (packMode && !includeRawHtml) return undefined;
  return `${out}.page-data.json`;
}

export function resolveEvidencePackOutputPath(args: readonly string[]): string | undefined {
  const index = args.indexOf('--evidence-pack');
  if (index < 0) return undefined;
  const path = args[index + 1];
  if (!path || path.startsWith('--')) throw new Error('--evidence-pack requires a ZIP path');
  return path;
}

/** The single source of artifact destinations for CLI publication and launcher preflight. */
export function planSingleSiteOutputs(args: readonly string[], options: ProfileOptions) {
  const outIndex = args.indexOf('--out');
  const out = resolve(outIndex >= 0 ? args[outIndex + 1] ?? 'webcrawl-output' : 'webcrawl-output');
  const pageDataIndex = args.indexOf('--page-data');
  const evidencePackPath = resolveEvidencePackOutputPath(args) ?? (options['evidence-pack'] ? `${out}.evidence.zip` : undefined);
  const resolvedEvidencePackPath = evidencePackPath === undefined ? undefined : resolve(evidencePackPath);
  const noPageData = !options['page-data'];
  const includeRawPageData = options['page-data-html'];
  const explicitPageDataPath = pageDataIndex < 0 ? undefined : args[pageDataIndex + 1];
  if (pageDataIndex >= 0 && (!explicitPageDataPath || explicitPageDataPath.startsWith('--'))) throw new Error('--page-data requires a path');
  if (noPageData && (pageDataIndex >= 0 || includeRawPageData)) throw new Error('--no-page-data cannot be combined with --page-data or --page-data-html');
  const pageDataPath = resolvePageDataOutputPath(out, resolvedEvidencePackPath !== undefined, noPageData, explicitPageDataPath, includeRawPageData) ?? (options['page-data'] ? `${out}.page-data.json` : undefined);
  const resolvedPageDataPath = pageDataPath === undefined ? undefined : resolve(pageDataPath);
  if (args.includes('--pdf') && args.includes('--no-pdf')) throw new Error('--pdf and --no-pdf are mutually exclusive');
  if (args.includes('--operator-pdf') && args.includes('--no-operator-pdf')) throw new Error('--operator-pdf and --no-operator-pdf are mutually exclusive');
  const writePdf = options.pdf;
  const writeOperatorPdf = options['operator-pdf'];
  const customerPdfPath = options['pdf-locale'] === 'de' ? `${out}.report-de.pdf` : `${out}.pdf`;
  const mobilePdfPath = `${out}.mobile${options['pdf-locale'] === 'de' ? '-de' : ''}.pdf`;
  const operatorPdfPath = `${out}.operator-status.pdf`;
  const reviewManifestPath = `${out}.review.json`;
  const pdfPaths = [...(writePdf ? [customerPdfPath, mobilePdfPath, reviewManifestPath] : []), ...(writeOperatorPdf ? [operatorPdfPath] : [])];
  const runLogPath = `${out}.run.log`;
  const auditJsonPath = `${out}.json`;
  const auditHtmlPath = `${out}.html`;
  const scanStatusPath = `${out}.scan-status.json`;
  const whatsappDraftPath = `${out}.whatsapp-draft.md`;
  const outputPaths = [runLogPath, auditJsonPath, auditHtmlPath, scanStatusPath, whatsappDraftPath, ...(resolvedPageDataPath ? [resolvedPageDataPath] : []), ...(resolvedEvidencePackPath ? [resolvedEvidencePackPath] : []), ...pdfPaths];
  const privatePaths = (includeRawPageData || explicitPageDataPath !== undefined) && resolvedPageDataPath ? [resolvedPageDataPath] : [];
  return { runLogPath, auditJsonPath, auditHtmlPath, scanStatusPath, operatorPdfPath, reviewManifestPath, resolvedEvidencePackPath, resolvedPageDataPath, includeRawPageData, writePdf, writeOperatorPdf, customerPdfPath, mobilePdfPath, whatsappDraftPath, outputPaths, privatePaths };
}

export async function validateOutputPaths(paths: readonly string[], privatePaths: readonly string[] = []): Promise<void> {
  if (new Set(paths).size !== paths.length) throw new Error('output_paths_must_be_distinct');
  const directories = new Set<string>();
  const identities = new Set<string>();
  for (const path of paths) {
    try { await lstat(path); throw new Error('output_file_already_exists'); }
    catch (error) {
      if (error instanceof Error && error.message === 'output_file_already_exists') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = await realpath(dirname(path)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') throw new Error('output_directory_not_found'); throw error; });
    const identity = join(parent, basename(path));
    if (identities.has(identity)) throw new Error('output_paths_must_be_distinct');
    identities.add(identity);
    directories.add(dirname(path));
  }
  for (const directory of directories) {
    const info = await stat(directory).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error('output_directory_not_found');
    await access(directory, constants.W_OK | constants.X_OK);
  }
  for (const path of privatePaths) {
    const parent = await realpath(dirname(path));
    const info = await stat(parent);
    if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 || (info.mode & 0o300) !== 0o300) throw new Error('unsafe_private_output_directory');
  }
}
