// Exercise upsertCandidates' real INSERT/MERGE SQL against a real SQLite db
// (node:sqlite, built into Node 22 — no npm deps) with migrations 0001+0005
// applied, proving the geo backfill semantics:
//   1. insert without geo -> lat/lon NULL
//   2. re-upsert same dedupe_key WITH geo + borough -> NULLs/'' backfilled
//   3. third upsert with DIFFERENT geo/borough -> existing values NOT clobbered
// Run: node scripts/test-upsert-geo.mjs
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildCandidate, upsertCandidates } from '../workers/when-ingest/src/normalize.js';

const sqlite = new DatabaseSync(':memory:');
for (const f of ['0001_event_ideas.sql', '0005_geo.sql']) {
  sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
}

/* Minimal D1-shaped shim over node:sqlite (prepare/bind/all/run/batch). */
function makeD1(db) {
  return {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...args) { this.params = args; return this; },
        async all() { return { results: db.prepare(this.sql).all(...this.params) }; },
        async run() { const r = db.prepare(this.sql).run(...this.params); return { meta: { changes: r.changes } }; },
      };
    },
    async batch(stmts) { for (const s of stmts) db.prepare(s.sql).run(...s.params); return []; },
  };
}
const d1 = makeD1(sqlite);

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}
const row = () => sqlite.prepare("SELECT neighborhood, lat, lon, signals FROM candidates WHERE title = 'Jazz Night'").get();

// Same title+venue+start => same dedupe_key across all three upserts.
const base = { title: 'Jazz Night', venue: 'Blue Note', start: '2026-08-01T19:00:00-04:00' };

// 1) ICS-style candidate: no geo at all.
let r = await upsertCandidates(d1, [buildCandidate({ ...base }, 'ics-source')]);
check('1. insert (no geo)', [r.inserted, r.merged], [1, 0]);
check('1. lat/lon NULL, neighborhood empty', [row().lat, row().lon, row().neighborhood], [null, null, '']);

// 2) SeatGeek-style re-sighting: coords + borough present -> backfill.
r = await upsertCandidates(d1, [buildCandidate({ ...base, lat: 40.7308, lon: -74.0006, neighborhood: 'Manhattan' }, 'seatgeek')]);
check('2. merged (same dedupe_key)', [r.inserted, r.merged], [0, 1]);
check('2. geo backfilled onto NULL row', [row().lat, row().lon, row().neighborhood], [40.7308, -74.0006, 'Manhattan']);
check('2. signals accumulated', JSON.parse(row().signals), ['ics-source', 'seatgeek']);

// 3) Different source claims different geo -> existing values win.
r = await upsertCandidates(d1, [buildCandidate({ ...base, lat: 40.9999, lon: -73.5001, neighborhood: 'Queens' }, 'ticketmaster')]);
check('3. merged again', [r.inserted, r.merged], [0, 1]);
check('3. existing geo NOT clobbered', [row().lat, row().lon, row().neighborhood], [40.7308, -74.0006, 'Manhattan']);
check('3. third signal accumulated', JSON.parse(row().signals), ['ics-source', 'seatgeek', 'ticketmaster']);

// 4) Fresh insert WITH geo lands directly.
await upsertCandidates(d1, [buildCandidate({ title: 'Geo First', venue: 'Kings Theatre', start: '2026-08-02T20:00:00-04:00', lat: 40.6461, lon: -73.9615, neighborhood: 'Brooklyn' }, 'ticketmaster')]);
const g = sqlite.prepare("SELECT lat, lon, neighborhood FROM candidates WHERE title = 'Geo First'").get();
check('4. insert with geo', [g.lat, g.lon, g.neighborhood], [40.6461, -73.9615, 'Brooklyn']);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
