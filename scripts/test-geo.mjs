// Unit tests for the ingest geo pass (migration 0005): borough-from-zip/city
// tables, NYC coordinate bounds, adapter mapEvent geo fields (documented-shape
// fixtures), nycParks feed coordinates, and the baked zip-centroid table.
// Run: node scripts/test-geo.mjs
import { readFileSync } from 'node:fs';
import { boroughFromZip, boroughFromCity, boroughFor, nycLatLon } from '../workers/when-ingest/src/geo.js';
import { mapEvent as tmMapEvent } from '../workers/when-ingest/src/adapters/ticketmaster.js';
import { mapEvent as sgMapEvent } from '../workers/when-ingest/src/adapters/seatgeek.js';
import { parseFeed } from '../workers/when-ingest/src/adapters/nycParks.js';
import { ldEventToRaw } from '../workers/when-ingest/src/crawl/jsonld.js';
import { nyISOFromDate, nyISOFromLocal, buildCandidate } from '../workers/when-ingest/src/normalize.js';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}
function checkNear(name, got, want, tol) {
  const ok = typeof got === 'number' && Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${got}, want ${want}±${tol})`}`);
}

/* ---- borough from zip ---- */
check('zip 10014 Manhattan', boroughFromZip('10014'), 'Manhattan');
check('zip 10119 Manhattan (101)', boroughFromZip('10119'), 'Manhattan');
check('zip 10280 Manhattan (102)', boroughFromZip('10280'), 'Manhattan');
check('zip 10314 Staten Island', boroughFromZip('10314'), 'Staten Island');
check('zip 10451 Bronx', boroughFromZip('10451'), 'Bronx');
check('zip 11215 Brooklyn', boroughFromZip('11215'), 'Brooklyn');
check('zip 11101 Queens (111)', boroughFromZip('11101'), 'Queens');
check('zip 11354 Queens (113)', boroughFromZip('11354'), 'Queens');
check('zip 11691 Queens (116)', boroughFromZip('11691'), 'Queens');
check('zip 11004 Queens edge (110 special)', boroughFromZip('11004'), 'Queens');
check('zip 11005 Queens edge (110 special)', boroughFromZip('11005'), 'Queens');
check('zip 11001 Nassau -> unknown', boroughFromZip('11001'), '');
check('zip 07030 Hoboken -> unknown', boroughFromZip('07030'), '');
check('zip garbage -> unknown', boroughFromZip('abc'), '');
check('zip zip+4 uses first 5', boroughFromZip('11215-1234'), 'Brooklyn');

/* ---- borough from city / combined ---- */
check('city Brooklyn', boroughFromCity('Brooklyn'), 'Brooklyn');
check('city staten island (case)', boroughFromCity('staten island'), 'Staten Island');
check('city New York -> Manhattan', boroughFromCity('New York'), 'Manhattan');
check('city Astoria -> Queens', boroughFromCity('Astoria'), 'Queens');
check('city Hoboken -> unknown', boroughFromCity('Hoboken'), '');
check('boroughFor zip wins over city', boroughFor('11215', 'New York'), 'Brooklyn');
check('boroughFor city fallback', boroughFor('', 'Bronx'), 'Bronx');
check('boroughFor non-NYC zip falls to city', boroughFor('11001', 'Brooklyn'), 'Brooklyn');

/* ---- coordinate bounds ---- */
check('nycLatLon strings ok', nycLatLon('40.7336', '-74.0056'), { lat: 40.7336, lon: -74.0056 });
check('nycLatLon numbers ok', nycLatLon(40.6, -73.9), { lat: 40.6, lon: -73.9 });
check('nycLatLon LA rejected', nycLatLon(34.05, -118.24), { lat: null, lon: null });
check('nycLatLon junk rejected', nycLatLon('x', 'y'), { lat: null, lon: null });
check('nycLatLon half-pair rejected', nycLatLon('40.7', ''), { lat: null, lon: null });

/* ---- Ticketmaster mapEvent (Discovery v2 documented shape) ---- */
const HELPERS = { nyISOFromDate, nyISOFromLocal };
const tmRaw = tmMapEvent({
  name: 'Test Show',
  url: 'https://www.ticketmaster.com/event/x',
  dates: { start: { dateTime: '2026-08-01T23:30:00Z' } },
  _embedded: {
    venues: [{
      name: 'Kings Theatre',
      postalCode: '11226',
      city: { name: 'Brooklyn' },
      location: { longitude: '-73.961465', latitude: '40.646123' },
    }],
  },
}, HELPERS);
check('TM borough from zip', tmRaw.neighborhood, 'Brooklyn');
check('TM lat/lon parsed', [tmRaw.lat, tmRaw.lon], [40.646123, -73.961465]);
const tmNoGeo = tmMapEvent({
  name: 'No Venue Geo', dates: { start: { localDate: '2026-08-02', localTime: '19:00:00' } },
  _embedded: { venues: [{ name: 'Somewhere', city: { name: 'New York' } }] },
}, HELPERS);
check('TM no coords -> nulls, city fallback borough', [tmNoGeo.lat, tmNoGeo.lon, tmNoGeo.neighborhood], [null, null, 'Manhattan']);

/* ---- SeatGeek mapEvent (Platform API documented shape) ---- */
const sgRaw = sgMapEvent({
  title: 'Test Gig',
  datetime_local: '2026-08-03T20:00:00',
  url: 'https://seatgeek.com/e/x',
  venue: {
    name: 'Forest Hills Stadium',
    city: 'Flushing',
    postal_code: '11375',
    location: { lat: 40.7196, lon: -73.8448 },
  },
  stats: {}, performers: [],
}, HELPERS);
check('SG borough from zip (11375 Queens)', sgRaw.neighborhood, 'Queens');
check('SG lat/lon numbers', [sgRaw.lat, sgRaw.lon], [40.7196, -73.8448]);
const sgOutside = sgMapEvent({
  title: 'Philly Show', datetime_local: '2026-08-03T20:00:00',
  venue: { name: 'The Fillmore', city: 'Philadelphia', postal_code: '19125', location: { lat: 39.9678, lon: -75.1347 } },
}, HELPERS);
check('SG out-of-bounds coords + non-NYC -> nulls/unknown', [sgOutside.lat, sgOutside.lon, sgOutside.neighborhood], [null, null, '']);

/* ---- NYC Parks parseFeed: event:coordinates ---- */
const parksXml = `<rss><channel><item>
<title><![CDATA[Birding Tour]]></title>
<link>http://www.nycgovparks.org/events/x</link>
<event:parkids>M072</event:parkids>
<event:parknames>Riverside Park</event:parknames>
<event:startdate>2026-08-01</event:startdate>
<event:enddate>2026-08-01</event:enddate>
<event:starttime>8:00 am</event:starttime>
<event:endtime>10:00 am</event:endtime>
<event:coordinates>40.80897335964300000, -73.96603202819800000</event:coordinates>
</item><item>
<title><![CDATA[No Coords Event]]></title>
<link>http://www.nycgovparks.org/events/y</link>
<event:parkids>B073</event:parkids>
<event:parknames>Prospect Park</event:parknames>
<event:startdate>2026-08-01</event:startdate>
</item></channel></rss>`;
const parks = parseFeed(parksXml, nyISOFromLocal);
check('Parks borough kept', parks[0].neighborhood, 'Manhattan');
checkNear('Parks lat parsed', parks[0].lat, 40.80897, 0.0001);
checkNear('Parks lon parsed', parks[0].lon, -73.96603, 0.0001);
check('Parks missing coords -> nulls', [parks[1].lat, parks[1].lon, parks[1].neighborhood], [null, null, 'Brooklyn']);

/* ---- JSON-LD ldEventToRaw: location.geo + address ---- */
const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const src = { id: 'green-wood', name: 'Green-Wood', crawl_url: 'https://www.green-wood.com/events/' };
const ldRaw = ldEventToRaw({
  '@type': 'Event', name: 'Twilight Tour', startDate: soon + 'T19:00',
  location: {
    '@type': 'Place', name: 'Green-Wood Cemetery',
    geo: { '@type': 'GeoCoordinates', latitude: 40.6591, longitude: -73.9937 },
    address: { '@type': 'PostalAddress', postalCode: '11232', addressLocality: 'Brooklyn' },
  },
}, src, HELPERS);
check('LD geo -> lat/lon', [ldRaw.lat, ldRaw.lon], [40.6591, -73.9937]);
check('LD postalCode -> borough', ldRaw.neighborhood, 'Brooklyn');
const ldNoGeo = ldEventToRaw({
  '@type': 'Event', name: 'Bare Event', startDate: soon + 'T19:00', location: 'Some Hall',
}, src, HELPERS);
check('LD string location -> nulls', [ldNoGeo.lat, ldNoGeo.lon, ldNoGeo.neighborhood], [null, null, '']);

/* ---- buildCandidate passthrough ---- */
const cand = buildCandidate({ title: 'T', venue: 'V', start: '2026-08-01T19:00:00-04:00', lat: 40.7, lon: -74.0 }, 'test');
check('buildCandidate lat/lon numbers', [cand.lat, cand.lon], [40.7, -74.0]);
const candNo = buildCandidate({ title: 'T2', venue: 'V', start: '2026-08-01T19:00:00-04:00' }, 'test');
check('buildCandidate missing -> nulls', [candNo.lat, candNo.lon], [null, null]);
const candStr = buildCandidate({ title: 'T3', venue: 'V', start: '2026-08-01T19:00:00-04:00', lat: '40.71', lon: '-73.99' }, 'test');
check('buildCandidate string coords -> numbers', [candStr.lat, candStr.lon], [40.71, -73.99]);

/* ---- baked zip table sanity ---- */
const zips = JSON.parse(readFileSync(new URL('../public/data/nyc-zips.json', import.meta.url), 'utf8'));
const n = Object.keys(zips).length;
check('zip table size ~200', n >= 150 && n <= 350, true);
checkNear('10014 lat', zips['10014'][0], 40.733, 0.02);
checkNear('10014 lon', zips['10014'][1], -74.006, 0.02);
checkNear('11215 lat', zips['11215'][0], 40.667, 0.02);
checkNear('11215 lon', zips['11215'][1], -73.985, 0.02);
checkNear('10451 lat', zips['10451'][0], 40.820, 0.02);
checkNear('10451 lon', zips['10451'][1], -73.925, 0.02);
check('11004 present (Queens edge)', Array.isArray(zips['11004']), true);
check('11001 absent (Nassau)', zips['11001'] === undefined, true);

console.log(failures ? `\n${failures} FAILURE(S)` : `\nALL PASS (zip table: ${n} zips)`);
process.exit(failures ? 1 : 0);
