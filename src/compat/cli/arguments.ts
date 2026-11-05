export function validateArguments(args: readonly string[]): string | undefined {
  const values = new Set(['--profile', '--profiles-file', '--batch', '--out', '--page-data', '--evidence-pack', '--report-contact-file', '--pages', '--requests', '--runtime-ms', '--response-bytes', '--total-bytes', '--concurrency', '--interval-ms', '--retries', '--image-checks', '--large-image-bytes', '--user-agent', '--locale', '--pdf-locale']);
  const flags = new Set(['--respect-robots', '--no-respect-robots', '--list-profiles', '--show-config', '--no-evidence-pack', '--no-browser', '--no-images', '--no-security-txt', '--no-progress', '--no-page-data-html', '--pagespeed-include-query', '--no-pagespeed-include-query', '--help', '--resume', '--security-txt', '--contacts', '--no-contacts', '--no-page-data', '--page-data-html', '--browser', '--browser=auto', '--pdf', '--no-pdf', '--technology', '--no-technology', '--images', '--pagespeed', '--no-pagespeed', '--progress']);
  const batchFlags = new Set(['--pagespeed-include-query', '--no-pagespeed-include-query', '--batch', '--out', '--resume', '--security-txt', '--contacts', '--no-contacts', '--pagespeed', '--no-pagespeed', '--progress', '--no-progress', '--help']);
  const seen = new Set<string>();
  let positionals = 0;
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      if (!values.has(arg) && !flags.has(arg)) throw new Error('unknown_cli_option');
      if (seen.has(arg)) throw new Error('duplicate_cli_option');
      seen.add(arg);
      if (args.includes('--batch') && !batchFlags.has(arg)) throw new Error('unsupported_batch_option');
      if (values.has(arg)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('missing_cli_option_value');
        if ((arg === '--locale' || arg === '--pdf-locale') && !['en', 'de'].includes(value)) throw new Error(arg === '--locale' ? 'invalid_locale' : 'invalid_pdf_locale');
      }
    } else { positionals++; target = arg; }
  }
  if (positionals > (args.includes('--batch') ? 0 : 1)) throw new Error('extra_cli_positional');
  if (!args.includes('--batch') && args.includes('--resume')) throw new Error('resume_requires_batch');
  return target;
}
