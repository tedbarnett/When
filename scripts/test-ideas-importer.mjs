// The red "＋ add event" button (paste-a-URL importer, issue #6) lives on the
// IDEAS pages now — Ted's ask: that's where events get added, so the calendar
// pages stay uncluttered. This checks, with no network:
//   1. every calendar page has NO add-event button and NO importer sheet/JS
//   2. every ideas page has the owner-gated button, the import sheet, and
//      unhides the button only after the owner gate passes
//   3. the client importer-core block is byte-identical across all 3 ideas
//      pages (same convention as dayinstance-core / personalcal-core)
//   4. the importer talks to the same endpoints as before the move:
//      /api/calendars/{cal}/import to extract, overlay action:"add" to save
// Run: node scripts/test-ideas-importer.mjs
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ================= calendar pages: button + importer are gone ================= */

const CAL_PAGES = ['teds-nyc', 'teds-dublin', 'teds-reykjavik', 'basics-nyc'];
for (const p of CAL_PAGES) {
  const html = read(`../public/${p}.html`);
  check(`${p}: no add-event button`, html.includes('add-event-open'), false);
  check(`${p}: no importer sheet`, html.includes('import-backdrop'), false);
  check(`${p}: no importer JS`, /openImport|import-url-form/.test(html), false);
  check(`${p}: ideas link pill kept`, html.includes('id="ideas-link"'), true);
}

/* ================= ideas pages: button + importer live here ================= */

const IDEAS_PAGES = ['nyc', 'dublin', 'reykjavik'];
for (const c of IDEAS_PAGES) {
  const html = read(`../public/${c}/ideas.html`);
  check(`${c}/ideas: add-event button (hidden until owner)`,
    /<button class="add-btn" id="add-event-open" type="button" hidden/.test(html), true);
  check(`${c}/ideas: import sheet`, html.includes('id="import-backdrop"'), true);
  check(`${c}/ideas: unhidden only after the owner gate`,
    /getElementById\('app'\)\.innerHTML = '';\n\s*document\.getElementById\('add-event-open'\)\.hidden = false;/.test(html), true);
}

/* ================= importer-core identical across all 3 ideas pages ================= */

function coreBlock(city) {
  const html = read(`../public/${city}/ideas.html`);
  const m = html.match(/\/\* importer-core:start[\s\S]*?\*\/([\s\S]*?)\/\* importer-core:end \*\//);
  if (!m) throw new Error('importer-core block not found: ' + city);
  return m[1];
}
const blocks = IDEAS_PAGES.map(coreBlock);
check('importer-core identical across all 3 ideas pages',
  [blocks[0] === blocks[1], blocks[1] === blocks[2]], [true, true]);

/* same wiring as before the move: extract endpoint + overlay save */
check('importer-core extracts via /api/calendars/{cal}/import',
  blocks[0].includes("'/api/calendars/' + cal + '/import'"), true);
check('importer-core saves through overlay action:"add"',
  /overlayPost\(target, \{ action: 'add', event: ev \}\)/.test(blocks[0]), true);
check('importer-core adds to the picked When calendar (addTarget)',
  blocks[0].includes('importUrlFor(addTarget)'), true);

process.exit(failures ? 1 : 0);
