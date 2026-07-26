// GET /data/teds-nyc.json — public calendar JSON.
// Intercepts the static asset path and serves the MERGED view: inherited
// NYC Basics events included, curator edits applied, hidden events
// excluded. Thin wrapper over the shared factory (_lib/calendarApi.js).
import { makePublicJsonHandler } from '../_lib/calendarApi.js';

export const onRequest = makePublicJsonHandler('teds-nyc').onRequest;
