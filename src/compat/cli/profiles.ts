import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const numericOptions = {
  pages: [1, 10_000], requests: [1, 10_000], 'runtime-ms': [1_000, 3_600_000],
  'response-bytes': [1, 100_000_000], 'total-bytes': [1, 1_000_000_000],
  concurrency: [1, 100], 'interval-ms': [0, 60_000], retries: [0, 10],
  'image-checks': [0, 1_000], 'large-image-bytes': [1, 20_000_000],
} as const;
const booleanOptions = ['respect-robots', 'pagespeed', 'pagespeed-include-query', 'pdf', 'operator-pdf', 'contacts', 'technology', 'images', 'security-txt', 'evidence-pack', 'page-data', 'page-data-html', 'progress'] as const;
export type ProfileOptions = { [K in keyof typeof numericOptions]: number }
  & { [K in typeof booleanOptions[number]]: boolean }
  & { browser: boolean | 'auto'; locale: 'en' | 'de'; 'pdf-locale': 'en' | 'de'; 'user-agent': string };
type Profile = Partial<ProfileOptions> & { extends?: string; description?: string };
type ProfileFile = { version: 1; defaultProfile?: string; profiles: Record<string, Profile> };
export const bundledProfilesPath = fileURLToPath(new URL('../../../compat-profiles.json', import.meta.url));
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function validateOption(key: string, value: unknown): void {
  if (Object.hasOwn(numericOptions, key)) {
    const [min, max] = numericOptions[key as keyof typeof numericOptions];
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`invalid_profile_option: ${key} must be an integer from ${min} to ${max}`);
  } else if ((booleanOptions as readonly string[]).includes(key)) {
    if (typeof value !== 'boolean') throw new Error(`invalid_profile_option: ${key} must be boolean`);
  } else if (key === 'browser') {
    if (typeof value !== 'boolean' && value !== 'auto') throw new Error('invalid_profile_option: browser must be boolean or "auto"');
  } else if (key === 'locale' || key === 'pdf-locale') {
    if (value !== 'en' && value !== 'de') throw new Error('invalid_profile_option: locale must be en or de');
  } else if (key === 'user-agent') {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\u0000]/u.test(value)) throw new Error('invalid_profile_option: user-agent');
  } else if (key === 'extends') {
    if (typeof value !== 'string' || !namePattern.test(value)) throw new Error('invalid_profile_parent');
  } else if (key === 'description') {
    if (typeof value !== 'string' || value.length > 500) throw new Error('invalid_profile_description');
  } else throw new Error(`unknown_profile_option: ${key}`);
}
async function readProfiles(path: string): Promise<ProfileFile> {
  const bytes = await readFile(path);
  if (bytes.length > 262_144) throw new Error('profiles_file_too_large');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('invalid_profiles_json'); }
  if (!record(value) || value.version !== 1 || !record(value.profiles) || Object.keys(value).some(k => !['version', 'defaultProfile', 'profiles'].includes(k))) throw new Error('invalid_profiles_file');
  if (value.defaultProfile !== undefined && (typeof value.defaultProfile !== 'string' || !namePattern.test(value.defaultProfile))) throw new Error('invalid_default_profile');
  if (Object.keys(value.profiles).length > 100) throw new Error('too_many_profiles');
  for (const [name, options] of Object.entries(value.profiles)) {
    if (!namePattern.test(name) || !record(options)) throw new Error('invalid_profile');
    for (const [key, option] of Object.entries(options)) validateOption(key, option);
  }
  return value as ProfileFile;
}

export async function loadProfiles(customPath?: string): Promise<{ defaultProfile: string; profiles: Record<string, { description?: string; options: ProfileOptions }> }> {
  const bundled = await readProfiles(bundledProfilesPath);
  const custom = customPath === undefined ? undefined : await readProfiles(customPath);
  const definitions = { ...bundled.profiles, ...custom?.profiles };
  const base = { 'respect-robots': false, ...bundled.profiles.default! };
  const resolved: Record<string, { description?: string; options: ProfileOptions }> = Object.create(null);
  const visit = (name: string, chain: string[] = []): ProfileOptions => {
    if (!Object.hasOwn(definitions, name)) throw new Error(`unknown_profile: ${name}`);
    if (chain.includes(name)) throw new Error(`profile_inheritance_cycle: ${[...chain, name].join(' -> ')}`);
    if (Object.hasOwn(resolved, name)) return resolved[name]!.options;
    const { extends: parent, description, ...overrides } = definitions[name]!;
    const options = { ...base, ...(parent ? visit(parent, [...chain, name]) : {}), ...overrides };
    delete options.extends; delete options.description;
    for (const key of [...Object.keys(numericOptions), ...booleanOptions, 'browser', 'locale', 'pdf-locale', 'user-agent']) validateOption(key, options[key as keyof typeof options]);
    resolved[name] = { ...(description === undefined ? {} : { description }), options: options as ProfileOptions };
    return resolved[name]!.options;
  };
  for (const name of Object.keys(definitions)) visit(name);
  const defaultProfile = custom?.defaultProfile ?? bundled.defaultProfile ?? 'default';
  if (!Object.hasOwn(resolved, defaultProfile)) throw new Error(`unknown_profile: ${defaultProfile}`);
  return { defaultProfile, profiles: resolved };
}

/** Explicit command-line options always win over the inherited profile. */
export function resolveProfileOptions(base: ProfileOptions, args: readonly string[]): ProfileOptions {
  const options = { ...base };
  for (const key of [...Object.keys(numericOptions), 'locale', 'pdf-locale', 'user-agent']) {
    const i = args.indexOf(`--${key}`);
    if (i >= 0) {
      const value = Object.hasOwn(numericOptions, key) ? Number(args[i + 1]) : args[i + 1];
      try { validateOption(key, value); }
      catch { throw new Error(`invalid_${key.replaceAll('-', '_')}`); }
      Object.assign(options, { [key]: value });
    }
  }
  if (args.includes('--no-page-data') && (args.includes('--page-data') || args.includes('--page-data-html'))) throw new Error('--no-page-data cannot be combined with --page-data or --page-data-html');
  for (const key of booleanOptions) {
    if (args.includes(`--${key}`) && args.includes(`--no-${key}`)) throw new Error(`--${key} and --no-${key} are mutually exclusive`);
    if (args.includes(`--${key}`)) options[key] = true;
    if (args.includes(`--no-${key}`)) options[key] = false;
  }
  const browserFlags = args.filter(arg => ['--browser', '--browser=auto', '--no-browser'].includes(arg));
  if (browserFlags.length > 1) throw new Error('conflicting_browser_options');
  if (browserFlags.length) options.browser = browserFlags[0] === '--browser=auto' ? 'auto' : browserFlags[0] === '--browser';
  if (!options.pagespeed) options['pagespeed-include-query'] = false;
  if (args.includes('--page-data-html') || args.includes('--page-data')) options['page-data'] = true;
  if (args.includes('--no-page-data')) options['page-data-html'] = false;
  if (options['page-data-html']) options['page-data'] = true;
  return options;
}

/** Select and override the same named/default profile in CLI and launcher preflight. */
export function selectProfileOptions(catalog: Awaited<ReturnType<typeof loadProfiles>>, args: readonly string[]): { name: string; options: ProfileOptions } {
  const index = args.indexOf('--profile');
  const name = index >= 0 ? args[index + 1]! : catalog.defaultProfile;
  if (!Object.hasOwn(catalog.profiles, name)) throw new Error(`unknown_profile: ${name}`);
  return { name, options: resolveProfileOptions(catalog.profiles[name]!.options, args) };
}
