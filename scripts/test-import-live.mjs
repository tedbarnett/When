// Live-page harness: fetch a REAL event page and run the importer's pass-1
// extraction (JSON-LD + og supplements + normalizer) on it. Network required;
// not part of the default test suite. Usage:
//   node scripts/test-import-live.mjs <event-page-url>
import { extractJsonLd, jsonldToRaw, extractSupplements, normalizeEvent, stripHtmlToText } from '../functions/api/calendars/teds-nyc/import.js';

const url = process.argv[2];
if (!url) { console.error('usage: node scripts/test-import-live.mjs <url>'); process.exit(2); }

const res = await fetch(url, {
  redirect: 'follow',
  headers: { 'User-Agent': 'When.org importer (+https://when.org)', Accept: 'text/html' },
});
console.log('HTTP', res.status, res.headers.get('content-type'));
const html = await res.text();
console.log('bytes:', html.length);

const sup = extractSupplements(html);
console.log('supplements:', JSON.stringify(sup, null, 2).slice(0, 600));

const ld = extractJsonLd(html);
if (!ld) {
  console.log('NO JSON-LD Event found — would fall through to AI pass.');
  console.log('stripped text preview:', stripHtmlToText(html).slice(0, 400));
  process.exit(1);
}
console.log('JSON-LD @type:', ld['@type']);
const ev = normalizeEvent(jsonldToRaw(ld), sup, url);
if (!ev) { console.log('JSON-LD present but no usable name+startDate — AI pass needed.'); process.exit(1); }
console.log('PASS-1 normalized event:');
console.log(JSON.stringify(ev, null, 2));
