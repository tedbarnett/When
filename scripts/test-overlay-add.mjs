// Unit check for overlay action:"add" (issue #6) + applyOverlay merge of
// added events, with stubbed KV/ASSETS. Also proves hide/edit/reset work on
// added events (reset REMOVES an added event).
import * as overlayFn from '../functions/api/calendars/teds-nyc/overlay.js';
import { applyOverlay, loadOverlay, CAL_KEY } from '../functions/_lib/calendar.js';
import { createSessionCookie } from '../functions/_lib/session.js';

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const base = {
  calendar: { slug: 'teds-nyc' },
  events: [
    { id: 'existing-0801', title: 'Existing', venue: 'Somewhere', start: '2026-08-01T19:00:00-04:00' },
    { id: 'late-0802', title: 'Later', venue: 'Elsewhere', start: '2026-08-02T21:00:00-04:00' },
  ],
};

const kv = new Map();
const env = {
  SESSION_SECRET: 'test-secret',
  WHEN_CAL: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
  },
  ASSETS: { fetch: async () => new Response(JSON.stringify(base), { headers: { 'content-type': 'application/json' } }) },
};
const owner = (await createSessionCookie(env, { email: 'tedbarnett@gmail.com' })).split(';')[0];
const other = (await createSessionCookie(env, { email: 'mallory@example.com' })).split(';')[0];

const req = (body, cookie) =>
  new Request('https://when.org/api/calendars/teds-nyc/overlay', {
    method: 'POST',
    headers: { cookie: cookie || '', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const call = (body, cookie) => overlayFn.onRequestPost({ request: req(body, cookie), env });

const newEv = {
  title: 'Imported Show', venue: 'Blue Note', neighborhood: 'Greenwich Village',
  start: '2026-08-01T20:00:00-04:00', end: '2026-08-01T21:30:00-04:00',
  price: '$35', blurb: 'A very good show.', url: 'https://example.com/e', image: 'https://example.com/i.jpg',
};

check('add anon -> 401', (await call({ action: 'add', event: newEv })).status, 401);
check('add non-owner -> 403', (await call({ action: 'add', event: newEv }, other)).status, 403);
check('add missing venue -> 400', (await call({ action: 'add', event: { title: 'X', start: '2026-08-01T20:00:00-04:00' } }, owner)).status, 400);
check('add bad start -> 400', (await call({ action: 'add', event: { ...newEv, start: 'friday' } }, owner)).status, 400);
check('add bad image -> 400', (await call({ action: 'add', event: { ...newEv, image: 'javascript:x' } }, owner)).status, 400);

const r1 = await call({ action: 'add', event: { ...newEv, id: 'imported-show-0801' } }, owner);
const d1 = await r1.json();
check('add -> 200', r1.status, 200);
check('add id honored', d1.id, 'imported-show-0801');
check('add stored tags/geo', JSON.stringify(d1.event.tags) + '|' + String(d1.event.geo), '[]|null');

const r2 = await call({ action: 'add', event: { ...newEv, id: 'imported-show-0801' } }, owner);
const d2 = await r2.json();
check('duplicate id -> suffix -2', d2.id, 'imported-show-0801-2');

const r3 = await call({ action: 'add', event: { ...newEv, id: 'existing-0801' } }, owner);
const d3 = await r3.json();
check('base-id collision -> suffix -2', d3.id, 'existing-0801-2');

// no id supplied -> derived slug-MMDD
const r4 = await call({ action: 'add', event: { ...newEv, title: 'Another Néw Show!' } }, owner);
const d4 = await r4.json();
check('derived id slug', d4.id, 'another-new-show-0801');

/* merged public output */
{
  const ov = await loadOverlay(env);
  const pub = applyOverlay(base, ov);
  const ids = pub.events.map((e) => e.id);
  check('public merge contains added', ids.includes('imported-show-0801'), true);
  check('public merge count', pub.events.length, 6);
  check('public sorted by start', ids.join(',').indexOf('existing-0801') < ids.join(',').indexOf('late-0802'), true);
  check('public: no _added marker', '_added' in pub.events.find((e) => e.id === 'imported-show-0801'), false);
  const first = pub.events[0];
  check('added sorts before later base event', pub.events[pub.events.length - 1].id, 'late-0802');
  void first;
  const own = applyOverlay(base, ov, { includeHidden: true });
  check('owner merge: _added marker', own.events.find((e) => e.id === 'imported-show-0801')._added, true);
}

/* hide / edit / reset on the added event */
check('hide added -> 200', (await call({ action: 'hide', id: 'imported-show-0801' }, owner)).status, 200);
{
  const ov = await loadOverlay(env);
  check('hidden added excluded from public', applyOverlay(base, ov).events.some((e) => e.id === 'imported-show-0801'), false);
  check('hidden added marked for owner', applyOverlay(base, ov, { includeHidden: true }).events.find((e) => e.id === 'imported-show-0801')._hidden, true);
}
check('unhide added -> 200', (await call({ action: 'unhide', id: 'imported-show-0801' }, owner)).status, 200);
check('edit added -> 200', (await call({ action: 'edit', id: 'imported-show-0801', fields: { title: 'Imported Show (Late Set)' } }, owner)).status, 200);
{
  const ov = await loadOverlay(env);
  const ev = applyOverlay(base, ov).events.find((e) => e.id === 'imported-show-0801');
  check('edit applied on added', ev.title, 'Imported Show (Late Set)');
}
check('reset added -> 200', (await call({ action: 'reset', id: 'imported-show-0801' }, owner)).status, 200);
{
  const ov = await loadOverlay(env);
  check('reset REMOVES added event', applyOverlay(base, ov, { includeHidden: true }).events.some((e) => e.id === 'imported-show-0801'), false);
  check('reset cleared edits doc', JSON.stringify(ov.edits['imported-show-0801'] || null), 'null');
}
/* reset on a base event still only clears edits */
await call({ action: 'edit', id: 'existing-0801', fields: { title: 'Existing (edited)' } }, owner);
await call({ action: 'reset', id: 'existing-0801' }, owner);
{
  const ov = await loadOverlay(env);
  const pub = applyOverlay(base, ov);
  check('base event survives reset', pub.events.some((e) => e.id === 'existing-0801'), true);
  check('base title restored', pub.events.find((e) => e.id === 'existing-0801').title, 'Existing');
}
/* remove / unremove (owner ✕: gone for EVERYONE, owner included) */
check('remove anon -> 401', (await call({ action: 'remove', id: 'existing-0801' })).status, 401);
check('remove non-owner -> 403', (await call({ action: 'remove', id: 'existing-0801' }, other)).status, 403);
check('remove unknown id -> 400', (await call({ action: 'remove', id: 'nope-0801' }, owner)).status, 400);
check('unremove unknown id -> 400', (await call({ action: 'unremove', id: 'nope-0801' }, owner)).status, 400);
/* removing a static event: hides/edits stay put so undo restores exactly */
await call({ action: 'hide', id: 'existing-0801' }, owner);
await call({ action: 'edit', id: 'existing-0801', fields: { title: 'Existing (edited)' } }, owner);
check('remove base -> 200', (await call({ action: 'remove', id: 'existing-0801' }, owner)).status, 200);
{
  const ov = await loadOverlay(env);
  check('removed flag stored', ov.removed['existing-0801'], true);
  check('removed gone from public', applyOverlay(base, ov).events.some((e) => e.id === 'existing-0801'), false);
  check('removed gone from OWNER view too', applyOverlay(base, ov, { includeHidden: true }).events.some((e) => e.id === 'existing-0801'), false);
  check('remove keeps hidden for undo', ov.hidden['existing-0801'], true);
  check('remove keeps edits for undo', ov.edits['existing-0801'].title, 'Existing (edited)');
}
check('unremove -> 200', (await call({ action: 'unremove', id: 'existing-0801' }, owner)).status, 200);
{
  const ov = await loadOverlay(env);
  check('unremove clears flag', 'existing-0801' in ov.removed, false);
  check('unremove: still hidden from public (state restored)', applyOverlay(base, ov).events.some((e) => e.id === 'existing-0801'), false);
  const own = applyOverlay(base, ov, { includeHidden: true }).events.find((e) => e.id === 'existing-0801');
  check('unremove: back in owner view', !!own, true);
  check('unremove: hide restored', own._hidden, true);
  check('unremove: edit restored', own.title, 'Existing (edited)');
}
await call({ action: 'unhide', id: 'existing-0801' }, owner);
await call({ action: 'reset', id: 'existing-0801' }, owner);
/* remove on a curator-ADDED event deletes it outright (mirrors reset) */
await call({ action: 'add', event: { ...newEv, id: 'removable-add-0801' } }, owner);
check('remove added -> 200', (await call({ action: 'remove', id: 'removable-add-0801' }, owner)).status, 200);
{
  const ov = await loadOverlay(env);
  check('remove deletes added entry', 'removable-add-0801' in ov.added, false);
  check('added remove leaves removed list clean', 'removable-add-0801' in ov.removed, false);
  check('added event gone everywhere', applyOverlay(base, ov, { includeHidden: true }).events.some((e) => e.id === 'removable-add-0801'), false);
}

/* legacy overlay docs (no added/removed keys) still load */
kv.set(CAL_KEY, JSON.stringify({ hidden: {}, edits: {} }));
{
  const ov = await loadOverlay(env);
  check('legacy overlay gets added:{}', JSON.stringify(ov.added), '{}');
  check('legacy overlay gets removed:{}', JSON.stringify(ov.removed), '{}');
  check('legacy overlay merge ok', applyOverlay(base, ov).events.length, 2);
}

process.exit(failures ? 1 : 0);
