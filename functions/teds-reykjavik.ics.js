// GET /teds-reykjavik.ics — ICS feed for the "Ted's Reykjavik" calendar.
// Built from the same merged view that renders the web page, so page,
// feed, and API never disagree. Thin wrapper over _lib/ics.js; event
// times are Reykjavik wall time (Atlantic/Reykjavik — UTC+0 year-round).
import { makeIcsHandler } from "./_lib/ics.js";

export const onRequest = makeIcsHandler("teds-reykjavik", {
  calName: "Ted's Reykjavik",
  prodId: "Teds Reykjavik",
  filename: "teds-reykjavik.ics",
  fallbackDesc: "Curated Reykjavik events",
  tzid: "Atlantic/Reykjavik",
}).onRequest;
