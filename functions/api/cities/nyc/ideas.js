/**
 * GET /api/cities/nyc/ideas?date=YYYY-MM-DD — Event Ideas for one day
 * (issue #13, P0). Curator-only: 401 without a session, 403 for non-owners
 * (same gate as the overlay API).
 *
 * Reads the D1 candidate pool (binding WHEN_EVENTS) filled by the
 * when-ingest Worker. date defaults to today in America/New_York.
 *
 * Response: { ok, date, prev, next, events: […], anyday: […] }
 *   events — candidates starting on `date` with status new|added
 *   anyday — multi-day runs (end 2+ days after start) overlapping `date`
 *   prev/next — nearest dates before/after `date` that have candidates
 *   each event: { id, title, venue, neighborhood, start, end, price, url,
 *                 image, source, source_url, signals: [ids], added: bool }
 *
 * `added` = already on the curator's calendar: the merged calendar
 * (base JSON + KV overlay) is matched by dedupe-style key
 * slug(venue)-YYYYMMDD-slug(title[:24]) or by exact title+date.
 *
 * Storage note: candidates.start/end_at carry the NY offset, so
 * substr(x, 1, 10) is the NY-local date. Never use SQLite date() on them —
 * it shifts offset-suffixed values to UTC.
 */
import { applyOverlay, loadBaseData, loadOverlay } from '../../../_lib/calendar.js';
import { readSession, json, OWNER_EMAIL } from '../../../_lib/session.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors slugify() in functions/api/calendars/teds-nyc/overlay.js. */
function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function nyTodayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
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

function rowToEvent(row, calKeys, calTitleDates) {
  const dateKey = String(row.start).slice(0, 10);
  const added =
    calKeys.has(calendarKey(row.venue, dateKey, row.title)) ||
    calTitleDates.has(String(row.title).trim().toLowerCase() + '|' + dateKey);
  return {
    id: row.id,
    title: row.title,
    venue: row.venue,
    neighborhood: row.neighborhood,
    start: row.start,
    end: row.end_at || '',
    price: row.price,
    url: row.url,
    image: row.image,
    image_source: row.image_source,
    blurb: row.blurb,
    source: row.source,
    source_url: row.source_url,
    signals: parseSignals(row.signals),
    status: row.status,
    added,
  };
}

export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);
  const db = env.WHEN_EVENTS;
  if (!db) return json({ ok: false, error: 'candidate pool unavailable' }, 503);

  const url = new URL(request.url);
  const qDate = url.searchParams.get('date') || '';
  const date = DATE_RE.test(qDate) ? qDate : nyTodayKey();

  // Already-on-calendar detection: merged calendar (base + overlay) keys.
  const calKeys = new Set();
  const calTitleDates = new Set();
  try {
    const [base, overlay] = await Promise.all([
      loadBaseData(env, url.origin),
      loadOverlay(env),
    ]);
    const merged = applyOverlay(base, overlay, { includeHidden: true });
    for (const ev of merged.events || []) {
      if (!ev || !ev.start) continue;
      const k = String(ev.start).slice(0, 10);
      calKeys.add(calendarKey(ev.venue || '', k, ev.title || ''));
      calTitleDates.add(String(ev.title || '').trim().toLowerCase() + '|' + k);
    }
  } catch {
    // Calendar unavailable: ideas still render, just without ✓ detection.
  }

  const [dayRes, anydayRes, prevRes, nextRes] = await db.batch([
    db.prepare(
      "SELECT * FROM candidates WHERE city = 'nyc' AND status IN ('new', 'added') " +
      'AND substr(start, 1, 10) = ? AND ' + SHORT_COND + ' ORDER BY start, title'
    ).bind(date),
    db.prepare(
      "SELECT * FROM candidates WHERE city = 'nyc' AND status IN ('new', 'added') " +
      'AND NOT ' + SHORT_COND + ' AND substr(start, 1, 10) <= ? AND substr(end_at, 1, 10) >= ? ' +
      'ORDER BY substr(end_at, 1, 10), start, title'
    ).bind(date, date),
    db.prepare(
      "SELECT MAX(substr(start, 1, 10)) AS d FROM candidates WHERE city = 'nyc' " +
      "AND status IN ('new', 'added') AND " + SHORT_COND + ' AND substr(start, 1, 10) < ?'
    ).bind(date),
    db.prepare(
      "SELECT MIN(substr(start, 1, 10)) AS d FROM candidates WHERE city = 'nyc' " +
      "AND status IN ('new', 'added') AND " + SHORT_COND + ' AND substr(start, 1, 10) > ?'
    ).bind(date),
  ]);

  const events = (dayRes.results || []).map((r) => rowToEvent(r, calKeys, calTitleDates));
  const anyday = (anydayRes.results || []).map((r) => rowToEvent(r, calKeys, calTitleDates));
  const prev = (prevRes.results && prevRes.results[0] && prevRes.results[0].d) || null;
  const next = (nextRes.results && nextRes.results[0] && nextRes.results[0].d) || null;

  return json(
    { ok: true, date, prev, next, events, anyday },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

/** Any other method (POST, etc.): explicit 405 instead of asset fallback. */
export function onRequest() {
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET' });
}
