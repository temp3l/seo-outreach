#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export type Locale = 'en' | 'es' | 'de' | 'pt-BR';
export type LiveCLI = { paidCallOptIn:true; configPath:string; statePath:string; batchId:string };
type AnalyzeArgs = { command:'analyze'; input:string; out:string; locale:Locale; recorded?:string; crmExisting?:string; sellerName?:string; sellerLocation?:string; dryRun:boolean; live?:LiveCLI; providerPreview?:string };
type BatchArgs = { command:'batch'; manifest:string; out:string; locale:Locale; crmExisting?:string; dryRun:boolean; live?:LiveCLI; providerPreview?:string };
type RenderArgs = { command:'render'; analysis:string; out:string; dryRun:boolean; customerReview?:string };
export type ParsedArgs = AnalyzeArgs | BatchArgs | RenderArgs | { command:'help' };

export type Pipeline = {
  analyze(options: Omit<AnalyzeArgs,'command'>): Promise<unknown>;
  batch(options: Omit<BatchArgs,'command'>): Promise<unknown>;
  render(options: Omit<RenderArgs,'command'>): Promise<unknown>;
};

const USAGE = [
  'seo-outreach analyze --input <file> --out <directory> [--locale en|es|de|pt-BR] [--recorded <file>] [--crm-existing <prospects.json>] [--seller-name <name> --seller-location <location>] [--dry-run] [--paid-call --provider-config <file> --state <file> --batch-id <id>]',
  'seo-outreach batch --manifest <file> --out <directory> [--locale en|es|de|pt-BR] [--crm-existing <prospects.json>] [--dry-run] [--paid-call --provider-config <file> --state <file> --batch-id <id>]',
  'seo-outreach render --analysis <file> --out <directory> [--customer-review <file>] [--dry-run]',
  'seo-outreach reports prepare --audit <json> --report-contact-file <private-json> --out <prefix> [--pdf-locale en|de]',
  'seo-outreach reports release --audit <json> --qualification <json> --review-manifest <json> --out <prefix>',
  'seo-outreach reports handoff --audit <json> --release <json> --message-file <txt> --company <id> --branch <id> --campaign <id> --out <json>',
  'seo-outreach --help'
].join('\n');

const valueFlags = new Set(['--input','--out','--manifest','--analysis','--customer-review','--locale','--recorded','--crm-existing','--seller-name','--seller-location','--provider-config','--state','--batch-id']);
const commonFlags = new Set(['--out','--dry-run']);
const validLocales = new Set<Locale>(['en','es','de','pt-BR']);
const safePipelineErrors = new Set([
  'invalid_json','unsupported_or_invalid_webcrawl_audit','recorded_output_invalid',
  'source_fingerprint_changed','source_changed_after_batch_preflight','destination_exists','invalid_output_directory','unsafe_output_path',
  'customer_review_invalid','customer_review_mismatch','report_readback_failed','invalid_seller_identity','seller_identity_incomplete','invalid_crm_snapshot','prospect_capacity_exceeded',
  'archive_input_size_invalid','archive_manifest_invalid','archive_manifest_hash_mismatch','archive_json_invalid','archive_member_corrupt',
  'archive_member_unsafe','archive_member_name_or_order_invalid','archive_members_missing','archive_pages_limit_or_format_invalid',
  'invalid_checker_coverage','archive_page_coverage_invalid','archive_coverage_metadata_invalid','archive_audit_coverage_mismatch','archive_false_complete_status','archive_target_mismatch','archive_decompression_invalid','archive_local_header_invalid',
  'archive_central_invalid','archive_central_mismatch','archive_end_invalid','archive_nonregular_member'
]);

/** Strict parser, exported for focused tests and embedding without invoking the CLI. */
export function parseArgs(argv: string[]): ParsedArgs {
  if (!Array.isArray(argv) || argv.some(x => typeof x !== 'string')) throw new Error('invalid_arguments');
  if (argv.length === 1 && argv[0] === '--help') return { command:'help' };
  const command = argv[0];
  if (!command) throw new Error('command_required');
  if (command === 'help') { if (argv.length === 1) return { command:'help' }; throw new Error('unexpected_help_arguments'); }
  if (!['analyze','batch','render'].includes(command)) throw new Error('unknown_command');
  if (argv.includes('--help')) { if (argv.length === 2) return { command:'help' }; throw new Error('unexpected_help_arguments'); }
  const allowed = command === 'analyze' ? new Set(['--input','--out','--locale','--recorded','--crm-existing','--seller-name','--seller-location','--dry-run','--paid-call','--provider-config','--state','--batch-id']) : command === 'batch' ? new Set(['--manifest','--out','--locale','--crm-existing','--dry-run','--paid-call','--provider-config','--state','--batch-id']) : new Set(['--analysis','--out','--dry-run','--customer-review']);
  const values: Record<string,string> = {};
  let dryRun = false;
  let paidCall = false;
  for (let i=1;i<argv.length;i++) {
    const flag = argv[i]!;
    if (!allowed.has(flag)) throw new Error(valueFlags.has(flag) || commonFlags.has(flag) || flag.startsWith('-') ? 'unknown_or_inapplicable_flag' : 'unexpected_positional_argument');
    if (flag === '--dry-run') { if (dryRun) throw new Error('duplicate_flag'); dryRun = true; continue; }
    if (flag === '--paid-call') { if (paidCall) throw new Error('duplicate_flag'); paidCall = true; continue; }
    if (Object.hasOwn(values,flag)) throw new Error('duplicate_flag');
    const value = argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error('flag_value_required');
    if (flag === '--provider-config' && /^sk-[A-Za-z0-9_-]{8,}$/.test(value)) throw new Error('provider_config_path_required_api_keys_not_accepted');
    values[flag] = value;
  }
  const liveParts=[paidCall,Boolean(values['--provider-config']),Boolean(values['--state']),Boolean(values['--batch-id'])];
  const liveSpecified=liveParts.some(Boolean);
  const liveComplete=liveParts.every(Boolean);
  if (command==='render' && liveSpecified) throw new Error('live_flags_not_supported_for_render');
  if (liveSpecified && !liveComplete) throw new Error('live_flags_must_be_provided_together');
  const live:LiveCLI|undefined=liveComplete?{paidCallOptIn:true,configPath:values['--provider-config']!,statePath:values['--state']!,batchId:values['--batch-id']!}:undefined;
  if (command === 'analyze') {
    if (!values['--input'] || !values['--out']) throw new Error('analyze_input_and_out_required');
    if (Boolean(values['--seller-name']) !== Boolean(values['--seller-location'])) throw new Error('seller_name_and_location_must_be_paired');
    const locale = (values['--locale'] ?? 'en') as Locale;
    if (!validLocales.has(locale)) throw new Error('unknown_locale');
    return { command, input:values['--input'], out:values['--out'], locale, recorded:values['--recorded'], ...(values['--crm-existing']?{crmExisting:values['--crm-existing']}:{}) , sellerName:values['--seller-name'], sellerLocation:values['--seller-location'], dryRun, ...(live?{live}:{}) };
  }
  if (command === 'batch') {
    if (!values['--manifest'] || !values['--out']) throw new Error('batch_manifest_and_out_required');
    const locale = (values['--locale'] ?? 'en') as Locale;
    if (!validLocales.has(locale)) throw new Error('unknown_locale');
    return { command, manifest:values['--manifest'], out:values['--out'], locale, ...(values['--crm-existing']?{crmExisting:values['--crm-existing']}:{}) , dryRun, ...(live?{live}:{}) };
  }
  if (!values['--analysis'] || !values['--out']) throw new Error('render_analysis_and_out_required');
  return { command:'render', analysis:values['--analysis'], out:values['--out'], dryRun, ...(values['--customer-review']?{customerReview:values['--customer-review']}:{}) };
}

function safeResult(value: unknown, depth=0): unknown {
  if (depth > 8) return '[omitted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2_000)
    .replace(/\bBearer\s+[^\s"']+/gi,'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|access_token|password|secret)=)[^&#\s]*/gi,'$1[REDACTED]');
  if (Array.isArray(value)) return value.slice(0,100).map(x=>safeResult(x,depth+1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string,unknown> = {};
    for (const [key,item] of Object.entries(value as Record<string,unknown>).slice(0,100)) {
      if (/api.?key|authorization|password|secret|credential|access.?token|refresh.?token/i.test(key)) continue;
      out[key.slice(0,100)] = safeResult(item,depth+1);
    }
    return out;
  }
  return undefined;
}

/** Execute with an injected pipeline to keep argument and dispatch behavior testable offline. */
export async function runCli(argv: string[], pipeline: Pipeline, io: { stdout:(text:string)=>void; stderr:(text:string)=>void }): Promise<number> {
  let args: ParsedArgs;
  try { args = parseArgs(argv); }
  catch (e) { io.stderr(JSON.stringify({ ok:false, error:(e as Error).message })); return 2; }
  if (args.command === 'help') { io.stdout(JSON.stringify({ help:USAGE })); return 0; }
  try {
    let effective = args;
    // A dry-run is an offline authority boundary: do not forward paid-call opt-in to the pipeline.
    if (args.command!=='render' && args.dryRun && args.live) { const {live,...offline}=args; effective={...offline,providerPreview:live.configPath}; }
    const {command,...options} = effective;
    const result = await pipeline[command](options as never);
    io.stdout(JSON.stringify({ ok:true, command, result:safeResult(result) }));
    return 0;
  } catch (e) {
    // Pipeline errors can contain source text, local paths, provider details, or credentials.
    const code=e instanceof Error&&safePipelineErrors.has(e.message)?e.message:'operation_failed';
    io.stderr(JSON.stringify({ ok:false, command:args.command, error:code }));
    return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if(argv[0]==='reports'){
    try{const {runReportCommand}=await import('./report-command.js');console.log(JSON.stringify({ok:true,result:await runReportCommand(argv.slice(1))}));}
    catch(e){const code=e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:'report_operation_failed';console.error(JSON.stringify({ok:false,error:code}));process.exitCode=1;}
    return;
  }
  let code = 0;
  try {
    // Loading the pipeline only after argument validation keeps --help and parse errors offline.
    const parsed = parseArgs(argv);
    if (parsed.command === 'help') { process.stdout.write(`${JSON.stringify({help:USAGE})}\n`); return; }
    const pipeline = await import('./pipeline.js') as unknown as Pipeline;
    code = await runCli(argv,pipeline,{stdout:s=>process.stdout.write(`${s}\n`),stderr:s=>process.stderr.write(`${s}\n`)});
  } catch (e) {
    const error = e instanceof Error && ['command_required','unknown_command','unknown_or_inapplicable_flag','unexpected_positional_argument','duplicate_flag','flag_value_required','analyze_input_and_out_required','batch_manifest_and_out_required','render_analysis_and_out_required','seller_name_and_location_must_be_paired','unknown_locale','unexpected_help_arguments','invalid_arguments','live_flags_must_be_provided_together','live_flags_not_supported_for_render','provider_config_path_required_api_keys_not_accepted'].includes(e.message) ? e.message : 'operation_failed';
    process.stderr.write(`${JSON.stringify({ok:false,error})}\n`); code = error === 'operation_failed' ? 1 : 2;
  }
  process.exitCode = code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
