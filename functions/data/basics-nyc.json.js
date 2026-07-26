// GET /data/basics-nyc.json — public NYC Basics calendar JSON (issue #15).
// Intercepts the static asset path and serves the MERGED view: curator
// edits applied, hidden events excluded. Thin wrapper over the shared
// factory (_lib/calendarApi.js).
import { makePublicJsonHandler } from '../_lib/calendarApi.js';

export const onRequest = makePublicJsonHandler('basics-nyc').onRequest;
