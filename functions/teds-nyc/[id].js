/**
 * Per-event shareable URLs: when.org/teds-nyc/{event-id}
 * Serves the Ted's NYC browser page with that event's OG/schema markup
 * injected and the detail modal opened on load (window.__WHEN_DETAIL_ID).
 * Unknown ids redirect to /teds-nyc. Events use the merged view (curator
 * edits applied); hidden events redirect to /teds-nyc for everyone but the
 * signed-in owner.
 */
import { loadMergedEvents } from '../_lib/calendar.js';
import { readSession, OWNER_EMAIL } from '../_lib/session.js';

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const id = decodeURIComponent(params.id || '');
  const origin = new URL(request.url).origin;

  // Never intercept the feed or data paths (defensive; routing shouldn't send them here)
  if (id.endsWith('.ics') || id.endsWith('.json')) {
    return env.ASSETS.fetch(request);
  }

  const [pageRes, merged, session] = await Promise.all([
    env.ASSETS.fetch(new Request(origin + '/teds-nyc.html')),
    loadMergedEvents(env, origin, { includeHidden: true }).catch(() => null),
    readSession(request, env)
  ]);
  if (!pageRes.ok) return Response.redirect(origin + '/teds-nyc', 302);

  const ev = merged ? (merged.data.events || []).find((e) => e.id === id) || null : null;
  if (!ev) return Response.redirect(origin + '/teds-nyc', 302);
  const isOwner = !!(session && session.email === OWNER_EMAIL);
  if (ev._hidden && !isOwner) return Response.redirect(origin + '/teds-nyc', 302);

  let html = await pageRes.text();

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const canonical = `https://when.org/teds-nyc/${encodeURIComponent(ev.id)}`;
  const title = `${ev.title} · Ted’s NYC · When.org`;
  const descBits = [];
  if (ev.venue) descBits.push(ev.venue + (ev.neighborhood ? ' · ' + ev.neighborhood : ''));
  if (ev.blurb) descBits.push(ev.blurb);
  const desc = descBits.join(' — ').slice(0, 280) || 'A pick from Ted’s NYC on When.org.';

  // Replace title + canonical + og tags for this event
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${canonical}">`)
    .replace(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${canonical}">`)
    .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(title)}">`)
    .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(desc)}">`)
    .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${esc(title)}">`)
    .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${esc(desc)}">`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(desc)}">`);

  if (ev.image) {
    html = html.replace(
      /<meta name="twitter:card"[^>]*>/,
      `<meta name="twitter:card" content="summary_large_image">\n<meta property="og:image" content="${esc(ev.image)}">`
    );
  }

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.title,
    startDate: ev.start,
    ...(ev.end ? { endDate: ev.end } : {}),
    url: canonical,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: ev.venue || 'New York',
      address: (ev.neighborhood ? ev.neighborhood + ', ' : '') + 'New York, NY'
    },
    ...(ev.image ? { image: [ev.image] } : {}),
    ...(ev.blurb ? { description: ev.blurb } : {}),
    organizer: { '@type': 'Person', name: 'Ted (Ted’s NYC on When.org)', url: 'https://when.org/teds-nyc' }
  };

  const inject =
    `<script>window.__WHEN_DETAIL_ID=${JSON.stringify(ev.id)};</script>\n` +
    `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n</head>`;
  html = html.replace('</head>', inject);

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': ev._hidden || ev._edited ? 'no-store' : 'public, max-age=300'
    }
  });
}
