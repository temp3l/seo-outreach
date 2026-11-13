import {CUSTOMER_REPORT_FRESHNESS_MS} from '../../dist/reports/freshness.js';
import { registerHooks } from 'node:module';

// Advance the isolated command's clock at the mobile boundary. Keep the actual
// qualification, HTML generation and Chromium renderer intact.
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith('/dist/reports/mobile.js')) return loaded;
  const source = String(loaded.source);
  if (process.env.WEBCRAWL_TEST_RELEASE_CLOCK_PHASE === 'renderer-error') {
    return { ...loaded, source: source.replace('const release =', 'throw new Error("SYNTHETIC_PRIVATE_RENDER_ERROR"); const release =') };
  }
  const advance = 'Date.now = () => ' + (Date.now() + CUSTOMER_REPORT_FRESHNESS_MS + 1) + ';';
  const after = process.env.WEBCRAWL_TEST_RELEASE_CLOCK_PHASE === 'after-mobile';
  const marker = after ? 'return renderer(html);' : 'const release =';
  if (!source.includes(marker)) throw new Error('mobile_clock_fixture_boundary_missing');
  return { ...loaded, source: source.replace(marker, after ? `const rendered = await renderer(html); ${advance} return rendered;` : `${advance} const release =`) };
} });
