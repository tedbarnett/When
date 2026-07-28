// Build Ted's Reykjavik data from the researched event set (2026-07-27).
//
// Inputs:  scripts/reykjavik-research-A.json (music/nightlife/shows beat)
//          scripts/reykjavik-research-B.json (tours/outdoor/lagoons beat)
//          scripts/reykjavik-research-C.json (museums/festivals/misc beat)
//          — every entry was verified against a live primary source page;
//          source_url records where the date/schedule was confirmed.
// Outputs: public/data/teds-reykjavik.json  (calendar base — the ~dozen
//          strongest picks, listed in SEEDS below)
//          scripts/reykjavik-candidates.sql (D1 candidates, city='reykjavik',
//          for the /reykjavik/ideas curator pool; run with
//          npx wrangler d1 execute when-events --remote --file=scripts/reykjavik-candidates.sql)
//
// Rules:
//   - Ted's window is Tue 2026-07-28 → Thu 2026-07-30 (Iceland stopover);
//     starts outside that window are rejected.
//   - all times are Atlantic/Reykjavik wall time — UTC+0 YEAR-ROUND (no
//     DST since 1968), so every ISO carries +00:00.
//   - recurring daily tours/shows are single rows spanning the window
//     (start = first day at the real departure/opening time, end = Jul 30)
//     so they surface in the ideas "anyday" bucket every day — same
//     pattern as the Dublin trad-session rows.
//   - single-day events without a verified time stay ideas-only (the
//     calendar never shows a made-up "12:00AM").
import { readFileSync, writeFileSync } from 'node:fs';

const beats = [];
for (const b of ['A', 'B', 'C']) {
  try {
    const doc = JSON.parse(readFileSync(new URL(`./reykjavik-research-${b}.json`, import.meta.url), 'utf8'));
    const rows = Array.isArray(doc) ? doc : doc.events || [];
    for (const r of rows) beats.push({ ...r, _beat: b });
  } catch (e) {
    console.error(`beat ${b}: ${e.message}`);
  }
}

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/* ---------- validate ---------- */
const WINDOW = ['2026-07-28', '2026-07-29', '2026-07-30'];
const valid = [];
for (const ev of beats) {
  const errs = [];
  if (!ev.title || !ev.venue || !ev.start) errs.push('missing title/venue/start');
  const d = String(ev.start || '').slice(0, 10);
  if (!WINDOW.includes(d)) errs.push('start outside window: ' + d);
  if (!/\+00:00$/.test(ev.start || '')) errs.push('start offset must be +00:00');
  if (ev.end && !/\+00:00$/.test(ev.end)) errs.push('end offset must be +00:00');
  if (!ev.url && !ev.source_url) errs.push('no url');
  if (errs.length) { console.error('REJECT', ev.title, '—', errs.join('; ')); continue; }
  valid.push(ev);
}

/* ---------- dedupe across beats ---------- */
const seen = new Map();
const merged = [];
for (const ev of valid) {
  const k = slugify(ev.venue).slice(0, 24) + '|' + ev.start.slice(0, 10) + '|' + slugify(ev.title).slice(0, 24);
  const prior = seen.get(k);
  if (prior) {
    for (const f of ['end', 'price', 'url', 'source_url', 'blurb', 'image', 'lat', 'lon']) {
      if (!prior[f] && ev[f]) prior[f] = ev[f];
    }
    continue;
  }
  seen.set(k, ev);
  merged.push(ev);
}

const CATS = ['theater', 'live-music', 'comedy', 'sports', 'outdoor', 'tours', 'film', 'museums', 'other'];
const cat = (ev) => (CATS.includes(ev.category) ? ev.category : 'other');

function addDays(dateKey, n) {
  return new Date(new Date(dateKey + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}
const isAnyday = (ev) => !!ev.end && ev.end.slice(0, 10) >= addDays(ev.start.slice(0, 10), 2);
const hasTime = (ev) => !/T00:00:00/.test(ev.start);

/* ---------- the calendar seeds: the ~dozen strongest picks ---------- */
// Matched by candidate id (slug(venue)-YYYYMMDD-slug(title[:40])).
const SEEDS = new Set(JSON.parse(readFileSync(new URL('./reykjavik-seeds.json', import.meta.url), 'utf8')));

/* ---------- hand corrections (verified 2026-07-27) ---------- */
// Whales of Iceland was researched by two beats under slightly different
// titles; keep beat C's museums row, drop beat B's duplicate.
const DROP = new Set(['whales-of-iceland-fiskislo-23-25-20260728-whales-of-iceland-exhibition']);

/* ---------- candidate rows (the full curator pool) ---------- */
const q = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const now = new Date().toISOString();
const stmts = [];
const calEvents = [];
const usedIds = new Set();
const seededIds = [];
for (const ev of merged) {
  const dateKey = ev.start.slice(0, 10);
  const candId = slugify(ev.venue) + '-' + dateKey.replace(/-/g, '') + '-' + slugify(ev.title).slice(0, 40);
  if (DROP.has(candId)) continue;
  if (usedIds.has(candId)) continue;
  usedIds.add(candId);
  stmts.push(
    'INSERT INTO candidates (id, city, title, venue, neighborhood, lat, lon, start, end_at, price, url, image, image_source, blurb, blurb_origin, source, source_url, category, signals, dedupe_key, first_seen, fetched_at, status) VALUES (' +
      [
        q(candId), q('reykjavik'), q(ev.title), q(ev.venue), q(ev.neighborhood || ''),
        typeof ev.lat === 'number' ? ev.lat : 'NULL', typeof ev.lon === 'number' ? ev.lon : 'NULL',
        q(ev.start), q(ev.end || ''), q(ev.price || ''), q(ev.url || ''), q(ev.image || ''), q(''),
        q(ev.blurb || ''), q(ev.blurb ? 'ai' : 'none'), q('curated'), q(ev.source_url || ev.url || ''),
        q(cat(ev)), q('["curated"]'), q(candId), q(now), q(now), q('new'),
      ].join(', ') +
      ") ON CONFLICT(id) DO UPDATE SET title=excluded.title, start=excluded.start, end_at=excluded.end_at, price=excluded.price, url=excluded.url, image=excluded.image, blurb=excluded.blurb, category=excluded.category, fetched_at=excluded.fetched_at;"
  );

  /* calendar base: seeded picks only; never invent a time */
  if (!SEEDS.has(candId)) continue;
  if (!hasTime(ev) && !isAnyday(ev)) { console.error('SEED SKIP (no time, not anyday):', candId); continue; }
  let id = slugify(ev.title).slice(0, 40) + '-' + dateKey.slice(5).replace('-', '');
  while (calEvents.some((e) => e.id === id)) id += '-2';
  seededIds.push(candId);
  calEvents.push({
    id,
    title: ev.title,
    blurb: ev.blurb || '',
    venue: ev.venue,
    neighborhood: ev.neighborhood || '',
    ...(typeof ev.lat === 'number' && typeof ev.lon === 'number' ? { geo: { lat: ev.lat, lng: ev.lon } } : {}),
    start: ev.start,
    ...(ev.end ? { end: ev.end } : {}),
    price: ev.price || '',
    url: ev.url || '',
    image: ev.image || '',
    tags: [cat(ev)],
  });
}
calEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

const calDoc = {
  calendar: {
    slug: 'teds-reykjavik',
    title: "Ted's Reykjavik",
    byline: 'Curated by Ted · things I’d actually go to',
    description:
      'Real Reykjavik this week: Harpa concerts, harbour whales, geothermal lagoons, midnight-sun tours. Hand-picked, no filler.',
    city: 'Reykjavik',
    timezone: 'Atlantic/Reykjavik',
    followers: 1,
  },
  events: calEvents,
};
writeFileSync(new URL('../public/data/teds-reykjavik.json', import.meta.url), JSON.stringify(calDoc, null, 2) + '\n');
writeFileSync(new URL('./reykjavik-candidates.sql', import.meta.url), stmts.join('\n') + '\n');

console.log('candidate rows:', stmts.length);
console.log('calendar (seeded) events:', calEvents.length);
const missedSeeds = [...SEEDS].filter((s) => !seededIds.includes(s));
if (missedSeeds.length) console.error('SEEDS NOT FOUND:', missedSeeds);
console.log('day spread (candidates):');
const byDay = {};
for (const ev of merged) {
  const k = ev.start.slice(0, 10) + (isAnyday(ev) ? ' (anyday span)' : '');
  byDay[k] = (byDay[k] || 0) + 1;
}
for (const d of Object.keys(byDay).sort()) console.log(' ', d, byDay[d]);
const byCat = {};
for (const ev of merged) byCat[cat(ev)] = (byCat[cat(ev)] || 0) + 1;
console.log('by category:', byCat);
const noImage = merged.filter((e) => !e.image).map((e) => e.title);
if (noImage.length) console.log('no image (' + noImage.length + '):', noImage.join(' | '));
