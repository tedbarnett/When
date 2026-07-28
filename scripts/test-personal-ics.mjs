// Personal Apple Calendar exports — server + client core, no network.
//
// Ted's ask: besides the curated When calendar, every event needs a small
// "add to YOUR Apple Calendar" action that downloads a one-event .ics.
// This proves, with stubbed KV/ASSETS:
//   1. /api/event.ics (the formatter the owner-gated ideas pages use)
//      escapes ICS text (commas/semicolons in LOCATION), keeps TZID wall
//      time for NYC/Dublin/Reykjavik (never UTC-shifted), emits VTIMEZONE,
//      URL/UID/DTSTAMP, and all-day VALUE=DATE events for date-only starts
//   2. /api/event.ics validates input (missing title / bad start / unknown
//      tz -> 400) and stays a pure echo formatter (no data access)
//   3. when.org/<cal>/{id}.ics serves a public calendar event to ANON users
//      with attachment headers; hidden events 404 for anon but download for
//      the owner; unknown ids 404; the ideas API itself stays 401 anon
//   4. the client personalcal-core block (byte-identical across all 3
//      ideas pages) builds correct download URLs — day-instance dates
//      bucket to the CHOSEN city-local day (incl. the 00:30 midnight edge),
//      single-day rows get a direct <a>, "every day" runs get the picker
//      button, and the picker preselects the day already on the When
//      calendar
//   5. the subscribe affordance still points webcal:// at the existing feed
// Run: node scripts/test-personal-ics.mjs
import { readFileSync } from 'node:fs';
import { onRequest as eventIcs } from '../functions/api/event.ics.js';
import { makeEventPageHandler } from '../functions/_lib/eventPage.js';
import { makeIcsHandler } from '../functions/_lib/ics.js';
import { makeIdeasHandler } from '../functions/_lib/ideasApi.js';
import { createSessionCookie } from '../functions/_lib/session.js';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
// first matching line INSIDE the VEVENT (VTIMEZONE has DTSTART lines too)
const line = (ics, name) => {
  const flat = unfold(ics);
  const ve = flat.slice(flat.indexOf('BEGIN:VEVENT'));
  const m = ve.split('\r\n').find((l) => l.startsWith(name));
  return m || null;
};

/* ================= 1+2. /api/event.ics formatter ================= */

async function fmt(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await eventIcs({ request: new Request('https://when.org/api/event.ics?' + qs) });
  const body = res.status === 200 ? await res.text() : await res.text();
  return { res, body };
}

{
  // escaping: commas + semicolons in venue/neighborhood -> escaped LOCATION
  const { res, body } = await fmt({
    title: 'Trad; Session, Late',
    venue: 'The Cobblestone, Smithfield',
    neighborhood: 'Dublin 7; Northside',
    start: '2026-07-30T20:30:00+01:00',
    end: '2026-07-30T23:00',
    tz: 'Europe/Dublin',
    url: 'https://example.com/trad',
    blurb: 'Nightly, informal; bring an instrument',
    uid: 'nightly-trad-session-20260730',
  });
  check('formatter -> 200', res.status, 200);
  check('Content-Type is text/calendar', res.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  check('Content-Disposition attachment + slug filename',
    res.headers.get('Content-Disposition'), 'attachment; filename="nightly-trad-session-20260730.ics"');
  check('LOCATION escapes commas/semicolons (and appends the city)',
    line(body, 'LOCATION:'),
    'LOCATION:The Cobblestone\\, Smithfield\\, Dublin 7\\; Northside\\, Dublin');
  check('SUMMARY escaped', line(body, 'SUMMARY:'), 'SUMMARY:Trad\\; Session\\, Late');
  check('DTSTART wall time with Dublin TZID (offset ignored, never shifted)',
    line(body, 'DTSTART'), 'DTSTART;TZID=Europe/Dublin:20260730T203000');
  check('DTEND accepts minute-precision input', line(body, 'DTEND'), 'DTEND;TZID=Europe/Dublin:20260730T230000');
  check('VTIMEZONE block present', body.includes('BEGIN:VTIMEZONE') && unfold(body).includes('TZID:Europe/Dublin'), true);
  check('UID stable from uid param', line(body, 'UID:'), 'UID:nightly-trad-session-20260730@when.org');
  check('URL carried', line(body, 'URL:'), 'URL:https://example.com/trad');
  check('DESCRIPTION = blurb + url', line(body, 'DESCRIPTION:'),
    'DESCRIPTION:Nightly\\, informal\\; bring an instrument\\nhttps://example.com/trad');
  check('DTSTAMP present', /^DTSTAMP:\d{8}T\d{6}Z$/.test(line(body, 'DTSTAMP:') || ''), true);
  check('exactly one VEVENT', (body.match(/BEGIN:VEVENT/g) || []).length, 1);
}

{
  // TZID correctness for the other two cities
  const ny = await fmt({ title: 'Jazz', start: '2026-08-01T19:00:00-04:00', tz: 'America/New_York', venue: 'Smalls' });
  check('NYC TZID wall time', line(ny.body, 'DTSTART'), 'DTSTART;TZID=America/New_York:20260801T190000');
  check('NYC default 2h DTEND', line(ny.body, 'DTEND'), 'DTEND;TZID=America/New_York:20260801T210000');
  check('NYC city label in LOCATION', line(ny.body, 'LOCATION:'), 'LOCATION:Smalls\\, New York');
  const rk = await fmt({ title: 'Midnight Sun Run', start: '2026-08-02T00:30:00+00:00', tz: 'Atlantic/Reykjavik' });
  check('Reykjavik 00:30 stays on chosen local date', line(rk.body, 'DTSTART'), 'DTSTART;TZID=Atlantic/Reykjavik:20260802T003000');
}

{
  // all-day: date-only start -> VALUE=DATE with exclusive DTEND
  const one = await fmt({ title: 'Museum Day', start: '2026-08-01', tz: 'Europe/Dublin' });
  check('all-day DTSTART;VALUE=DATE', line(one.body, 'DTSTART'), 'DTSTART;VALUE=DATE:20260801');
  check('all-day DTEND is next day (exclusive)', line(one.body, 'DTEND'), 'DTEND;VALUE=DATE:20260802');
  const run = await fmt({ title: 'Exhibition', start: '2026-08-01', end: '2026-08-03', tz: 'Europe/Dublin' });
  check('all-day run DTEND = last day + 1', line(run.body, 'DTEND'), 'DTEND;VALUE=DATE:20260804');
}

{
  // validation: pure formatter rejects junk, echoes nothing else
  check('missing title -> 400', (await fmt({ start: '2026-08-01' })).res.status, 400);
  check('bad start -> 400', (await fmt({ title: 'x', start: 'tonightish' })).res.status, 400);
  check('unknown tz -> 400', (await fmt({ title: 'x', start: '2026-08-01', tz: 'Mars/Olympus' })).res.status, 400);
  const noscheme = await fmt({ title: 'x', start: '2026-08-01', url: 'javascript:alert(1)' });
  check('non-http url dropped', unfold(noscheme.body).includes('URL:'), false);
}

/* ================= 3. per-event downloads from a real calendar ================= */

const base = {
  calendar: { slug: 'teds-dublin', description: 'Test cal' },
  events: [
    { id: 'whelans-gig-0801', title: 'Single Gig', venue: 'Whelans', neighborhood: 'Portobello', start: '2026-08-01T20:00:00+01:00', url: 'https://example.com/gig', blurb: 'Loud.' },
    { id: 'secret-show-0802', title: 'Secret Show', venue: 'Hush', start: '2026-08-02T21:00:00+01:00' },
  ],
};
const kv = new Map();
kv.set('cal:teds-dublin', JSON.stringify({ hidden: { 'secret-show-0802': true }, edits: {}, added: {}, removed: {} }));
const env = {
  SESSION_SECRET: 'test-secret',
  WHEN_CAL: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
  },
  ASSETS: {
    fetch: async (req) => {
      const url = String(req && req.url ? req.url : req);
      if (url.endsWith('/data/teds-dublin.json')) {
        return new Response(JSON.stringify(base), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('<html><head><title>x</title></head><body></body></html>', { headers: { 'content-type': 'text/html' } });
    },
  },
};
const owner = (await createSessionCookie(env, { email: 'tedbarnett@gmail.com' })).split(';')[0];
const pageHandler = makeEventPageHandler('teds-dublin', { calLabel: 'Ted’s Dublin', tzid: 'Europe/Dublin' });
async function fetchEventIcs(id, cookie) {
  const request = new Request('https://when.org/teds-dublin/' + id + '.ics', { headers: { cookie: cookie || '' } });
  const res = await pageHandler.onRequestGet({ request, env, params: { id: id + '.ics' } });
  return { res, body: res.status === 200 ? await res.text() : '' };
}

{
  const { res, body } = await fetchEventIcs('whelans-gig-0801');
  check('public event .ics anon -> 200', res.status, 200);
  check('anon download headers', [res.headers.get('Content-Type'), res.headers.get('Content-Disposition')],
    ['text/calendar; charset=utf-8', 'attachment; filename="whelans-gig-0801.ics"']);
  check('VEVENT fields from calendar data', [line(body, 'SUMMARY:'), line(body, 'DTSTART'), line(body, 'LOCATION:'), line(body, 'UID:')],
    ['SUMMARY:Single Gig', 'DTSTART;TZID=Europe/Dublin:20260801T200000', 'LOCATION:Whelans\\, Portobello\\, Dublin', 'UID:whelans-gig-0801@when.org']);
  check('DESCRIPTION blurb + url', line(body, 'DESCRIPTION:'), 'DESCRIPTION:Loud.\\nhttps://example.com/gig');
}
check('hidden event .ics anon -> 404', (await fetchEventIcs('secret-show-0802')).res.status, 404);
check('hidden event .ics owner -> 200', (await fetchEventIcs('secret-show-0802', owner)).res.status, 200);
check('unknown id .ics -> 404', (await fetchEventIcs('nope')).res.status, 404);

// the ideas API itself stays owner-only (the formatter never replaces it)
{
  const ideas = makeIdeasHandler('dublin');
  const res = await ideas.onRequestGet({ request: new Request('https://when.org/api/cities/dublin/ideas?date=2026-08-01'), env });
  check('ideas API anon -> 401 (unchanged)', res.status, 401);
}

// feed regression: subscription feed still serves TZID events inline
{
  const icsHandler = makeIcsHandler('teds-dublin', { tzid: 'Europe/Dublin' });
  const res = await icsHandler.onRequest({ request: new Request('https://when.org/teds-dublin.ics'), env });
  const ics = await res.text();
  check('feed still 200 + inline', [res.status, res.headers.get('Content-Disposition')], [200, 'inline; filename="teds-dublin.ics"']);
  check('feed DTSTART unchanged', unfold(ics).includes('DTSTART;TZID=Europe/Dublin:20260801T200000'), true);
  check('feed excludes hidden events', ics.includes('Secret Show'), false);
}

/* ================= 4. client personalcal-core (all 3 ideas pages) ================= */

const PAGES = ['../public/nyc/ideas.html', '../public/dublin/ideas.html', '../public/reykjavik/ideas.html'];
function coreBlock(path, name) {
  const html = readFileSync(new URL(path, import.meta.url), 'utf8');
  const m = html.match(new RegExp('/\\* ' + name + ':start[\\s\\S]*?\\*/([\\s\\S]*?)/\\* ' + name + ':end \\*/'));
  if (!m) throw new Error(name + ' block not found: ' + path);
  return m[1];
}
{
  const blocks = PAGES.map((p) => coreBlock(p, 'personalcal-core'));
  check('personalcal-core identical across all 3 ideas pages', [blocks[0] === blocks[1], blocks[1] === blocks[2]], [true, true]);
}

// wire the extracted block to the real dayinstance-core helpers
const dayBlock = coreBlock('../public/dublin/ideas.html', 'dayinstance-core');
const dayDate = (key) => new Date(key + 'T12:00:00+01:00');
const ddateLabel = (key) => dayDate(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
const makeDayCore = new Function(
  'nyTodayKey', 'dayDate', 'ddateLabel',
  dayBlock + 'return { isMultiDay, dayPickerDates, dayInstanceTimes, dayInstanceId, dayOptionLabel };'
);
const day = makeDayCore(() => '2026-07-27', dayDate, ddateLabel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pcalBlock = coreBlock('../public/dublin/ideas.html', 'personalcal-core');
const makePcal = new Function(
  'PCAL_TZ', 'esc', 'isMultiDay', 'dayPickerDates', 'dayInstanceTimes', 'dayInstanceId', 'dayOptionLabel', 'ddateLabel',
  pcalBlock + 'return { personalIcsUrl, personalCalBtnHtml, pcalDefaultDay, pcalFormHtml };'
);
const pcal = makePcal('Europe/Dublin', esc, day.isMultiDay, day.dayPickerDates, day.dayInstanceTimes, day.dayInstanceId, day.dayOptionLabel, ddateLabel);

const run = {
  id: 'cand-trad', title: 'Nightly Trad Session', venue: 'The Cobblestone', neighborhood: 'Smithfield',
  start: '2026-07-25T20:30:00+01:00', end: '2026-08-20T23:00:00+01:00', source_url: 'https://example.com/trad',
  added_instances: [{ id: 'nightly-trad-session-20260730', date: '2026-07-30', added: true, run: false }],
};
{
  const url = pcal.personalIcsUrl(run, '2026-07-30');
  const q = new URLSearchParams(url.split('?')[1]);
  check('day-instance URL buckets to the chosen day', [q.get('start'), q.get('end')], ['2026-07-30T20:30', '2026-07-30T23:00']);
  check('day-instance uid is date-stamped', q.get('uid'), 'nightly-trad-session-20260730');
  check('tz + source_url fallback carried', [q.get('tz'), q.get('url')], ['Europe/Dublin', 'https://example.com/trad']);

  // full round trip: client URL -> server ICS on the chosen local day
  const rt = await fmt(Object.fromEntries(q));
  check('round trip DTSTART on chosen Dublin day', line(rt.body, 'DTSTART'), 'DTSTART;TZID=Europe/Dublin:20260730T203000');

  // midnight edge: 00:30 session must stay on the chosen date
  const late = { ...run, start: '2026-07-25T00:30:00+01:00', end: '2026-08-20T02:00:00+01:00' };
  const q2 = new URLSearchParams(pcal.personalIcsUrl(late, '2026-08-02').split('?')[1]);
  const rt2 = await fmt(Object.fromEntries(q2));
  check('00:30 instance not UTC-shifted', line(rt2.body, 'DTSTART'), 'DTSTART;TZID=Europe/Dublin:20260802T003000');
}
{
  const single = { id: 'cand-gig', title: 'Single Gig', venue: 'Whelans', start: '2026-08-01T20:00:00+01:00' };
  check('single-day row -> direct <a> download', pcal.personalCalBtnHtml(single, false).startsWith('<a class="ical-btn" href="/api/event.ics?'), true);
  check('every-day run -> picker button', pcal.personalCalBtnHtml(run, true).startsWith('<button class="ical-btn" type="button" data-personalcal='), true);
  check('finished run falls back to direct link',
    pcal.personalCalBtnHtml({ ...run, start: '2026-07-01T20:30:00+01:00', end: '2026-07-20T23:00:00+01:00' }, true).slice(0, 3), '<a ');
  check('picker preselects the day already on the When calendar', pcal.pcalDefaultDay(run, day.dayPickerDates(run)), '2026-07-30');
  check('picker defaults to first day otherwise', pcal.pcalDefaultDay({ ...run, added_instances: [] }, day.dayPickerDates(run)), '2026-07-27');
  const form = pcal.pcalFormHtml(run);
  check('picker marks on-When-calendar days', form.includes('— on When calendar'), true);
  check('picker form downloads (no overlay write)', form.includes('Download for Apple Calendar'), true);
}

/* ================= 5. subscribe affordance on the calendar pages ================= */

for (const [page, cal] of [['../public/teds-nyc.html', 'teds-nyc'], ['../public/teds-dublin.html', 'teds-dublin'], ['../public/teds-reykjavik.html', 'teds-reykjavik'], ['../public/basics-nyc.html', 'basics-nyc']]) {
  const html = readFileSync(new URL(page, import.meta.url), 'utf8');
  check(cal + ': webcal subscribe link + explainer + per-event ics link', [
    html.includes('href="webcal://when.org/' + cal + '.ics">Subscribe in Apple Calendar</a>'),
    html.includes('class="sub-note"'),
    html.includes(`href="/${cal}/' + encodeURIComponent(ev.id) + '.ics">`),
  ], [true, true, true]);
}

process.exit(failures ? 1 : 0);
