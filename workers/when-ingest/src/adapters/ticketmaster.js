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
 */

import { boroughFor, nycLatLon } from '../geo.js';

const API_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
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
  };
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

  const candidates = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      API_URL +
      '?apikey=' + encodeURIComponent(env.TM_API_KEY) +
      '&dmaId=' + NY_DMA_ID +
      '&size=' + PAGE_SIZE +
      '&page=' + page +
      '&sort=date,asc';
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('discovery HTTP ' + res.status);
    const data = await res.json();
    const events = (data._embedded && data._embedded.events) || [];
    for (const ev of events) {
      const raw = mapEvent(ev, helpers);
      if (raw) candidates.push(raw);
    }
    const pageInfo = data.page || {};
    if (events.length < PAGE_SIZE || page + 1 >= (pageInfo.totalPages || 0)) break;
  }
  return { candidates, status: 'ok:' + candidates.length };
}
