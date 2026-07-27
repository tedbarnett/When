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
 * slug(venue)-YYYYMMDD-slug(title[:24]) or by exact title+date. `added_on`
 * names the calendar it was found on; `added_id` is the CALENDAR event's
 * id (candidate ids never match calendar ids — overlay writes like
 * action:remove must target added_id). `added_added` marks a match that is
 * a curator-ADDED overlay entry (remove deletes it outright, so undo must
 * re-add); for those, `added_event` carries the add-payload fields needed
 * to re-add the exact same event.
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

function calendarKey(venue, dateKey, title) {
  return slugify(venue) + '-' + dateKey.replace(/-/g, '') + '-' + slugify(String(title).slice(0, 24));
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
  const dateKey = String(row.start).slice(0, 10);
  const key = calendarKey(row.venue, dateKey, row.title);
  const titleDate = String(row.title).trim().toLowerCase() + '|' + dateKey;
  let addedOn = '';
  let match = null;
  for (const m of marks) {
    const hit = m.keys.get(key) || m.titleDates.get(titleDate);
    if (hit) { addedOn = m.cal; match = hit; break; }
  }
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
    added_id: match ? String(match.id || '') : '',
    added_added: !!(match && match._added),
    added_event: match && match._added ? addPayloadOf(match) : null,
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
      // Maps keep the matched CALENDAR event so the client can target overlay
      // writes (remove/unremove) at the calendar id, not the candidate id.
      const m = { cal, keys: new Map(), titleDates: new Map() };
      try {
        const merged = await loadComposed(env, url.origin, cal, { includeHidden: true });
        for (const ev of merged.events || []) {
          if (!ev || !ev.start) continue;
          const k = String(ev.start).slice(0, 10);
          const kk = calendarKey(ev.venue || '', k, ev.title || '');
          const td = String(ev.title || '').trim().toLowerCase() + '|' + k;
          if (!m.keys.has(kk)) m.keys.set(kk, ev);
          if (!m.titleDates.has(td)) m.titleDates.set(td, ev);
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
