/**
 * Shared, per-calendar API handler factories (issue #15).
 *
 * The teds-nyc admin/overlay endpoints were originally written inline; this
 * module generalizes them over a calendar id so basics-nyc (and future
 * calendars) get identical behavior from thin route wrappers:
 *
 *   makeAdminHandler(calId)   — GET  /api/calendars/<id>/admin
 *   makeOverlayHandler(calId) — POST /api/calendars/<id>/overlay
 *
 * Composition-aware: both operate on the calendar's COMPOSED base (own base
 * events plus inherited parent events when the registry declares extends),
 * so hide/edit/reset work on inherited events and add's id de-dupe
 * considers inherited ids. All writes go ONLY to the calendar's own overlay
 * (subscribe model: hiding an inherited event is a local hide; the parent
 * calendar keeps it).
 *
 * This directory is underscore-prefixed so Pages Functions never routes it.
 */
import { calKey, loadComposed, loadComposedBase, loadOverlayFor } from './calendar.js';
import { readSession, json, OWNER_EMAIL } from './session.js';

/* ---------------- admin ---------------- */

/**
 * GET /api/calendars/<id>/admin — owner-only full calendar view.
 * Same shape as /data/<id>.json, but hidden events are INCLUDED and marked
 * (_hidden), edited events are marked (_edited), curator-added events
 * (_added), inherited events (_inherited), and the raw overlay document
 * rides along for the edit UI. 401 without a session, 403 for signed-in
 * non-owners.
 */
export function makeAdminHandler(calId) {
  async function onRequestGet({ request, env }) {
    const session = await readSession(request, env);
    if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
    if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);
    try {
      const origin = new URL(request.url).origin;
      const { data, overlay } = await loadComposed(env, origin, calId, { includeHidden: true });
      return json({ ...data, overlay }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, error: 'calendar data unavailable' }, 502);
    }
  }
  /** Any other method: explicit 405 instead of asset fallback. */
  function onRequest() {
    return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'GET' });
  }
  return { onRequestGet, onRequest };
}

/* ---------------- overlay ---------------- */

const ACTIONS = { hide: 1, unhide: 1, edit: 1, reset: 1, add: 1, remove: 1, unremove: 1 };

const FIELD_RULES = {
  title: { max: 200, required: true },
  venue: { max: 200 },
  neighborhood: { max: 120 },
  price: { max: 60 },
  blurb: { max: 600 },
  start: { max: 40, required: true, start: true },
  end: { max: 40, start: true },
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
    if (rule.start && val && !START_RE.test(val)) return { error: key + ' must be an ISO datetime' };
    if (rule.url && val && !/^https?:\/\//i.test(val)) {
      return { error: key + ' must be an http(s) URL' };
    }
    const baseVal = baseEv[key] == null ? '' : String(baseEv[key]);
    if (val !== baseVal) out[key] = val;
  }
  return { fields: out };
}

/**
 * POST/PATCH /api/calendars/<id>/overlay — owner-only curator writes.
 *
 * Body (JSON), one of:
 *   { action: "hide",   id }                — hide an event from public view
 *                                             (inherited events: LOCAL hide;
 *                                             the parent calendar keeps it)
 *   { action: "unhide", id }                — restore it
 *   { action: "edit",   id, fields: {...} } — in-place edit (replace
 *       semantics: the provided fields become the event's full edit set;
 *       values equal to the base/inherited event are dropped, so an
 *       all-base save clears the edit)
 *   { action: "reset",  id }                — drop all edits for the event
 *                                             (on a curator-ADDED event,
 *                                             reset REMOVES the event; on an
 *                                             inherited event it just drops
 *                                             the local edit — the event
 *                                             stays inherited)
 *   { action: "add",    event: {...} }      — add a new event. Requires
 *                                             title/start/venue; id is
 *                                             slugified + de-duped against
 *                                             base, added, AND inherited ids.
 *   { action: "remove", id }                — delete the event from THIS
 *       calendar for everyone, owner included ("it was a mistake"). On a
 *       curator-ADDED event this deletes the added entry outright (same as
 *       reset); on a base or inherited event it lands on the overlay's
 *       removed list — hides/edits are left in place so an unremove
 *       restores the event exactly as it was. Inherited events: LOCAL
 *       removal — the parent calendar keeps the event.
 *   { action: "unremove", id }              — take it back off the removed
 *                                             list (the undo).
 *
 * 401 without a session, 403 for signed-in non-owners, 400 on bad input.
 * Returns { ok: true, overlay } on success ({ ok, id, event, overlay } for add).
 */
export function makeOverlayHandler(calId) {
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
      // Composed base: own base events + inherited parent events, so
      // hide/edit/reset target inherited ids and add de-dupes against them.
      base = await loadComposedBase(env, new URL(request.url).origin, calId);
    } catch {
      return json({ ok: false, error: 'calendar data unavailable' }, 502);
    }
    const overlay = await loadOverlayFor(env, calId);

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
      await env.WHEN_CAL.put(calKey(calId), JSON.stringify(overlay));
      return json({ ok: true, id, event: ev, overlay }, 200, { 'Cache-Control': 'no-store' });
    }

    const id = body && body.id;
    if (typeof id !== 'string' || !id || id.length > 200) {
      return json({ ok: false, error: 'missing or invalid id' }, 400);
    }
    // hide/edit/reset/remove apply to base events, inherited events, AND
    // curator-added events. unremove additionally accepts any id already on
    // the removed list (the base asset may have changed underneath it).
    const addedEv = overlay.added[id];
    const baseEv = (base.events || []).find((e) => e.id === id) || addedEv;
    if (!baseEv && !(action === 'unremove' && overlay.removed[id])) {
      return json({ ok: false, error: 'unknown event id' }, 400);
    }

    if (action === 'remove') {
      if (addedEv) {
        // curator-added events are deleted outright (mirrors reset)
        delete overlay.added[id];
        delete overlay.hidden[id];
        delete overlay.edits[id];
      } else {
        overlay.removed[id] = true;
      }
    } else if (action === 'unremove') {
      delete overlay.removed[id];
    } else if (action === 'hide') {
      overlay.hidden[id] = true;
    } else if (action === 'unhide') {
      delete overlay.hidden[id];
    } else if (action === 'reset') {
      if (addedEv) {
        // reset on an added event removes it entirely
        delete overlay.added[id];
        delete overlay.hidden[id];
      }
      // on a base or inherited event this just drops the local edit —
      // an inherited event remains inherited
      delete overlay.edits[id];
    } else if (action === 'edit') {
      const res = validateEdit(body.fields, baseEv);
      if (res.error) return json({ ok: false, error: res.error }, 400);
      if (Object.keys(res.fields).length) overlay.edits[id] = res.fields;
      else delete overlay.edits[id];
    }

    await env.WHEN_CAL.put(calKey(calId), JSON.stringify(overlay));
    return json({ ok: true, overlay }, 200, { 'Cache-Control': 'no-store' });
  }

  /** Any other method (GET, etc.): explicit 405 instead of asset fallback. */
  function onRequest() {
    return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'POST, PATCH' });
  }

  return { onRequestPost: handle, onRequestPatch: handle, onRequest };
}

/* ---------------- public merged JSON ---------------- */

/**
 * GET /data/<id>.json — public calendar JSON.
 * Intercepts the static asset path and serves the MERGED (composed) view:
 * inherited events included, curator edits applied, hidden events excluded.
 * Same shape as the static file, so the browser page and any external
 * consumers keep working unchanged.
 */
export function makePublicJsonHandler(calId) {
  async function onRequest(context) {
    const method = context.request.method;
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    try {
      const origin = new URL(context.request.url).origin;
      const { data } = await loadComposed(context.env, origin, calId);
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
  return { onRequest };
}
