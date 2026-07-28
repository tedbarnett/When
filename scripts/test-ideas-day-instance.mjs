// Day-specific add for "every day" (multi-day) events — server + client core.
//
// Ted's ask: a run like a nightly trad session or a month-long exhibition
// should be addable to his calendar for ONE specific day. This proves, with
// stubbed D1/KV/ASSETS (no network):
//   1. overlay action:add accepts a date-stamped day-instance id
//      (baseslug-YYYYMMDD) and several instances of one run coexist
//   2. ideasApi marks a multi-day candidate as on-calendar when ANY date in
//      its run window matches, and reports every match in added_instances
//      ({id, date, added, run, event}); run copies sort first
//   3. timezone bucketing: offset-suffixed starts (20:30 and even 00:30
//      Europe/Dublin) bucket to the CHOSEN date — never UTC-shifted
//   4. day-instances flow into the anonymous public JSON + ICS feed
//   5. instances remove independently; undo (re-add same id) round-trips
//   6. single-day candidates keep the legacy added_id/added_added shape
//   7. the client dayinstance-core block (identical across all 3 ideas
//      pages) builds ids, picker windows, and instance times correctly
// Run: node scripts/test-ideas-day-instance.mjs
import { readFileSync } from 'node:fs';
import { makeIdeasHandler } from '../functions/_lib/ideasApi.js';
import { makeOverlayHandler, makePublicJsonHandler } from '../functions/_lib/calendarApi.js';
import { makeIcsHandler } from '../functions/_lib/ics.js';
import { createSessionCookie } from '../functions/_lib/session.js';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}

const DATE = '2026-08-01';

/* ---- calendar base: one single-day gig + one base event that happens to
   fall inside a multi-day candidate's window (a pre-existing day entry) ---- */
const base = {
  calendar: { slug: 'teds-dublin' },
  events: [
    { id: 'whelans-gig-0801', title: 'Single Gig', venue: 'Whelans', start: '2026-08-01T20:00:00+01:00' },
    { id: 'whale-watching-0805', title: 'Whale Watching', venue: 'Dublin Bay Cruises', start: '2026-08-05T09:00:00+01:00' },
  ],
};

/* ---- D1 candidate pool ---- */
const mkRow = (o) => ({
  neighborhood: '', lat: null, lon: null, end_at: '', price: '', url: '',
  image: '', image_source: '', blurb: '', source: 'curated', source_url: '',
  category: 'other', signals: '[]', status: 'new', ...o,
});
const dayRows = [
  mkRow({ id: 'cand-gig', title: 'Single Gig', venue: 'Whelans', start: '2026-08-01T20:00:00+01:00' }),
];
const anydayRows = [
  // nightly trad session, runs almost a month — the "every day" case
  mkRow({ id: 'cand-trad', title: 'Nightly Trad Session', venue: 'The Cobblestone', start: '2026-07-25T20:30:00+01:00', end_at: '2026-08-20T23:00:00+01:00' }),
  // daily tours whose window already contains a BASE single-day event
  mkRow({ id: 'cand-whale', title: 'Whale Watching', venue: 'Dublin Bay Cruises', start: '2026-08-01T09:00:00+01:00', end_at: '2026-08-31T17:00:00+01:00' }),
];

/* ---- stubs: KV, static asset, D1 batch (day/anyday/prev/next order) ---- */
const kv = new Map();
const env = {
  SESSION_SECRET: 'test-secret',
  WHEN_CAL: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
  },
  ASSETS: { fetch: async () => new Response(JSON.stringify(base), { headers: { 'content-type': 'application/json' } }) },
  WHEN_EVENTS: {
    prepare(sql) { return { sql, bind() { return this; } }; },
    async batch(stmts) {
      return stmts.map((st) => {
        if (st.sql.includes('MAX(')) return { results: [{ d: null }] };
        if (st.sql.includes('MIN(')) return { results: [{ d: null }] };
        if (st.sql.includes('AND NOT')) return { results: anydayRows };
        return { results: dayRows };
      });
    },
  },
};

const owner = (await createSessionCookie(env, { email: 'tedbarnett@gmail.com' })).split(';')[0];
const ideas = makeIdeasHandler('dublin');
const overlayHandler = makeOverlayHandler('teds-dublin');
const jsonHandler = makePublicJsonHandler('teds-dublin');
const icsHandler = makeIcsHandler('teds-dublin', { tzid: 'Europe/Dublin' });

async function fetchIdeas(cookie) {
  const request = new Request(`https://when.org/api/cities/dublin/ideas?date=${DATE}`, {
    headers: { cookie: cookie || '' },
  });
  const res = await ideas.onRequestGet({ request, env });
  return { s: res.status, d: res.status === 200 ? await res.json() : null };
}
const overlayCall = async (body) => {
  const request = new Request('https://when.org/api/calendars/teds-dublin/overlay', {
    method: 'POST',
    headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const r = await overlayHandler.onRequestPost({ request, env });
  return { s: r.status, d: await r.json() };
};
const find = (d, id) => [...(d.events || []), ...(d.anyday || [])].find((e) => e.id === id);
const instBrief = (ev) => (ev.added_instances || []).map((i) => [i.id, i.date, i.added, i.run]);

/* ---- auth stays owner-only ---- */
check('ideas anon -> 401', (await fetchIdeas()).s, 401);

/* ---- 0. baseline: run not added; base day event inside a window counts ---- */
{
  const { d } = await fetchIdeas(owner);
  const trad = find(d, 'cand-trad');
  check('run starts un-added', [trad.added, trad.added_instances], [false, []]);
  const gig = find(d, 'cand-gig');
  check('single-day legacy match intact', [gig.added, gig.added_id, gig.added_added], [true, 'whelans-gig-0801', false]);
  check('single-day instances shape', instBrief(gig), [['whelans-gig-0801', '2026-08-01', false, false]]);
  const whale = find(d, 'cand-whale');
  check('base day event inside run window = day-instance', instBrief(whale), [['whale-watching-0805', '2026-08-05', false, false]]);
}

/* ---- 1. add two day-instances of the trad run (the client's payloads:
   date-stamped id, chosen date + the run's normal start time) ---- */
const addA = await overlayCall({
  action: 'add',
  event: {
    id: 'nightly-trad-session-20260730', title: 'Nightly Trad Session', venue: 'The Cobblestone',
    start: '2026-07-30T20:30:00+01:00', end: '2026-07-30T23:00:00+01:00', url: 'https://example.com/trad',
  },
});
check('day-instance A add -> id round-trips', [addA.s, addA.d.id], [200, 'nightly-trad-session-20260730']);
// midnight edge: a 00:30 Dublin start is 23:30Z the PREVIOUS day in UTC —
// bucketing must stay on the chosen local date
const addB = await overlayCall({
  action: 'add',
  event: {
    id: 'nightly-trad-session-20260802', title: 'Nightly Trad Session', venue: 'The Cobblestone',
    start: '2026-08-02T00:30:00+01:00',
  },
});
check('day-instance B add (00:30 local) -> 200', [addB.s, addB.d.id], [200, 'nightly-trad-session-20260802']);
{
  const { d } = await fetchIdeas(owner);
  const trad = find(d, 'cand-trad');
  check('run now added with 2 coexisting instances', [trad.added, trad.added_on], [true, 'teds-dublin']);
  check('instances sorted by date, tz-correct', instBrief(trad), [
    ['nightly-trad-session-20260730', '2026-07-30', true, false],
    ['nightly-trad-session-20260802', '2026-08-02', true, false],
  ]);
  check('added_id = first instance', trad.added_id, 'nightly-trad-session-20260730');
  check('instance carries re-add payload', trad.added_instances[0].event.start, '2026-07-30T20:30:00+01:00');
}

/* ---- 2. a whole-run copy sorts first and reads as run:true ---- */
const addRun = await overlayCall({
  action: 'add',
  event: {
    id: 'nightly-trad-session-run', title: 'Nightly Trad Session', venue: 'The Cobblestone',
    start: '2026-07-25T20:30:00+01:00', end: '2026-08-20T23:00:00+01:00',
  },
});
check('whole-run copy add -> 200', addRun.s, 200);
{
  const { d } = await fetchIdeas(owner);
  const trad = find(d, 'cand-trad');
  check('run copy sorts first, flagged run:true', instBrief(trad)[0], ['nightly-trad-session-run', '2026-07-25', true, true]);
  check('3 instances coexist', trad.added_instances.length, 3);
}
check('drop run copy again', (await overlayCall({ action: 'remove', id: 'nightly-trad-session-run' })).s, 200);

/* ---- 3. anonymous public JSON + ICS carry the day-instances ---- */
{
  const res = await jsonHandler.onRequest({ request: new Request('https://when.org/data/teds-dublin.json'), env });
  const pub = await res.json();
  const a = (pub.events || []).find((e) => e.id === 'nightly-trad-session-20260730');
  const b = (pub.events || []).find((e) => e.id === 'nightly-trad-session-20260802');
  check('public JSON: instance A single-day', [res.status, a.start, a.end || ''], [200, '2026-07-30T20:30:00+01:00', '2026-07-30T23:00:00+01:00']);
  check('public JSON: instance B present', b.start, '2026-08-02T00:30:00+01:00');
}
{
  const res = await icsHandler.onRequest({ request: new Request('https://when.org/teds-dublin.ics'), env });
  const ics = await res.text();
  check('ICS: instance A DTSTART on chosen local date', ics.includes('DTSTART;TZID=Europe/Dublin:20260730T203000'), true);
  check('ICS: instance B DTSTART not UTC-shifted', ics.includes('DTSTART;TZID=Europe/Dublin:20260802T003000'), true);
}

/* ---- 4. instances remove independently; undo re-adds the same id ---- */
check('remove instance A -> 200', (await overlayCall({ action: 'remove', id: 'nightly-trad-session-20260730' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  const trad = find(d, 'cand-trad');
  check('other instance survives', [trad.added, instBrief(trad)], [true, [['nightly-trad-session-20260802', '2026-08-02', true, false]]]);
  const ovDoc = JSON.parse(kv.get('cal:teds-dublin'));
  check('instance deleted outright (curator-added)', ['nightly-trad-session-20260730' in ovDoc.added, 'nightly-trad-session-20260730' in ovDoc.removed], [false, false]);
}
const reAdd = await overlayCall({
  action: 'add',
  event: {
    id: 'nightly-trad-session-20260730', title: 'Nightly Trad Session', venue: 'The Cobblestone',
    start: '2026-07-30T20:30:00+01:00', end: '2026-07-30T23:00:00+01:00', url: 'https://example.com/trad',
  },
});
check('undo (re-add same id) -> 200 + same id', [reAdd.s, reAdd.d.id], [200, 'nightly-trad-session-20260730']);
{
  const { d } = await fetchIdeas(owner);
  check('both instances back', instBrief(find(d, 'cand-trad')).map((i) => i[1]), ['2026-07-30', '2026-08-02']);
}
check('remove A again', (await overlayCall({ action: 'remove', id: 'nightly-trad-session-20260730' })).s, 200);
check('remove B', (await overlayCall({ action: 'remove', id: 'nightly-trad-session-20260802' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('all instances gone -> back to + add', [find(d, 'cand-trad').added, find(d, 'cand-trad').added_instances], [false, []]);
}

/* ---- 5. base day event inside a window removes via the removed list ---- */
check('remove base day-instance -> 200', (await overlayCall({ action: 'remove', id: 'whale-watching-0805' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('whale run back to + add', find(d, 'cand-whale').added, false);
}
check('unremove restores it', (await overlayCall({ action: 'unremove', id: 'whale-watching-0805' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('whale instance restored', instBrief(find(d, 'cand-whale')), [['whale-watching-0805', '2026-08-05', false, false]]);
}

/* ================= client dayinstance-core (all 3 ideas pages) ================= */

const PAGES = ['../public/nyc/ideas.html', '../public/dublin/ideas.html', '../public/reykjavik/ideas.html'];
function coreBlock(path) {
  const html = readFileSync(new URL(path, import.meta.url), 'utf8');
  const m = html.match(/\/\* dayinstance-core:start[\s\S]*?\*\/([\s\S]*?)\/\* dayinstance-core:end \*\//);
  if (!m) throw new Error('dayinstance-core block not found: ' + path);
  return m[1];
}
const blocks = PAGES.map(coreBlock);
check('dayinstance-core identical across all 3 ideas pages', [blocks[0] === blocks[1], blocks[1] === blocks[2]], [true, true]);

// The extracted code is the exact code the pages run; nyTodayKey, dayDate and
// ddateLabel are the externals it closes over — they become wrapper params.
const makeCore = new Function(
  'nyTodayKey', 'dayDate', 'ddateLabel',
  blocks[1] +
  'return { slugifyId: slugifyId, plusDaysKey: plusDaysKey, isMultiDay: isMultiDay, ' +
  'dayInstanceId: dayInstanceId, dayPickerDates: dayPickerDates, dayInstanceTimes: dayInstanceTimes, ' +
  'dayOptionLabel: dayOptionLabel, oncalChipLabel: oncalChipLabel, canAddAnotherDay: canAddAnotherDay };'
);
const dayDate = (key) => new Date(key + 'T12:00:00+01:00');
const ddateLabel = (key) => dayDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
const core = makeCore(() => '2026-07-27', dayDate, ddateLabel);

check('slugifyId folds accents/punctuation', core.slugifyId('Cobblestone — Trad Séssion!'), 'cobblestone-trad-session');
check('dayInstanceId = slug + YYYYMMDD', core.dayInstanceId('Nightly Trad Session', '2026-07-30'), 'nightly-trad-session-20260730');
check('plusDaysKey month rollover', core.plusDaysKey('2026-07-31', 1), '2026-08-01');
check('isMultiDay: +1 day is NOT a run', core.isMultiDay({ start: '2026-07-25T20:30:00+01:00', end: '2026-07-26T23:00:00+01:00' }), false);
check('isMultiDay: +2 days IS a run', core.isMultiDay({ start: '2026-07-25T20:30:00+01:00', end: '2026-07-27T23:00:00+01:00' }), true);
check('isMultiDay: no end -> false', core.isMultiDay({ start: '2026-07-25T20:30:00+01:00' }), false);

const run = { start: '2026-07-25T20:30:00+01:00', end: '2026-08-20T23:00:00+01:00' };
{
  const dates = core.dayPickerDates(run);
  check('picker starts today (city clock), not run start', dates[0], '2026-07-27');
  check('picker capped at 3 weeks (21 days)', [dates.length, dates[dates.length - 1]], [21, '2026-08-16']);
}
check('picker ends at run end when sooner', core.dayPickerDates({ start: '2026-07-25T20:30:00+01:00', end: '2026-07-29T23:00:00+01:00' }), ['2026-07-27', '2026-07-28', '2026-07-29']);
check('picker empty for a finished run', core.dayPickerDates({ start: '2026-07-01T20:30:00+01:00', end: '2026-07-20T23:00:00+01:00' }), []);
check('picker starts at run start for a future run', core.dayPickerDates({ start: '2026-08-05T10:00:00+01:00', end: '2026-08-09T17:00:00+01:00' })[0], '2026-08-05');

check('20:30 Dublin session lands on the chosen date', core.dayInstanceTimes(run, '2026-07-30'), { start: '2026-07-30T20:30', end: '2026-07-30T23:00' });
check('end time before start time is dropped', core.dayInstanceTimes({ start: '2026-07-25T20:30:00+01:00', end: '2026-08-20T00:00:00+01:00' }, '2026-07-30'), { start: '2026-07-30T20:30', end: '' });

const oneInst = { added_instances: [{ id: 'x-20260730', date: '2026-07-30', added: true, run: false }] };
const twoInst = { added_instances: [{ date: '2026-07-30', run: false }, { date: '2026-08-02', run: false }] };
const runInst = { added_instances: [{ date: '2026-07-25', run: true }] };
check('chip shows the day for one instance', core.oncalChipLabel(oneInst, true), '✓ on calendar · JUL 30');
check('chip counts several instances', core.oncalChipLabel(twoInst, true), '✓ on calendar · 2 days');
check('chip stays plain for a whole-run copy', core.oncalChipLabel(runInst, true), '✓ on calendar');
check('chip stays plain on single-day rows', core.oncalChipLabel(oneInst, false), '✓ on calendar');
check('day-instance rows offer ＋ day', core.canAddAnotherDay(oneInst, true), true);
check('whole-run rows do not offer ＋ day', core.canAddAnotherDay(runInst, true), false);
check('un-added rows do not offer ＋ day', core.canAddAnotherDay({ added_instances: [] }, true), false);

process.exit(failures ? 1 : 0);
