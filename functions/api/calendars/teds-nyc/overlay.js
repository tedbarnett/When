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
 *                                                 (on a curator-ADDED event,
 *                                                 reset REMOVES the event)
 *   { action: "add",    event: {...} }          — add a new event (from the
 *                                                 URL importer). Requires
 *                                                 title/start/venue; id is
 *                                                 slugified + de-duped.
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

const ACTIONS = { hide: 1, unhide: 1, edit: 1, reset: 1, add: 1 };

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
const ID_RE = /^[a-z0-9-]{1,80}$/;

/* add-only extras: venue becomes required, optional end datetime allowed */
const ADD_RULES = {
  ...FIELD_RULES,
  venue: { max: 200, required: true },
  end: { max: 40, start: true },
};

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // fold accents
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Validate an "add" payload. Returns { event } (normalized, no id) or { error }. */
function validateAdd(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'event must be an object' };
  }
  const out = {};
  for (const key of Object.keys(ADD_RULES)) {
    const rule = ADD_RULES[key];
    let v = raw[key];
    if (v == null) v = '';
    if (typeof v !== 'string') return { error: key + ' must be a string' };
    const val = v.trim();
    if (rule.required && !val) return { error: key + ' is required' };
    if (!val) continue;
    if (val.length > rule.max) return { error: key + ' too long (max ' + rule.max + ')' };
    if (rule.start && !START_RE.test(val)) return { error: key + ' must be an ISO datetime' };
    if (rule.url && !/^https?:\/\//i.test(val)) return { error: key + ' must be an http(s) URL' };
    out[key] = val;
  }
  return { event: { ...out, tags: [], geo: null } };
}

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
  if (!action || !ACTIONS[action]) return json({ ok: false, error: 'unknown action' }, 400);

  let base;
  try {
    base = await loadBaseData(env, new URL(request.url).origin);
  } catch {
    return json({ ok: false, error: 'calendar data unavailable' }, 502);
  }
  const overlay = await loadOverlay(env);

  if (action === 'add') {
    const res = validateAdd(body.event);
    if (res.error) return json({ ok: false, error: res.error }, 400);
    const ev = res.event;
    // id: caller-suggested (importer builds slug-MMDD) or derived here
    let wanted = typeof body.event.id === 'string' && ID_RE.test(body.event.id)
      ? body.event.id
      : slugify(ev.title) + '-' + ev.start.slice(5, 7) + ev.start.slice(8, 10);
    if (!ID_RE.test(wanted)) wanted = 'event-' + ev.start.slice(5, 7) + ev.start.slice(8, 10);
    const taken = {};
    for (const e of base.events || []) taken[e.id] = true;
    for (const k of Object.keys(overlay.added)) taken[k] = true;
    let id = wanted;
    for (let n = 2; taken[id]; n++) id = wanted + '-' + n;
    ev.id = id;
    overlay.added[id] = ev;
    await env.WHEN_CAL.put(CAL_KEY, JSON.stringify(overlay));
    return json({ ok: true, id, event: ev, overlay }, 200, { 'Cache-Control': 'no-store' });
  }

  const id = body && body.id;
  if (typeof id !== 'string' || !id || id.length > 200) {
    return json({ ok: false, error: 'missing or invalid id' }, 400);
  }
  // hide/edit/reset apply to base events AND curator-added events
  const addedEv = overlay.added[id];
  const baseEv = (base.events || []).find((e) => e.id === id) || addedEv;
  if (!baseEv) return json({ ok: false, error: 'unknown event id' }, 400);

  if (action === 'hide') {
    overlay.hidden[id] = true;
  } else if (action === 'unhide') {
    delete overlay.hidden[id];
  } else if (action === 'reset') {
    if (addedEv) {
      // reset on an added event removes it entirely
      delete overlay.added[id];
      delete overlay.hidden[id];
    }
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

/** Any other method (GET, etc.): explicit 405 instead of asset fallback. */
export function onRequest() {
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'POST, PATCH' });
}
