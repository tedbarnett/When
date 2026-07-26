-- Migration 0005: candidate coordinates (borough + distance filtering).
--
-- lat/lon are nullable REAL on purpose (see the 0004 lesson: NOT NULL +
-- INSERT OR IGNORE silently ate a row). NULL = source had no usable
-- coordinates; re-ingest backfills NULLs without clobbering existing values
-- (normalize.js merge path). Values are validated to rough NYC bounds
-- (40.3–41.1 lat, -74.5–-73.4 lon) before insert.

ALTER TABLE candidates ADD COLUMN lat REAL;
ALTER TABLE candidates ADD COLUMN lon REAL;
