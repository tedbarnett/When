/**
 * GET /api/calendars/teds-dublin/admin — owner-only full calendar view.
 * Thin wrapper over the shared factory (see _lib/calendarApi.js).
 */
import { makeAdminHandler } from '../../../_lib/calendarApi.js';

const handler = makeAdminHandler('teds-dublin');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
