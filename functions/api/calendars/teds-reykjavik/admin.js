/**
 * GET /api/calendars/teds-reykjavik/admin — owner-only full calendar view.
 * Thin wrapper over the shared factory (see _lib/calendarApi.js).
 */
import { makeAdminHandler } from '../../../_lib/calendarApi.js';

const handler = makeAdminHandler('teds-reykjavik');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
