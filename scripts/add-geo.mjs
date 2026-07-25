// One-shot data pass for issue #5: add "geo" to every event in
// public/data/teds-nyc.json and normalize a couple of neighborhoods.
// Run: node scripts/add-geo.mjs   (idempotent — overwrites geo each run)
import { readFileSync, writeFileSync } from 'node:fs';

const PATH = new URL('../public/data/teds-nyc.json', import.meta.url);

// Well-known NYC venues; 4-decimal precision (~11m), ±150m is fine.
const GEO = {
  'warm-up-ps1-0724':               { lat: 40.7456, lng: -73.9470 }, // MoMA PS1, 22-25 Jackson Ave, LIC
  'bandshell-jazz-0724':            { lat: 40.6650, lng: -73.9760 }, // Lena Horne Bandshell, Prospect Park (9th St entrance)
  'mcbride-bluenote-0724':          { lat: 40.7308, lng: -74.0006 }, // Blue Note, 131 W 3rd St
  'whitney-friday-0724':            { lat: 40.7396, lng: -74.0089 }, // Whitney, 99 Gansevoort St
  'ska-bryant-0724':                { lat: 40.7536, lng: -73.9832 }, // Bryant Park
  'rooftop-urlirl-0724':            { lat: 40.6558, lng: -74.0095 }, // Industry City, Courtyard 5/6 (~36th St)
  'winters-tale-0725':              { lat: 40.7801, lng: -73.9690 }, // Delacorte Theater, Central Park
  'kris-davis-vanguard-0725':       { lat: 40.7362, lng: -74.0017 }, // Village Vanguard, 178 7th Ave S
  'afro-latinas-summerstage-0725':  { lat: 40.7710, lng: -73.9700 }, // Rumsey Playfield, Central Park
  'summer-streets-0725':            { lat: 40.7560, lng: -73.9445 }, // Vernon Blvd route midpoint (44th Dr–30th Rd), Queens waterfront
  'fort-greene-jazz-0725':          { lat: 40.6908, lng: -73.9756 }, // Fort Greene Park
  'smorgasburg-wburg-0725':         { lat: 40.7218, lng: -73.9624 }, // Marsha P. Johnson State Park, 90 Kent Ave
  'marjorie-eliot-0726':            { lat: 40.8330, lng: -73.9407 }, // 555 Edgecombe Ave, Sugar Hill
  'guelaguetza-socrates-0726':      { lat: 40.7684, lng: -73.9367 }, // Socrates Sculpture Park, 32-01 Vernon Blvd
  'grand-bazaar-vintage-0726':      { lat: 40.7813, lng: -73.9761 }, // Grand Bazaar NYC, 100 W 77th St
  'third-man-filmforum-0726':       { lat: 40.7289, lng: -74.0036 }, // Film Forum, 209 W Houston St
  'vjo-vanguard-0727':              { lat: 40.7362, lng: -74.0017 }, // Village Vanguard
  'broadway-boardwalk-0727':        { lat: 40.7692, lng: -73.9937 }, // Clinton Cove, Hudson River Park (~W 55th St)
  'truman-bryant-0727':             { lat: 40.7536, lng: -73.9832 }, // Bryant Park
  'keyon-harrold-bluenote-0728':    { lat: 40.7308, lng: -74.0006 }, // Blue Note
  'comedy-cellar-0728':             { lat: 40.7302, lng: -74.0003 }, // Comedy Cellar, 117 MacDougal St
  'julieta-venegas-summerstage-0729': { lat: 40.7710, lng: -73.9700 }, // Rumsey Playfield
  'philadanco-joyce-0729':          { lat: 40.7433, lng: -74.0009 }, // The Joyce Theater, 175 8th Ave
  'ubb-summerstage-0730':           { lat: 40.7710, lng: -73.9700 }, // Rumsey Playfield
  'atomic-habitz-bluenote-0730':    { lat: 40.7308, lng: -74.0006 }, // Blue Note
  'funeral-of-god-0730':            { lat: 40.7595, lng: -73.9902 }, // AMT Theater, 354 W 45th St
};

// Neighborhood normalization (real neighborhood/anchor names so the
// borough map in the browser stays a simple lookup).
const HOOD = {
  'winters-tale-0725': 'Central Park',        // was "Upper West Side" — the Delacorte is mid-park
  'broadway-boardwalk-0727': "Hell's Kitchen", // was "West Side waterfront" — Clinton Cove is at W 55th
};

const data = JSON.parse(readFileSync(PATH, 'utf8'));
const missing = [];
data.events = data.events.map((ev) => {
  const geo = GEO[ev.id];
  if (!geo) { missing.push(ev.id); return ev; }
  const out = {};
  for (const k of Object.keys(ev)) {
    if (k === 'geo') continue;
    out[k] = HOOD[ev.id] && k === 'neighborhood' ? HOOD[ev.id] : ev[k];
    if (k === 'neighborhood') out.geo = geo; // insert geo right after neighborhood
  }
  if (!out.geo) out.geo = geo;
  return out;
});
if (missing.length) { console.error('No geo for:', missing); process.exit(1); }
writeFileSync(PATH, JSON.stringify(data, null, 2) + '\n');
console.log('geo added to', data.events.length, 'events');
