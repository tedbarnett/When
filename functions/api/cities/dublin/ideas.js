/**
 * GET /api/cities/dublin/ideas?date=YYYY-MM-DD — Event Ideas for one Dublin
 * day. Thin wrapper over the shared multi-city factory (_lib/ideasApi.js
 * for the full contract). Day-bucketing runs on Europe/Dublin — a Dublin
 * evening must not be bucketed by a New York clock; "added" detection
 * checks Ted's Dublin.
 */
import { makeIdeasHandler } from '../../../_lib/ideasApi.js';

const handler = makeIdeasHandler('dublin');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
