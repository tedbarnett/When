/**
 * when-ingest generic crawler — iCalendar (.ics) feeds (issue #13, P1 / Tier C).
 *
 * Given a `sources` row (kind 'ics', crawl_url set), fetches the feed and
 * parses VEVENT blocks into raw candidates for normalize.js. Hand-rolled
 * parser on purpose (no npm deps) covering what venue calendars actually
 * emit (The Events Calendar, Squarespace, Google Calendar exports):
 *   - line unfolding (continuation lines start with space/tab, RFC 5545 §3.1)
 *   - DTSTART/DTEND forms: UTC ('...Z'), TZID=America/New_York (and other
 *     TZIDs — treated as NY wall clock; every source here is a NYC venue),
 *     and date-only (VALUE=DATE)
 *   - SUMMARY / LOCATION / URL with \\ \; \, \n text unescaping
 *
 * Window: events in the past or more than 120 days out are skipped.
 *
 * Legal posture (issue #13): facts only — no images (ATTACH ignored), no
 * DESCRIPTION prose (never read into blurb).
 */

import { fetchWithTimeout, stripHtml } from './jsonld.js';

const MAX_BYTES = 1_500_000;
const MAX_DAYS_OUT = 120;

/** Unfold RFC 5545 folded lines: CRLF followed by space/tab is a wrap. */
export function unfoldLines(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** "SUMMARY;LANGUAGE=en:Foo" -> { name, params: {LANGUAGE:'EN'}, value }. */
function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = left.split(';');
  const name = parts[0].trim().toUpperCase();
  const params = {};
  for (let p = 1; p < parts.length; p++) {
    const eq = parts[p].indexOf('=');
    if (eq > 0) params[parts[p].slice(0, eq).trim().toUpperCase()] = parts[p].slice(eq + 1).trim();
  }
  return { name, params, value };
}

/** TEXT value unescaping (RFC 5545 §3.3.11). */
function unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One DTSTART/DTEND property -> NY-local ISO string (via helpers) or ''.
 * dateOnly flag comes back so DTEND exclusivity can be handled by the caller.
 */
export function icsDateToISO(prop, helpers) {
  const v = String(prop.value).trim();
  // Date-only: VALUE=DATE or a bare 8-digit value.
  if ((prop.params.VALUE === 'DATE' && /^\d{8}$/.test(v)) || /^\d{8}$/.test(v)) {
    const iso = v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8);
    return { iso: helpers.nyISOFromLocal(iso + 'T00:00'), dateOnly: true };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return { iso: '', dateOnly: false };
  const local = m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00');
  if (m[7]) {
    // UTC instant -> NY-local equivalent.
    const d = new Date(local + 'Z');
    return { iso: isNaN(d.getTime()) ? '' : helpers.nyISOFromDate(d), dateOnly: false };
  }
  // TZID=America/New_York, other TZIDs, or floating: NYC venues publish NY
  // wall-clock times; treat the value as NY-local.
  return { iso: helpers.nyISOFromLocal(local), dateOnly: false };
}

function nyToday(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now || new Date());
}

/** Days from NY-today to the ISO datetime's NY date (negative = past). */
function daysOutISO(iso, todayKey) {
  const a = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  const b = new Date(todayKey + 'T12:00:00Z');
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Parse an ICS document into raw candidates (facts only).
 * Exported separately so the harness/tests can run it on fixture text.
 */
export function parseICS(text, source, helpers, now) {
  const today = nyToday(now);
  const out = [];
  let ev = null; // props of the VEVENT being read, or null
  for (const line of unfoldLines(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) { ev = {}; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (ev) {
        const raw = veventToRaw(ev, source, helpers, today);
        if (raw) out.push(raw);
      }
      ev = null;
      continue;
    }
    if (!ev) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (['DTSTART', 'DTEND', 'SUMMARY', 'LOCATION', 'URL', 'STATUS'].includes(p.name)) {
      ev[p.name] = p;
    }
  }
  return out;
}

function veventToRaw(ev, source, helpers, today) {
  if (!ev.DTSTART || !ev.SUMMARY) return null;
  if (ev.STATUS && /CANCELLED/i.test(ev.STATUS.value)) return null;
  const start = icsDateToISO(ev.DTSTART, helpers);
  if (!start.iso) return null;
  const days = daysOutISO(start.iso, today);
  if (days < 0 || days > MAX_DAYS_OUT) return null;

  let end = '';
  if (ev.DTEND) {
    const e = icsDateToISO(ev.DTEND, helpers);
    if (e.iso) {
      if (e.dateOnly) {
        // DTEND for all-day events is exclusive: a one-day event has
        // DTEND = start+1. Roll back a day; same-day means "no end".
        const d = new Date(e.iso.slice(0, 10) + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        const endDay = d.toISOString().slice(0, 10);
        if (endDay > start.iso.slice(0, 10)) end = helpers.nyISOFromLocal(endDay + 'T23:59');
      } else if (e.iso > start.iso) {
        end = e.iso;
      }
    }
  }

  const url = ev.URL ? String(ev.URL.value).trim() : '';
  return {
    title: stripHtml(unescapeText(ev.SUMMARY.value)),
    venue: ev.LOCATION ? stripHtml(unescapeText(ev.LOCATION.value)) : (source.name || ''),
    neighborhood: '',
    start: start.iso,
    end,
    price: '', // ICS carries no price facts
    url: /^https?:\/\//i.test(url) ? url.slice(0, 600) : source.crawl_url,
    source_url: source.crawl_url,
    image: '', image_source: '', // never scraped images
    blurb: '', blurb_origin: 'none', // DESCRIPTION is never read
  };
}

/**
 * Crawl one ics source.
 * @returns {Promise<{candidates: object[], status: string}>}
 *          status: 'ok:N' | 'blocked'; throws on other errors
 */
export async function crawl(source, helpers) {
  const res = await fetchWithTimeout(source.crawl_url);
  if (res.status === 403) return { candidates: [], status: 'blocked' };
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let text = await res.text();
  if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an ICS document');
  const candidates = parseICS(text, source, helpers);
  return { candidates, status: 'ok:' + candidates.length };
}
