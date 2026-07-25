-- Migration 0001: Event Ideas candidate pool (issue #13, P0).
--
-- sources    — one row per ingestion adapter (Ticketmaster, NYC Parks, …).
--              enabled=0 kills a source; last_run/last_status are the
--              adapter heartbeat written by the when-ingest Worker.
-- candidates — normalized, legally-clean event facts for a city. The base
--              spec calls this column "end"; that's a SQLite keyword, so it
--              is stored as end_at here and surfaced as "end" in API JSON.
--
-- Datetimes (start, end_at, first_seen, fetched_at, last_run) are ISO 8601
-- strings; start/end_at carry the America/New_York offset so substr(x,1,10)
-- is always the NY-local date (never use date() on them — SQLite would
-- shift offset-suffixed values to UTC).

CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,           -- 'ticketmaster', 'nyc-parks', …
  tier        TEXT NOT NULL DEFAULT '',   -- 'A' licensed API | 'B' open data | 'C' JSON-LD | 'D' signals
  name        TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run    TEXT NOT NULL DEFAULT '',
  last_status TEXT NOT NULL DEFAULT '',   -- 'ok:N' | 'no_key' | 'error: …'
  notes       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS candidates (
  id           TEXT PRIMARY KEY,          -- = dedupe_key of first sighting
  city         TEXT NOT NULL DEFAULT 'nyc',
  title        TEXT NOT NULL DEFAULT '',
  venue        TEXT NOT NULL DEFAULT '',
  neighborhood TEXT NOT NULL DEFAULT '',
  start        TEXT NOT NULL DEFAULT '',  -- ISO with NY offset
  end_at       TEXT NOT NULL DEFAULT '',  -- '' = no end; API JSON field name is "end"
  price        TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  image        TEXT NOT NULL DEFAULT '',
  image_source TEXT NOT NULL DEFAULT '',  -- 'api_licensed' | 'venue_press' | 'curator_upload' | ''
  blurb        TEXT NOT NULL DEFAULT '',  -- never copied prose; facts/AI only
  blurb_origin TEXT NOT NULL DEFAULT 'none', -- 'ai' | 'api_licensed' | 'none'
  source       TEXT NOT NULL DEFAULT '',  -- sources.id that first produced it
  source_url   TEXT NOT NULL DEFAULT '',  -- provenance/linkout (primary page)
  signals      TEXT NOT NULL DEFAULT '[]',-- JSON array of source ids that have seen it
  dedupe_key   TEXT NOT NULL DEFAULT '',  -- slug(venue)-YYYYMMDD-slug(title[:24])
  first_seen   TEXT NOT NULL DEFAULT '',
  fetched_at   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'new' -- new | added | dismissed | expired | purged
);

CREATE INDEX IF NOT EXISTS idx_candidates_city_start ON candidates (city, start);
CREATE INDEX IF NOT EXISTS idx_candidates_dedupe_key ON candidates (dedupe_key);
