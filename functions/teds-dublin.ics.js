// GET /teds-dublin.ics — ICS feed for the "Ted's Dublin" calendar.
// Built from the same merged view that renders the web page, so page,
// feed, and API never disagree. Thin wrapper over _lib/ics.js; event
// times are Dublin wall time (Europe/Dublin VTIMEZONE).
import { makeIcsHandler } from "./_lib/ics.js";

export const onRequest = makeIcsHandler("teds-dublin", {
  calName: "Ted's Dublin",
  prodId: "Teds Dublin",
  filename: "teds-dublin.ics",
  fallbackDesc: "Curated Dublin events",
  tzid: "Europe/Dublin",
}).onRequest;
