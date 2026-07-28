// GET /api/event.ics — a one-event .ics FORMATTER for personal calendars.
//
// The ideas pages are owner-gated (candidate data never leaves an authed
// session), so their "add to Apple Calendar" buttons pass the event fields
// the owner is already looking at as query params and this endpoint simply
// formats them as a downloadable VEVENT. It reads NO calendar or ideas
// data, so it stays anonymous without leaking anything: you get back
// exactly (and only) what you sent.
//
// Public calendar events have a nicer canonical route with the same output
// shape: when.org/<cal>/{id}.ics (see _lib/eventPage.js).
//
// Params: title* start* (YYYY-MM-DD = all-day, or YYYY-MM-DDTHH:MM[:SS]
// wall time — any trailing UTC offset is ignored, TZID semantics) plus
// optional end, tz (IANA zone from the feed's TZINFO table; default
// America/New_York), venue, neighborhood, blurb, price, url, uid.
import { TZINFO, singleEventIcsResponse, icsSlug } from "../_lib/ics.js";

var LIMITS = { title: 200, venue: 200, neighborhood: 120, price: 60, blurb: 600, url: 600, uid: 120 };

export async function onRequest(context) {
  var request = context.request;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }
  var q = new URL(request.url).searchParams;
  var get = function (k) { return String(q.get(k) || "").slice(0, LIMITS[k] || 200).trim(); };

  var title = get("title");
  var start = normStamp(q.get("start"));
  var end = normStamp(q.get("end"));
  if (!title) return bad("title is required");
  if (!start) return bad("start must be YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]");
  if (q.get("end") && !end) return bad("end must be YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]");

  var tz = String(q.get("tz") || "America/New_York");
  if (!TZINFO[tz]) return bad("unknown tz");

  var url = get("url");
  if (url && !/^https?:\/\//.test(url)) url = "";

  var ev = {
    id: icsSlug(get("uid") || title + "-" + start.slice(0, 10)),
    title: title,
    venue: get("venue"),
    neighborhood: get("neighborhood"),
    price: get("price"),
    blurb: get("blurb"),
    url: url,
    start: start,
  };
  if (end) ev.end = end;

  return singleEventIcsResponse(ev, {
    tzid: tz,
    prodId: "When Event",
    filename: icsSlug(ev.id) + ".ics",
    cacheControl: "no-store",
  });
}

/** Normalize a start/end param to a date key or a seconds-precision local
 * stamp; anything malformed returns "" (rejected). Trailing offsets/Z from
 * stored event starts are dropped — wall time + TZID is the contract. */
function normStamp(v) {
  var s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?/);
  if (!m) return "";
  return m[1] + (m[2] || ":00");
}

function bad(msg) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}
