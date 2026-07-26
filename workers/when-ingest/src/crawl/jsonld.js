/**
 * when-ingest generic crawler — schema.org Event JSON-LD from a venue page
 * (issue #13, P1 / Tier C).
 *
 * Given a `sources` row (kind 'jsonld', crawl_url set), fetches the page and
 * extracts EVERY schema.org/Event node from its JSON-LD blocks (including
 * @graph, arrays, ItemList wrappers) into raw candidates for normalize.js.
 *
 * The JSON-LD parsing core (event-type matching, recursive collection,
 * offers→price) is copied from functions/api/calendars/teds-nyc/import.js
 * (extractJsonLd and friends) — that module returns only the single BEST
 * event for the one-event import flow, while this crawler needs all of them,
 * so the shared walk lives here rather than refactoring import.js (its
 * behavior must not change). Keep the two in sync if the type list grows.
 *
 * Legal posture (issue #13): facts only —
 *   - image / image_source stay empty (no scraped images, ever)
 *   - blurb stays '' with blurb_origin 'none' (never copy description prose)
 *   - robots.txt honored (Disallow for `*` and our UA), honest User-Agent,
 *     no bot-wall circumvention: HTTP 403 → status 'blocked', full stop.
 */

import { boroughFor, nycLatLon } from '../geo.js';

export const USER_AGENT = 'When.org events bot (+https://when.org/bot)';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_500_000; // 1.5 MB page cap
const MAX_DAYS_OUT = 120; // ignore events further out (and in the past)

/* ------------------------------ robots.txt ------------------------------ */

/**
 * Parse robots.txt into { star: [paths], us: [paths] | null } Disallow lists.
 * `us` is null when no group names our UA (fall back to `*`). Group parsing
 * follows the de-facto standard: consecutive User-agent lines share the
 * rules that follow, until the next User-agent block.
 */
export function parseRobots(txt) {
  const star = [];
  let us = null;
  let agents = [];
  let rulesSeen = false;
  for (const rawLine of String(txt).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (rulesSeen) { agents = []; rulesSeen = false; }
      agents.push(value.toLowerCase());
    } else if (field === 'disallow') {
      rulesSeen = true;
      for (const a of agents) {
        if (a === '*') { if (value) star.push(value); }
        else if (USER_AGENT.toLowerCase().includes(a)) {
          if (us === null) us = [];
          if (value) us.push(value);
        }
      }
    } else if (field === 'allow' || field === 'crawl-delay' || field === 'sitemap') {
      if (field !== 'sitemap') rulesSeen = true;
    }
  }
  return { star, us };
}

/** True when `path` is blocked by the parsed robots rules. */
export function robotsDisallowed(rules, path) {
  const list = rules.us !== null ? rules.us : rules.star;
  return list.some((prefix) => path.startsWith(prefix));
}

/**
 * Fetch + cache robots.txt per origin for this run.
 * @param {Map<string, object>} cache origin -> parsed rules
 * @returns {Promise<boolean>} true when crawling `url` is allowed
 */
export async function robotsAllows(url, cache, fetchFn) {
  const u = new URL(url);
  let rules = cache.get(u.origin);
  if (!rules) {
    try {
      const res = await (fetchFn || fetchWithTimeout)(u.origin + '/robots.txt');
      // Missing/unreadable robots.txt (incl. 404) = no restrictions.
      rules = res.ok ? parseRobots(await res.text()) : { star: [], us: null };
    } catch {
      rules = { star: [], us: null };
    }
    cache.set(u.origin, rules);
  }
  return !robotsDisallowed(rules, u.pathname + u.search);
}

/* ------------------------- fetch with guardrails ------------------------ */

export async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/calendar,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* --------------- JSON-LD Event extraction (all events) ------------------ */
/* Copied from functions/api/calendars/teds-nyc/import.js (extractJsonLd     */
/* core) — see the header comment for why it's duplicated here.             */

const EVENT_TYPE_RE = /(^|\b)(Event|Festival|MusicEvent|TheaterEvent|ComedyEvent|DanceEvent|ScreeningEvent|ExhibitionEvent|SocialEvent|SportsEvent|FoodEvent|LiteraryEvent|EducationEvent|VisualArtsEvent|ChildrensEvent|BusinessEvent|CourseInstance)$/;

function isEventType(node) {
  const t = node['@type'];
  const types = Array.isArray(t) ? t : t ? [t] : [];
  return types.some((x) => typeof x === 'string' && EVENT_TYPE_RE.test(x.replace(/^https?:\/\/schema\.org\//i, '')));
}

function collectEvents(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectEvents(n, out, depth + 1);
    return;
  }
  if (isEventType(node)) out.push(node);
  for (const key of ['@graph', 'itemListElement', 'item', 'subEvent', 'mainEntity']) {
    if (node[key]) collectEvents(node[key], out, depth + 1);
  }
}

/** ALL schema.org/Event objects from every JSON-LD block on the page. */
export function extractAllJsonLdEvents(html) {
  const found = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rawTxt = m[1].trim();
    if (!rawTxt) continue;
    let doc = null;
    try {
      doc = JSON.parse(rawTxt);
    } catch {
      try { doc = JSON.parse(rawTxt.replace(/[\u0000-\u001f]+/g, ' ')); } catch { continue; }
    }
    collectEvents(doc, found, 0);
  }
  return found;
}

function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const s = firstString(x); if (s) return s; } return ''; }
  if (v && typeof v === 'object') return firstString(v.url || v['@id'] || v.name || '');
  return '';
}

/* -------------------------- field normalization ------------------------- */

/** "TITLE <br>with markup &amp; entities" -> plain text (venue pages love <br>). */
export function stripHtml(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => {
      const c = parseInt(d, 10);
      return c > 31 && c < 65536 ? String.fromCharCode(c) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a schema.org startDate/endDate to NY-local ISO.
 * Handles: date-only '2026-08-01', naive '2026-08-01T19:30[:00]' (treated as
 * NY wall clock — venue pages publish local time), and zoned ISO ('Z' or
 * ±HH:MM offset, converted to the NY-local equivalent).
 * Returns '' when unparseable.
 */
export function normalizeLdDate(v, helpers) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return helpers.nyISOFromLocal(s + 'T00:00');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return helpers.nyISOFromLocal(s);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return helpers.nyISOFromDate(d);
  }
  return '';
}

/** offers.price -> '$N' per the P1 spec (facts only; no ranges/currency games). */
export function priceFromOffers(offers) {
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (!o || typeof o !== 'object') return '';
  const p = o.price;
  if (p == null || p === '' || p === 0 || p === '0') return '';
  const s = String(p).trim();
  return s.startsWith('$') ? s : '$' + s;
}

/** Absolute http(s) URL or ''. Relative values resolve against the page. */
function absUrl(v, baseUrl) {
  const s = firstString(v).trim();
  if (!s) return '';
  try {
    const u = new URL(s, baseUrl);
    return /^https?:$/.test(u.protocol) ? u.href.slice(0, 600) : '';
  } catch {
    return '';
  }
}

/** Days from NY-today to the ISO date (negative = past). */
function daysOut(iso, helpers) {
  const today = new Date(helpers.nyISOFromLocal(nyToday() + 'T00:00'));
  const d = new Date(iso);
  return Math.floor((d.getTime() - today.getTime()) / 86_400_000);
}

function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Map one JSON-LD Event node to the raw candidate shape (facts only). */
export function ldEventToRaw(ld, source, helpers) {
  const start = normalizeLdDate(ld.startDate, helpers);
  if (!start) return null;
  const days = daysOut(start, helpers);
  if (days < 0 || days > MAX_DAYS_OUT) return null;

  const loc = Array.isArray(ld.location) ? ld.location[0] : ld.location;
  let venue = '';
  if (typeof loc === 'string') venue = loc;
  else if (loc && typeof loc === 'object') venue = firstString(loc.name) || '';
  if (!venue) venue = source.name || '';

  // Geo facts when the page publishes them: location.geo.{latitude,longitude}
  // (GeoCoordinates), borough from location.address postalCode first,
  // addressLocality fallback. All optional — nulls/'' when absent.
  let geo = { lat: null, lon: null };
  let borough = '';
  if (loc && typeof loc === 'object') {
    const g = Array.isArray(loc.geo) ? loc.geo[0] : loc.geo;
    if (g && typeof g === 'object') geo = nycLatLon(g.latitude, g.longitude);
    const addr = Array.isArray(loc.address) ? loc.address[0] : loc.address;
    if (addr && typeof addr === 'object') {
      // postalCode is occasionally a number — keep scalars as-is (boroughFor
      // stringifies), unwrap only nested objects/arrays.
      const postal = typeof addr.postalCode === 'object' ? firstString(addr.postalCode) : addr.postalCode;
      const cityName = typeof addr.addressLocality === 'object' ? firstString(addr.addressLocality) : addr.addressLocality;
      borough = boroughFor(postal, cityName);
    }
  }

  return {
    title: stripHtml(firstString(ld.name)),
    venue: stripHtml(venue),
    neighborhood: borough,
    lat: geo.lat,
    lon: geo.lon,
    start,
    end: normalizeLdDate(ld.endDate, helpers),
    price: priceFromOffers(ld.offers),
    url: absUrl(ld.url, source.crawl_url) || source.crawl_url,
    source_url: source.crawl_url,
    image: '', image_source: '', // never scraped images
    blurb: '', blurb_origin: 'none', // never copied prose
  };
}

/**
 * Crawl one jsonld source.
 * @param {{id: string, name: string, crawl_url: string}} source sources row
 * @param {{nyISOFromLocal, nyISOFromDate}} helpers from normalize.js
 * @param {Map} robotsCache per-run robots.txt cache (origin -> rules)
 * @returns {Promise<{candidates: object[], status: string}>}
 *          status: 'ok:N' | 'robots_disallow' | 'blocked'; throws on other errors
 */
export async function crawl(source, helpers, robotsCache) {
  if (!(await robotsAllows(source.crawl_url, robotsCache))) {
    return { candidates: [], status: 'robots_disallow' };
  }
  const res = await fetchWithTimeout(source.crawl_url);
  if (res.status === 403) return { candidates: [], status: 'blocked' };
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let html = await res.text();
  if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);

  const candidates = [];
  for (const ld of extractAllJsonLdEvents(html)) {
    const raw = ldEventToRaw(ld, source, helpers);
    if (raw && raw.title) candidates.push(raw);
  }
  return { candidates, status: 'ok:' + candidates.length };
}
