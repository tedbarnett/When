/**
 * POST /api/calendars/basics-nyc/import — owner-only paste-a-URL event
 * importer for NYC Basics (issue #15). The importer is calendar-agnostic
 * (it only EXTRACTS an event; saving goes through the calendar's own
 * overlay endpoint), so this re-exports the teds-nyc implementation.
 */
export { onRequestPost, onRequest } from '../teds-nyc/import.js';
