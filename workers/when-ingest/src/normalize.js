/**
 * when-ingest — canonical candidate builder + D1 upsert (issue #13, P0).
 *
 * Adapters return "raw" candidates (title/venue/start/… — facts only).
 * This module turns them into canonical rows:
 *   - start/end as ISO 8601 with the America/New_York offset, so
 *     substr(start, 1, 10) is always the NY-local date
 *   - dedupe_key = slug(normVenue) + '-' + YYYYMMDD + '-' + slug(normTitle)
 *     (normTitle/normVenue collapse cross-source spelling: TM vs SeatGeek)
 *   - upsert: an existing dedupe_key merges `signals` (JSON array of source
 *     ids) and keeps the earliest first_seen; new keys insert with
 *     id = dedupe_key, status 'new', city 'nyc'
 *
 * The candidates column for the spec's "end" is end_at ("end" is a SQLite
 * keyword); the ideas API surfaces it as "end" in JSON.
 *
 * category (migration 0006): adapter metadata first (refined — TM/SG have
 * no tours/film/museums buckets, see refineCategory), keyword heuristics as
 * fallback (see categorize.js). Merge only upgrades 'other' — a
 * metadata-derived category is never overwritten by a heuristic guess.
 */
import { validCategory, categoryFromText, refineCategory } from './categorize.js';

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

/**
 * Cross-source title normalization for dedupe (issue #13 follow-up).
 *
 * Ticketmaster and SeatGeek spell the same show differently — TM bills
 * "Fedge | Anjoli Simone | Havan" where SG bills "Fedge with Anjoli Simone,
 * Havantepe (21+)" — and their support-act lists disagree (and truncate), so
 * only the HEADLINER is stable across sources. Rules:
 *   - fold accents, lowercase, "w/" -> "with"
 *   - strip age tags: "(21+)", "18+", "16+ event"
 *   - strip trailing "presented by …" promoter noise
 *   - strip a leading "an evening with " frame (keeps the artist)
 *   - keep the first segment before a support separator: "|", " with ", ","
 *   - strip trailing city-suffix/parenthetical noise (stripTitleNoise)
 *   - strip punctuation, a leading article (the/a/an), collapse whitespace
 * Band names containing "with"/commas split the same way on both sources, so
 * they still self-collapse; false merges would need two different same-day
 * shows at one venue sharing a headliner prefix.
 */
export function normTitle(title) {
  let s = stripTitleNoise(foldTitle(title));
  s = s.split(/\s*\|\s*/)[0];
  s = s.split(/\s+with\s+/)[0];
  s = s.split(/\s*,\s*/)[0];
  s = s
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Shared first pass: fold accents, lowercase, "w/" -> "with", age tags, promoter noise. */
function foldTitle(title) {
  return String(title)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bw\/\s*/g, 'with ')
    .replace(/\(?\b(?:16|18|21)\s*\+\s*(?:event\b)?\)?/g, ' ')
    .replace(/\s+presented by\b.*$/, ' ')
    .replace(/^\s*an evening with\s+/, '');
}

// Trailing venue-city suffixes SeatGeek (and sometimes TM) append to titles:
// "Six the Musical - New York", "Hamilton - New York, NY", "The Moth - Brooklyn".
const CITY_TAIL_RE =
  /\s*[-\u2013\u2014]\s*(?:new york(?:\s*,?\s*ny)?(?:\s+city)?|nyc|ny|brooklyn|manhattan|queens|(?:the\s+)?bronx|staten island|long island)\s*[.!]*\s*$/;
// Trailing parentheticals are location/audience noise, never the show name:
// "(New York, NY)", "(NY)", "(No Children Under 4)", "(18 and Over)".
const PAREN_TAIL_RE = /\s*\([^()]*\)\s*$/;

/**
 * Strip trailing city-suffix / parenthetical noise from a folded title
 * (Ted's rule: "Six (New York, NY)", "Six: The Musical" and "Six the
 * Musical - New York" are one show). Loops because the noise stacks:
 * "Two Strangers (Carry a Cake Across New York) - New York". Returns the
 * pre-strip string when stripping would empty the title.
 */
export function stripTitleNoise(s) {
  let out = String(s);
  for (;;) {
    const next = out.replace(PAREN_TAIL_RE, '').replace(CITY_TAIL_RE, '');
    if (next === out) break;
    if (!next.trim()) return out.trim();
    out = next;
  }
  return out.trim();
}

/** Punctuation/article collapse shared by normTitle and titleSimilarityParts. */
function collapseWords(s) {
  return String(s)
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Connector words ignored for token-set comparison, so "New York Mets vs.
// Los Angeles Dodgers" and "Los Angeles Dodgers at New York Mets" match.
const TOKEN_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'at', 'on', 'vs', 'v', 'and', 'with', 'w',
  'for', 'to', 'by', 'presents', 'featuring', 'feat', 'ft',
]);

/**
 * Precomputed comparison variants for one title (see titlesSimilar):
 *   full   — noise-stripped, collapsed ("moulin rouge the musical")
 *   core   — full minus a ": subtitle" / " - subtitle" tail ('' if none)
 *   head   — headliner via normTitle ('' when it equals full)
 *   tokens — full's words minus connector stopwords
 */
export function titleSimilarityParts(title) {
  const s = stripTitleNoise(foldTitle(title));
  const full = collapseWords(s);
  const core = collapseWords(s.split(/\s+[-\u2013\u2014]\s+|\s*:\s*/)[0]);
  const head = normTitle(title);
  return {
    full,
    core: core && core !== full ? core : '',
    head: head && head !== full ? head : '',
    tokens: full.split(' ').filter((t) => t && !TOKEN_STOPWORDS.has(t)),
  };
}

/**
 * Same-event title check for Ted's "same location at same time" dedupe rule
 * (only ever consulted for rows sharing normVenue + EXACT start). Two titles
 * are the same event when:
 *   1. any variant pair matches exactly — EXCEPT core-vs-core, because two
 *      different events can share a generic colon prefix ("Ongoing Museum
 *      Exhibit: Alice's Garden" vs "Ongoing Museum Exhibit: Still Waters");
 *      a headliner can't play two shows at one venue at the same instant,
 *      so head-based matches are safe at exact-start granularity
 *   2. one full is a word-boundary substring of the other
 *      ("death of salesman" ⊂ "arthur millers death of salesman")
 *   3. one token set (≥2 tokens) is a subset of the other after dropping
 *      connector words ("mets vs dodgers" = "dodgers at mets")
 * Distinct same-slot events (Bethel Woods' four museum tours, Conference
 * House Park's four exhibits) fail all three.
 */
export function titlesSimilar(a, b) {
  const A = typeof a === 'object' && a !== null ? a : titleSimilarityParts(a);
  const B = typeof b === 'object' && b !== null ? b : titleSimilarityParts(b);
  if (!A.full || !B.full) return false;
  const av = [A.full, A.core, A.head];
  const bv = [B.full, B.core, B.head];
  for (let i = 0; i < av.length; i++) {
    for (let j = 0; j < bv.length; j++) {
      if (i === 1 && j === 1) continue; // core-vs-core is ambiguous
      if (av[i] && av[i] === bv[j]) return true;
    }
  }
  const pa = ' ' + A.full + ' ';
  const pb = ' ' + B.full + ' ';
  if (pa.includes(pb) || pb.includes(pa)) return true;
  const [small, big] =
    A.tokens.length <= B.tokens.length ? [A.tokens, B.tokens] : [B.tokens, A.tokens];
  if (small.length >= 2) {
    const bigSet = new Set(big);
    if (small.every((t) => bigSet.has(t))) return true;
  }
  return false;
}

/**
 * Canonical-title preference when two spellings merge: a title still carrying
 * city/parenthetical noise loses to one that doesn't ("Six: The Musical"
 * beats "Six (New York, NY)" and "Six the Musical - New York"); ties keep
 * the existing row's title for stability.
 */
export function preferTitle(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const noisy = (t) => {
    const s = String(t)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
    return stripTitleNoise(s) !== s;
  };
  const ne = noisy(existing);
  return ne !== noisy(incoming) ? (ne ? incoming : existing) : existing;
}

// Venue city-suffix noise: TM says "Ambassador Theatre" AND "Ambassador
// Theatre-NY" while SeatGeek says "Ambassador Theatre - New York" — one
// building, three slot keys unless stripped. Dash/parenthesized city tails
// only: a bare trailing "new york" must survive ("Museum of the City of
// New York" is the venue's name).
const VENUE_CITY_TAIL_RE =
  /(?:\s*[-\u2013\u2014]\s*(?:new york(?:\s*,?\s*ny)?(?:\s+city)?|nyc|ny|brooklyn|manhattan|queens|(?:the\s+)?bronx|staten island)|\s*\(\s*(?:new york(?:\s*,?\s*ny)?|nyc|ny)\s*\))\s*$/;

/**
 * Venue normalization for dedupe: fold accents/punctuation, strip trailing
 * city suffixes, and drop a leading article so TM's "(Le) Poisson Rouge"
 * keys like SG's "Le Poisson Rouge" and "Ambassador Theatre-NY" keys like
 * "Ambassador Theatre - New York". (Watched venues already ingest under a
 * canonical name; this covers the citywide rest.)
 */
export function normVenue(venue) {
  let s = String(venue)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  for (;;) {
    const next = s.replace(VENUE_CITY_TAIL_RE, '');
    if (next === s || !next.trim()) break;
    s = next;
  }
  s = s
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|le|la|el|los)\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * dedupe_key = slug(normVenue)-YYYYMMDD-slug(normTitle[:40])
 *
 * Local DATE only (no hour): TM and SG disagree on start times for the same
 * show (doors vs set, e.g. 19:30 vs 20:00), so hour-bucketing misses real
 * dupes. Same-day different shows still split on title. Caveat: an early and
 * a late show of the SAME headliner on one day collapse to one candidate.
 * Falls back to the legacy raw-title slug when normalization empties the
 * title (e.g. a title that is only an age tag).
 */
export function dedupeKey(venue, startISO, title) {
  const day = String(startISO).slice(0, 10).replace(/-/g, '');
  const t = slugify(normTitle(title)).slice(0, 40) || slugify(String(title).slice(0, 24));
  return slugify(normVenue(venue)) + '-' + day + '-' + t;
}

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max || 600));

/* Coordinate passthrough: finite number or null (adapters already bounds-check). */
const num = (v) => {
  const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

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
    lat: num(raw.lat),
    lon: num(raw.lon),
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
    category: validCategory(raw.category)
      ? refineCategory(validCategory(raw.category), title, venue)
      : categoryFromText(title, venue),
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
  'INSERT INTO candidates (id, city, title, venue, neighborhood, lat, lon, start, end_at, ' +
  'price, url, image, image_source, blurb, blurb_origin, source, source_url, category, ' +
  'signals, dedupe_key, first_seen, fetched_at, status) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  // Last-resort guard: a concurrent run (or an id/dedupe_key mismatch the
  // by-id fallback below did not catch) must never abort the whole source.
  'ON CONFLICT(id) DO NOTHING';

// Merge path: accumulate signals, keep the earliest first_seen, refresh
// fetched_at, and fill previously-blank facts (never overwrite existing ones).
// lat/lon backfill NULLs only (both gated on lat so a pair never mixes rows);
// neighborhood backfills '' — re-ingest after migration 0005 fills old rows.
const MERGE_SQL =
  'UPDATE candidates SET title = ?, signals = ?, fetched_at = ?, ' +
  "end_at = CASE WHEN end_at = '' THEN ? ELSE end_at END, " +
  "price = CASE WHEN price = '' THEN ? ELSE price END, " +
  "url = CASE WHEN url = '' THEN ? ELSE url END, " +
  "image = CASE WHEN image = '' THEN ? ELSE image END, " +
  "image_source = CASE WHEN image = '' THEN ? ELSE image_source END, " +
  "blurb = CASE WHEN blurb = '' THEN ? ELSE blurb END, " +
  "blurb_origin = CASE WHEN blurb = '' THEN ? ELSE blurb_origin END, " +
  "neighborhood = CASE WHEN neighborhood = '' THEN ? ELSE neighborhood END, " +
  'lat = CASE WHEN lat IS NULL THEN ? ELSE lat END, ' +
  'lon = CASE WHEN lat IS NULL THEN ? ELSE lon END, ' +
  "category = CASE WHEN category IS NULL OR category = '' OR category = 'other' THEN ? ELSE category END " +
  'WHERE id = ?';

/**
 * Upsert a batch of canonical candidates into D1.
 * Returns { inserted, merged }.
 */
export async function upsertCandidates(db, candidates) {
  if (!candidates.length) return { inserted: 0, merged: 0 };

  // One read for the whole batch: existing rows keyed by dedupe_key, plus a
  // by-id fallback — legacy rows keep their original id after the dedupe_key
  // formula changes, so a new event's key can equal an old row's id without
  // matching any dedupe_key; that must merge, not insert (PK conflict).
  // byVenueStart backs Ted's rule: same venue + same exact start = same
  // event (titlesSimilar guards the genuinely-different-event exceptions).
  const existing = new Map();
  const byId = new Map();
  const byVenueStart = new Map(); // normVenue|start -> [{row, parts}]
  const slotKey = (venue, start) => normVenue(venue) + '|' + start;
  const addToSlot = (row) => {
    const k = slotKey(row.venue, row.start);
    let list = byVenueStart.get(k);
    if (!list) byVenueStart.set(k, (list = []));
    list.push(row);
  };
  const { results } = await db
    .prepare("SELECT id, dedupe_key, signals, title, venue, start FROM candidates WHERE city = 'nyc'")
    .all();
  for (const row of results || []) {
    existing.set(row.dedupe_key, row);
    byId.set(row.id, row);
    addToSlot(row);
  }
  const findInSlot = (c) => {
    const list = byVenueStart.get(slotKey(c.venue, c.start));
    if (!list) return null;
    const parts = titleSimilarityParts(c.title);
    for (const row of list) {
      if (!row.parts) row.parts = titleSimilarityParts(row.title);
      if (titlesSimilar(parts, row.parts)) return row;
    }
    return null;
  };

  const stmts = [];
  let inserted = 0;
  let merged = 0;
  const seenThisBatch = new Set();
  const pendingById = new Map(); // queued-insert candidates, mutable until flush

  for (const c of candidates) {
    if (seenThisBatch.has(c.dedupe_key)) continue; // intra-batch dupe (same key)
    seenThisBatch.add(c.dedupe_key);
    const prior = existing.get(c.dedupe_key) || byId.get(c.dedupe_key) || findInSlot(c);
    if (prior && pendingById.has(prior.id)) {
      // Same event as a not-yet-flushed insert from this batch: fold the
      // facts into the queued candidate instead of writing a second row.
      const p = pendingById.get(prior.id);
      const signals = parseSignals(p.signals);
      if (!signals.includes(c.source)) signals.push(c.source);
      p.signals = JSON.stringify(signals);
      p.title = prior.title = preferTitle(p.title, c.title);
      prior.parts = null; // recompute against the kept title
      if (!p.end_at) p.end_at = c.end_at;
      if (!p.price) p.price = c.price;
      if (!p.url) p.url = c.url;
      if (!p.image) { p.image = c.image; p.image_source = c.image_source; }
      if (!p.blurb) { p.blurb = c.blurb; p.blurb_origin = c.blurb_origin; }
      if (!p.neighborhood) p.neighborhood = c.neighborhood;
      if (p.lat == null) { p.lat = c.lat; p.lon = c.lon; }
      if (!p.category || p.category === 'other') p.category = c.category;
      existing.set(c.dedupe_key, prior);
      merged++;
    } else if (prior) {
      const signals = parseSignals(prior.signals);
      if (!signals.includes(c.source)) signals.push(c.source);
      const title = preferTitle(prior.title, c.title);
      prior.title = title;
      prior.parts = null;
      stmts.push(
        db.prepare(MERGE_SQL).bind(
          title, JSON.stringify(signals), c.fetched_at,
          c.end_at, c.price, c.url, c.image, c.image_source,
          c.blurb, c.blurb_origin, c.neighborhood,
          c.lat, c.lon, c.category,
          prior.id
        )
      );
      // Later candidates in this batch may carry this row's key spelling.
      existing.set(c.dedupe_key, prior);
      merged++;
    } else {
      pendingById.set(c.id, c);
      addToSlot(c); // c has id/title/venue/start — slot-compatible
      byId.set(c.id, c);
      inserted++;
    }
  }

  for (const c of pendingById.values()) {
    stmts.push(
      db.prepare(INSERT_SQL).bind(
        c.id, c.city, c.title, c.venue, c.neighborhood, c.lat, c.lon,
        c.start, c.end_at,
        c.price, c.url, c.image, c.image_source, c.blurb, c.blurb_origin,
        c.source, c.source_url, c.category, c.signals, c.dedupe_key, c.first_seen,
        c.fetched_at, c.status
      )
    );
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
