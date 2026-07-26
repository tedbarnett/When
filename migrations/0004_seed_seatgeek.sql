-- Event Ideas (issue #13): seed the SeatGeek source (Tier A licensed API).
-- Adapter: workers/when-ingest/src/adapters/seatgeek.js — requires the
-- SEATGEEK_CLIENT_ID worker secret; skips with last_status 'no_key' without it.
INSERT OR IGNORE INTO sources (id, tier, name, url, enabled, kind, crawl_url, notes) VALUES
  ('seatgeek', 'A', 'SeatGeek', 'https://seatgeek.com', 1,
   'api', '',
   'Platform API, lat/lon 15mi around Manhattan (covers all boroughs); requires SEATGEEK_CLIENT_ID secret');
