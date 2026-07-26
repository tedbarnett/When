/**
 * GET /api/calendars/teds-nyc/admin — owner-only full calendar view.
 * Thin wrapper over the shared factory (see _lib/calendarApi.js). Since
 * teds-nyc extends basics-nyc, inherited events appear with _inherited.
 */
import { makeAdminHandler } from '../../../_lib/calendarApi.js';

const handler = makeAdminHandler('teds-nyc');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
