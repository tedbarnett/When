/**
 * GET /api/calendars/teds-nyc/admin — owner-only full calendar view.
 * Same shape as /data/teds-nyc.json, but hidden events are INCLUDED and
 * marked (_hidden), edited events are marked (_edited), and the raw overlay
 * document rides along for the edit UI. 401 without a session, 403 for
 * signed-in non-owners.
 */
import { loadMergedEvents } from '../../../_lib/calendar.js';
import { readSession, json, OWNER_EMAIL } from '../../../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);
  try {
    const origin = new URL(request.url).origin;
    const { data, overlay } = await loadMergedEvents(env, origin, { includeHidden: true });
    return json({ ...data, overlay }, 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    return json({ ok: false, error: 'calendar data unavailable' }, 502);
  }
}

/** Any other method: explicit 405 instead of asset fallback. */
export function onRequest() {
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET' });
}
