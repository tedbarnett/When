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
 */

const API_URL = 'https://api.seatgeek.com/2/events';
const NYC_LAT = '40.7318';
const NYC_LON = '-74.0035';
const RANGE = '15mi';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;

function mapEvent(ev, helpers) {
  const dtLocal = typeof ev.datetime_local === 'string' ? ev.datetime_local : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dtLocal)) return null;
  const start = helpers.nyISOFromLocal(dtLocal.slice(0, 16));
  if (!start) return null;

  const venue = ev.venue || {};
  const stats = ev.stats || {};
  const performer = (Array.isArray(ev.performers) && ev.performers[0]) || {};
  const image = performer.image || '';
  const low = stats.lowest_price;

  return {
    title: ev.title || ev.short_title || '',
    venue: venue.name || '',
    neighborhood: '',
    start,
    end: '',
    price: typeof low === 'number' && low > 0 ? '$' + low + '+' : '',
    url: ev.url || '',
    source_url: ev.url || '',
    image,
    image_source: image ? 'api_licensed' : '',
    blurb: '',
    blurb_origin: 'none',
  };
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

  const candidates = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      API_URL +
      '?client_id=' + encodeURIComponent(env.SEATGEEK_CLIENT_ID) +
      '&lat=' + NYC_LAT + '&lon=' + NYC_LON + '&range=' + RANGE +
      '&per_page=' + PAGE_SIZE +
      '&page=' + page +
      '&sort=datetime_local.asc';
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('seatgeek HTTP ' + res.status);
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    for (const ev of events) {
      const raw = mapEvent(ev, helpers);
      if (raw) candidates.push(raw);
    }
    const total = (data.meta && data.meta.total) || 0;
    if (events.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
  }
  return { candidates, status: 'ok:' + candidates.length };
}
