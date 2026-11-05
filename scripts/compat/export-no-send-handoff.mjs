#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { reviewRow, HANDOFF_SCHEMA } from './no-send-handoff-core.mjs';
const rows = new Map();
for (const path of process.argv.slice(2)) {
  const row = reviewRow(JSON.parse(await readFile(path, 'utf8')));
  rows.set(row.id, row);
}
process.stdout.write(`${JSON.stringify({ schema: HANDOFF_SCHEMA, rows: [...rows.values()].sort((a,b) => a.id.localeCompare(b.id)) }, null, 2)}\n`);
