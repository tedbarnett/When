-- Migration 0002: seed the P0 sources (issue #13).
-- INSERT OR IGNORE so re-running never clobbers enabled/last_* state.

INSERT OR IGNORE INTO sources (id, tier, name, url, enabled, notes) VALUES
  ('nyc-parks', 'B', 'NYC Parks events',
   'https://www.nycgovparks.org/xml/events_300_rss.xml', 1,
   'Public events RSS, upcoming 14 days. Open data; facts only, no images rehosted.'),
  ('ticketmaster', 'A', 'Ticketmaster Discovery API',
   'https://app.ticketmaster.com/discovery/v2/events.json', 1,
   'requires TM_API_KEY secret');
