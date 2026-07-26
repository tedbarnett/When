// Rerunnable category backfill (migration 0006; extended for the
// tours/film/museums split). Re-derives a category from stored facts,
// mirroring what a fresh ingest would compute:
//   - stored metadata category (anything but ''/other) -> refineCategory
//     (museum exhibits filed under theater, venue tours under music/sports,
//     parks exhibits/tours/movie-nights under outdoor)
//   - ''/other rows -> categoryFromText keyword heuristics
// Emits UPDATE statements only for rows whose derived category changed,
// guarded by AND category = <old> so a concurrent ingest never loses.
//
// Usage:
//   npx wrangler d1 execute when-events --remote --json --command \
//     "SELECT id,title,venue,category FROM candidates WHERE substr(start,1,10) >= 'YYYY-MM-DD'" \
//     > /tmp/when-cat.json
//   node scripts/backfill-category.mjs /tmp/when-cat.json > /tmp/when-cat.sql
//   (review the stderr report, then)
//   npx wrangler d1 execute when-events --remote --file /tmp/when-cat.sql
import { readFileSync } from 'node:fs';
import {
  categoryFromText,
  refineCategory,
  validCategory,
} from '../workers/when-ingest/src/categorize.js';

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error('usage: node scripts/backfill-category.mjs <wrangler-json-dump>');
  process.exit(2);
}
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const rows = (Array.isArray(dump) ? dump[0].results : dump.results) || [];

function derive(row) {
  const stored = validCategory(row.category);
  if (stored && stored !== 'other') return refineCategory(stored, row.title, row.venue);
  return categoryFromText(row.title, row.venue);
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const before = {};
const after = {};
const moves = {};
let updates = 0;
for (const row of rows) {
  const old = validCategory(row.category) || 'other';
  const cat = derive(row);
  before[old] = (before[old] || 0) + 1;
  after[cat] = (after[cat] || 0) + 1;
  if (cat === old) continue;
  const mv = old + ' -> ' + cat;
  moves[mv] = (moves[mv] || 0) + 1;
  console.log(`UPDATE candidates SET category = ${q(cat)} WHERE id = ${q(row.id)} AND category = ${q(row.category || '')};`);
  updates++;
}
console.error(`rows in dump: ${rows.length}, updates emitted: ${updates}`);
console.error('before:', JSON.stringify(before));
console.error('after: ', JSON.stringify(after));
console.error('moves: ', JSON.stringify(moves));
if (!updates) console.error('(nothing to do — no SQL emitted)');
