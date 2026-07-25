/**
 * /api/me/prefs — per-account saved/attended/followed sync (issue #7).
 *
 * GET  → { saved: {id:true}, attended: {id:true}, followed: bool, updated }
 *        for the signed-in user; 401 for anonymous visitors.
 * PUT  → replaces the whole document (client merges before writing).
 *        Validation: saved/attended must be objects of id -> true with
 *        ids ≤ 120 chars and ≤ 500 entries each; followed must be boolean.
 *
 * Storage: WHEN_AUTH KV, key "prefs:{email}" (reuses the auth namespace —
 * prefs are account data, same blast radius as sessions/tokens).
 */
import { readSession, json } from '../../_lib/session.js';

const MAX_ENTRIES = 500;
const MAX_ID_LEN = 120;

function prefsKey(email) {
  return 'prefs:' + String(email).toLowerCase();
}

/** Validate an id->true map. Returns a cleaned copy or null when invalid. */
function cleanIdMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (!v[k]) continue; // only truthy entries persist
    if (!k || k.length > MAX_ID_LEN) return null;
    if (++n > MAX_ENTRIES) return null;
    out[k] = true;
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  let doc = { saved: {}, attended: {}, followed: false, updated: null };
  try {
    const raw = await env.WHEN_AUTH.get(prefsKey(session.email));
    if (raw) {
      const o = JSON.parse(raw);
      doc = {
        saved: cleanIdMap(o && o.saved) || {},
        attended: cleanIdMap(o && o.attended) || {},
        followed: !!(o && o.followed),
        updated: (o && typeof o.updated === 'string' && o.updated) || null,
      };
    }
  } catch {
    /* corrupt doc reads as empty — next PUT repairs it */
  }
  return json(doc, 200, { 'Cache-Control': 'no-store' });
}

export async function onRequestPut({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }
  const saved = cleanIdMap(body && body.saved);
  const attended = cleanIdMap(body && body.attended);
  if (!saved || !attended || typeof (body && body.followed) !== 'boolean') {
    return json({ ok: false, error: 'invalid prefs' }, 400);
  }
  const doc = {
    saved,
    attended,
    followed: body.followed,
    updated: new Date().toISOString(),
  };
  await env.WHEN_AUTH.put(prefsKey(session.email), JSON.stringify(doc));
  return json({ ok: true, updated: doc.updated }, 200, { 'Cache-Control': 'no-store' });
}

/** Any other method: explicit 405 instead of asset fallback. */
export function onRequest() {
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET, PUT' });
}
