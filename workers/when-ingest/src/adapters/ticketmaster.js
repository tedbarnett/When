/**
 * when-ingest adapter — Ticketmaster Discovery API v2 (Tier A: licensed API).
 *
 * GET https://app.ticketmaster.com/discovery/v2/events.json
 *   ?apikey=…&dmaId=345 (New York) &size=…&sort=date,asc
 *
 * Facts + API-licensed images (attribution = linkout to the event's
 * Ticketmaster page, which every candidate carries). Blurbs stay empty —
 * we never copy promoter prose.
 *
 * Requires the TM_API_KEY secret. Without it the adapter SKIPS gracefully:
 * the source stays enabled and its last_status records 'no_key'.
 *
 * Venue watchlist (src/watchlist.js): before the citywide pull, each watched
 * venue gets a dedicated full-horizon events fetch (venueId-scoped, exempt
 * from the citywide page caps); the citywide pull then skips those venue ids
 * so the watched fetch owns their rows under the canonical venue name.
 */

import { boroughFor, nycLatLon } from '../geo.js';
import { WATCHED_VENUES, pickVenue } from '../watchlist.js';
import { slugify } from '../normalize.js';
import { categoryFromTicketmaster } from '../categorize.js';

const API_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
const VENUES_URL = 'https://app.ticketmaster.com/discovery/v2/venues.json';
const NY_DMA_ID = '345';
const PAGE_SIZE = 200;
const MAX_PAGES = 5; // Discovery hard-caps size*(page+1) at 1000 — this is the max reach

/** "$25–60" (min–max), "$25" when min == max. Empty when no price facts. */
function priceLabel(ev) {
  const pr = Array.isArray(ev.priceRanges) && ev.priceRanges[0];
  if (!pr || typeof pr.min !== 'number') return '';
  const fmt = (n) => (n % 1 === 0 ? String(n) : n.toFixed(2));
  if (typeof pr.max === 'number' && pr.max > pr.min) {
    return '$' + fmt(pr.min) + '\u2013' + fmt(pr.max);
  }
  return '$' + fmt(pr.min);
}

/** Largest 16_9 image URL (falls back to the largest image of any ratio). */
function bestImage(ev) {
  const images = Array.isArray(ev.images) ? ev.images : [];
  let best = null;
  for (const img of images) {
    if (!img || !img.url) continue;
    const wide = img.ratio === '16_9';
    if (
      !best ||
      (wide && !best.wide) ||
      (wide === best.wide && (img.width || 0) > best.width)
    ) {
      best = { url: img.url, width: img.width || 0, wide };
    }
  }
  return best ? best.url : '';
}

export function mapEvent(ev, helpers) {
  const dates = (ev.dates && ev.dates.start) || {};
  let start = '';
  if (dates.dateTime) {
    // Absolute UTC instant -> NY-local ISO with offset.
    const d = new Date(dates.dateTime);
    if (!isNaN(d)) start = helpers.nyISOFromDate(d);
  } else if (dates.localDate) {
    start = helpers.nyISOFromLocal(
      dates.localDate + 'T' + (dates.localTime || '00:00').slice(0, 5)
    );
  }
  if (!start) return null;

  const venueObj =
    (ev._embedded && Array.isArray(ev._embedded.venues) && ev._embedded.venues[0]) || {};
  const image = bestImage(ev);

  // Geo facts: venue.location.{latitude,longitude} (strings), NYC-bounds
  // checked; borough from venue.postalCode first, venue.city.name fallback.
  const loc = venueObj.location || {};
  const geo = nycLatLon(loc.latitude, loc.longitude);
  const borough = boroughFor(venueObj.postalCode, venueObj.city && venueObj.city.name);

  return {
    title: ev.name || '',
    venue: venueObj.name || '',
    neighborhood: borough,
    lat: geo.lat,
    lon: geo.lon,
    start,
    end: '',
    price: priceLabel(ev),
    url: ev.url || '',
    source_url: ev.url || '',
    image,
    image_source: image ? 'api_licensed' : '',
    blurb: '',
    blurb_origin: 'none',
    category: categoryFromTicketmaster(ev),
  };
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('discovery HTTP ' + res.status);
  return res.json();
}

/** Resolve a watchlist entry to a Discovery venue id ('' when not found). */
async function resolveWatchedVenueId(entry, apiKey) {
  if (entry.tm.venueId) return entry.tm.venueId;
  const url =
    VENUES_URL +
    '?apikey=' + encodeURIComponent(apiKey) +
    '&keyword=' + encodeURIComponent(entry.tm.keyword) +
    '&stateCode=NY&size=50';
  const data = await fetchJSON(url);
  const hits = ((data._embedded && data._embedded.venues) || []).map((v) => ({
    id: v.id,
    name: v.name || '',
    address: (v.address && v.address.line1) || '',
    city: (v.city && v.city.name) || '',
  }));
  const hit = pickVenue(entry, hits);
  return hit ? hit.id : '';
}

/** All upcoming events for one Discovery venue id (paginated to exhaustion). */
async function fetchVenueEvents(venueId, apiKey, helpers, venueName) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      API_URL +
      '?apikey=' + encodeURIComponent(apiKey) +
      '&venueId=' + encodeURIComponent(venueId) +
      '&size=' + PAGE_SIZE +
      '&page=' + page +
      '&sort=date,asc';
    const data = await fetchJSON(url);
    const events = (data._embedded && data._embedded.events) || [];
    for (const ev of events) {
      const raw = mapEvent(ev, helpers);
      if (raw) {
        raw.venue = venueName; // canonical name so dedupe slugs align across sources
        out.push(raw);
      }
    }
    const pageInfo = data.page || {};
    if (events.length < PAGE_SIZE || page + 1 >= (pageInfo.totalPages || 0)) break;
  }
  return out;
}

/**
 * Venue watchlist pass: dedicated full-horizon fetch per watched venue,
 * exempt from the citywide caps. Per-venue try/catch so a bad lookup never
 * kills the run. Returns candidates, the set of watched Discovery venue ids
 * (so the citywide pull can skip them — the watched fetch owns those shows,
 * under the canonical venue name), and a compact status note.
 */
async function fetchWatchedVenues(env, helpers) {
  const candidates = [];
  const venueIds = new Set();
  const notes = [];
  for (const entry of WATCHED_VENUES) {
    const key = slugify(entry.venue);
    try {
      const venueId = await resolveWatchedVenueId(entry, env.TM_API_KEY);
      if (!venueId) {
        notes.push(key + '=?');
        continue;
      }
      venueIds.add(venueId);
      const events = await fetchVenueEvents(venueId, env.TM_API_KEY, helpers, entry.venue);
      candidates.push(...events);
      notes.push(key + '=' + venueId + ':' + events.length);
    } catch (err) {
      notes.push(key + '=err');
      console.error('ticketmaster watchlist failed', entry.venue, err);
    }
  }
  return { candidates, venueIds, note: notes.join(',') };
}

/**
 * Run the adapter. Without TM_API_KEY: logs + returns status 'no_key' with
 * zero candidates (source stays enabled; not an error).
 * @returns {Promise<{candidates: object[], status: string}>}
 */
export async function run(env, helpers) {
  if (!env.TM_API_KEY) {
    console.log('ticketmaster: TM_API_KEY not set — skipping (last_status=no_key)');
    return { candidates: [], status: 'no_key' };
  }

  // Watchlist first: full forward calendar for watched venues, and the id
  // set the citywide pull uses to skip their events (avoids duplicate rows
  // under Ticketmaster's own venue naming).
  const watch = await fetchWatchedVenues(env, helpers);
  const candidates = [...watch.candidates];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      API_URL +
      '?apikey=' + encodeURIComponent(env.TM_API_KEY) +
      '&dmaId=' + NY_DMA_ID +
      '&size=' + PAGE_SIZE +
      '&page=' + page +
      '&sort=date,asc';
    const data = await fetchJSON(url);
    const events = (data._embedded && data._embedded.events) || [];
    for (const ev of events) {
      const venueObj =
        (ev._embedded && Array.isArray(ev._embedded.venues) && ev._embedded.venues[0]) || {};
      if (venueObj.id && watch.venueIds.has(venueObj.id)) continue; // watched fetch owns it
      const raw = mapEvent(ev, helpers);
      if (raw) candidates.push(raw);
    }
    const pageInfo = data.page || {};
    if (events.length < PAGE_SIZE || page + 1 >= (pageInfo.totalPages || 0)) break;
  }
  const status =
    'ok:' + candidates.length + (watch.note ? ' watch[' + watch.note + ']' : '');
  return { candidates, status };
}
