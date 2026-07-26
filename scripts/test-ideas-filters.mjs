// Unit-test the /nyc/ideas client-side filter logic by extracting the real
// marked blocks from public/nyc/ideas.html (geo-core + collate-core) and
// walking a synthetic API payload through them: borough filter, zip+radius
// distance filter (incl. the no-coordinates hidden count), composition with
// the source filter, and collation-group shrinkage.
// Run: node scripts/test-ideas-filters.mjs
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/nyc/ideas.html', import.meta.url), 'utf8');
function block(name) {
  const re = new RegExp('/\\* ' + name + ':start[\\s\\S]*?\\*/([\\s\\S]*?)/\\* ' + name + ':end \\*/');
  const m = html.match(re);
  if (!m) throw new Error('marker block not found: ' + name);
  return m[1];
}
// The extracted code is the exact code the page runs; srcFilter is the one
// external it closes over, so it becomes the wrapper parameter.
const makeCore = new Function(
  'srcFilter',
  block('geo-core') + block('collate-core') +
  'return { BOROUGH_CHIPS: BOROUGH_CHIPS, boroughOf: boroughOf, haversineMi: haversineMi, ' +
  'applyGeoFilter: applyGeoFilter, passesSrc: passesSrc, groupList: groupList };'
);
const core = makeCore('all');

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
const ids = (r) => r.list.map((e) => e.id);

/* ---- haversine spot checks ---- */
// 10014 centroid -> Times Square (40.758, -73.9855): ~2.0 mi great-circle.
const zips = JSON.parse(readFileSync(new URL('../public/data/nyc-zips.json', import.meta.url), 'utf8'));
checkNear('haversine 10014 -> Times Sq ~2.0mi', core.haversineMi(zips['10014'][0], zips['10014'][1], 40.758, -73.9855), 2.0, 0.3);
// 1 degree of latitude = ~69.05 mi (deterministic yardstick).
checkNear('haversine 1 deg latitude ~69.05mi', core.haversineMi(40, -74, 41, -74), 69.05, 0.15);
check('haversine zero distance', core.haversineMi(40.7, -74, 40.7, -74), 0);

/* ---- boroughOf ---- */
check('boroughOf borough name', core.boroughOf({ neighborhood: 'Queens' }), 'Queens');
check('boroughOf real neighborhood -> unknown', core.boroughOf({ neighborhood: 'Williamsburg' }), '');
check('boroughOf empty -> unknown', core.boroughOf({ neighborhood: '' }), '');

/* ---- synthetic payload ---- */
// Coordinates: bn = Blue Note (Manhattan), ks = Kings Theatre (Brooklyn),
// fh = Forest Hills Stadium (Queens). tm1 has borough but NO coords;
// x1 has neither borough nor coords.
const EVS = [
  { id: 'bn', title: 'Jazz Night', neighborhood: 'Manhattan', lat: 40.7308, lon: -74.0006, start: '2026-08-01T19:00:00-04:00', signals: ['seatgeek'], source: 'seatgeek' },
  { id: 'ks', title: 'Kings Show', neighborhood: 'Brooklyn', lat: 40.6461, lon: -73.9615, start: '2026-08-01T20:00:00-04:00', signals: ['ticketmaster'], source: 'ticketmaster' },
  { id: 'fh', title: 'Stadium Gig', neighborhood: 'Queens', lat: 40.7196, lon: -73.8448, start: '2026-08-01T18:00:00-04:00', signals: ['seatgeek'], source: 'seatgeek' },
  { id: 'tm1', title: 'Mystery Hall', neighborhood: 'Manhattan', lat: null, lon: null, start: '2026-08-01T19:00:00-04:00', signals: ['ticketmaster'], source: 'ticketmaster' },
  { id: 'x1', title: 'Crawled Thing', neighborhood: '', lat: null, lon: null, start: '2026-08-01T19:00:00-04:00', signals: ['green-wood'], source: 'green-wood' },
];

/* no filters: everything passes, nothing hidden */
let r = core.applyGeoFilter(EVS, { center: null, radiusMi: 1, borough: '' });
check('no filter: all pass', ids(r), ['bn', 'ks', 'fh', 'tm1', 'x1']);
check('no filter: hidden 0', r.hidden, 0);

/* borough filter: unknown-borough events hidden + counted; other boroughs
   filtered but NOT counted */
r = core.applyGeoFilter(EVS, { center: null, radiusMi: 1, borough: 'Manhattan' });
check('borough Manhattan: bn + tm1 (no coords but known borough)', ids(r), ['bn', 'tm1']);
check('borough Manhattan: only x1 counted hidden', r.hidden, 1);
r = core.applyGeoFilter(EVS, { center: null, radiusMi: 1, borough: 'Staten Island' });
check('borough SI: none match', ids(r), []);
check('borough SI: hidden still 1 (unknown only)', r.hidden, 1);

/* distance filter: zip 10014 (West Village) @ 1mi -> Blue Note only;
   tm1 + x1 hidden (no coords), Brooklyn/Queens out of radius (not counted) */
r = core.applyGeoFilter(EVS, { center: zips['10014'], radiusMi: 1, borough: '' });
check('zip 10014 @1mi: Blue Note only', ids(r), ['bn']);
check('zip 10014 @1mi: 2 hidden for missing coords', r.hidden, 2);

/* wider radius pulls in Brooklyn; distance overrides borough */
r = core.applyGeoFilter(EVS, { center: zips['10014'], radiusMi: 10, borough: 'Queens' });
check('zip 10014 @10mi (center wins over borough)', ids(r), ['bn', 'ks', 'fh']);

/* zip 11215 (Park Slope) @2mi -> Kings Theatre only */
r = core.applyGeoFilter(EVS, { center: zips['11215'], radiusMi: 2, borough: '' });
check('zip 11215 @2mi: Kings Theatre only', ids(r), ['ks']);

/* composition with the source filter (runs first, like renderDay) */
const sgCore = makeCore('seatgeek');
const sgOnly = EVS.filter((ev) => sgCore.passesSrc(ev));
check('source filter first: seatgeek only', sgOnly.map((e) => e.id), ['bn', 'fh']);
r = core.applyGeoFilter(sgOnly, { center: null, radiusMi: 1, borough: 'Queens' });
check('source + borough compose', ids(r), ['fh']);
r = core.applyGeoFilter(sgOnly, { center: zips['10014'], radiusMi: 1, borough: '' });
check('source + distance compose, hidden reflects filtered list', [ids(r), r.hidden], [['bn'], 0]);

/* collation groups shrink to the filtered items (counts honest) */
const REPEATS = [
  { id: 'k1', title: 'Kids In Motion: Playground A', neighborhood: 'Brooklyn', lat: 40.62, lon: -74.03, start: '2026-08-01T10:00:00-04:00', signals: ['nyc-parks'], source: 'nyc-parks' },
  { id: 'k2', title: 'Kids In Motion: Playground B', neighborhood: 'Brooklyn', lat: 40.67, lon: -73.99, start: '2026-08-01T10:00:00-04:00', signals: ['nyc-parks'], source: 'nyc-parks' },
  { id: 'k3', title: 'Kids In Motion: Playground C', neighborhood: 'Queens', lat: 40.72, lon: -73.85, start: '2026-08-01T10:00:00-04:00', signals: ['nyc-parks'], source: 'nyc-parks' },
];
let groups = core.groupList(REPEATS, false);
check('unfiltered collation: one group of 3', groups.map((g) => g.items.length), [3]);
/* distinct "Base: Location" titles need 3+ to share a base group; filtered
   below that they honestly render as individual rows */
r = core.applyGeoFilter(REPEATS, { center: null, radiusMi: 1, borough: 'Brooklyn' });
groups = core.groupList(r.list, false);
check('borough filter drops base-group below 3 -> individual rows', groups.map((g) => g.items.length), [1, 1]);
/* 11215 @1mi: only k2 (Park Slope) is in range — k1 is Bay Ridge ~3.7mi,
   k3 is Queens */
r = core.applyGeoFilter(REPEATS, { center: zips['11215'], radiusMi: 1, borough: '' });
check('distance-filtered collation: only k2 remains', ids(r), ['k2']);
groups = core.groupList(r.list, false);
check('1 remaining -> plain row', groups.map((g) => g.items.length), [1]);
/* identical titles group at any count >= 2, so those groups shrink in place */
const SAME = ['Manhattan', 'Brooklyn', 'Queens'].map((b, i) => ({
  id: 's' + i, title: 'Free Yoga', neighborhood: b,
  lat: [40.73, 40.66, 40.72][i], lon: [-74.0, -73.98, -73.85][i],
  start: '2026-08-01T09:00:00-04:00', signals: ['nyc-parks'], source: 'nyc-parks',
}));
groups = core.groupList(SAME, false);
check('same-title collation: one group of 3', groups.map((g) => g.items.length), [3]);
/* 11215 @5mi keeps West Village + Park Slope, drops Forest Hills (~8mi) */
r = core.applyGeoFilter(SAME, { center: zips['11215'], radiusMi: 5, borough: '' });
check('same-title shrink kept 2 of 3', ids(r), ['s0', 's1']);
groups = core.groupList(r.list, false);
check('same-title group shrinks in place (count honest)', groups.map((g) => g.items.length), [2]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
