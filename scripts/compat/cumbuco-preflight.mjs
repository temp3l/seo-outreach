#!/usr/bin/env node
// Read-only inventory for the Cumbuco archive. Production CLI remains root-bound.
import { realpath } from 'node:fs/promises';
import { buildCumbucoPreflight } from './cumbuco-preflight-core.mjs';

const root = await realpath(process.argv[2] ?? '');
const expected = '/home/box/spora-worktrees/brazil-cumbuco';
if (root !== expected) throw Error('unexpected_campaign_path');
console.log(JSON.stringify(await buildCumbucoPreflight(root), null, 2));
