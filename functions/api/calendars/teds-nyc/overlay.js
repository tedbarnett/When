/**
 * POST/PATCH /api/calendars/teds-nyc/overlay — owner-only curator writes.
 *
 * Body (JSON), one of:
 *   { action: "hide",   id }                    — hide an event from public view
 *   { action: "unhide", id }                    — restore it
 *   { action: "edit",   id, fields: {...} }     — in-place edit (replace semantics:
 *       the provided fields become the event's full edit set; values equal to
 *       the base event are dropped, so an all-base save clears the edit)
 *   { action: "reset",  id }                    — drop all edits for the event
 *
 * Editable fields: title, venue, neighborhood, price, blurb, start, url, image.
 * All values are strings; title/start must be non-empty; url/image must be
 * http(s); start must be ISO-like (YYYY-MM-DDTHH:MM[:SS][±HH:MM]).
 *
 * 401 without a session, 403 for signed-in non-owners, 400 on bad input.
 * Returns { ok: true, overlay } on success.
 */
import { CAL_KEY, loadBaseData, loadOverlay } from '../../../_lib/calendar.js';
import { readSession, json, OWNER_EMAIL } from '../../../_lib/session.js';

const ACTIONS = { hide: 1, unhide: 1, edit: 1, reset: 1 };

const FIELD_RULES = {
  title: { max: 200, required: true },
  venue: { max: 200 },
  neighborhood: { max: 120 },
  price: { max: 60 },
  blurb: { max: 600 },
  start: { max: 40, required: true, start: true },
  url: { max: 600, url: true },
  image: { max: 600, url: true },
};

const START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/;

/** Validate + normalize an edit payload against the base event.
 * Returns { fields } (diff vs base, may be empty) or { error }. */
function validateEdit(rawFields, baseEv) {
  if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields)) {
    return { error: 'fields must be an object' };
  }
  const out = {};
  for (const key of Object.keys(rawFields)) {
    const rule = FIELD_RULES[key];
    if (!rule) return { error: 'unknown field: ' + key };
    const raw = rawFields[key];
    if (typeof raw !== 'string') return { error: key + ' must be a string' };
    const val = raw.trim();
    if (rule.required && !val) return { error: key + ' cannot be empty' };
    if (val.length > rule.max) return { error: key + ' too long (max ' + rule.max + ')' };
    if (rule.start && !START_RE.test(val)) return { error: 'start must be an ISO datetime' };
    if (rule.url && val && !/^https?:\/\//i.test(val)) {
      return { error: key + ' must be an http(s) URL' };
    }
    const baseVal = baseEv[key] == null ? '' : String(baseEv[key]);
    if (val !== baseVal) out[key] = val;
  }
  return { fields: out };
}

async function handle({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);
  if (!env.WHEN_CAL) return json({ ok: false, error: 'storage unavailable' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }
  const action = body && body.action;
  const id = body && body.id;
  if (!action || !ACTIONS[action]) return json({ ok: false, error: 'unknown action' }, 400);
  if (typeof id !== 'string' || !id || id.length > 200) {
    return json({ ok: false, error: 'missing or invalid id' }, 400);
  }

  let base;
  try {
    base = await loadBaseData(env, new URL(request.url).origin);
  } catch {
    return json({ ok: false, error: 'calendar data unavailable' }, 502);
  }
  const baseEv = (base.events || []).find((e) => e.id === id);
  if (!baseEv) return json({ ok: false, error: 'unknown event id' }, 400);

  const overlay = await loadOverlay(env);

  if (action === 'hide') {
    overlay.hidden[id] = true;
  } else if (action === 'unhide') {
    delete overlay.hidden[id];
  } else if (action === 'reset') {
    delete overlay.edits[id];
  } else if (action === 'edit') {
    const res = validateEdit(body.fields, baseEv);
    if (res.error) return json({ ok: false, error: res.error }, 400);
    if (Object.keys(res.fields).length) overlay.edits[id] = res.fields;
    else delete overlay.edits[id];
  }

  await env.WHEN_CAL.put(CAL_KEY, JSON.stringify(overlay));
  return json({ ok: true, overlay }, 200, { 'Cache-Control': 'no-store' });
}

export const onRequestPost = handle;
export const onRequestPatch = handle;
