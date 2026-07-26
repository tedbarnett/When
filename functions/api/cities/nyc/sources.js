/**
 * /api/cities/nyc/sources — source registry for the Event Ideas pipeline
 * (issue #13, P1). Owner-only, same gate as /api/cities/nyc/ideas: 401
 * without a session, 403 for non-owners.
 *
 * GET  — every `sources` row plus per-source candidate stats from one
 *        grouped query: candidates_total (all rows ever attributed to the
 *        source) and candidates_upcoming (start on/after today NY, status
 *        new|added). Response: { ok, today, sources: […] }.
 *
 * POST — {id, enabled: 0|1} flips a source on/off (the owner's kill switch /
 *        re-enable from /nyc/sources). Validates the id exists; returns
 *        { ok, source: <updated row> }. The when-ingest Worker picks the
 *        change up on its next run.
 *
 * Storage note: candidates.start carries the NY offset, so substr(start,1,10)
 * is the NY-local date — never use SQLite date() on it.
 */
import { readSession, json, OWNER_EMAIL } from '../../../_lib/session.js';

function nyTodayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function requireOwner(request, env) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);
  return null;
}

function rowToSource(row, stats) {
  const s = stats.get(row.id) || { total: 0, upcoming: 0 };
  return {
    id: row.id,
    tier: row.tier,
    name: row.name,
    url: row.url,
    kind: row.kind || '',
    crawl_url: row.crawl_url || '',
    enabled: row.enabled ? 1 : 0,
    last_run: row.last_run || '',
    last_status: row.last_status || '',
    last_count: row.last_count || 0,
    last_error: row.last_error || '',
    notes: row.notes || '',
    candidates_total: s.total,
    candidates_upcoming: s.upcoming,
  };
}

export async function onRequestGet({ request, env }) {
  const gate = await requireOwner(request, env);
  if (gate) return gate;
  const db = env.WHEN_EVENTS;
  if (!db) return json({ ok: false, error: 'source registry unavailable' }, 503);

  const today = nyTodayKey();
  const [srcRes, statRes] = await db.batch([
    db.prepare('SELECT * FROM sources ORDER BY tier, name'),
    db.prepare(
      "SELECT source, COUNT(*) AS total, " +
      "SUM(CASE WHEN substr(start, 1, 10) >= ? AND status IN ('new', 'added') THEN 1 ELSE 0 END) AS upcoming " +
      "FROM candidates WHERE city = 'nyc' GROUP BY source"
    ).bind(today),
  ]);

  const stats = new Map();
  for (const r of statRes.results || []) {
    stats.set(r.source, { total: r.total || 0, upcoming: r.upcoming || 0 });
  }
  const sources = (srcRes.results || []).map((row) => rowToSource(row, stats));
  return json({ ok: true, today, sources }, 200, { 'Cache-Control': 'no-store' });
}

export async function onRequestPost({ request, env }) {
  const gate = await requireOwner(request, env);
  if (gate) return gate;
  const db = env.WHEN_EVENTS;
  if (!db) return json({ ok: false, error: 'source registry unavailable' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const enabled = body.enabled === 1 || body.enabled === true ? 1
    : body.enabled === 0 || body.enabled === false ? 0 : null;
  if (!id || enabled === null) {
    return json({ ok: false, error: 'expected {id, enabled: 0|1}' }, 400);
  }

  const existing = await db.prepare('SELECT id FROM sources WHERE id = ?').bind(id).first();
  if (!existing) return json({ ok: false, error: 'unknown source' }, 404);

  await db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').bind(enabled, id).run();
  const row = await db.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first();
  return json({ ok: true, source: rowToSource(row, new Map()) }, 200, { 'Cache-Control': 'no-store' });
}

/** Any other method (PUT, DELETE, …): explicit 405 instead of asset fallback. */
export function onRequest() {
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET, POST' });
}
