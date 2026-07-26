// GET /basics-nyc.ics — ICS feed for the "NYC Basics" calendar (issue #15).
// Built from the same merged view that renders the web page, so page, feed,
// and API never disagree. Thin wrapper over _lib/ics.js.
import { makeIcsHandler } from "./_lib/ics.js";

export const onRequest = makeIcsHandler("basics-nyc", {
  calName: "NYC Basics",
  prodId: "NYC Basics",
  filename: "basics-nyc.ics",
  fallbackDesc: "The pre-cleaned NYC baseline calendar",
}).onRequest;
