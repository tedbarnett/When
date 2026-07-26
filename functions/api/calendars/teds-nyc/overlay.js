/**
 * POST/PATCH /api/calendars/teds-nyc/overlay — owner-only curator writes.
 * Thin wrapper over the shared factory (see _lib/calendarApi.js for the
 * full action/body contract). Writes go ONLY to teds-nyc's overlay —
 * hiding/editing an inherited NYC Basics event is a local hide/edit.
 */
import { makeOverlayHandler } from '../../../_lib/calendarApi.js';

const handler = makeOverlayHandler('teds-nyc');
export const onRequestPost = handler.onRequestPost;
export const onRequestPatch = handler.onRequestPatch;
export const onRequest = handler.onRequest;
