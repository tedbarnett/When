/**
 * When.org calendar overlay helpers.
 *
 * Each calendar's base lives in the repo as a static asset
 * (public/data/<id>.json). Curator changes — hidden events, in-place edits,
 * and curator-added events — live in KV (binding WHEN_CAL) as one overlay
 * document per calendar:
 *
 *   key "cal:<id>" = {
 *     hidden: { <eventId>: true },
 *     edits:  { <eventId>: { title?, venue?, neighborhood?, price?,
 *                            blurb?, start?, url?, image? } },
 *     added:  { <eventId>: { full event object — curator-imported events
 *                            that don't exist in the base JSON } },
 *     removed: { <eventId>: true }  — events deleted from THIS calendar for
 *                            everyone, owner included ("it was a mistake").
 *                            Unlike hidden, removed events vanish from the
 *                            public page, ICS, JSON API, AND owner/admin
 *                            views; only overlay action "unremove" brings
 *                            one back.
 *   }
 *
 * COMPOSITION (issue #15): a calendar may declare `extends: <parentId>` in
 * the CALENDARS registry. Its merged output is then
 *
 *   applyOverlay( parentPublicEvents ∪ ownBaseEvents, ownOverlay )
 *
 * where parentPublicEvents is the parent's own merged PUBLIC view (parent
 * base + parent overlay, parent hides applied) and duplicate ids resolve
 * child-wins. Inherited events behave exactly like base events for the
 * child: the child's overlay can hide them (local hide — the parent keeps
 * them), edit them in place, and "reset" drops the local edit while the
 * event remains inherited. In owner/admin views (opts.includeHidden)
 * inherited events carry _inherited: true; public output stays clean.
 *
 * Every consumer (public JSON, ICS feed, per-event pages, admin API) merges
 * through this module so they never disagree.
 *
 * This directory is underscore-prefixed so Pages Functions never routes it.
 */

/** Registry of known calendars. extends = parent calendar id (depth 1). */
export const CALENDARS = {
  'teds-nyc': { title: "Ted's NYC", extends: 'basics-nyc' },
  'basics-nyc': { title: 'NYC Basics', extends: null },
  'teds-dublin': { title: "Ted's Dublin", extends: null },
};

/**
 * Registry of known cities (multi-city support). Each entry:
 *   label     — display name
 *   timeZone  — IANA zone; "today" and day-bucketing for the city's ideas
 *               pool use THIS zone, never the viewer's clock
 *   calendars — calendar ids checked for the ideas "added" detection,
 *               preferred label first (base layers before composers)
 *   page      — the city's flagship calendar path
 */
export const CITIES = {
  nyc: {
    label: 'New York',
    timeZone: 'America/New_York',
    calendars: ['basics-nyc', 'teds-nyc'],
    page: '/teds-nyc',
  },
  dublin: {
    label: 'Dublin',
    timeZone: 'Europe/Dublin',
    calendars: ['teds-dublin'],
    page: '/teds-dublin',
  },
};

/** KV key for a calendar's overlay document. */
export function calKey(id) {
  return 'cal:' + id;
}

/** Back-compat: the original single-calendar constant. */
export const CAL_KEY = calKey('teds-nyc');

/**
 * Pure merge: apply an overlay to a base calendar document.
 * - edits are shallow-merged onto matching events
 * - hidden events are filtered OUT unless opts.includeHidden
 * - with opts.includeHidden, events gain _hidden / _edited marker flags
 *   (owner/admin view only — never in public output)
 * Returns a new document; the input is not mutated.
 */
export function applyOverlay(data, overlay, opts) {
  const includeHidden = !!(opts && opts.includeHidden);
  const hidden = (overlay && overlay.hidden) || {};
  const edits = (overlay && overlay.edits) || {};
  const added = (overlay && overlay.added) || {};
  const removed = (overlay && overlay.removed) || {};
  const events = [];
  const baseIds = {};
  for (const base of (data && data.events) || []) {
    baseIds[base.id] = true;
    // Removed events are gone for EVERYONE, owner included — no marker,
    // no includeHidden escape hatch. Undo goes through action "unremove".
    if (removed[base.id]) continue;
    const isHidden = !!hidden[base.id];
    if (isHidden && !includeHidden) continue;
    const edit = edits[base.id];
    const ev = edit ? { ...base, ...edit, id: base.id } : { ...base };
    if (includeHidden) {
      if (isHidden) ev._hidden = true;
      if (edit && Object.keys(edit).length) ev._edited = true;
    }
    events.push(ev);
  }
  // Curator-added events: same hide/edit machinery as base events. A base
  // event with the same id always wins (add enforces uniqueness anyway).
  for (const id of Object.keys(added)) {
    if (baseIds[id]) continue;
    if (removed[id]) continue; // defensive: added events are deleted outright, but honor removed anyway
    const src = added[id];
    if (!src || typeof src !== 'object' || !src.start) continue;
    const isHidden = !!hidden[id];
    if (isHidden && !includeHidden) continue;
    const edit = edits[id];
    const ev = edit ? { ...src, ...edit, id } : { ...src, id };
    if (includeHidden) {
      ev._added = true;
      if (isHidden) ev._hidden = true;
      if (edit && Object.keys(edit).length) ev._edited = true;
    }
    events.push(ev);
  }
  // Edits can move start times across days; keep output chronologically sorted.
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { ...data, events };
}

/** Read a calendar's overlay document from KV. Always returns {hidden, edits, added, removed}. */
export async function loadOverlayFor(env, id) {
  const empty = { hidden: {}, edits: {}, added: {}, removed: {} };
  if (!env || !env.WHEN_CAL) return empty;
  try {
    const raw = await env.WHEN_CAL.get(calKey(id));
    if (!raw) return empty;
    const o = JSON.parse(raw);
    return {
      hidden: (o && typeof o.hidden === 'object' && o.hidden) || {},
      edits: (o && typeof o.edits === 'object' && o.edits) || {},
      added: (o && typeof o.added === 'object' && o.added) || {},
      removed: (o && typeof o.removed === 'object' && o.removed) || {},
    };
  } catch {
    return empty;
  }
}

/** Back-compat: Ted's NYC overlay. */
export function loadOverlay(env) {
  return loadOverlayFor(env, 'teds-nyc');
}

/** Fetch a calendar's base JSON asset (bypasses Functions routing, so no recursion). */
export async function loadBaseDataFor(env, origin, id) {
  const res = await env.ASSETS.fetch(new URL('/data/' + id + '.json', origin));
  if (!res.ok) throw new Error('calendar data unavailable');
  return res.json();
}

/** Back-compat: Ted's NYC base JSON. */
export function loadBaseData(env, origin) {
  return loadBaseDataFor(env, origin, 'teds-nyc');
}

/**
 * The EFFECTIVE base for a calendar: its own base events plus, when the
 * registry declares `extends`, the parent's merged public events (parent
 * hides applied, parent edits baked in). Duplicate ids resolve child-wins.
 * With opts.markInherited, inherited events carry _inherited: true (used by
 * owner/admin views; never set for public output).
 * Returns the base document (same envelope as the calendar's own base).
 */
export async function loadComposedBase(env, origin, id, opts) {
  const entry = CALENDARS[id] || {};
  const parentId = entry.extends || null;
  const markInherited = !!(opts && opts.markInherited);
  if (!parentId) return loadBaseDataFor(env, origin, id);
  const [ownBase, parentBase, parentOverlay] = await Promise.all([
    loadBaseDataFor(env, origin, id),
    loadBaseDataFor(env, origin, parentId),
    loadOverlayFor(env, parentId),
  ]);
  // Parent contributes its PUBLIC merged view: parent-hidden events are
  // gone for subscribers, parent edits and parent-added events flow down.
  const parentPub = applyOverlay(parentBase, parentOverlay);
  if (!(parentPub.events || []).length) return ownBase;
  const ownIds = {};
  for (const e of ownBase.events || []) ownIds[e.id] = true;
  const inherited = [];
  for (const e of parentPub.events || []) {
    if (ownIds[e.id]) continue; // duplicate id: the child calendar wins
    inherited.push(markInherited ? { ...e, _inherited: true } : e);
  }
  return { ...ownBase, events: inherited.concat(ownBase.events || []) };
}

/**
 * Load a calendar's composed base + its own overlay and merge.
 * Returns { data, events, overlay } where data is the full merged document.
 * opts.includeHidden=true keeps hidden events (marked _hidden/_edited/
 * _added/_inherited) for owner views.
 */
export async function loadComposed(env, origin, id, opts) {
  const includeHidden = !!(opts && opts.includeHidden);
  const [base, overlay] = await Promise.all([
    loadComposedBase(env, origin, id, { markInherited: includeHidden }),
    loadOverlayFor(env, id),
  ]);
  const data = applyOverlay(base, overlay, opts);
  return { data, events: data.events, overlay };
}

/**
 * Back-compat: Ted's NYC merged view. Since teds-nyc now extends basics-nyc,
 * this is the composed view — a no-op while NYC Basics is empty.
 */
export function loadMergedEvents(env, origin, opts) {
  return loadComposed(env, origin, 'teds-nyc', opts);
}
