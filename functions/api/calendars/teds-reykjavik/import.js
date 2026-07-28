/**
 * POST /api/calendars/teds-reykjavik/import — owner-only paste-a-URL event importer.
 *
 * Body: { url }. Fetches the page server-side and EXTRACTS an event — it never
 * saves anything (saving goes through the overlay endpoint's action:"add").
 *
 * Pass 1 (cheap): schema.org/Event from JSON-LD script tags (handles @graph,
 * arrays of events — picks the most complete), supplemented by og:title /
 * og:image / og:description / canonical.
 *
 * Pass 2 (AI fallback, only when pass 1 lacks a usable name+startDate):
 * Anthropic Messages API (env.ANTHROPIC_API_KEY) over the stripped page text.
 * The model must answer strict JSON, or {"error":"no_event"} when the page has
 * no real event (passed through as 422). Guardrail: the image is NEVER taken
 * from the AI answer — real photos only, from JSON-LD image / og:image.
 *
 * 401 anon, 403 non-owner, 405 other methods, 400 bad input, 415 non-HTML,
 * 422 no event found, 502 fetch/AI failure.
 *
 * Returns { ok:true, event:{...}, source:"jsonld"|"ai" }.
 */
import { readSession, json, OWNER_EMAIL } from '../../../_lib/session.js';

const UA = 'When.org importer (+https://when.org)';
const FETCH_TIMEOUT_MS = 10000;
const MAX_BYTES = 1536 * 1024; // ~1.5 MB
const AI_MODEL = 'claude-sonnet-4-6';
const AI_MAX_TOKENS = 1000;
const AI_TEXT_CAP = 12000;

/* ---------------- Reykjavik time helpers ---------------- */

function nyOffset(d) {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Atlantic/Reykjavik',
      timeZoneName: 'longOffset',
    }).format(d);
    const m = s.match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (m) return m[1] + ':' + (m[2] || '00');
  } catch {}
  return '+00:00';
}

/** Rebuild a Date as 'YYYY-MM-DDTHH:MM:SS±HH:MM' in Atlantic/Reykjavik. */
function toNyIso(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Atlantic/Reykjavik',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${nyOffset(d)}`;
}

/**
 * Normalize a startDate-ish string to ISO8601 with the Reykjavik offset (+00:00, no DST).
 * Accepts full ISO (any offset / Z — converted to Reykjavik wall time), naive
 * datetimes (assumed Reykjavik local), and bare dates (midnight, time TBD).
 * Returns '' when unusable.
 */
export function normalizeStart(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  let m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?([+-]\d{2}:?\d{2}|Z)$/);
  if (m) {
    const off = m[4] === 'Z' ? 'Z' : m[4].includes(':') ? m[4] : m[4].slice(0, 3) + ':' + m[4].slice(3);
    if (off === '+00:00') {
      return m[1] + 'T' + m[2] + (m[3] ? m[3].slice(0, 3) : ':00') + off;
    }
    const d = new Date(m[1] + 'T' + m[2] + (m[3] ? m[3].slice(0, 3) : ':00') + off);
    if (isNaN(d)) return '';
    return toNyIso(d);
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
  if (m) {
    // naive: assume Reykjavik local; offset approximated from the date itself
    const dt = m[1] + 'T' + m[2] + (m[3] || ':00');
    return dt + nyOffset(new Date(dt + 'Z'));
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (m) {
    // date only — midnight as "time TBD"; the review card lets the curator fix it
    return m[1] + 'T00:00:00' + nyOffset(new Date(m[1] + 'T12:00:00Z'));
  }
  return '';
}

/* ---------------- HTML scraping helpers ---------------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => {
      const c = parseInt(n, 10);
      return c > 31 && c < 65536 ? String.fromCharCode(c) : ' ';
    });
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? (m[2] != null ? m[2] : m[3]) : '';
}

/** og:* + canonical supplements. */
export function extractSupplements(html) {
  const sup = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (attrOf(tag, 'property') || attrOf(tag, 'name')).toLowerCase();
    const content = attrOf(tag, 'content');
    if (!key || !content) continue;
    if (key === 'og:title' && !sup.title) sup.title = decodeEntities(content).trim();
    if (key === 'og:description' && !sup.description) sup.description = decodeEntities(content).trim();
    if (key === 'og:image' && !sup.image) sup.image = decodeEntities(content).trim();
    if (key === 'og:url' && !sup.url) sup.url = decodeEntities(content).trim();
  }
  const link = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i);
  if (link) {
    const href = attrOf(link[0], 'href');
    if (href) sup.canonical = decodeEntities(href).trim();
  }
  return sup;
}

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

function scoreEvent(ev) {
  let s = 0;
  if (ev.name) s += 4;
  if (ev.startDate) s += 4;
  if (ev.location) s += 2;
  if (ev.description) s += 1;
  if (ev.image) s += 1;
  if (ev.offers) s += 1;
  if (ev.endDate) s += 1;
  return s;
}

/** Best schema.org/Event object from all JSON-LD blocks, or null. */
export function extractJsonLd(html) {
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
  if (!found.length) return null;
  found.sort((a, b) => scoreEvent(b) - scoreEvent(a));
  return found[0];
}

function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const s = firstString(x); if (s) return s; } return ''; }
  if (v && typeof v === 'object') return firstString(v.url || v['@id'] || v.name || '');
  return '';
}

function priceFromOffers(offers) {
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (!o || typeof o !== 'object') return typeof offers === 'string' ? offers : '';
  const cur = typeof o.priceCurrency === 'string' && /USD/i.test(o.priceCurrency) ? '$' : '';
  const one = (p) => {
    const n = parseFloat(p);
    if (isNaN(n)) return String(p);
    if (n === 0) return 'Free';
    return cur + (n % 1 === 0 ? String(n) : n.toFixed(2));
  };
  if (o.price != null && o.price !== '') return one(o.price);
  if (o.lowPrice != null) {
    return o.highPrice != null && o.highPrice !== o.lowPrice
      ? one(o.lowPrice) + '–' + one(o.highPrice).replace(/^Free$/, cur + '0')
      : one(o.lowPrice);
  }
  return '';
}

/** Map a schema.org Event node to the importer's raw field shape. */
export function jsonldToRaw(ld) {
  const loc = Array.isArray(ld.location) ? ld.location[0] : ld.location;
  let venue = '', neighborhood = '';
  if (typeof loc === 'string') venue = loc;
  else if (loc && typeof loc === 'object') {
    venue = firstString(loc.name) || '';
    const addr = loc.address;
    if (addr && typeof addr === 'object') neighborhood = firstString(addr.addressLocality) || '';
    else if (typeof addr === 'string') neighborhood = addr.split(',')[0];
    if (/reykjavik|reykjav\u00edk/i.test(venue) && venue === neighborhood) neighborhood = '';
  }
  return {
    title: firstString(ld.name),
    blurb: typeof ld.description === 'string' ? ld.description : firstString(ld.description),
    venue,
    neighborhood,
    start: firstString(ld.startDate),
    end: firstString(ld.endDate),
    price: priceFromOffers(ld.offers),
    url: firstString(ld.url),
    image: firstString(ld.image),
  };
}

/* ---------------- normalization to the calendar event shape ---------------- */

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // fold accents: Cécile -> Cecile
    .toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60);
}

function httpUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^https?:\/\//i.test(s) ? s.slice(0, 600) : '';
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function truncBlurb(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

/**
 * Normalize raw extracted fields (+ og supplements) into the calendar's
 * event shape. Returns null when there's no usable title+start.
 */
export function normalizeEvent(raw, sup, pageUrl) {
  const title = stripTags(raw.title || (sup && sup.title) || '').slice(0, 200);
  const start = normalizeStart(raw.start);
  if (!title || !start) return null;
  const ev = {
    id: (slugify(title) || 'event') + '-' + start.slice(5, 7) + start.slice(8, 10),
    title,
    blurb: truncBlurb(stripTags(raw.blurb || (sup && sup.description) || ''), 140).slice(0, 600),
    venue: stripTags(raw.venue || '').slice(0, 200),
    neighborhood: stripTags(raw.neighborhood || '').slice(0, 120),
    start,
    price: stripTags(raw.price || '').slice(0, 60),
    url: httpUrl(raw.url) || httpUrl(sup && sup.canonical) || httpUrl(sup && sup.url) || httpUrl(pageUrl),
    image: httpUrl(raw.image) || httpUrl(sup && sup.image) || '',
    tags: [],
    geo: null,
  };
  const end = normalizeStart(raw.end);
  if (end && end > start) ev.end = end;
  return ev;
}

/* ---------------- AI fallback ---------------- */

/** Strip a page to readable text, capped for the model. */
export function stripHtmlToText(html) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|nav|footer|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|dd|dt|section|article|header)>/gi, '\n')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return s.slice(0, AI_TEXT_CAP);
}

async function aiExtract(env, pageText, pageUrl) {
  const today = toNyIso(new Date()).slice(0, 10);
  const prompt =
    'You extract ONE real-world event from a web page. Today is ' + today +
    ' (Reykjavik, Iceland). Page URL: ' + pageUrl + '\n\n' +
    'Answer with STRICT JSON only — no prose, no markdown fences. Shape:\n' +
    '{"title":"","venue":"","neighborhood":"","start":"ISO8601 with the +00:00 Reykjavik offset","end":"optional, same format","price":"e.g. Free, 3.900 kr, 5.000–9.000 kr","url":"the event page URL","blurb":"<=140 chars, strictly factual, from the page"}\n\n' +
    'Rules: never invent facts; omit or use "" for anything the page does not state. ' +
    'If the page describes no specific real event (or only a list/venue/homepage), answer exactly {"error":"no_event"}.\n\n' +
    'PAGE TEXT:\n' + pageText;
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    return { error: 'ai_failed' };
  }
  if (!res.ok) return { error: 'ai_failed' };
  let data;
  try { data = await res.json(); } catch { return { error: 'ai_failed' }; }
  const txt = (Array.isArray(data.content) ? data.content : [])
    .map((c) => (c && c.text) || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'ai_unparseable' };
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return { error: 'ai_unparseable' }; }
  if (!obj || typeof obj !== 'object' || obj.error) return { error: 'no_event' };
  return { raw: obj };
}

/* ---------------- page fetch ---------------- */

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      return { error: 'site_blocked', status: 502 };
    }
    if (!res.ok) return { error: 'the page returned ' + res.status, status: 502 };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return { error: 'not an HTML page (' + ct.split(';')[0] + ')', status: 415 };
    }
    if (!res.body || !res.body.getReader) {
      const t = await res.text();
      return { html: t.slice(0, MAX_BYTES) };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch {}
    const buf = new Uint8Array(Math.min(total, MAX_BYTES));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.byteLength, buf.length - off);
      buf.set(take === c.byteLength ? c : c.subarray(0, take), off);
      off += take;
      if (off >= buf.length) break;
    }
    return { html: new TextDecoder('utf-8', { fatal: false }).decode(buf) };
  } catch (e) {
    return {
      error: e && e.name === 'AbortError' ? 'the page took too long to load' : 'could not fetch the page',
      status: 502,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- handler ---------------- */

export async function onRequestPost({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  if (session.email !== OWNER_EMAIL) return json({ ok: false, error: 'forbidden' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON body' }, 400);
  }
  const url = body && typeof body.url === 'string' ? body.url.trim() : '';
  if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) {
    return json({ ok: false, error: 'url must be an http(s) link' }, 400);
  }

  const page = await fetchPage(url);
  if (page.error) return json({ ok: false, error: page.error }, page.status || 502);

  const sup = extractSupplements(page.html);

  // Pass 1: JSON-LD
  const ld = extractJsonLd(page.html);
  if (ld) {
    const ev = normalizeEvent(jsonldToRaw(ld), sup, url);
    if (ev) return json({ ok: true, event: ev, source: 'jsonld' }, 200, { 'Cache-Control': 'no-store' });
  }

  // Pass 2: AI fallback
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: 'ai unavailable' }, 503);
  const text = stripHtmlToText(page.html);
  if (text.length < 40) return json({ ok: false, error: 'no_event' }, 422);
  const ai = await aiExtract(env, text, url);
  if (ai.error === 'no_event') return json({ ok: false, error: 'no_event' }, 422);
  if (ai.error) return json({ ok: false, error: 'could not read the page with AI' }, 502);
  // Guardrail: images come only from page data (JSON-LD/og), never the model.
  const raw = { ...ai.raw, image: '' };
  const ev = normalizeEvent(raw, sup, url);
  if (!ev) return json({ ok: false, error: 'no_event' }, 422);
  return json({ ok: true, event: ev, source: 'ai' }, 200, { 'Cache-Control': 'no-store' });
}

/** Any other method: explicit 405 instead of asset fallback. */
export function onRequest() {
  return json({ ok: false, error: 'method not allowed' }, 405, { Allow: 'POST' });
}
