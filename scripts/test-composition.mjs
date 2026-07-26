// Composition tests for NYC Basics (issue #15): calendar registry, the
// extends chain (teds-nyc extends basics-nyc), and the subscribe-model
// overlay semantics on inherited events, with stubbed KV/ASSETS.
//
// Regression requirement #1: while basics is empty, teds-nyc's composed
// output is JSON-deep-equal to the pre-refactor applyOverlay(base, overlay)
// on fixture data covering hidden/edited/added cases.
import {
  applyOverlay, loadComposed, loadComposedBase, loadOverlayFor, calKey, CAL_KEY,
} from '../functions/_lib/calendar.js';
import * as tedsOverlayFn from '../functions/api/calendars/teds-nyc/overlay.js';
import * as basicsOverlayFn from '../functions/api/calendars/basics-nyc/overlay.js';
import * as tedsAdminFn from '../functions/api/calendars/teds-nyc/admin.js';
import { createSessionCookie } from '../functions/_lib/session.js';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}

const ORIGIN = 'https://when.org';

function makeEnv(bases) {
  const kv = new Map();
  return {
    kv,
    SESSION_SECRET: 'test-secret',
    WHEN_CAL: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => { kv.set(k, v); },
    },
    ASSETS: {
      fetch: async (url) => {
        const path = new URL(String(url.url || url)).pathname;
        for (const id of Object.keys(bases)) {
          if (path === '/data/' + id + '.json') {
            return new Response(JSON.stringify(bases[id]), { headers: { 'content-type': 'application/json' } });
          }
        }
        return new Response('not found', { status: 404 });
      },
    },
  };
}

const owner = async (env) => (await createSessionCookie(env, { email: 'tedbarnett@gmail.com' })).split(';')[0];
const post = (mod, cal, env, body, cookie) =>
  mod.onRequestPost({
    request: new Request(`${ORIGIN}/api/calendars/${cal}/overlay`, {
      method: 'POST',
      headers: { cookie: cookie || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  });

check('calKey', calKey('basics-nyc'), 'cal:basics-nyc');
check('CAL_KEY back-compat', CAL_KEY, 'cal:teds-nyc');

/* =====================================================================
 * PART 1 — regression: basics empty ⇒ teds composed === pre-refactor merge
 * Fixture covers hidden, edited, added, hidden+edited, and plain events.
 * =================================================================== */
{
  const tedsBase = {
    calendar: { slug: 'teds-nyc', title: "Ted's NYC" },
    events: [
      { id: 'plain-0801', title: 'Plain', venue: 'V1', start: '2026-08-01T19:00:00-04:00', tags: [], geo: null },
      { id: 'hidden-0801', title: 'Hidden', venue: 'V2', start: '2026-08-01T20:00:00-04:00', tags: [], geo: null },
      { id: 'edited-0802', title: 'Edited', venue: 'V3', start: '2026-08-02T19:00:00-04:00', tags: [], geo: null },
      { id: 'hidedit-0803', title: 'HidEdit', venue: 'V4', start: '2026-08-03T19:00:00-04:00', tags: [], geo: null },
    ],
  };
  const basicsBase = { calendar: { slug: 'basics-nyc', title: 'NYC Basics' }, events: [] };
  const overlay = {
    hidden: { 'hidden-0801': true, 'hidedit-0803': true },
    edits: { 'edited-0802': { title: 'Edited!', start: '2026-08-04T21:00:00-04:00' }, 'hidedit-0803': { price: '$10' } },
    added: { 'added-0805': { id: 'added-0805', title: 'Added', venue: 'V5', start: '2026-08-05T19:00:00-04:00', tags: [], geo: null } },
  };
  const env = makeEnv({ 'teds-nyc': tedsBase, 'basics-nyc': basicsBase });
  env.kv.set('cal:teds-nyc', JSON.stringify(overlay));

  const preRefactorPublic = applyOverlay(tedsBase, overlay);
  const preRefactorOwner = applyOverlay(tedsBase, overlay, { includeHidden: true });
  const composedPublic = (await loadComposed(env, ORIGIN, 'teds-nyc')).data;
  const composedOwner = (await loadComposed(env, ORIGIN, 'teds-nyc', { includeHidden: true })).data;
  check('REGRESSION public deep-equal (basics empty)', composedPublic, preRefactorPublic);
  check('REGRESSION owner deep-equal (basics empty)', composedOwner, preRefactorOwner);
  check('regression public count', composedPublic.events.length, 3);
  check('regression no _inherited anywhere', composedOwner.events.some((e) => e._inherited), false);
}

/* =====================================================================
 * PART 2 — inheritance end-to-end through the real handlers
 * =================================================================== */
{
  const tedsBase = {
    calendar: { slug: 'teds-nyc', title: "Ted's NYC" },
    events: [
      { id: 'teds-own-0801', title: 'Teds Own', venue: 'Vanguard', start: '2026-08-01T19:00:00-04:00', tags: [], geo: null },
      { id: 'dup-0802', title: 'Teds Version', venue: 'Teds Venue', start: '2026-08-02T19:00:00-04:00', tags: [], geo: null },
    ],
  };
  const basicsBase = {
    calendar: { slug: 'basics-nyc', title: 'NYC Basics' },
    events: [
      { id: 'dup-0802', title: 'Basics Version', venue: 'Basics Venue', start: '2026-08-02T18:00:00-04:00', tags: [], geo: null },
      { id: 'basics-hidden-0803', title: 'Basics Hidden', venue: 'X', start: '2026-08-03T19:00:00-04:00', tags: [], geo: null },
    ],
  };
  const env = makeEnv({ 'teds-nyc': tedsBase, 'basics-nyc': basicsBase });
  const cookie = await owner(env);

  // basics curates: hide one of its own base events, edit the other, add one
  check('basics hide own -> 200', (await post(basicsOverlayFn, 'basics-nyc', env, { action: 'hide', id: 'basics-hidden-0803' }, cookie)).status, 200);
  check('basics edit dup -> 200', (await post(basicsOverlayFn, 'basics-nyc', env, { action: 'edit', id: 'dup-0802', fields: { price: '$5' } }, cookie)).status, 200);
  const addRes = await post(basicsOverlayFn, 'basics-nyc', env, {
    action: 'add',
    event: { id: 'basics-added-0804', title: 'Basics Added', venue: 'Bowery', start: '2026-08-04T20:00:00-04:00' },
  }, cookie);
  check('basics add -> 200', addRes.status, 200);
  check('basics overlay is its own KV key', !!env.kv.get('cal:basics-nyc'), true);
  check('teds overlay untouched by basics writes', env.kv.get('cal:teds-nyc') ?? null, null);

  // basics public output
  const basicsPub = (await loadComposed(env, ORIGIN, 'basics-nyc')).data;
  check('basics public ids', basicsPub.events.map((e) => e.id), ['dup-0802', 'basics-added-0804']);

  // teds composed public: inherits basics-added, dup resolves teds-wins,
  // basics-hidden never flows down
  const tedsPub = (await loadComposed(env, ORIGIN, 'teds-nyc')).data;
  check('teds composed ids', tedsPub.events.map((e) => e.id), ['teds-own-0801', 'dup-0802', 'basics-added-0804']);
  const dup = tedsPub.events.find((e) => e.id === 'dup-0802');
  check('dup id: teds wins', dup.title + '|' + (dup.price || ''), 'Teds Version|');
  check('inherited event clean in public (no _inherited)', '_inherited' in tedsPub.events.find((e) => e.id === 'basics-added-0804'), false);
  check('parent-hidden event not inherited', tedsPub.events.some((e) => e.id === 'basics-hidden-0803'), false);

  // teds admin marks _inherited
  const adminRes = await tedsAdminFn.onRequestGet({
    request: new Request(ORIGIN + '/api/calendars/teds-nyc/admin', { headers: { cookie } }),
    env,
  });
  check('teds admin -> 200', adminRes.status, 200);
  const admin = await adminRes.json();
  check('admin: inherited marked', admin.events.find((e) => e.id === 'basics-added-0804')._inherited, true);
  check('admin: own events unmarked', '_inherited' in admin.events.find((e) => e.id === 'teds-own-0801'), false);
  check('admin: overlay doc rides along', !!admin.overlay, true);

  // teds hides the inherited event: LOCAL hide — basics keeps it
  check('teds hide inherited -> 200', (await post(tedsOverlayFn, 'teds-nyc', env, { action: 'hide', id: 'basics-added-0804' }, cookie)).status, 200);
  check('teds public: inherited hidden', (await loadComposed(env, ORIGIN, 'teds-nyc')).data.events.some((e) => e.id === 'basics-added-0804'), false);
  check('basics public: still there', (await loadComposed(env, ORIGIN, 'basics-nyc')).data.events.some((e) => e.id === 'basics-added-0804'), true);
  const ownView = (await loadComposed(env, ORIGIN, 'teds-nyc', { includeHidden: true })).data;
  const hid = ownView.events.find((e) => e.id === 'basics-added-0804');
  check('owner view: _hidden + _inherited', [hid._hidden, hid._inherited], [true, true]);
  check('teds unhide inherited -> 200', (await post(tedsOverlayFn, 'teds-nyc', env, { action: 'unhide', id: 'basics-added-0804' }, cookie)).status, 200);

  // teds edits the inherited event locally — basics unaffected
  check('teds edit inherited -> 200', (await post(tedsOverlayFn, 'teds-nyc', env, { action: 'edit', id: 'basics-added-0804', fields: { title: 'Basics Added (Teds Cut)' } }, cookie)).status, 200);
  check('teds public: edit applied', (await loadComposed(env, ORIGIN, 'teds-nyc')).data.events.find((e) => e.id === 'basics-added-0804').title, 'Basics Added (Teds Cut)');
  check('basics public: title unchanged', (await loadComposed(env, ORIGIN, 'basics-nyc')).data.events.find((e) => e.id === 'basics-added-0804').title, 'Basics Added');
  const edView = (await loadComposed(env, ORIGIN, 'teds-nyc', { includeHidden: true })).data.events.find((e) => e.id === 'basics-added-0804');
  check('owner view: _edited + _inherited', [edView._edited, edView._inherited], [true, true]);

  // reset on inherited-and-locally-edited: drops the edit, event REMAINS
  check('teds reset inherited -> 200', (await post(tedsOverlayFn, 'teds-nyc', env, { action: 'reset', id: 'basics-added-0804' }, cookie)).status, 200);
  const afterReset = (await loadComposed(env, ORIGIN, 'teds-nyc')).data.events.find((e) => e.id === 'basics-added-0804');
  check('reset: event remains, inherited title back', afterReset ? afterReset.title : null, 'Basics Added');
  const tedsOv = await loadOverlayFor(env, 'teds-nyc');
  check('reset: teds overlay has no edit/added for it', [tedsOv.edits['basics-added-0804'] ?? null, tedsOv.added['basics-added-0804'] ?? null], [null, null]);

  // edit saved with all-inherited values clears the local edit
  check('teds edit-to-base -> 200', (await post(tedsOverlayFn, 'teds-nyc', env, { action: 'edit', id: 'basics-added-0804', fields: { title: 'Basics Added' } }, cookie)).status, 200);
  check('all-base edit stored as no edit', (await loadOverlayFor(env, 'teds-nyc')).edits['basics-added-0804'] ?? null, null);

  // add id-collision de-dupe considers inherited ids
  const collide = await post(tedsOverlayFn, 'teds-nyc', env, {
    action: 'add',
    event: { id: 'basics-added-0804', title: 'Collider', venue: 'Elsewhere', start: '2026-08-04T21:00:00-04:00' },
  }, cookie);
  check('add colliding with inherited id -> suffixed', (await collide.json()).id, 'basics-added-0804-2');

  // teds can edit an inherited BASE basics event too (the dup id is teds';
  // check the basics-owned one after removing shadow: use basics' dup via
  // its own endpoint instead — teds edit of dup edits TEDS' event)
  check('teds edit dup edits teds copy -> 200', (await post(tedsOverlayFn, 'teds-nyc', env, { action: 'edit', id: 'dup-0802', fields: { title: 'Teds Version 2' } }, cookie)).status, 200);
  check('basics dup untouched', (await loadComposed(env, ORIGIN, 'basics-nyc')).data.events.find((e) => e.id === 'dup-0802').title, 'Basics Version');

  // composed base helper: markInherited only when asked
  const cb = await loadComposedBase(env, ORIGIN, 'teds-nyc');
  check('loadComposedBase: no markers by default', cb.events.some((e) => e._inherited), false);

  // basics itself has no parent: composed === plain merge
  const basicsOwner = (await loadComposed(env, ORIGIN, 'basics-nyc', { includeHidden: true })).data;
  check('basics owner view marks own added', basicsOwner.events.find((e) => e.id === 'basics-added-0804')._added, true);
  check('basics owner view: nothing inherited', basicsOwner.events.some((e) => e._inherited), false);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
