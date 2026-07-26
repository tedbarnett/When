// GET /teds-nyc.ics — ICS feed for the "Ted's NYC" calendar.
// Built from the same merged (composed) view that renders the web page, so
// page, feed, and API never disagree. Thin wrapper over _lib/ics.js.
import { makeIcsHandler } from "./_lib/ics.js";

export const onRequest = makeIcsHandler("teds-nyc", {
  calName: "Ted's NYC",
  prodId: "Teds NYC",
  filename: "teds-nyc.ics",
  fallbackDesc: "Curated NYC events",
}).onRequest;
