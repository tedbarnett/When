// GET /teds-nyc.ics — ICS feed for the "Ted's NYC" calendar.
// Built from the same merged view that renders the web page (base JSON +
// curator overlay from KV), so page, feed, and API never disagree.
// Hidden events are excluded; curator edits are applied.

import { loadMergedEvents } from "./_lib/calendar.js";

var TZID = "America/New_York";

export async function onRequest(context) {
  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  var data;
  try {
    var origin = new URL(context.request.url).origin;
    data = (await loadMergedEvents(context.env, origin)).data;
  } catch (e) {
    return new Response("Calendar data unavailable", { status: 502 });
  }

  var now = utcStamp(new Date());
  var lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//When.org//Teds NYC//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Ted's NYC",
    "X-WR-CALDESC:" + escapeText(data.calendar.description || "Curated NYC events"),
    "X-WR-TIMEZONE:" + TZID,
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "BEGIN:VTIMEZONE",
    "TZID:" + TZID,
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
    "END:STANDARD",
    "END:VTIMEZONE"
  ];

  for (var i = 0; i < data.events.length; i++) {
    var ev = data.events[i];
    var start = localStamp(ev.start);
    var end = ev.end ? localStamp(ev.end) : localStamp(addHours(ev.start, 2));
    var descParts = [];
    if (ev.blurb) descParts.push(ev.blurb);
    if (ev.price) descParts.push("Price: " + ev.price);
    if (ev.url) descParts.push(ev.url);

    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + ev.id + "@when.org");
    lines.push("DTSTAMP:" + now);
    lines.push("DTSTART;TZID=" + TZID + ":" + start);
    lines.push("DTEND;TZID=" + TZID + ":" + end);
    lines.push("SUMMARY:" + escapeText(ev.title));
    lines.push("DESCRIPTION:" + escapeText(descParts.join("\n")));
    lines.push("LOCATION:" + escapeText(ev.venue + ", " + ev.neighborhood + ", New York"));
    if (ev.url) lines.push("URL:" + ev.url);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  var body = lines.map(foldLine).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="teds-nyc.ics"',
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*"
    }
  });
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
