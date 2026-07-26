-- Migration 0003: source registry for generic crawlers (issue #13, P1).
--
-- Adds crawler plumbing to `sources`:
--   kind       — 'api' (bespoke adapter) | 'jsonld' (schema.org Event crawl)
--                | 'ics' (iCalendar feed) | 'signal' (leads only, P2)
--   crawl_url  — the exact URL the generic crawler fetches (kind jsonld/ics)
--   last_count — candidates produced on the last run
--   last_error — last failure message ('' when the run was clean)
--
-- Then seeds ~30 NYC sources across the "fun things to do" space. Every
-- enabled=1 row was verified live on 2026-07-25: the crawl_url returned
-- schema.org Event JSON-LD with startDate, or a working ICS feed, and the
-- origin's robots.txt permits the path. enabled=0 rows record in `notes`
-- exactly why they can't ship yet (no structured data, bot wall, 403, …).
-- Signal outlets (Time Out, The Skint, …) ship disabled: their product is
-- *selection*, so P2 resolves their leads to primary sources before use.

ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN crawl_url TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN last_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN last_error TEXT NOT NULL DEFAULT '';

-- P0 rows run bespoke adapters.
UPDATE sources SET kind = 'api' WHERE id IN ('nyc-parks', 'ticketmaster');

INSERT OR IGNORE INTO sources (id, tier, name, url, enabled, kind, crawl_url, notes) VALUES

-- ---------------------------------------------------------------- rep cinema
  ('film-forum', 'C', 'Film Forum', 'https://filmforum.org', 1,
   'jsonld', 'https://filmforum.org/events',
   'Special events + Q&As (JSON-LD w/ startDate). /now_playing has ScreeningEvent nodes but no dates.'),
  ('metrograph', 'C', 'Metrograph', 'https://metrograph.com', 0,
   'jsonld', 'https://metrograph.com/calendar/',
   'no Event JSON-LD (Yoast WebPage @graph only); JS calendar — needs custom parser'),
  ('bam', 'C', 'BAM (Brooklyn Academy of Music)', 'https://www.bam.org', 0,
   'jsonld', 'https://www.bam.org/',
   'no Event JSON-LD; listings are JS-rendered — needs custom parser or partner feed'),
  ('anthology-film-archives', 'C', 'Anthology Film Archives', 'http://anthologyfilmarchives.org', 0,
   'jsonld', 'http://anthologyfilmarchives.org/film_screenings/calendar',
   'no JSON-LD at all; server-rendered HTML calendar — needs custom parser'),
  ('ifc-center', 'C', 'IFC Center', 'https://www.ifccenter.com', 0,
   'jsonld', 'https://www.ifccenter.com/',
   'JSON-LD is Organization only, no Event nodes; showtimes are plain HTML — needs custom parser'),
  ('nitehawk', 'C', 'Nitehawk Cinema', 'https://nitehawkcinema.com', 0,
   'jsonld', 'https://nitehawkcinema.com/williamsburg/',
   'no Event JSON-LD; JS-driven showtimes (Veezi) — needs custom parser'),

-- -------------------------------------------------- music venues (not on TM)
  ('le-poisson-rouge', 'C', 'Le Poisson Rouge', 'https://lpr.com', 0,
   'jsonld', 'https://lpr.com/events/',
   'no Event JSON-LD (CollectionPage only); JS calendar — most shows reach Tier A via AXS/TM anyway'),
  ('bowery-ballroom', 'C', 'Bowery Ballroom', 'https://www.boweryballroom.com', 0,
   'jsonld', 'https://www.boweryballroom.com/calendar/',
   'no JSON-LD; Bowery Presents JS calendar — shows surface via Ticketmaster (Tier A)'),
  ('brooklyn-steel', 'C', 'Brooklyn Steel', 'https://www.brooklynsteel.com', 0,
   'jsonld', 'https://www.brooklynsteel.com/calendar/',
   'site serves a JS bot-lander redirect (114 bytes); shows surface via Ticketmaster (Tier A)'),
  ('national-sawdust', 'C', 'National Sawdust', 'https://www.nationalsawdust.org', 0,
   'jsonld', 'https://www.nationalsawdust.org/performances',
   'no Event JSON-LD; JS listings — needs custom parser'),
  ('barbes', 'C', 'Barbès', 'https://www.barbesbrooklyn.com', 0,
   'jsonld', 'https://www.barbesbrooklyn.com/events',
   'Wix site, no Event JSON-LD — needs custom parser'),
  ('jalopy-theatre', 'C', 'Jalopy Theatre', 'https://jalopytheatre.org', 0,
   'jsonld', 'https://jalopytheatre.org/livemusic',
   'calendar is a React SPA (empty HTML shell); no JSON-LD/ICS — needs custom parser'),

-- ------------------------------------------------------------------- comedy
  ('comedy-cellar', 'C', 'Comedy Cellar', 'https://www.comedycellar.com', 0,
   'jsonld', 'https://www.comedycellar.com/reservations/',
   'no structured data; line-up is JS-rendered — needs custom parser'),
  ('brooklyn-comedy-collective', 'C', 'Brooklyn Comedy Collective', 'https://www.brooklyncc.com', 0,
   'jsonld', 'https://www.brooklyncc.com/whats-playing-shows',
   'Squarespace, no Event JSON-LD; ticketing is Eventbrite — pull via Eventbrite organizer API (P3)'),
  ('union-hall', 'C', 'Union Hall', 'https://www.unionhallny.com', 0,
   'jsonld', 'https://www.unionhallny.com/calendar',
   'no Event JSON-LD; Eventbrite-driven — pull via Eventbrite organizer API (P3)'),
  ('littlefield', 'C', 'Littlefield', 'https://littlefieldnyc.com', 0,
   'jsonld', 'https://littlefieldnyc.com/calendar/',
   'no Event JSON-LD; Eventbrite-driven — pull via Eventbrite organizer API (P3)'),

-- ------------------------------------------------------------ culture/ideas
  ('92ny', 'C', '92NY (92nd Street Y)', 'https://www.92ny.org', 0,
   'jsonld', 'https://www.92ny.org/events',
   'blocked: Incapsula bot wall (noindex interstitial) — no circumvention; needs partner feed'),
  ('bpl-events', 'C', 'Brooklyn Public Library events', 'https://www.bklynlibrary.org', 0,
   'jsonld', 'https://www.bklynlibrary.org/calendar/',
   'JS-only calendar, no JSON-LD/ICS found — check for a public events API (Tier B candidate)'),
  ('nypl-events', 'C', 'New York Public Library events', 'https://www.nypl.org', 0,
   'jsonld', 'https://www.nypl.org/events/calendar',
   'blocked: Incapsula bot wall — no circumvention; NYPL has open-data leanings, ask for a feed'),
  ('public-theater', 'C', 'The Public Theater', 'https://publictheater.org', 0,
   'jsonld', 'https://publictheater.org/whats-on/',
   'blocked 403 to our UA — respected; most productions reach Tier A via Ticketmaster/TodayTix'),
  ('st-anns-warehouse', 'C', 'St. Ann''s Warehouse', 'https://stannswarehouse.org', 0,
   'jsonld', 'https://stannswarehouse.org/whats-on/',
   'blocked 403 to our UA — respected; needs partner feed'),

-- ------------------------------------- urban exploration / experiences
  ('untapped-new-york', 'C', 'Untapped New York tours', 'https://untappednewyorktours.com', 1,
   'jsonld', 'https://untappednewyorktours.com/',
   'PRIMARY source: their own tours/experiences, Event JSON-LD verified (date-only startDate normalized to 00:00).'),
  ('open-house-new-york', 'C', 'Open House New York', 'https://www.ohny.org', 0,
   'jsonld', 'https://www.ohny.org/whats-on/',
   'JS-only page (1KB loading shell), no JSON-LD; revisit around OHNY Weekend'),
  ('green-wood', 'C', 'Green-Wood Cemetery events', 'https://www.green-wood.com', 1,
   'jsonld', 'https://www.green-wood.com/events/',
   'The Events Calendar (WP): Event JSON-LD w/ startDate verified; ICS also available (?ical=1).'),
  ('brooklyn-botanic-garden', 'C', 'Brooklyn Botanic Garden', 'https://www.bbg.org', 0,
   'jsonld', 'https://www.bbg.org/events',
   'no Event JSON-LD on the events page — needs custom parser'),
  ('wave-hill', 'C', 'Wave Hill', 'https://www.wavehill.org', 0,
   'jsonld', 'https://www.wavehill.org/calendar',
   'no Event JSON-LD; JS calendar — needs custom parser'),
  ('ny-transit-museum', 'C', 'New York Transit Museum', 'https://www.nytransitmuseum.org', 1,
   'ics', 'https://www.nytransitmuseum.org/programs/?ical=1',
   'The Events Calendar (WP) ICS feed verified (30 VEVENTs); JSON-LD also present on /programs/.'),

-- ------------------------------------------------------------- markets/food
  ('smorgasburg', 'C', 'Smorgasburg', 'https://www.smorgasburg.com', 0,
   'jsonld', 'https://www.smorgasburg.com/',
   'no Event JSON-LD; weekly recurring markets — consider hand-seeded recurring facts instead'),
  ('grand-bazaar-nyc', 'C', 'Grand Bazaar NYC', 'https://grandbazaarnyc.org', 0,
   'jsonld', 'https://grandbazaarnyc.org/',
   'no Event JSON-LD; weekly recurring market — consider hand-seeded recurring facts instead'),

-- ------------------------------------------- signal outlets (leads, not facts)
  ('timeout-nyc', 'D', 'Time Out New York', 'https://www.timeout.com/newyork/things-to-do', 0,
   'signal', 'https://www.timeout.com/newyork/things-to-do',
   'signal-only: leads, not facts — P2 (fetch 200 OK; selection is protected expression)'),
  ('the-skint', 'D', 'The Skint', 'https://theskint.com', 0,
   'signal', 'https://theskint.com/',
   'signal-only: leads, not facts — P2 (fetch 200 OK)'),
  ('donyc', 'D', 'DoNYC', 'https://donyc.com', 0,
   'signal', 'https://donyc.com/',
   'signal-only: leads, not facts — P2 (currently 403 to our UA; may need partner blessing)'),
  ('nonsense-nyc', 'D', 'Nonsense NYC', 'https://www.nonsensenyc.com', 0,
   'signal', 'https://www.nonsensenyc.com/',
   'signal-only: leads, not facts — P2 (site is a newsletter archive; leads come from the list)');
