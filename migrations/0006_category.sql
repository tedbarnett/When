-- Migration 0006: per-event category for the Ideas page filter chips.
--
-- Small fixed set (workers/when-ingest/src/categorize.js):
--   theater | live-music | comedy | sports | outdoor | other
--
-- Deterministic rules, no LLM: adapter source metadata first (Ticketmaster
-- segment/genre, SeatGeek taxonomies, NYC Parks = outdoor), keyword
-- heuristics on title/venue as fallback. The merge path in normalize.js only
-- upgrades 'other', so metadata-derived values survive re-ingest.
-- Existing rows backfill via re-ingest + scripts/backfill-category.mjs.

ALTER TABLE candidates ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
