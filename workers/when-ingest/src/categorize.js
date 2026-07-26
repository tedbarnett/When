/**
 * when-ingest — deterministic event categorization (no LLM).
 *
 * Small fixed set for the Ideas page filter chips:
 *   theater | live-music | comedy | sports | outdoor | tours | film |
 *   museums | other
 *
 * Precedence (buildCandidate in normalize.js):
 *   1. adapter-supplied raw.category from source metadata — Ticketmaster
 *      classifications (segment/genre), SeatGeek taxonomies/type, NYC Parks
 *      (outdoor)
 *   2. refineCategory — a metadata guess can still be WRONG for the
 *      tours/film/museums split, because TM/SG have no such buckets: TM
 *      files museum exhibitions under Arts & Theatre ("The Museum At Bethel
 *      Woods: Story of 60s & Woodstock" → theater), venue tours under Music
 *      or Sports ("Radio City Music Hall Tour Experience" → Music segment,
 *      "Classic Tour at Yankee Stadium" → Sports), and Parks hosts museum
 *      exhibits, guided tours, and movie nights that shouldn't sit in
 *      outdoor. Only narrow title patterns override metadata — a concert
 *      billed "World Tour"/"Farewell Tour" must stay live-music, and a
 *      play produced by a "Stage & Film" festival must stay theater.
 *   3. keyword heuristics on venue/title (categoryFromText) — crawled
 *      jsonld/ics sources carry no taxonomy, and backfills re-derive from
 *      stored facts
 *   4. 'other'
 *
 * The D1 merge path only upgrades category when the stored value is
 * 'other'/'', so a metadata-derived category is never clobbered by a
 * heuristic guess from another source.
 */

export const CATEGORIES = [
  'theater', 'live-music', 'comedy', 'sports', 'outdoor',
  'tours', 'film', 'museums', 'other',
];

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
  if (genre.indexOf('museum') >= 0) return 'museums'; // e.g. Miscellaneous/Museum
  if (seg === 'music') return 'live-music';
  if (seg === 'sports') return 'sports';
  if (seg === 'film') return 'film';
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
const SG_FILM = new Set(['film', 'movies', 'cinema', 'film_festival', 'screening']);
const SG_MUSEUM = new Set(['museum', 'museums', 'exhibition', 'exhibitions']);

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
  if (names.some((n) => SG_FILM.has(n))) return 'film';
  if (names.some((n) => SG_MUSEUM.has(n))) return 'museums';
  return '';
}

/* Keyword fallback — deliberately conservative; misses land in 'other'.
   Order: comedy, tours, theater, live-music, film, museums, outdoor (venue
   names like "Delacorte Theater" in a park should stay theater; tours
   before music so "Radio City Music Hall Tour Experience" doesn't trip the
   "music hall" rule; film before museums so "Monday Movie Day" at the
   Banksy Museum reads as a screening). */
const COMEDY_RE = /\b(comedy|stand[\s-]?up|improv)\b/i;
const THEATER_VENUE_RE = /\b(theat(?:re|er)|playhouse|opera house)\b/i;
const THEATER_TITLE_RE = /\b(the musical|on broadway|a play\b)/i;
const MUSIC_RE = /\b(concert|live music|jazz|orchestra|symphony|philharmonic|music hall|recital|dj set)\b/i;
const OUTDOOR_VENUE_RE =
  /\b(park|parks|garden|gardens|playground|pier|beach|plaza|botanic(?:al)?|greenway|promenade|bandshell|recreation center)\b/i;
// Big indoor arenas whose names would otherwise trip the outdoor rule.
const NOT_OUTDOOR_RE = /\bmadison square garden\b/i;

/* --- tours / film / museums keyword rules (Ted's three new chips) ---

   The trap: concert titles carry "Tour" ("Bon Jovi: Forever Tour", "Guns N'
   Roses: World Tour 2026"), so a bare \btour\b keyword is forbidden. Tours
   only classify on:
     a. STRONG_TOURS_RE — phrases that only appear on actual guided-tour
        events ("walking tour", "docent", "tour experience", "Classic Tour
        at Yankee Stadium", "Barclays Center Tours"). These are trusted
        enough to override a wrong metadata segment (Radio City's tour is
        TM segment Music; Yankee Stadium's is Sports).
     b. a \btour\b title at a museum/gallery venue (Bethel Woods' "Adults
        Only Tour", "20th Anniversary Tour: Building Bethel Woods") —
        museums don't host touring rock acts.
     c. any \btour\b title on a metadata-outdoor (nyc-parks) event via
        refineCategory ("Hart Island Tour") — parks don't either. */
const STRONG_TOURS_RE =
  /\b(?:walking tours?|guided tours?|docent|behind[\s-]the[\s-]scenes tours?|site tours?|tours? experience|gallery tours?|museum tours?|studio tours?|backstage tours?|stadium tours?|ballpark tours?|mansion tours?|boat tours?|harbor tours?|food tours?|transit walk|tours? at\b|(?:center|arena|hall|garden) tours?)\b/i;
const TOUR_WORD_RE = /\btours?\b/i;
// Screenings. "films?" deliberately doesn't match "Filmmaker" — a Q&A "with
// Filmmaker X" at Film Forum classifies on the venue instead.
const FILM_TITLE_RE = /\b(films?|movies?|screenings?|cinema|documentar(?:y|ies))\b/i;
const FILM_VENUE_RE = /\b(cinema|film|ifc center|angelika|metrograph|nitehawk|drafthouse|movie)\b/i;
const MUSEUM_TITLE_RE = /\b(museums?|exhibits?|exhibitions?|galler(?:y|ies))\b/i;
const MUSEUM_VENUE_RE = /\b(museums?|galler(?:y|ies))\b/i;

/**
 * Second-pass refinement of a metadata-derived category (see header).
 * Conservative by design: music/sports/comedy metadata is only ever
 * overridden by STRONG_TOURS_RE; theater additionally yields to museum
 * words in the TITLE (TM files museum exhibitions under Arts & Theatre) —
 * but never to film words ("TRIP AROUND THE SUN | Stage & Film Summer
 * Season" is a play); outdoor (nyc-parks) yields to museum exhibits,
 * guided tours, and movie nights hosted in parks.
 */
export function refineCategory(cat, title, venue) {
  const t = String(title || '');
  if (STRONG_TOURS_RE.test(t)) return 'tours';
  if (cat === 'theater') {
    if (MUSEUM_TITLE_RE.test(t)) return 'museums';
    return 'theater';
  }
  if (cat === 'outdoor') {
    if (MUSEUM_TITLE_RE.test(t)) return 'museums';
    if (TOUR_WORD_RE.test(t)) return 'tours';
    if (FILM_TITLE_RE.test(t)) return 'film';
    return 'outdoor';
  }
  return cat;
}

/**
 * Heuristic fallback from stored facts (title/venue). Used when the source
 * carries no taxonomy (jsonld/ics crawls) and by the category backfill.
 */
export function categoryFromText(title, venue) {
  const t = String(title || '');
  const v = String(venue || '');
  const both = t + ' ' + v;
  if (COMEDY_RE.test(both)) return 'comedy';
  if (STRONG_TOURS_RE.test(t)) return 'tours';
  if (MUSEUM_VENUE_RE.test(v) && TOUR_WORD_RE.test(t)) return 'tours';
  if (THEATER_VENUE_RE.test(v) || THEATER_TITLE_RE.test(t)) return 'theater';
  if (MUSIC_RE.test(both)) return 'live-music';
  if (FILM_TITLE_RE.test(t) || FILM_VENUE_RE.test(v)) return 'film';
  if (MUSEUM_TITLE_RE.test(t) || MUSEUM_VENUE_RE.test(v)) return 'museums';
  if (OUTDOOR_VENUE_RE.test(v) && !NOT_OUTDOOR_RE.test(v)) return 'outdoor';
  return 'other';
}
