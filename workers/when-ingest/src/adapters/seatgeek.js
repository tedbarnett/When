/**
 * when-ingest adapter — SeatGeek Platform API (Tier A: licensed API).
 *
 * GET https://api.seatgeek.com/2/events
 *   ?client_id=…&lat=40.73&lon=-73.99&range=15mi&per_page=…&sort=datetime_local.asc
 *
 * Lat/lon + range instead of venue.city so Brooklyn/Queens/Bronx venues are
 * covered (venue.city=New York would miss them). Facts + API-licensed
 * performer images; linkout to the SeatGeek event page. Blurbs stay empty —
 * we never copy promoter prose. Prices are resale "from" floors: "$25+".
 *
 * Requires the SEATGEEK_CLIENT_ID secret. Without it the adapter SKIPS
 * gracefully: the source stays enabled and last_status records 'no_key'.
 *
 * Venue watchlist (src/watchlist.js): before the citywide pull, each watched
 * venue gets a dedicated full-horizon events fetch (venue.id-scoped, exempt
 * from the citywide page caps); the citywide pull then skips those venue ids
 * so the watched fetch owns their rows under the canonical venue name.
 */

import { boroughFor, nycLatLon } from '../geo.js';
import { WATCHED_VENUES, pickVenue } from '../watchlist.js';
import { slugify } from '../normalize.js';
import { categoryFromSeatgeek } from '../categorize.js';

const API_URL = 'https://api.seatgeek.com/2/events';
const VENUES_URL = 'https://api.seatgeek.com/2/venues';
const NYC_LAT = '40.7318';
const NYC_LON = '-74.0035';
const RANGE = '15mi';
const PAGE_SIZE = 100; // SeatGeek silently caps per_page at 100
const MAX_PAGES = 10; // 1000/run — pushes the citywide horizon out ~2-3 weeks

export function mapEvent(ev, helpers) {
  const dtLocal = typeof ev.datetime_local === 'string' ? ev.datetime_local : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dtLocal)) return null;
  const start = helpers.nyISOFromLocal(dtLocal.slice(0, 16));
  if (!start) return null;

  const venue = ev.venue || {};
  const stats = ev.stats || {};
  const performer = (Array.isArray(ev.performers) && ev.performers[0]) || {};
  const image = performer.image || '';
  const low = stats.lowest_price;

  // Geo facts: venue.location.{lat,lon} (numbers), NYC-bounds checked;
  // borough from venue.postal_code first, venue.city fallback.
  const loc = venue.location || {};
  const geo = nycLatLon(loc.lat, loc.lon);
  const borough = boroughFor(venue.postal_code, venue.city);

  return {
    title: ev.title || ev.short_title || '',
    venue: venue.name || '',
    neighborhood: borough,
    lat: geo.lat,
    lon: geo.lon,
    start,
    end: '',
    price: typeof low === 'number' && low > 0 ? '$' + low + '+' : '',
    url: ev.url || '',
    source_url: ev.url || '',
    image,
    image_source: image ? 'api_licensed' : '',
    blurb: '',
    blurb_origin: 'none',
    category: categoryFromSeatgeek(ev),
  };
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('seatgeek HTTP ' + res.status);
  return res.json();
}

/** Resolve a watchlist entry to a SeatGeek venue id (0 when not found). */
async function resolveWatchedVenueId(entry, clientId) {
  if (entry.seatgeek.venueId) return entry.seatgeek.venueId;
  const url =
    VENUES_URL +
    '?client_id=' + encodeURIComponent(clientId) +
    '&q=' + encodeURIComponent(entry.seatgeek.query) +
    '&state=NY&per_page=25';
  const data = await fetchJSON(url);
  const hits = (Array.isArray(data.venues) ? data.venues : []).map((v) => ({
    id: v.id,
    name: v.name || '',
    address: v.address || '',
    city: v.city || '',
  }));
  const hit = pickVenue(entry, hits);
  return hit ? hit.id : 0;
}

/** All upcoming events for one SeatGeek venue id (paginated to exhaustion). */
async function fetchVenueEvents(venueId, clientId, helpers, venueName) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      API_URL +
      '?client_id=' + encodeURIComponent(clientId) +
      '&venue.id=' + encodeURIComponent(venueId) +
      '&per_page=' + PAGE_SIZE +
      '&page=' + page +
      '&sort=datetime_local.asc';
    const data = await fetchJSON(url);
    const events = Array.isArray(data.events) ? data.events : [];
    for (const ev of events) {
      const raw = mapEvent(ev, helpers);
      if (raw) {
        raw.venue = venueName; // canonical name so dedupe slugs align across sources
        out.push(raw);
      }
    }
    const total = (data.meta && data.meta.total) || 0;
    if (events.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
  }
  return out;
}

/**
 * Venue watchlist pass: dedicated full-horizon fetch per watched venue,
 * exempt from the citywide caps. Per-venue try/catch so a bad lookup never
 * kills the run. Returns candidates, the set of watched venue ids (so the
 * citywide pull can skip them — the watched fetch owns those shows, under
 * the canonical venue name), and a compact status note.
 */
async function fetchWatchedVenues(env, helpers) {
  const candidates = [];
  const venueIds = new Set();
  const notes = [];
  for (const entry of WATCHED_VENUES) {
    const key = slugify(entry.venue);
    try {
      const venueId = await resolveWatchedVenueId(entry, env.SEATGEEK_CLIENT_ID);
      if (!venueId) {
        notes.push(key + '=?');
        continue;
      }
      venueIds.add(venueId);
      const events = await fetchVenueEvents(venueId, env.SEATGEEK_CLIENT_ID, helpers, entry.venue);
      candidates.push(...events);
      notes.push(key + '=' + venueId + ':' + events.length);
    } catch (err) {
      notes.push(key + '=err');
      console.error('seatgeek watchlist failed', entry.venue, err);
    }
  }
  return { candidates, venueIds, note: notes.join(',') };
}

/**
 * Run the adapter. Without SEATGEEK_CLIENT_ID: logs + returns status 'no_key'
 * with zero candidates (source stays enabled; not an error).
 * @returns {Promise<{candidates: object[], status: string}>}
 */
export async function run(env, helpers) {
  if (!env.SEATGEEK_CLIENT_ID) {
    console.log('seatgeek: SEATGEEK_CLIENT_ID not set — skipping (last_status=no_key)');
    return { candidates: [], status: 'no_key' };
  }

  // Watchlist first: full forward calendar for watched venues, and the id
  // set the citywide pull uses to skip their events (avoids duplicate rows).
  const watch = await fetchWatchedVenues(env, helpers);
  const candidates = [...watch.candidates];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      API_URL +
      '?client_id=' + encodeURIComponent(env.SEATGEEK_CLIENT_ID) +
      '&lat=' + NYC_LAT + '&lon=' + NYC_LON + '&range=' + RANGE +
      '&per_page=' + PAGE_SIZE +
      '&page=' + page +
      '&sort=datetime_local.asc';
    const data = await fetchJSON(url);
    const events = Array.isArray(data.events) ? data.events : [];
    for (const ev of events) {
      if (ev.venue && ev.venue.id && watch.venueIds.has(ev.venue.id)) continue; // watched fetch owns it
      const raw = mapEvent(ev, helpers);
      if (raw) candidates.push(raw);
    }
    const total = (data.meta && data.meta.total) || 0;
    if (events.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
  }
  const status =
    'ok:' + candidates.length + (watch.note ? ' watch[' + watch.note + ']' : '');
  return { candidates, status };
}
