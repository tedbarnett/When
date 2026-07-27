// Ideas ⇄ calendar round-trip: the "✓ on calendar" chip on /dublin/ideas +
// /nyc/ideas is now an owner remove toggle. This proves the server
// mechanics end-to-end with stubbed D1/KV/ASSETS:
//   1. ideas responses carry added_id (the CALENDAR event id — never the
//      candidate id), added_added, and added_event (re-add payload for
//      curator-added matches)
//   2. overlay action:remove on added_id flips the candidate back to
//      "+ add" on the next ideas fetch (base events via the removed list,
//      curator-added entries deleted outright)
//   3. undo restores: unremove for base events; re-add with the saved
//      payload + id for curator-added entries
//   4. multi-day ("any day") candidates match + remove correctly too
import { makeIdeasHandler } from '../functions/_lib/ideasApi.js';
import * as overlayFn from '../functions/api/calendars/teds-dublin/overlay.js';
import { createSessionCookie } from '../functions/_lib/session.js';

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const DATE = '2026-08-01';

/* ---- calendar base: one single-day event + one multi-day exhibition ---- */
const base = {
  calendar: { slug: 'teds-dublin' },
  events: [
    { id: 'cobblestone-trad-0801', title: 'Trad Session', venue: 'The Cobblestone', start: '2026-08-01T21:00:00+01:00' },
    { id: 'hugh-lane-exhibit', title: 'Big Exhibition', venue: 'Hugh Lane Gallery', start: '2026-07-01T10:00:00+01:00', end: '2026-09-30T17:00:00+01:00' },
  ],
};

/* ---- D1 candidate pool: rows the ideas pages render ---- */
const mkRow = (o) => ({
  neighborhood: '', lat: null, lon: null, end_at: '', price: '', url: '',
  image: '', image_source: '', blurb: '', source: 'curated', source_url: '',
  category: 'other', signals: '[]', status: 'new', ...o,
});
const dayRows = [
  // matches the STATIC base event by slug(venue)-YYYYMMDD-slug(title[:24])
  mkRow({ id: 'cand-trad', title: 'Trad Session', venue: 'The Cobblestone', start: '2026-08-01T21:00:00+01:00' }),
  // matches a curator-ADDED overlay entry (added below) by exact title+date
  mkRow({ id: 'cand-gig', title: 'Curator Gig', venue: 'Whelans', start: '2026-08-01T20:00:00+01:00' }),
  // matches nothing
  mkRow({ id: 'cand-free', title: 'Unrelated Thing', venue: 'Nowhere', start: '2026-08-01T19:00:00+01:00' }),
];
const anydayRows = [
  // multi-day run overlapping DATE; key is built from the START date
  mkRow({ id: 'cand-exhibit', title: 'Big Exhibition', venue: 'Hugh Lane Gallery', start: '2026-07-01T10:00:00+01:00', end_at: '2026-09-30T17:00:00+01:00' }),
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
  const r = await overlayFn.onRequestPost({ request, env });
  return { s: r.status, d: await r.json() };
};
const find = (d, id) => [...(d.events || []), ...(d.anyday || [])].find((e) => e.id === id);

/* ---- auth: ideas stays owner-only ---- */
check('ideas anon -> 401', (await fetchIdeas()).s, 401);

/* ---- seed the curator-added entry cand-gig should match ---- */
const addRes = await overlayCall({
  action: 'add',
  event: {
    id: 'curator-gig-0801', title: 'Curator Gig', venue: 'Whelans',
    start: '2026-08-01T20:00:00+01:00', price: '\u20ac20', url: 'https://example.com/gig',
  },
});
check('seed add -> 200 + id', [addRes.s, addRes.d.id], [200, 'curator-gig-0801']);

/* ---- 1. added_id / added_added / added_event ride along ---- */
{
  const { d } = await fetchIdeas(owner);
  const trad = find(d, 'cand-trad');
  check('static match: added', trad.added, true);
  check('static match: added_id is CALENDAR id', trad.added_id, 'cobblestone-trad-0801');
  check('static match: not curator-added', trad.added_added, false);
  check('static match: no re-add payload', trad.added_event, null);
  const gig = find(d, 'cand-gig');
  check('added match: added_id', gig.added_id, 'curator-gig-0801');
  check('added match: added_added', gig.added_added, true);
  check('added match: payload for undo re-add', [gig.added_event.title, gig.added_event.venue, gig.added_event.price], ['Curator Gig', 'Whelans', '\u20ac20']);
  const ex = find(d, 'cand-exhibit');
  check('anyday match: added_id', ex.added_id, 'hugh-lane-exhibit');
  check('unmatched candidate stays "+ add"', [find(d, 'cand-free').added, find(d, 'cand-free').added_id], [false, '']);
}

/* ---- 2a. remove a STATIC calendar event -> chip flips to "+ add" ---- */
check('remove static -> 200', (await overlayCall({ action: 'remove', id: 'cobblestone-trad-0801' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('static removed: candidate back to add state', [find(d, 'cand-trad').added, find(d, 'cand-trad').added_id], [false, '']);
}
/* undo = unremove */
check('undo static (unremove) -> 200', (await overlayCall({ action: 'unremove', id: 'cobblestone-trad-0801' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('static restored: chip back', [find(d, 'cand-trad').added, find(d, 'cand-trad').added_id], [true, 'cobblestone-trad-0801']);
}

/* ---- 2b. remove a curator-ADDED entry -> deleted outright ---- */
const savedPayload = find((await fetchIdeas(owner)).d, 'cand-gig').added_event;
check('remove added -> 200', (await overlayCall({ action: 'remove', id: 'curator-gig-0801' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('added removed: candidate back to add state', find(d, 'cand-gig').added, false);
  const ovDoc = JSON.parse(kv.get('cal:teds-dublin'));
  check('added entry deleted outright (not on removed list)', ['curator-gig-0801' in ovDoc.added, 'curator-gig-0801' in ovDoc.removed], [false, false]);
}
/* undo = re-add the saved payload with the same id (the client's toast path) */
const reAdd = await overlayCall({ action: 'add', event: { ...savedPayload, id: 'curator-gig-0801' } });
check('undo added (re-add) -> same id', [reAdd.s, reAdd.d.id], [200, 'curator-gig-0801']);
{
  const { d } = await fetchIdeas(owner);
  const gig = find(d, 'cand-gig');
  check('added restored: chip + identity intact', [gig.added, gig.added_id, gig.added_added], [true, 'curator-gig-0801', true]);
  check('added restored: payload round-trips', gig.added_event.price, '\u20ac20');
}

/* ---- 2c. multi-day ("any day") remove works too ---- */
check('remove anyday -> 200', (await overlayCall({ action: 'remove', id: 'hugh-lane-exhibit' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('anyday removed: candidate back to add state', find(d, 'cand-exhibit').added, false);
}
check('undo anyday -> 200', (await overlayCall({ action: 'unremove', id: 'hugh-lane-exhibit' })).s, 200);
{
  const { d } = await fetchIdeas(owner);
  check('anyday restored', find(d, 'cand-exhibit').added_id, 'hugh-lane-exhibit');
}

process.exit(failures ? 1 : 0);
