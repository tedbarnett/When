/**
 * Shared per-event shareable page factory (issue #15): when.org/<cal>/{id}
 * Serves the calendar's browser page with that event's OG/schema markup
 * injected and the detail modal opened on load (window.__WHEN_DETAIL_ID).
 * Unknown ids redirect to /<cal>. Events use the merged (composed) view —
 * inherited events resolve too; hidden events redirect for everyone but the
 * signed-in owner.
 *
 * This directory is underscore-prefixed so Pages Functions never routes it.
 */
import { loadComposed } from './calendar.js';
import { readSession, OWNER_EMAIL } from './session.js';

/**
 * makeEventPageHandler('teds-nyc', {
 *   calLabel: 'Ted’s NYC',
 *   fallbackDesc: 'A pick from Ted’s NYC on When.org.',
 *   organizer: { '@type': 'Person', name: 'Ted (Ted’s NYC on When.org)' },
 *   cityName: 'New York', cityAddress: 'New York, NY',   // schema.org Place
 * }) -> { onRequestGet }
 */
export function makeEventPageHandler(calId, opts) {
  const calLabel = (opts && opts.calLabel) || calId;
  const fallbackDesc = (opts && opts.fallbackDesc) || `A pick from ${calLabel} on When.org.`;
  const organizerBase = (opts && opts.organizer) || { '@type': 'Organization', name: calLabel };
  const cityName = (opts && opts.cityName) || 'New York';
  const cityAddress = (opts && opts.cityAddress) || 'New York, NY';
  const pagePath = '/' + calId;

  async function onRequestGet(context) {
    const { params, env, request } = context;
    const id = decodeURIComponent(params.id || '');
    const origin = new URL(request.url).origin;

    // Never intercept the feed or data paths (defensive; routing shouldn't send them here)
    if (id.endsWith('.ics') || id.endsWith('.json')) {
      return env.ASSETS.fetch(request);
    }

    const [pageRes, merged, session] = await Promise.all([
      env.ASSETS.fetch(new Request(origin + pagePath + '.html')),
      loadComposed(env, origin, calId, { includeHidden: true }).catch(() => null),
      readSession(request, env)
    ]);
    if (!pageRes.ok) return Response.redirect(origin + pagePath, 302);

    const ev = merged ? (merged.data.events || []).find((e) => e.id === id) || null : null;
    if (!ev) return Response.redirect(origin + pagePath, 302);
    const isOwner = !!(session && session.email === OWNER_EMAIL);
    if (ev._hidden && !isOwner) return Response.redirect(origin + pagePath, 302);

    let html = await pageRes.text();

    const esc = (s) =>
      String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const canonical = `https://when.org${pagePath}/${encodeURIComponent(ev.id)}`;
    const title = `${ev.title} · ${calLabel} · When.org`;
    const descBits = [];
    if (ev.venue) descBits.push(ev.venue + (ev.neighborhood ? ' · ' + ev.neighborhood : ''));
    if (ev.blurb) descBits.push(ev.blurb);
    const desc = descBits.join(' — ').slice(0, 280) || fallbackDesc;

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
        name: ev.venue || cityName,
        address: (ev.neighborhood ? ev.neighborhood + ', ' : '') + cityAddress
      },
      ...(ev.image ? { image: [ev.image] } : {}),
      ...(ev.blurb ? { description: ev.blurb } : {}),
      organizer: { ...organizerBase, url: 'https://when.org' + pagePath }
    };

    const inject =
      `<script>window.__WHEN_DETAIL_ID=${JSON.stringify(ev.id)};</script>\n` +
      `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n</head>`;
    html = html.replace('</head>', inject);

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': ev._hidden || ev._edited || ev._added ? 'no-store' : 'public, max-age=300'
      }
    });
  }

  return { onRequestGet };
}
