/**
 * when-ingest — venue watchlist (issue #13 follow-up).
 *
 * Venues whose FULL forward calendar must always land in `candidates`,
 * regardless of the citywide horizon caps in the adapters (both Ticketmaster
 * and SeatGeek pull the next ~1000 events citywide sorted by date, so a small
 * club's show two months out can fall past the horizon and never ingest).
 *
 * Each adapter does a dedicated per-venue events fetch for every entry here,
 * exempt from the citywide page caps. Venue IDs are resolved at runtime via
 * each API's venue search (one cheap call per venue per run) unless pinned;
 * pin IDs once known to skip the lookup and kill ambiguity.
 *
 * `venue` is the canonical display name — watched-venue candidates are
 * ingested under it so dedupe_key slugs line up across sources (SeatGeek
 * already says "Berlin NYC" / "Le Poisson Rouge"). `addressHint` is a
 * lowercase street-address fragment used to disambiguate venue search hits
 * (matched against a whitespace-normalized lowercase address line).
 */

export const WATCHED_VENUES = [
  {
    venue: 'Berlin NYC', // 25 Ave A, Manhattan (East Village)
    addressHint: '25 av', // matches "25 Ave A" and "25 Avenue A"
    tm: { keyword: 'Berlin', venueId: '' },
    seatgeek: { query: 'Berlin NYC', venueId: '' },
  },
  {
    venue: 'Le Poisson Rouge', // 158 Bleecker St, Manhattan (Greenwich Village)
    addressHint: '158 bleecker',
    // TM lists it as "(Le) Poisson Rouge"; "Poisson" is the safest keyword.
    tm: { keyword: 'Poisson', venueId: '' },
    seatgeek: { query: 'Le Poisson Rouge', venueId: '' },
  },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Pick the watched venue from API search hits ({id, name, address, city}).
 * NYC hits first, then the address hint decides; ambiguity falls back to the
 * first NYC (Manhattan) hit. Returns the hit or null.
 */
export function pickVenue(entry, venues) {
  const list = Array.isArray(venues) ? venues.filter((v) => v && v.id) : [];
  const nyc = list.filter((v) => /new york/i.test(v.city || ''));
  const pool = nyc.length ? nyc : list;
  const byAddress = pool.find((v) => norm(v.address).includes(norm(entry.addressHint)));
  return byAddress || pool[0] || null;
}
