/**
 * GET /api/calendars/basics-nyc/admin — owner-only full calendar view for
 * NYC Basics (issue #15). Thin wrapper over the shared factory.
 */
import { makeAdminHandler } from '../../../_lib/calendarApi.js';

const handler = makeAdminHandler('basics-nyc');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
