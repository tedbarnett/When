// Shared ICS feed builder for When.org calendars (issue #15).
// Built from the same merged (composed) view that renders each web page
// (base JSON + inherited parent events + curator overlay from KV), so page,
// feed, and API never disagree. Hidden events are excluded; curator edits
// are applied.
//
// This directory is underscore-prefixed so Pages Functions never routes it.

import { loadComposed } from './calendar.js';

// Per-zone VTIMEZONE blocks + the city name appended to LOCATION lines.
// Events are authored as local wall time with the zone's offset baked into
// the ISO string, so the feed only needs the zone's standing DST rules.
// Exported: the personal-calendar endpoints share the same zone table.
export var TZINFO = {
  "America/New_York": {
    cityLabel: "New York",
    vtimezone: [
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "TZNAME:EDT",
      "DTSTART:19700308T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "TZNAME:EST",
      "DTSTART:19701101T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD"
    ]
  },
  "Europe/Dublin": {
    cityLabel: "Dublin",
    vtimezone: [
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0100",
      "TZNAME:IST",
      "DTSTART:19700329T010000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0000",
      "TZNAME:GMT",
      "DTSTART:19701025T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD"
    ]
  },
  "Atlantic/Reykjavik": {
    cityLabel: "Reykjavik",
    vtimezone: [
      // Iceland is UTC+0 year-round — no DST since 1968.
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "TZNAME:GMT",
      "DTSTART:19700101T000000",
      "END:STANDARD"
    ]
  }
};

/**
 * makeIcsHandler('teds-nyc', { calName: "Ted's NYC", prodId: 'Teds NYC',
 * filename: 'teds-nyc.ics', fallbackDesc: 'Curated NYC events',
 * tzid: 'America/New_York' (default) })
 * -> { onRequest } serving GET /<id>.ics
 */
export function makeIcsHandler(calId, opts) {
  var calName = (opts && opts.calName) || calId;
  var prodId = (opts && opts.prodId) || calName;
  var filename = (opts && opts.filename) || calId + ".ics";
  var fallbackDesc = (opts && opts.fallbackDesc) || "Curated NYC events";
  var TZID = (opts && opts.tzid && TZINFO[opts.tzid]) ? opts.tzid : "America/New_York";
  var tzinfo = TZINFO[TZID];

  async function onRequest(context) {
    if (context.request.method !== "GET" && context.request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    var data;
    try {
      var origin = new URL(context.request.url).origin;
      data = (await loadComposed(context.env, origin, calId)).data;
    } catch (e) {
      return new Response("Calendar data unavailable", { status: 502 });
    }

    var now = utcStamp(new Date());
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//When.org//" + prodId + "//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:" + calName,
      "X-WR-CALDESC:" + escapeText((data.calendar && data.calendar.description) || fallbackDesc),
      "X-WR-TIMEZONE:" + TZID,
      "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
      "BEGIN:VTIMEZONE",
      "TZID:" + TZID
    ].concat(tzinfo.vtimezone, ["END:VTIMEZONE"]);

    for (var i = 0; i < data.events.length; i++) {
      lines = lines.concat(veventLines(data.events[i], TZID, tzinfo, now));
    }

    lines.push("END:VCALENDAR");

    var body = lines.map(foldLine).join("\r\n") + "\r\n";
    return new Response(body, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="' + filename + '"',
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  return { onRequest };
}

// One event as VEVENT lines — shared by the feed and the per-event
// personal-calendar downloads so the two can never disagree.
// Timed events use DTSTART;TZID=<zone> wall time (never UTC-shifted);
// date-only starts (YYYY-MM-DD) become all-day events (VALUE=DATE, with
// the RFC 5545 exclusive DTEND one day past the last day).
export function veventLines(ev, TZID, tzinfo, now) {
  var lines = [];
  var descParts = [];
  if (ev.blurb) descParts.push(ev.blurb);
  if (ev.price) descParts.push("Price: " + ev.price);
  if (ev.url) descParts.push(ev.url);

  lines.push("BEGIN:VEVENT");
  lines.push("UID:" + ev.id + "@when.org");
  lines.push("DTSTAMP:" + now);
  if (isDateOnly(ev.start)) {
    var lastDay = isDateOnly(ev.end) ? ev.end : ev.start;
    lines.push("DTSTART;VALUE=DATE:" + dateStamp(ev.start));
    lines.push("DTEND;VALUE=DATE:" + dateStamp(plusDays(lastDay, 1)));
  } else {
    var start = localStamp(ev.start);
    var end = ev.end ? localStamp(ev.end) : localStamp(addHours(ev.start, 2));
    lines.push("DTSTART;TZID=" + TZID + ":" + start);
    lines.push("DTEND;TZID=" + TZID + ":" + end);
  }
  lines.push("SUMMARY:" + escapeText(ev.title));
  lines.push("DESCRIPTION:" + escapeText(descParts.join("\n")));
  lines.push("LOCATION:" + escapeText([ev.venue, ev.neighborhood, tzinfo.cityLabel].filter(Boolean).join(", ")));
  if (ev.url) lines.push("URL:" + ev.url);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * A complete one-event .ics download (the "add THIS event to your own
 * Apple Calendar" affordance). Served with Content-Disposition: attachment
 * so iOS Safari hands it straight to Apple Calendar. opts:
 * { tzid, prodId?, calName?, filename? }.
 */
export function singleEventIcsResponse(ev, opts) {
  var TZID = (opts && opts.tzid && TZINFO[opts.tzid]) ? opts.tzid : "America/New_York";
  var tzinfo = TZINFO[TZID];
  var prodId = (opts && opts.prodId) || "When Event";
  var filename = (opts && opts.filename) || icsSlug(ev.id || ev.title) + ".ics";
  var lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//When.org//" + prodId + "//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE",
    "TZID:" + TZID
  ].concat(tzinfo.vtimezone, ["END:VTIMEZONE"],
    veventLines(ev, TZID, tzinfo, utcStamp(new Date())),
    ["END:VCALENDAR"]);
  var body = lines.map(foldLine).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + filename + '"',
      "Cache-Control": (opts && opts.cacheControl) || "public, max-age=300",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/** Safe .ics filename slug from an event id or title. */
export function icsSlug(s) {
  s = String(s || "event");
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
  s = s.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "event";
}

function isDateOnly(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}

function dateStamp(key) {
  return String(key).replace(/-/g, "");
}

function plusDays(key, n) {
  var d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "2026-07-24T20:00:00-04:00" -> "20260724T200000" (already NY-local by authoring convention)
function localStamp(iso) {
  return iso.slice(0, 19).replace(/[-:]/g, "");
}

function addHours(iso, h) {
  var datePart = iso.slice(0, 10);
  var hour = parseInt(iso.slice(11, 13), 10) + h;
  var rest = iso.slice(13, 19);
  if (hour >= 24) {
    // roll the date forward; fine for late shows ending after midnight
    var d = new Date(datePart + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    datePart = d.toISOString().slice(0, 10);
    hour -= 24;
  }
  return datePart + "T" + String(hour).padStart(2, "0") + rest + "-04:00";
}

function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545: lines longer than 75 octets are folded with CRLF + space.
function foldLine(line) {
  var bytes = 0, out = "", cur = "";
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    var chBytes = new TextEncoder().encode(ch).length;
    if (bytes + chBytes > 73) {
      out += cur + "\r\n ";
      cur = ch;
      bytes = chBytes;
    } else {
      cur += ch;
      bytes += chBytes;
    }
  }
  return out + cur;
}
