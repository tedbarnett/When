// GET /data/teds-nyc.json — public calendar JSON.
// Intercepts the static asset path and serves the MERGED view: curator edits
// applied, hidden events excluded. Same shape as the static file, so the
// browser page and any external consumers keep working unchanged.
import { loadMergedEvents } from '../_lib/calendar.js';

export async function onRequest(context) {
  const method = context.request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  try {
    const origin = new URL(context.request.url).origin;
    const { data } = await loadMergedEvents(context.env, origin);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // Short cache so curator hides/edits propagate quickly.
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'calendar data unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
}
