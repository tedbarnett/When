// Unit check for functions/api/calendars/teds-nyc/import.js:
// auth gates, JSON-LD pass, AI fallback (mocked Anthropic), no_event, and the
// normalizeStart/normalizeEvent pure helpers. Network is fully stubbed.
import * as imp from '../functions/api/calendars/teds-nyc/import.js';
import { createSessionCookie } from '../functions/_lib/session.js';

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

/* ---------- pure helpers ---------- */
check('normalizeStart keeps NY offset', imp.normalizeStart('2026-08-01T19:00:00-04:00'), '2026-08-01T19:00:00-04:00');
check('normalizeStart converts Z (EDT)', imp.normalizeStart('2026-08-01T23:00:00Z'), '2026-08-01T19:00:00-04:00');
check('normalizeStart converts Z (EST)', imp.normalizeStart('2026-12-05T00:30:00Z'), '2026-12-04T19:30:00-05:00');
check('normalizeStart naive assumed NY', imp.normalizeStart('2026-08-01T19:00'), '2026-08-01T19:00:00-04:00');
check('normalizeStart date-only -> midnight', imp.normalizeStart('2026-08-01'), '2026-08-01T00:00:00-04:00');
check('normalizeStart garbage -> empty', imp.normalizeStart('tomorrow at 8'), '');
check('normalizeStart offset no colon', imp.normalizeStart('2026-08-01T19:00:00-0400'), '2026-08-01T19:00:00-04:00');

const FIX_LD = `<!doctype html><html><head>
<title>Cécile McLorin Salvant at the Blue Note</title>
<link rel="canonical" href="https://example.com/events/salvant">
<meta property="og:image" content="https://example.com/img/salvant.jpg">
<meta property="og:description" content="Two sets nightly.">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","name":"Blue Note"},
 {"@type":"MusicEvent","name":"Cécile McLorin Salvant","startDate":"2026-08-01T20:00:00-04:00","endDate":"2026-08-01T21:30:00-04:00",
  "location":{"@type":"Place","name":"Blue Note Jazz Club","address":{"@type":"PostalAddress","addressLocality":"Greenwich Village","addressRegion":"NY"}},
  "offers":{"@type":"Offer","price":"35.00","priceCurrency":"USD"},
  "image":["https://example.com/img/salvant-hero.jpg"],
  "description":"<p>The great jazz vocalist returns for two nights of standards &amp; originals, with a stellar trio behind her and much more to hear.</p>",
  "url":"https://example.com/events/salvant"}]}
</script></head><body>hi</body></html>`;

const FIX_PLAIN = `<!doctype html><html><head><title>Free outdoor movie</title>
<meta property="og:image" content="https://example.com/img/movie.jpg">
</head><body><main><h1>Movies Under the Stars: Do the Right Thing</h1>
<p>Join us Friday, August 7, 2026 at 8:00 PM at Herbert Von King Park, Bed-Stuy, Brooklyn. Free admission.</p></main></body></html>`;

const FIX_NOEVENT = `<!doctype html><html><head><title>About us</title></head>
<body><p>We are a company that makes widgets. Contact us for pricing and enterprise quotes today.</p></body></html>`;

/* ---------- extraction pass 1 (pure, same code the endpoint runs) ---------- */
{
  const ld = imp.extractJsonLd(FIX_LD);
  check('jsonld found', !!ld, true);
  const ev = imp.normalizeEvent(imp.jsonldToRaw(ld), imp.extractSupplements(FIX_LD), 'https://example.com/events/salvant?utm=x');
  check('jsonld title', ev.title, 'Cécile McLorin Salvant');
  check('jsonld id slug', ev.id, 'cecile-mclorin-salvant-0801');
  check('jsonld start', ev.start, '2026-08-01T20:00:00-04:00');
  check('jsonld end', ev.end, '2026-08-01T21:30:00-04:00');
  check('jsonld venue', ev.venue, 'Blue Note Jazz Club');
  check('jsonld neighborhood', ev.neighborhood, 'Greenwich Village');
  check('jsonld price', ev.price, '$35');
  check('jsonld image from ld', ev.image, 'https://example.com/img/salvant-hero.jpg');
  check('jsonld url canonical', ev.url, 'https://example.com/events/salvant');
  check('jsonld blurb <=140 + stripped', ev.blurb.length <= 140 && !ev.blurb.includes('<'), true);
  check('jsonld tags/geo shape', JSON.stringify(ev.tags) + '|' + String(ev.geo), '[]|null');
}

/* ---------- endpoint with stubbed network ---------- */
const env = { SESSION_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test-key' };
const owner = (await createSessionCookie(env, { email: 'tedbarnett@gmail.com', name: 'Ted' })).split(';')[0];
const other = (await createSessionCookie(env, { email: 'mallory@example.com', name: 'M' })).split(';')[0];

const req = (body, cookie) =>
  new Request('https://when.org/api/calendars/teds-nyc/import', {
    method: 'POST',
    headers: { cookie: cookie || '', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let pageHtml = FIX_LD;
let aiAnswer = null; // string the mocked model returns
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com/')) {
    return new Response(JSON.stringify({ content: [{ type: 'text', text: aiAnswer }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (u.startsWith('https://example.com/')) {
    return new Response(pageHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (u.startsWith('https://notfound.example/')) {
    return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  }
  if (u.startsWith('https://pdf.example/')) {
    return new Response('%PDF-', { status: 200, headers: { 'content-type': 'application/pdf' } });
  }
  return realFetch(url, opts);
};

check('anon -> 401', (await imp.onRequestPost({ request: req({ url: 'https://example.com/e' }), env })).status, 401);
check('non-owner -> 403', (await imp.onRequestPost({ request: req({ url: 'https://example.com/e' }, other), env })).status, 403);
check('GET -> 405', imp.onRequest().status, 405);
check('bad url -> 400', (await imp.onRequestPost({ request: req({ url: 'ftp://x' }, owner), env })).status, 400);
check('missing url -> 400', (await imp.onRequestPost({ request: req({}, owner), env })).status, 400);
check('upstream 404 -> 502', (await imp.onRequestPost({ request: req({ url: 'https://notfound.example/x' }, owner), env })).status, 502);
check('non-HTML -> 415', (await imp.onRequestPost({ request: req({ url: 'https://pdf.example/x' }, owner), env })).status, 415);

{
  pageHtml = FIX_LD;
  const r = await imp.onRequestPost({ request: req({ url: 'https://example.com/events/salvant' }, owner), env });
  const d = await r.json();
  check('jsonld import -> 200', r.status, 200);
  check('jsonld source', d.source, 'jsonld');
  check('jsonld event title over endpoint', d.event.title, 'Cécile McLorin Salvant');
}

{
  pageHtml = FIX_PLAIN;
  aiAnswer = 'Here you go:\n{"title":"Movies Under the Stars: Do the Right Thing","venue":"Herbert Von King Park","neighborhood":"Bed-Stuy","start":"2026-08-07T20:00:00-04:00","price":"Free","url":"https://example.com/movies","blurb":"Spike Lee\'s classic, free on the lawn at Herbert Von King Park.","image":"https://evil.example/ai-made-this-up.jpg"}';
  const r = await imp.onRequestPost({ request: req({ url: 'https://example.com/movies' }, owner), env });
  const d = await r.json();
  check('ai import -> 200', r.status, 200);
  check('ai source', d.source, 'ai');
  check('ai title', d.event.title, 'Movies Under the Stars: Do the Right Thing');
  check('ai image guardrail: og wins, AI url ignored', d.event.image, 'https://example.com/img/movie.jpg');
  check('ai start', d.event.start, '2026-08-07T20:00:00-04:00');
}

{
  pageHtml = FIX_NOEVENT;
  aiAnswer = '{"error":"no_event"}';
  const r = await imp.onRequestPost({ request: req({ url: 'https://example.com/about' }, owner), env });
  check('no_event -> 422', r.status, 422);
  check('no_event error code', (await r.json()).error, 'no_event');
}

{
  pageHtml = FIX_NOEVENT;
  aiAnswer = 'I could not find anything useful, sorry!';
  const r = await imp.onRequestPost({ request: req({ url: 'https://example.com/about' }, owner), env });
  check('ai unparseable -> 502', r.status, 502);
}

globalThis.fetch = realFetch;
process.exit(failures ? 1 : 0);
