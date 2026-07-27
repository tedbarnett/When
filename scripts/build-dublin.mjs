// Build Ted's Dublin data from the researched event set (2026-07-27).
//
// Inputs:  scripts/dublin-research-A.json (music/comedy/sports beat)
//          scripts/dublin-research-B.json (theatre/museums/family beat)
//          — every entry was verified against a live primary source page;
//          source_url records where the date was confirmed.
// Outputs: public/data/teds-dublin.json   (calendar base — merged view base)
//          scripts/dublin-candidates.sql  (D1 candidates, city='dublin',
//          for the /dublin/ideas curator pool; run with
//          npx wrangler d1 execute when-events --remote --file=scripts/dublin-candidates.sql)
//
// Rules:
//   - dedupe across the two research beats by slug(venue)+date+slug(title)
//   - all times are Europe/Dublin wall time; Jul–Aug 2026 is IST (+01:00)
//   - single-day events WITHOUT a verified time stay ideas-only (the
//     calendar never shows a made-up "12:00AM"); multi-day runs are fine
//     without times (they render as date ranges on the "any day" shelf)
//   - recurring markets expand to their actual market days; the nightly
//     theatre run at Bord Gáis expands to its listed performance nights
import { readFileSync, writeFileSync } from 'node:fs';

const A = JSON.parse(readFileSync(new URL('./dublin-research-A.json', import.meta.url), 'utf8'));
const B = JSON.parse(readFileSync(new URL('./dublin-research-B.json', import.meta.url), 'utf8'));

const OFFSET = '+01:00'; // Europe/Dublin, summer (IST)

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/* Approximate venue coordinates for the detail-modal map link. */
const GEO = {
  '3arena': { lat: 53.3478, lng: -6.2288 },
  'croke park': { lat: 53.3607, lng: -6.2511 },
  'aviva stadium': { lat: 53.3352, lng: -6.2281 },
  'rds': { lat: 53.3277, lng: -6.2296 },
  'bord gais energy theatre': { lat: 53.3444, lng: -6.2402 },
  'gaiety theatre': { lat: 53.3403, lng: -6.261 },
  'gate theatre': { lat: 53.3527, lng: -6.2604 },
  "whelan's": { lat: 53.335, lng: -6.265 },
  'vicar street': { lat: 53.3432, lng: -6.2782 },
  'the academy': { lat: 53.3486, lng: -6.26 },
  'smock alley theatre': { lat: 53.345, lng: -6.2705 },
  'national gallery of ireland': { lat: 53.341, lng: -6.2523 },
  'epic the irish emigration museum': { lat: 53.3489, lng: -6.2488 },
  'dublin zoo': { lat: 53.3559, lng: -6.3055 },
  'dalymount park': { lat: 53.3609, lng: -6.2723 },
  'tallaght stadium': { lat: 53.2842, lng: -6.3742 },
  'leopardstown racecourse': { lat: 53.268, lng: -6.1959 },
  'the laughter lounge': { lat: 53.348, lng: -6.256 },
  'light house cinema': { lat: 53.348, lng: -6.278 },
  'howth market': { lat: 53.3877, lng: -6.0654 },
  "people's park": { lat: 53.2937, lng: -6.1312 },
  'the duke pub': { lat: 53.3421, lng: -6.2593 },
  'trinity college': { lat: 53.3438, lng: -6.2546 },
};
function geoFor(venue) {
  const v = String(venue).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const key of Object.keys(GEO)) if (v.includes(key)) return GEO[key];
  return null;
}

/* ---------- merge + dedupe ---------- */
const seen = new Map();
function key(ev) { return slugify(ev.venue).slice(0, 24) + '|' + ev.date + '|' + slugify(ev.title).slice(0, 24); }
const merged = [];
for (const ev of [...A, ...B]) {
  const k = key(ev);
  const prior = seen.get(k);
  if (prior) {
    // Merge: keep the entry with a time; fill blanks from the other.
    const win = ev.time && !prior.time ? ev : prior;
    const lose = win === ev ? prior : ev;
    for (const f of ['time', 'end_date', 'price', 'url', 'source_url', 'blurb', 'image']) {
      if (!win[f] && lose[f]) win[f] = lose[f];
    }
    if (win.category === 'other' && lose.category !== 'other') win.category = lose.category;
    if (win !== prior) { merged[merged.indexOf(prior)] = win; seen.set(k, win); }
    continue;
  }
  seen.set(k, ev);
  merged.push(ev);
}
let events = merged;

/* ---------- hand corrections (verified 2026-07-27) ---------- */
for (const ev of events) {
  // epicchq.com event page: from 17:30, last entry 19:45, open until 21:00, €10.
  if (/dublin by dusk/i.test(ev.title)) {
    ev.time = '17:30';
    if (!ev.price) ev.price = '€10';
  }
  // Fawlty Towers: category from beat B (theater), Grand Canal Dock.
  if (/^fawlty towers/i.test(ev.title)) ev.category = 'theater';
  // Horse Show: the sports pick of the week, not "outdoor".
  if (/dublin horse show/i.test(ev.title)) ev.category = 'sports';
  // GAZE runs at the Light House (Smithfield) + IFI (Temple Bar).
  if (/gaze international/i.test(ev.title)) { ev.venue = 'Light House Cinema & IFI'; ev.neighborhood = 'Smithfield'; }
}

/* ---------- recurrence expansion ---------- */
const expanded = [];
for (const ev of events) {
  if (/^fawlty towers/i.test(ev.title)) {
    // Nightly performances listed 28 Jul – 1 Aug on the venue page.
    for (const d of ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01']) {
      expanded.push({ ...ev, date: d, end_date: '' });
    }
    continue;
  }
  if (/^howth market/i.test(ev.title)) {
    // Sat/Sun + bank-holiday Monday, 09:00–18:00 (howthmarket.ie).
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-08', '2026-08-09']) {
      expanded.push({ ...ev, date: d, end_date: '' });
    }
    continue;
  }
  if (/^people's park market/i.test(ev.title)) {
    // Sundays 11:00–16:00 (dunlaoghairetown.ie).
    for (const d of ['2026-08-02', '2026-08-09']) {
      expanded.push({ ...ev, date: d, end_date: '' });
    }
    continue;
  }
  expanded.push(ev);
}
events = expanded;

/* ---------- canonical rows ---------- */
function startISO(ev) { return ev.date + 'T' + (ev.time || '00:00') + ':00' + OFFSET; }
function addDays(dateKey, n) {
  return new Date(new Date(dateKey + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}
function endISO(ev) { return ev.end_date ? ev.end_date + 'T23:00:00' + OFFSET : ''; }
function isMultiDay(ev) { return !!ev.end_date && ev.end_date > ev.date; }

const CATS = ['theater', 'live-music', 'comedy', 'sports', 'outdoor', 'tours', 'film', 'museums', 'other'];

/* Calendar base: multi-day runs, or single-day events with verified times. */
const calEvents = [];
const usedIds = new Set();
for (const ev of events) {
  // Ideas-only cases — the calendar never invents a time: single-day events
  // without one, and sub-2-day "runs" (they'd land in a day column at 12AM;
  // the any-day shelf needs end ≥ start+2 days).
  const anydayEligible = isMultiDay(ev) && ev.end_date >= addDays(ev.date, 2);
  if (!ev.time && !anydayEligible) continue;
  let id = slugify(ev.title).slice(0, 40) + '-' + ev.date.slice(5).replace('-', '');
  while (usedIds.has(id)) id += '-2';
  usedIds.add(id);
  const geo = geoFor(ev.venue);
  calEvents.push({
    id,
    title: ev.title,
    blurb: ev.blurb || '',
    venue: ev.venue,
    neighborhood: ev.neighborhood || '',
    ...(geo ? { geo } : {}),
    start: startISO(ev),
    ...(endISO(ev) ? { end: endISO(ev) } : {}),
    price: ev.price || '',
    url: ev.url || '',
    image: ev.image || '',
    tags: [CATS.includes(ev.category) ? ev.category : 'other'],
  });
}
calEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

const calDoc = {
  calendar: {
    slug: 'teds-dublin',
    title: "Ted's Dublin",
    byline: 'Curated by Ted · things I’d actually go to',
    description:
      'Real Dublin this week: gigs, Georgian theatres, castle tours, seaside markets. Hand-picked, no filler.',
    city: 'Dublin',
    timezone: 'Europe/Dublin',
    followers: 1,
  },
  events: calEvents,
};
writeFileSync(new URL('../public/data/teds-dublin.json', import.meta.url), JSON.stringify(calDoc, null, 2) + '\n');

/* D1 candidates: everything (the curator pool). */
const q = (s) => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
const now = new Date().toISOString();
const stmts = [];
const seenKeys = new Set();
for (const ev of events) {
  const start = startISO(ev);
  const dk = slugify(ev.venue) + '-' + ev.date.replace(/-/g, '') + '-' + slugify(ev.title).slice(0, 40);
  if (seenKeys.has(dk)) continue;
  seenKeys.add(dk);
  const geo = geoFor(ev.venue);
  const cat = CATS.includes(ev.category) ? ev.category : 'other';
  stmts.push(
    'INSERT INTO candidates (id, city, title, venue, neighborhood, lat, lon, start, end_at, price, url, image, image_source, blurb, blurb_origin, source, source_url, category, signals, dedupe_key, first_seen, fetched_at, status) VALUES (' +
      [
        q(dk), q('dublin'), q(ev.title), q(ev.venue), q(ev.neighborhood || ''),
        geo ? geo.lat : 'NULL', geo ? geo.lng : 'NULL',
        q(start), q(endISO(ev)), q(ev.price || ''), q(ev.url || ''), q(ev.image || ''), q(''),
        q(ev.blurb || ''), q(ev.blurb ? 'ai' : 'none'), q('curated'), q(ev.source_url || ev.url || ''),
        q(cat), q('["curated"]'), q(dk), q(now), q(now), q('new'),
      ].join(', ') +
      ") ON CONFLICT(id) DO UPDATE SET title=excluded.title, start=excluded.start, end_at=excluded.end_at, price=excluded.price, url=excluded.url, blurb=excluded.blurb, category=excluded.category, fetched_at=excluded.fetched_at, status=CASE WHEN candidates.status='dismissed' THEN candidates.status ELSE candidates.status END;"
  );
}
writeFileSync(new URL('./dublin-candidates.sql', import.meta.url), stmts.join('\n') + '\n');

console.log('calendar events:', calEvents.length);
console.log('candidate rows:', stmts.length);
console.log('day spread:');
const byDay = {};
for (const ev of events) byDay[ev.date] = (byDay[ev.date] || 0) + 1;
for (const d of Object.keys(byDay).sort()) console.log(' ', d, byDay[d]);
