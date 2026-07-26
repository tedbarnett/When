/**
 * when-ingest — shared NYC geo helpers (borough + coordinate hygiene).
 *
 * Sources rarely say "borough" outright, but they do return zips, city
 * names, and coordinates. These helpers turn those into the same borough
 * vocabulary nyc-parks already uses in candidates.neighborhood
 * ('Manhattan' | 'Brooklyn' | 'Queens' | 'Bronx' | 'Staten Island') plus
 * NYC-bounds-checked lat/lon for the distance filter on /nyc/ideas.
 *
 * Zip wins over city name: USPS city names are messy for Queens (venues
 * say "Astoria"/"Flushing"/…), while zip prefixes map cleanly.
 */

/* Rough NYC bounding box — anything outside is treated as no-coordinates. */
const LAT_MIN = 40.3;
const LAT_MAX = 41.1;
const LON_MIN = -74.5;
const LON_MAX = -73.4;

/**
 * Parse + validate a coordinate pair. Returns { lat, lon } as finite
 * numbers inside rough NYC bounds, or { lat: null, lon: null }.
 */
export function nycLatLon(latRaw, lonRaw) {
  const lat = typeof latRaw === 'number' ? latRaw : parseFloat(latRaw);
  const lon = typeof lonRaw === 'number' ? lonRaw : parseFloat(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: null, lon: null };
  if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) {
    return { lat: null, lon: null };
  }
  return { lat, lon };
}

/**
 * Borough from a 5-digit NYC zip (prefix convention):
 *   100/101/102 -> Manhattan     103 -> Staten Island   104 -> Bronx
 *   112 -> Brooklyn              111/113/114/116 -> Queens
 *   110 -> Queens ONLY for 11004/11005 (Glen Oaks/Floral Park); the rest
 *   of 110xx is Nassau County, not NYC.
 * Everything else (incl. malformed input) -> ''.
 */
export function boroughFromZip(zip) {
  const z = String(zip == null ? '' : zip).trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return '';
  if (z === '11004' || z === '11005') return 'Queens';
  const p = z.slice(0, 3);
  if (p === '100' || p === '101' || p === '102') return 'Manhattan';
  if (p === '103') return 'Staten Island';
  if (p === '104') return 'Bronx';
  if (p === '112') return 'Brooklyn';
  if (p === '111' || p === '113' || p === '114' || p === '116') return 'Queens';
  return '';
}

/* City-name fallback (APIs put the USPS city here). Queens venues carry
   their neighborhood as the "city" — a few common ones are listed, but the
   zip path above is the reliable one; this is best-effort only. */
const CITY_BOROUGH = {
  'brooklyn': 'Brooklyn',
  'bronx': 'Bronx',
  'the bronx': 'Bronx',
  'staten island': 'Staten Island',
  'new york': 'Manhattan',
  'new york city': 'Manhattan',
  'manhattan': 'Manhattan',
  'queens': 'Queens',
  'long island city': 'Queens',
  'astoria': 'Queens',
  'flushing': 'Queens',
  'jamaica': 'Queens',
  'forest hills': 'Queens',
  'ridgewood': 'Queens',
  'corona': 'Queens',
  'elmhurst': 'Queens',
  'jackson heights': 'Queens',
  'woodside': 'Queens',
  'sunnyside': 'Queens',
  'rockaway park': 'Queens',
  'far rockaway': 'Queens',
  'bayside': 'Queens',
  'college point': 'Queens',
};

/** Borough from a city name ('' when unknown — do not guess). */
export function boroughFromCity(city) {
  const c = String(city == null ? '' : city).trim().toLowerCase();
  return CITY_BOROUGH[c] || '';
}

/** Borough from zip first (reliable), city name as fallback; '' unknown. */
export function boroughFor(zip, city) {
  return boroughFromZip(zip) || boroughFromCity(city);
}
