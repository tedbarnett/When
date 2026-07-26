// Rerunnable category backfill for candidates still sitting at 'other'
// (migration 0006). Re-derives a category from stored facts:
//   - signals containing nyc-parks -> outdoor
//   - otherwise keyword heuristics on venue/title (categorize.js)
// Emits UPDATE statements ONLY for rows whose derived category != 'other',
// so metadata-derived values written by ingest are never touched (dump is
// pre-filtered to category='other' anyway).
//
// Usage:
//   npx wrangler d1 execute when-events --remote --json --command \
//     "SELECT id,title,venue,signals FROM candidates WHERE category = 'other' AND substr(start,1,10) >= 'YYYY-MM-DD'" \
//     > /tmp/when-cat.json
//   node scripts/backfill-category.mjs /tmp/when-cat.json > /tmp/when-cat.sql
//   (review the stderr report, then)
//   npx wrangler d1 execute when-events --remote --file /tmp/when-cat.sql
import { readFileSync } from 'node:fs';
import { categoryFromText } from '../workers/when-ingest/src/categorize.js';

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error('usage: node scripts/backfill-category.mjs <wrangler-json-dump>');
  process.exit(2);
}
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const rows = (Array.isArray(dump) ? dump[0].results : dump.results) || [];

function derive(row) {
  try {
    const sigs = JSON.parse(row.signals || '[]');
    if (Array.isArray(sigs) && sigs.indexOf('nyc-parks') >= 0) return 'outdoor';
  } catch {}
  return categoryFromText(row.title, row.venue);
}

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const counts = {};
let updates = 0;
for (const row of rows) {
  const cat = derive(row);
  counts[cat] = (counts[cat] || 0) + 1;
  if (cat === 'other') continue;
  console.log(`UPDATE candidates SET category = ${q(cat)} WHERE id = ${q(row.id)} AND category = 'other';`);
  updates++;
}
console.error(`rows in dump: ${rows.length}, updates emitted: ${updates}`);
console.error('derived distribution:', JSON.stringify(counts));
if (!updates) console.error('(nothing to do — no SQL emitted)');
