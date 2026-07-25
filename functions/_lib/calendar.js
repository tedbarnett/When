/**
 * When.org calendar overlay helpers.
 *
 * The base calendar lives in the repo as a static asset
 * (public/data/teds-nyc.json). Curator changes — hidden events and in-place
 * edits — live in KV (binding WHEN_CAL) as a single overlay document:
 *
 *   key "cal:teds-nyc" = {
 *     hidden: { <eventId>: true },
 *     edits:  { <eventId>: { title?, venue?, neighborhood?, price?,
 *                            blurb?, start?, url?, image? } }
 *   }
 *
 * Every consumer (public JSON, ICS feed, per-event pages, admin API) merges
 * through this module so they never disagree.
 *
 * This directory is underscore-prefixed so Pages Functions never routes it.
 */

export const CAL_KEY = 'cal:teds-nyc';

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
  const events = [];
  for (const base of (data && data.events) || []) {
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
  // Edits can move start times across days; keep output chronologically sorted.
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { ...data, events };
}

/** Read the overlay document from KV. Always returns {hidden, edits}. */
export async function loadOverlay(env) {
  const empty = { hidden: {}, edits: {} };
  if (!env || !env.WHEN_CAL) return empty;
  try {
    const raw = await env.WHEN_CAL.get(CAL_KEY);
    if (!raw) return empty;
    const o = JSON.parse(raw);
    return {
      hidden: (o && typeof o.hidden === 'object' && o.hidden) || {},
      edits: (o && typeof o.edits === 'object' && o.edits) || {},
    };
  } catch {
    return empty;
  }
}

/** Fetch the base JSON asset (bypasses Functions routing, so no recursion). */
export async function loadBaseData(env, origin) {
  const res = await env.ASSETS.fetch(new URL('/data/teds-nyc.json', origin));
  if (!res.ok) throw new Error('calendar data unavailable');
  return res.json();
}

/**
 * Load base data + overlay and merge.
 * Returns { data, events, overlay } where data is the full merged document.
 * opts.includeHidden=true keeps hidden events (marked) for owner views.
 */
export async function loadMergedEvents(env, origin, opts) {
  const [base, overlay] = await Promise.all([
    loadBaseData(env, origin),
    loadOverlay(env),
  ]);
  const data = applyOverlay(base, overlay, opts);
  return { data, events: data.events, overlay };
}
