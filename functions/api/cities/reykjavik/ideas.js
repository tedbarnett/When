/**
 * GET /api/cities/reykjavik/ideas?date=YYYY-MM-DD — Event Ideas for one
 * Reykjavik day. Thin wrapper over the shared multi-city factory
 * (_lib/ideasApi.js for the full contract). Day-bucketing runs on
 * Atlantic/Reykjavik (UTC+0 year-round) — a Reykjavik evening must not be
 * bucketed by a New York clock; "added" detection checks Ted's Reykjavik.
 */
import { makeIdeasHandler } from '../../../_lib/ideasApi.js';

const handler = makeIdeasHandler('reykjavik');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
