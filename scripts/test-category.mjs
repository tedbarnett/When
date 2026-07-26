// Unit tests for workers/when-ingest/src/categorize.js (rule-based event
// categories, migration 0006). Run: node scripts/test-category.mjs
import {
  CATEGORIES,
  validCategory,
  categoryFromTicketmaster,
  categoryFromSeatgeek,
  categoryFromText,
} from '../workers/when-ingest/src/categorize.js';
import { buildCandidate } from '../workers/when-ingest/src/normalize.js';

let bad = 0;
function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log('PASS', name);
  else { bad++; console.error('FAIL', name, '— got', g, 'want', w); }
}

check('category set', CATEGORIES, ['theater', 'live-music', 'comedy', 'sports', 'outdoor', 'other']);
check('validCategory known', validCategory('live-music'), 'live-music');
check('validCategory unknown', validCategory('opera'), '');

// Ticketmaster: classifications[0].segment/genre
const tm = (segment, genre) => ({ classifications: [{ segment: { name: segment }, genre: { name: genre } }] });
check('TM music', categoryFromTicketmaster(tm('Music', 'Rock')), 'live-music');
check('TM theatre', categoryFromTicketmaster(tm('Arts & Theatre', 'Theatre')), 'theater');
check('TM comedy genre wins', categoryFromTicketmaster(tm('Arts & Theatre', 'Comedy')), 'comedy');
check('TM sports', categoryFromTicketmaster(tm('Sports', 'Baseball')), 'sports');
check('TM film -> unknown', categoryFromTicketmaster(tm('Film', 'Drama')), '');
check('TM no classifications', categoryFromTicketmaster({}), '');

// SeatGeek: taxonomies[].name + type (comedy is a child of theater — first)
check('SG broadway', categoryFromSeatgeek({ type: 'broadway_tickets_national', taxonomies: [{ name: 'theater' }, { name: 'broadway_tickets_national' }] }), 'theater');
check('SG concert', categoryFromSeatgeek({ type: 'concert', taxonomies: [{ name: 'concert' }] }), 'live-music');
check('SG comedy under theater', categoryFromSeatgeek({ type: 'comedy', taxonomies: [{ name: 'theater' }, { name: 'comedy' }] }), 'comedy');
check('SG mlb', categoryFromSeatgeek({ type: 'mlb', taxonomies: [{ name: 'sports' }, { name: 'baseball' }, { name: 'mlb' }] }), 'sports');
check('SG classical', categoryFromSeatgeek({ type: 'classical', taxonomies: [{ name: 'concerts' }, { name: 'classical' }] }), 'live-music');
check('SG unknown', categoryFromSeatgeek({ type: 'family' }), '');

// Keyword fallback (crawled sources / backfill)
check('txt Broadway theatre', categoryFromText('Hamilton', 'Richard Rodgers Theatre'), 'theater');
check('txt musical title', categoryFromText('Six the Musical', 'Lena Horne Thtr'), 'theater');
check('txt park', categoryFromText('Kids In Motion', 'Riverside Park'), 'outdoor');
check('txt MSG is not outdoor', categoryFromText('Billy Joel', 'Madison Square Garden'), 'other');
check('txt comedy venue', categoryFromText('Late Show', 'Comedy Cellar'), 'comedy');
check('txt standup title', categoryFromText('Stand-Up Night', 'Some Bar'), 'comedy');
check('txt jazz', categoryFromText('Jazz Quartet', 'Village Vanguard'), 'live-music');
check('txt delacorte stays theater', categoryFromText('Twelfth Night', 'Delacorte Theater'), 'theater');
check('txt other', categoryFromText('Annual Gala', 'Cipriani Wall Street'), 'other');

// buildCandidate: adapter category wins, fallback fills, junk clamps
const at = '2026-08-01T19:00:00-04:00';
check('candidate keeps adapter category',
  buildCandidate({ title: 'Some Gala', venue: 'Beacon Theatre', start: at, category: 'live-music' }, 'ticketmaster').category,
  'live-music');
check('candidate falls back to heuristics',
  buildCandidate({ title: 'Hamlet', venue: 'Public Theater', start: at }, 'village-voice').category,
  'theater');
check('candidate clamps junk category',
  buildCandidate({ title: 'Annual Gala', venue: 'Some Hall', start: at, category: 'gala' }, 'x').category,
  'other');

if (bad) { console.error(bad + ' FAILURES'); process.exit(1); }
console.log('ALL PASS');
