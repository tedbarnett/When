// One-time (rerunnable) sweep for Ted's "same location at same time,
// de-dupe!" rule: collapse future candidates that share normVenue + exact
// start and pass titlesSimilar (see workers/when-ingest/src/normalize.js)
// into one row — union signals, backfill blank facts, keep the canonical
// (noise-free) title — and delete the shadowed twins.
//
// Curated rows (status not in new/expired, i.e. 'added') are never deleted;
// when a cluster contains one, it wins and only uncurated twins drop.
//
// Usage:
//   npx wrangler d1 execute when-events --remote --json --command \
//     "SELECT id,title,venue,start,status,signals,first_seen,end_at,price,url,image,image_source,blurb,blurb_origin,neighborhood,lat,lon FROM candidates WHERE substr(start,1,10) >= 'YYYY-MM-DD'" \
//     > /tmp/when-future.json
//   node scripts/dedupe-sweep.mjs /tmp/when-future.json > /tmp/when-dedupe.sql
//   (review stderr report, then)
//   npx wrangler d1 execute when-events --remote --file /tmp/when-dedupe.sql
import { readFileSync } from 'node:fs';
import {
  normVenue,
  preferTitle,
  titleSimilarityParts,
  titlesSimilar,
} from '../workers/when-ingest/src/normalize.js';

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error('usage: node scripts/dedupe-sweep.mjs <wrangler-json-dump>');
  process.exit(2);
}
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const rows = dump[0]?.results || [];
if (!rows.length) {
  console.error('no rows in dump');
  process.exit(2);
}

const CURATED = (s) => s !== 'new' && s !== 'expired';
const q = (s) => "'" + String(s ?? '').replace(/'/g, "''") + "'";
const parseSignals = (s) => {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

// Group by venue+exact-start slot, then cluster similar titles (union-find).
const slots = new Map();
for (const r of rows) {
  const k = normVenue(r.venue) + '|' + r.start;
  let list = slots.get(k);
  if (!list) slots.set(k, (list = []));
  list.push(r);
}

const clusters = [];
for (const list of slots.values()) {
  if (list.length < 2) continue;
  for (const r of list) r.parts = titleSimilarityParts(r.title);
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (titlesSimilar(list[i].parts, list[j].parts)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < list.length; i++) {
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = []));
    g.push(list[i]);
  }
  for (const g of groups.values()) if (g.length > 1) clusters.push(g);
}

// Emit merges. Winner order: curated first, then noise-free title, then
// earliest first_seen, then id (determinism).
const stmts = [];
let removed = 0;
const perVenue = new Map();
for (const g of clusters) {
  g.sort((a, b) => {
    const ca = CURATED(a.status) ? 0 : 1;
    const cb = CURATED(b.status) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    // preferTitle(a,b) returns the cleaner (ties -> first arg)
    const pa = preferTitle(a.title, b.title) === a.title ? 0 : 1;
    const pb = preferTitle(b.title, a.title) === b.title ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.first_seen !== b.first_seen) return a.first_seen < b.first_seen ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  const win = g[0];
  const losers = g.slice(1).filter((r) => !CURATED(r.status));
  if (!losers.length) continue;

  let title = win.title;
  const signals = parseSignals(win.signals);
  const fill = { ...win };
  for (const l of losers) {
    title = preferTitle(title, l.title);
    for (const s of parseSignals(l.signals)) if (!signals.includes(s)) signals.push(s);
    for (const f of ['end_at', 'price', 'url', 'blurb', 'neighborhood']) {
      if (!fill[f]) fill[f] = l[f];
    }
    if (!fill.image && l.image) { fill.image = l.image; fill.image_source = l.image_source; }
    if (fill.blurb && fill.blurb === l.blurb) fill.blurb_origin = l.blurb_origin;
    if (fill.lat == null && l.lat != null) { fill.lat = l.lat; fill.lon = l.lon; }
  }
  stmts.push(
    'UPDATE candidates SET ' +
      `title = ${q(title)}, signals = ${q(JSON.stringify(signals))}, ` +
      `end_at = ${q(fill.end_at)}, price = ${q(fill.price)}, url = ${q(fill.url)}, ` +
      `image = ${q(fill.image)}, image_source = ${q(fill.image_source)}, ` +
      `blurb = ${q(fill.blurb)}, blurb_origin = ${q(fill.blurb_origin || 'none')}, ` +
      `neighborhood = ${q(fill.neighborhood)}, ` +
      `lat = ${fill.lat == null ? 'NULL' : fill.lat}, lon = ${fill.lon == null ? 'NULL' : fill.lon} ` +
      `WHERE id = ${q(win.id)};`
  );
  stmts.push(`DELETE FROM candidates WHERE id IN (${losers.map((l) => q(l.id)).join(', ')});`);
  removed += losers.length;
  const vk = normVenue(win.venue);
  perVenue.set(vk, (perVenue.get(vk) || 0) + losers.length);
  console.error(
    `MERGE ${win.venue} @ ${win.start}: keep ${q(title)} (${win.id}), drop ${losers
      .map((l) => q(l.title))
      .join(', ')}`
  );
}

for (const s of stmts) console.log(s);
console.error(`\n${clusters.length} clusters, ${removed} rows to remove across ${perVenue.size} venues`);
const top = [...perVenue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
for (const [v, n] of top) console.error(`  ${n}\t${v}`);
