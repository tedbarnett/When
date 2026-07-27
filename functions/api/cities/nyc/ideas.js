/**
 * GET /api/cities/nyc/ideas?date=YYYY-MM-DD — Event Ideas for one NYC day
 * (issue #13, P0). Thin wrapper over the shared multi-city factory
 * (_lib/ideasApi.js for the full contract). Day-bucketing runs on
 * America/New_York; "added" detection checks NYC Basics first (preferred
 * label — teds-nyc inherits it), then the composed Ted's NYC.
 */
import { makeIdeasHandler } from '../../../_lib/ideasApi.js';

const handler = makeIdeasHandler('nyc');
export const onRequestGet = handler.onRequestGet;
export const onRequest = handler.onRequest;
