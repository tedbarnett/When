/**
 * when-ingest — canonical candidate builder + D1 upsert (issue #13, P0).
 *
 * Adapters return "raw" candidates (title/venue/start/… — facts only).
 * This module turns them into canonical rows:
 *   - start/end as ISO 8601 with the America/New_York offset, so
 *     substr(start, 1, 10) is always the NY-local date
 *   - dedupe_key = slug(venue) + '-' + YYYYMMDD + '-' + slug(title[:24])
 *     (slug mirrors overlay.js slugify)
 *   - upsert: an existing dedupe_key merges `signals` (JSON array of source
 *     ids) and keeps the earliest first_seen; new keys insert with
 *     id = dedupe_key, status 'new', city 'nyc'
 *
 * The candidates column for the spec's "end" is end_at ("end" is a SQLite
 * keyword); the ideas API surfaces it as "end" in JSON.
 */

/** Mirrors slugify() in functions/api/calendars/teds-nyc/overlay.js. */
export function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // fold accents
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** YYYY-MM-DD for "now" in America/New_York. */
export function nyTodayKey(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now || new Date());
}

/** NY UTC offset ("-04:00"/"-05:00") in effect at the given Date. */
export function nyOffsetAt(date) {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'longOffset',
    }).format(date);
    const m = s.match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (m) return m[1] + ':' + (m[2] || '00');
  } catch {}
  return '-05:00';
}

/**
 * NY-local ISO string for a wall-clock datetime already expressed in NY time
 * ("2026-07-26T19:30" or "2026-07-26T19:30:00") — appends the DST-correct
 * offset. Mirrors nyOffsetFor() in public/teds-nyc.html.
 */
export function nyISOFromLocal(dtLocal) {
  const base = dtLocal.length === 16 ? dtLocal + ':00' : dtLocal.slice(0, 19);
  // Approximate the instant to pick the right offset (DST edges only shift
  // the guess by an hour, which never crosses an offset change for events).
  const guess = new Date(base + 'Z');
  const offset = nyOffsetAt(guess);
  return base + offset;
}

/** NY-local ISO string ("2026-07-26T19:30:00-04:00") for an absolute Date. */
export function nyISOFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour; // some ICU builds emit 24:00
  return (
    p.year + '-' + p.month + '-' + p.day +
    'T' + hour + ':' + p.minute + ':' + p.second + nyOffsetAt(date)
  );
}

/** dedupe_key = slug(venue)-YYYYMMDD-slug(title[:24]) */
export function dedupeKey(venue, startISO, title) {
  const day = String(startISO).slice(0, 10).replace(/-/g, '');
  return slugify(venue) + '-' + day + '-' + slugify(String(title).slice(0, 24));
}

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max || 600));

/**
 * Build a canonical candidate row from an adapter's raw candidate.
 * Returns null when the raw facts are too thin to be useful.
 */
export function buildCandidate(raw, sourceId, now) {
  const title = str(raw.title, 200);
  const start = str(raw.start, 40);
  if (!title || !/^\d{4}-\d{2}-\d{2}T/.test(start)) return null;
  // Cancelled events are noise, not ideas (NYC Parks prefixes titles with
  // "CANCELED:"; covers both spellings and separator styles).
  if (/^\s*cancell?ed\b/i.test(title)) return null;
  const venue = str(raw.venue, 200);
  const key = dedupeKey(venue, start, title);
  const iso = (now || new Date()).toISOString();
  return {
    id: key,
    city: 'nyc',
    title,
    venue,
    neighborhood: str(raw.neighborhood, 120),
    start,
    end_at: str(raw.end, 40),
    price: str(raw.price, 60),
    url: str(raw.url, 600),
    image: str(raw.image, 600),
    image_source: str(raw.image_source, 40),
    blurb: str(raw.blurb, 600),
    blurb_origin: str(raw.blurb_origin, 20) || 'none',
    source: sourceId,
    source_url: str(raw.source_url, 600) || str(raw.url, 600),
    signals: JSON.stringify([sourceId]),
    dedupe_key: key,
    first_seen: iso,
    fetched_at: iso,
    status: 'new',
  };
}

function parseSignals(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const INSERT_SQL =
  'INSERT INTO candidates (id, city, title, venue, neighborhood, start, end_at, ' +
  'price, url, image, image_source, blurb, blurb_origin, source, source_url, ' +
  'signals, dedupe_key, first_seen, fetched_at, status) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

// Merge path: accumulate signals, keep the earliest first_seen, refresh
// fetched_at, and fill previously-blank facts (never overwrite existing ones).
const MERGE_SQL =
  'UPDATE candidates SET signals = ?, fetched_at = ?, ' +
  "end_at = CASE WHEN end_at = '' THEN ? ELSE end_at END, " +
  "price = CASE WHEN price = '' THEN ? ELSE price END, " +
  "url = CASE WHEN url = '' THEN ? ELSE url END, " +
  "image = CASE WHEN image = '' THEN ? ELSE image END, " +
  "image_source = CASE WHEN image = '' THEN ? ELSE image_source END, " +
  "neighborhood = CASE WHEN neighborhood = '' THEN ? ELSE neighborhood END " +
  'WHERE id = ?';

/**
 * Upsert a batch of canonical candidates into D1.
 * Returns { inserted, merged }.
 */
export async function upsertCandidates(db, candidates) {
  if (!candidates.length) return { inserted: 0, merged: 0 };

  // One read for the whole batch: existing rows keyed by dedupe_key.
  const existing = new Map();
  const { results } = await db
    .prepare("SELECT id, dedupe_key, signals FROM candidates WHERE city = 'nyc'")
    .all();
  for (const row of results || []) existing.set(row.dedupe_key, row);

  const stmts = [];
  let inserted = 0;
  let merged = 0;
  const seenThisBatch = new Set();

  for (const c of candidates) {
    if (seenThisBatch.has(c.dedupe_key)) continue; // intra-batch dupe
    seenThisBatch.add(c.dedupe_key);
    const prior = existing.get(c.dedupe_key);
    if (prior) {
      const signals = parseSignals(prior.signals);
      if (!signals.includes(c.source)) signals.push(c.source);
      stmts.push(
        db.prepare(MERGE_SQL).bind(
          JSON.stringify(signals), c.fetched_at,
          c.end_at, c.price, c.url, c.image, c.image_source, c.neighborhood,
          prior.id
        )
      );
      merged++;
    } else {
      stmts.push(
        db.prepare(INSERT_SQL).bind(
          c.id, c.city, c.title, c.venue, c.neighborhood, c.start, c.end_at,
          c.price, c.url, c.image, c.image_source, c.blurb, c.blurb_origin,
          c.source, c.source_url, c.signals, c.dedupe_key, c.first_seen,
          c.fetched_at, c.status
        )
      );
      inserted++;
    }
  }

  // D1 batch is transactional and one round trip per chunk.
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100));
  }
  return { inserted, merged };
}

/**
 * Expiry pass: candidates whose start date (NY-local, = first 10 chars of the
 * stored ISO string) is before today flip from 'new' to 'expired'.
 * substr() and not date(): SQLite's date() shifts offset-suffixed values to UTC.
 */
export async function expirePast(db, now) {
  const today = nyTodayKey(now);
  const res = await db
    .prepare("UPDATE candidates SET status = 'expired' WHERE substr(start, 1, 10) < ? AND status = 'new'")
    .bind(today)
    .run();
  return (res && res.meta && res.meta.changes) || 0;
}
