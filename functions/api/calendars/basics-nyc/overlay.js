/**
 * POST/PATCH /api/calendars/basics-nyc/overlay — owner-only curator writes
 * for NYC Basics (issue #15). Thin wrapper over the shared factory. Events
 * added here flow down to every calendar that extends basics-nyc (teds-nyc).
 */
import { makeOverlayHandler } from '../../../_lib/calendarApi.js';

const handler = makeOverlayHandler('basics-nyc');
export const onRequestPost = handler.onRequestPost;
export const onRequestPatch = handler.onRequestPatch;
export const onRequest = handler.onRequest;
