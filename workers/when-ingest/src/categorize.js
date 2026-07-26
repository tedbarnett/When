/**
 * when-ingest — deterministic event categorization (no LLM).
 *
 * Small fixed set for the Ideas page filter chips:
 *   theater | live-music | comedy | sports | outdoor | other
 *
 * Precedence (buildCandidate in normalize.js):
 *   1. adapter-supplied raw.category from source metadata — Ticketmaster
 *      classifications (segment/genre), SeatGeek taxonomies/type, NYC Parks
 *      (always outdoor)
 *   2. keyword heuristics on venue/title (categoryFromText) — crawled
 *      jsonld/ics sources carry no taxonomy, and backfills re-derive from
 *      stored facts
 *   3. 'other'
 *
 * The D1 merge path only upgrades category when the stored value is
 * 'other'/'', so a metadata-derived category is never clobbered by a
 * heuristic guess from another source.
 */

export const CATEGORIES = ['theater', 'live-music', 'comedy', 'sports', 'outdoor', 'other'];

/** Clamp any value to a known category ('' when unknown — caller falls back). */
export function validCategory(v) {
  return CATEGORIES.indexOf(v) >= 0 ? v : '';
}

/**
 * Ticketmaster Discovery: ev.classifications[0].segment/genre names.
 * Segments observed: Music, Sports, Arts & Theatre, Film, Miscellaneous.
 * Comedy is a genre under Arts & Theatre (and occasionally Miscellaneous).
 */
export function categoryFromTicketmaster(ev) {
  const cls =
    (Array.isArray(ev && ev.classifications) &&
      ev.classifications.find((c) => c && (c.segment || c.genre))) ||
    null;
  if (!cls) return '';
  const seg = ((cls.segment && cls.segment.name) || '').toLowerCase();
  const genre = ((cls.genre && cls.genre.name) || '').toLowerCase();
  if (genre === 'comedy') return 'comedy';
  if (seg === 'music') return 'live-music';
  if (seg === 'sports') return 'sports';
  if (seg.indexOf('theatre') >= 0 || seg.indexOf('theater') >= 0 || seg === 'arts & theatre') {
    return 'theater';
  }
  return '';
}

/* SeatGeek taxonomy/type buckets. Root taxonomies are sports / concert /
   theater; comedy is a child of theater, so it's checked first. */
const SG_COMEDY = new Set(['comedy']);
const SG_MUSIC = new Set([
  'concert', 'concerts', 'music_festival', 'band', 'classical',
  'classical_orchestral_instrumental', 'classical_vocal', 'jazz', 'folk',
]);
const SG_THEATER = new Set([
  'theater', 'broadway_tickets_national', 'off_broadway', 'cirque_du_soleil',
  'classical_opera', 'ballet', 'dance_performance_tour', 'musical',
]);

/** SeatGeek: ev.taxonomies[].name (root→leaf) + ev.type. */
export function categoryFromSeatgeek(ev) {
  const names = [];
  if (Array.isArray(ev && ev.taxonomies)) {
    for (const t of ev.taxonomies) if (t && t.name) names.push(String(t.name).toLowerCase());
  }
  if (ev && ev.type) names.push(String(ev.type).toLowerCase());
  if (names.some((n) => SG_COMEDY.has(n))) return 'comedy';
  if (names.some((n) => SG_MUSIC.has(n))) return 'live-music';
  if (names.some((n) => SG_THEATER.has(n))) return 'theater';
  if (names.indexOf('sports') >= 0) return 'sports';
  return '';
}

/* Keyword fallback — deliberately conservative; misses land in 'other'.
   Order: comedy, theater, live-music, outdoor (venue names like "Delacorte
   Theater" in a park should stay theater). */
const COMEDY_RE = /\b(comedy|stand[\s-]?up|improv)\b/i;
const THEATER_VENUE_RE = /\b(theat(?:re|er)|playhouse|opera house)\b/i;
const THEATER_TITLE_RE = /\b(the musical|on broadway|a play\b)/i;
const MUSIC_RE = /\b(concert|live music|jazz|orchestra|symphony|philharmonic|music hall|recital|dj set)\b/i;
const OUTDOOR_VENUE_RE =
  /\b(park|parks|garden|gardens|playground|pier|beach|plaza|botanic(?:al)?|greenway|promenade|bandshell|recreation center)\b/i;
// Big indoor arenas whose names would otherwise trip the outdoor rule.
const NOT_OUTDOOR_RE = /\bmadison square garden\b/i;

/**
 * Heuristic fallback from stored facts (title/venue). Used when the source
 * carries no taxonomy (jsonld/ics crawls) and by the category backfill.
 */
export function categoryFromText(title, venue) {
  const t = String(title || '');
  const v = String(venue || '');
  const both = t + ' ' + v;
  if (COMEDY_RE.test(both)) return 'comedy';
  if (THEATER_VENUE_RE.test(v) || THEATER_TITLE_RE.test(t)) return 'theater';
  if (MUSIC_RE.test(both)) return 'live-music';
  if (OUTDOOR_VENUE_RE.test(v) && !NOT_OUTDOOR_RE.test(v)) return 'outdoor';
  return 'other';
}
