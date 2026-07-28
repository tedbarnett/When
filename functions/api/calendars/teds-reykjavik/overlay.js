/**
 * POST/PATCH /api/calendars/teds-reykjavik/overlay — owner-only curator
 * writes. Thin wrapper over the shared factory (see _lib/calendarApi.js
 * for the full action/body contract).
 */
import { makeOverlayHandler } from '../../../_lib/calendarApi.js';

const handler = makeOverlayHandler('teds-reykjavik');
export const onRequestPost = handler.onRequestPost;
export const onRequestPatch = handler.onRequestPatch;
export const onRequest = handler.onRequest;
