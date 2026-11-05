import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Package managers can invoke bins through symlinks while Node resolves the
 * module URL to its real file. Missing argv paths (e.g. stdin) are imports. */
export function isMainModule(moduleUrl: string, entry = process.argv[1]): boolean {
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}
