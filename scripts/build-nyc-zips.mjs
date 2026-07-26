// Build public/data/nyc-zips.json — NYC zip -> [lat, lon] centroids for the
// /nyc/ideas distance filter. Run: node scripts/build-nyc-zips.mjs
//
// Data: US Census 2013 ZCTA centroids (public domain), via erichurst's
// well-known gist "US Zip Codes from 2013 Government Data"
// (https://gist.github.com/erichurst/7882666). Baked at build time — the
// site never geocodes at runtime.
//
// NYC zips = prefixes 100/101/102 (Manhattan), 103 (Staten Island),
// 104 (Bronx), 112 (Brooklyn), 111/113/114/116 (Queens) + 11004/11005
// (Queens; the rest of 110xx is Nassau County).
import { writeFileSync } from 'node:fs';

const SRC =
  'https://gist.githubusercontent.com/erichurst/7882666/raw/5bdc46db47d9515269ab12ed6fb2850377fd869e/US%20Zip%20Codes%20from%202013%20Government%20Data';

const NYC_PREFIXES = ['100', '101', '102', '103', '104', '111', '112', '113', '114', '116'];
const NYC_EXTRA = new Set(['11004', '11005']);

function isNycZip(z) {
  return NYC_EXTRA.has(z) || NYC_PREFIXES.includes(z.slice(0, 3));
}

const res = await fetch(SRC);
if (!res.ok) throw new Error('fetch failed: HTTP ' + res.status);
const csv = await res.text();

const table = {};
for (const line of csv.split('\n').slice(1)) {
  const [zip, lat, lng] = line.split(',').map((s) => String(s || '').trim());
  if (!/^\d{5}$/.test(zip) || !isNycZip(zip)) continue;
  const la = parseFloat(lat);
  const lo = parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
  table[zip] = [Math.round(la * 1e4) / 1e4, Math.round(lo * 1e4) / 1e4];
}

const zips = Object.keys(table).sort();
if (zips.length < 150 || zips.length > 350) {
  throw new Error('suspicious NYC zip count: ' + zips.length);
}

// Sanity anchors (±0.02°): West Village, Park Slope, South Bronx.
const ANCHORS = { 10014: [40.733, -74.006], 11215: [40.667, -73.985], 10451: [40.82, -73.925] };
for (const [z, [la, lo]] of Object.entries(ANCHORS)) {
  const got = table[z];
  if (!got || Math.abs(got[0] - la) > 0.02 || Math.abs(got[1] - lo) > 0.02) {
    throw new Error('sanity check failed for ' + z + ': ' + JSON.stringify(got));
  }
  console.log('sanity OK', z, got);
}

const json =
  '{\n' + zips.map((z) => JSON.stringify(z) + ':[' + table[z][0] + ',' + table[z][1] + ']').join(',\n') + '\n}\n';
writeFileSync(new URL('../public/data/nyc-zips.json', import.meta.url), json);
console.log('wrote public/data/nyc-zips.json —', zips.length, 'zips');
