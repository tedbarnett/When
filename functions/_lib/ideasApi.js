/**
 * Shared Event Ideas API factory (multi-city support).
 *
 * makeIdeasHandler('nyc') -> { onRequestGet, onRequest } serving
 * GET /api/cities/<city>/ideas?date=YYYY-MM-DD — the curator's candidate
 * pool for one day. Curator-only: 401 without a session, 403 for
 * non-owners (same gate as the overlay API).
 *
 * Reads the D1 candidate pool (binding WHEN_EVENTS) scoped by
 * candidates.city. date defaults to today in the CITY's own timezone
 * (CITIES registry in _lib/calendar.js) — a Dublin evening must not be
 * bucketed by a New York clock. Optional ?category=… filters events/anyday
 * server-side (prev/next stay category-agnostic — the client chips filter
 * locally anyway).
 *
 * Response: { ok, date, prev, next, events: […], anyday: […] }
 *   events — candidates starting on `date` with status new|added
 *   anyday — multi-day runs (end 2+ days after start) overlapping `date`
 *   prev/next — nearest dates before/after `date` that have candidates
 *   each event: { id, title, venue, neighborhood, lat, lon, start, end,
 *                 price, url, image, source, source_url, category,
 *                 signals: [ids], added: bool }
 *
 * `added` = already on one of the city's curator calendars (CITIES
 * registry, preferred label first), matched by dedupe-style key
 * slug(venue)+slug(title[:24]) or by exact title, at the candidate's date.
 * Multi-day ("any day") candidates match at ANY date inside their run
 * window, so a single-day instance the curator added for just one night
 * ("Cobblestone trad — Jul 30 only") still marks the idea as on-calendar.
 * `added_on` names the calendar it was found on; `added_id` is the
 * CALENDAR event's id (candidate ids never match calendar ids — overlay
 * writes like action:remove must target added_id). `added_added` marks a
 * match that is a curator-ADDED overlay entry (remove deletes it outright,
 * so undo must re-add); for those, `added_event` carries the add-payload
 * fields needed to re-add the exact same event.
 *
 * `added_instances` lists EVERY matched calendar event (a multi-day
 * candidate can have several coexisting day-instances), each as
 * { id, date, added, run, event }: date = the calendar event's own date,
 * run = the calendar event is itself a 2+ day run (a whole-run copy, not a
 * day-instance), added/event mirror added_added/added_event per instance.
 * Whole-run copies sort first, then instances by date, so added_id keeps
 * its historical meaning for single matches.
 *
 * Storage note: candidates.start/end_at carry the city's local offset, so
 * substr(x, 1, 10) is the city-local date. Never use SQLite date() on
 * them — it shifts offset-suffixed values to UTC.
 *
 * This directory is underscore-prefixed so Pages Functions never routes it.
 */
import { CITIES, loadComposed } from './calendar.js';
import { readSession, json, OWNER_EMAIL } from './session.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors slugify() in functions/_lib/calendarApi.js. */
function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function todayKeyIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function normTitleKey(t) {
  return String(t || '').trim().toLowerCase();
}

/** dateKey + n days (pure string math via UTC noon — no zone drift). */
function plusDays(dateKey, n) {
  const d = new Date(dateKey + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** end 2+ days after start — the same rule as SHORT_COND in SQL. */
function isMultiDayRange(startKey, endKey) {
  return !!endKey && endKey >= plusDays(startKey, 2);
}

function parseSignals(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/* Candidates that belong to a single day (not a 2+ day "any day" run). */
const SHORT_COND =
  "(end_at = '' OR substr(end_at, 1, 10) < date(substr(start, 1, 10), '+2 day'))";

/** Add-payload fields (mirrors calendarApi ADD_RULES) for undo re-add. */
const ADD_FIELDS = ['title', 'venue', 'neighborhood', 'price', 'blurb', 'start', 'end', 'url', 'image'];

function addPayloadOf(calEv) {
  const out = {};
  for (const k of ADD_FIELDS) {
    const v = calEv[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

function rowToEvent(row, marks) {
  const startKey = String(row.start).slice(0, 10);
  const endKey = String(row.end_at || '').slice(0, 10);
  const multi = isMultiDayRange(startKey, endKey);
  const vt = slugify(row.venue) + '|' + slugify(String(row.title).slice(0, 24));
  const tt = normTitleKey(row.title);
  let addedOn = '';
  let instances = [];
  for (const m of marks) {
    // Union of venue+title and exact-title matches; a single-day candidate
    // matches only at its own date, a multi-day run at any date inside
    // [startKey, endKey] (day-instances the curator added for one night).
    const found = new Map(); // calendar event id -> { ev, date }
    for (const dateMap of [m.byVenueTitle.get(vt), m.byTitle.get(tt)]) {
      if (!dateMap) continue;
      for (const [d, ev] of dateMap) {
        if (multi ? d >= startKey && d <= endKey : d === startKey) {
          if (!found.has(ev.id)) found.set(ev.id, { ev, date: d });
        }
      }
    }
    if (found.size) {
      addedOn = m.cal;
      instances = [...found.values()]
        .map(({ ev, date }) => ({
          id: String(ev.id || ''),
          date,
          added: !!ev._added,
          run: isMultiDayRange(String(ev.start).slice(0, 10), String(ev.end || '').slice(0, 10)),
          event: ev._added ? addPayloadOf(ev) : null,
        }))
        .sort((a, b) =>
          (b.run ? 1 : 0) - (a.run ? 1 : 0) ||
          (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      break;
    }
  }
  const first = instances.length ? instances[0] : null;
  return {
    id: row.id,
    title: row.title,
    venue: row.venue,
    neighborhood: row.neighborhood,
    lat: typeof row.lat === 'number' ? row.lat : null,
    lon: typeof row.lon === 'number' ? row.lon : null,
    start: row.start,
    end: row.end_at || '',
    price: row.price,
    url: row.url,
    image: row.image,
    image_source: row.image_source,
    blurb: row.blurb,
    source: row.source,
    source_url: row.source_url,
    category: row.category || 'other',
    signals: parseSignals(row.signals),
    status: row.status,
    added: !!addedOn,
    added_on: addedOn,
    added_id: first ? first.id : '',
    added_added: !!(first && first.added),
    added_event: first && first.added ? first.event : null,
    added_instances: instances,
  };
}

export function makeIdeasHandler(city) {
  const cityEntry = CITIES[city] || {};
  const timeZone = cityEntry.timeZone || 'America/New_York';
  const calendars = cityEntry.calendars || [];

  async function onRequestGet({ request, env }) {
    const session = await readSession(request, env);
    if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
    if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);
    const db = env.WHEN_EVENTS;
    if (!db) return json({ ok: false, error: 'candidate pool unavailable' }, 503);

    const url = new URL(request.url);
    const qDate = url.searchParams.get('date') || '';
    const date = DATE_RE.test(qDate) ? qDate : todayKeyIn(timeZone);
    const qCat = url.searchParams.get('category') || '';
    const catOk = (ev) => !qCat || ev.category === qCat;

    // Already-on-calendar detection against the city's curator calendars
    // (preferred label first — base layers before the calendars composing them).
    const marks = [];
    for (const cal of calendars) {
      // Nested maps (identity key -> date -> CALENDAR event) so single-day
      // candidates look up their exact date and multi-day runs can scan
      // their whole window; the matched event rides along so the client can
      // target overlay writes at the calendar id, not the candidate id.
      const m = { cal, byVenueTitle: new Map(), byTitle: new Map() };
      try {
        const merged = await loadComposed(env, url.origin, cal, { includeHidden: true });
        for (const ev of merged.events || []) {
          if (!ev || !ev.start) continue;
          const d = String(ev.start).slice(0, 10);
          const vt = slugify(ev.venue || '') + '|' + slugify(String(ev.title || '').slice(0, 24));
          const tt = normTitleKey(ev.title);
          let bv = m.byVenueTitle.get(vt);
          if (!bv) { bv = new Map(); m.byVenueTitle.set(vt, bv); }
          if (!bv.has(d)) bv.set(d, ev);
          let bt = m.byTitle.get(tt);
          if (!bt) { bt = new Map(); m.byTitle.set(tt, bt); }
          if (!bt.has(d)) bt.set(d, ev);
        }
      } catch {
        // Calendar unavailable: ideas still render, just without ✓ detection.
      }
      marks.push(m);
    }

    const [dayRes, anydayRes, prevRes, nextRes] = await db.batch([
      db.prepare(
        "SELECT * FROM candidates WHERE city = ? AND status IN ('new', 'added') " +
        'AND substr(start, 1, 10) = ? AND ' + SHORT_COND + ' ORDER BY start, title'
      ).bind(city, date),
      db.prepare(
        "SELECT * FROM candidates WHERE city = ? AND status IN ('new', 'added') " +
        'AND NOT ' + SHORT_COND + ' AND substr(start, 1, 10) <= ? AND substr(end_at, 1, 10) >= ? ' +
        'ORDER BY substr(end_at, 1, 10), start, title'
      ).bind(city, date, date),
      db.prepare(
        'SELECT MAX(substr(start, 1, 10)) AS d FROM candidates WHERE city = ? ' +
        "AND status IN ('new', 'added') AND " + SHORT_COND + ' AND substr(start, 1, 10) < ?'
      ).bind(city, date),
      db.prepare(
        'SELECT MIN(substr(start, 1, 10)) AS d FROM candidates WHERE city = ? ' +
        "AND status IN ('new', 'added') AND " + SHORT_COND + ' AND substr(start, 1, 10) > ?'
      ).bind(city, date),
    ]);

    const events = (dayRes.results || []).map((r) => rowToEvent(r, marks)).filter(catOk);
    const anyday = (anydayRes.results || []).map((r) => rowToEvent(r, marks)).filter(catOk);
    const prev = (prevRes.results && prevRes.results[0] && prevRes.results[0].d) || null;
    const next = (nextRes.results && nextRes.results[0] && nextRes.results[0].d) || null;

    return json(
      { ok: true, date, prev, next, events, anyday },
      200,
      { 'Cache-Control': 'no-store' }
    );
  }

  /** Any other method (POST, etc.): explicit 405 instead of asset fallback. */
  function onRequest() {
    return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET' });
  }

  return { onRequestGet, onRequest };
}
