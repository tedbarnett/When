// Unit tests for workers/when-ingest/src/categorize.js (rule-based event
// categories, migration 0006). Run: node scripts/test-category.mjs
import {
  CATEGORIES,
  validCategory,
  categoryFromTicketmaster,
  categoryFromSeatgeek,
  categoryFromText,
  refineCategory,
} from '../workers/when-ingest/src/categorize.js';
import { buildCandidate } from '../workers/when-ingest/src/normalize.js';

let bad = 0;
function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) console.log('PASS', name);
  else { bad++; console.error('FAIL', name, '— got', g, 'want', w); }
}

check('category set', CATEGORIES, ['theater', 'live-music', 'comedy', 'sports', 'outdoor', 'tours', 'film', 'museums', 'other']);
check('validCategory known', validCategory('live-music'), 'live-music');
check('validCategory unknown', validCategory('opera'), '');

// Ticketmaster: classifications[0].segment/genre
const tm = (segment, genre) => ({ classifications: [{ segment: { name: segment }, genre: { name: genre } }] });
check('TM music', categoryFromTicketmaster(tm('Music', 'Rock')), 'live-music');
check('TM theatre', categoryFromTicketmaster(tm('Arts & Theatre', 'Theatre')), 'theater');
check('TM comedy genre wins', categoryFromTicketmaster(tm('Arts & Theatre', 'Comedy')), 'comedy');
check('TM sports', categoryFromTicketmaster(tm('Sports', 'Baseball')), 'sports');
check('TM film segment', categoryFromTicketmaster(tm('Film', 'Drama')), 'film');
check('TM museum genre', categoryFromTicketmaster(tm('Miscellaneous', 'Museum')), 'museums');
check('TM misc -> unknown', categoryFromTicketmaster(tm('Miscellaneous', 'Fairs & Festivals')), '');
check('TM no classifications', categoryFromTicketmaster({}), '');

// SeatGeek: taxonomies[].name + type (comedy is a child of theater — first)
check('SG broadway', categoryFromSeatgeek({ type: 'broadway_tickets_national', taxonomies: [{ name: 'theater' }, { name: 'broadway_tickets_national' }] }), 'theater');
check('SG concert', categoryFromSeatgeek({ type: 'concert', taxonomies: [{ name: 'concert' }] }), 'live-music');
check('SG comedy under theater', categoryFromSeatgeek({ type: 'comedy', taxonomies: [{ name: 'theater' }, { name: 'comedy' }] }), 'comedy');
check('SG mlb', categoryFromSeatgeek({ type: 'mlb', taxonomies: [{ name: 'sports' }, { name: 'baseball' }, { name: 'mlb' }] }), 'sports');
check('SG classical', categoryFromSeatgeek({ type: 'classical', taxonomies: [{ name: 'concerts' }, { name: 'classical' }] }), 'live-music');
check('SG film', categoryFromSeatgeek({ type: 'film', taxonomies: [{ name: 'film' }] }), 'film');
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

// tours / film / museums keywords (Ted's three new chips)
check('txt docent tour', categoryFromText('Guided Docent Tour', 'The Museum at Bethel Woods'), 'tours');
check('txt behind the scenes', categoryFromText('Behind the Scenes Tour', 'The Museum at Bethel Woods'), 'tours');
check('txt site tour', categoryFromText('The Historic Site Tour', 'The Museum at Bethel Woods'), 'tours');
check('txt museum venue + tour title', categoryFromText('Adults Only Tour', 'The Museum at Bethel Woods'), 'tours');
check('txt arena tours', categoryFromText('Barclays Center Tours', 'Barclays Center'), 'tours');
check('txt MSG tour experience', categoryFromText('Madison Square Garden Tour Experience', 'Madison Square Garden'), 'tours');
check('txt walking tour', categoryFromText('Public Walking Tour - Chinatown: A Walk through History', 'Museum of Chinese in America'), 'tours');
// THE TRAP: a concert billed "World Tour" must never keyword-match tours
check('txt world tour stays non-tour', categoryFromText("Guns N' Roses: World Tour 2026", 'Some Arena'), 'other');
check('txt farewell tour not tours', categoryFromText('Elton John: Farewell Tour', 'UBS Arena'), 'other');
check('txt museum admission', categoryFromText('Museum of Chinese in America General Admission', 'Museum of Chinese in America'), 'museums');
check('txt museum venue event', categoryFromText('Summer Mahjong Night', 'Museum of Chinese in America'), 'museums');
check('txt exhibit title', categoryFromText('Ongoing Museum Exhibit: Still Waters', 'Conference House Park'), 'museums');
check('txt film venue', categoryFromText('LATE FAME Q&A with Filmmaker Kent Jones', 'Film Forum'), 'film');
check('txt screening title', categoryFromText('Film Forum Presents NYC IN TRANSIT: SPEEDY', 'Off-Site'), 'film');
check('txt movie at museum is film', categoryFromText('Banksy Museum NY - Monday Movie Day and Nights!', 'Banksy Museum New York'), 'film');
check('txt transit walk', categoryFromText('Transit Walk: Downtown Brooklyn', 'Off-Site'), 'tours');
check('txt museum venue misc night', categoryFromText('Vinyl Nights Presents Return to \'76', 'New York Transit Museum, Brooklyn'), 'museums');

// refineCategory: metadata guess vs title reality
check('refine music world tour stays music', refineCategory('live-music', 'Bon Jovi: Forever Tour', 'Madison Square Garden'), 'live-music');
check('refine radio city tour', refineCategory('live-music', 'Radio City Music Hall Tour Experience', 'Radio City Music Hall Tour Experience'), 'tours');
check('refine yankee stadium tour', refineCategory('sports', 'Classic Tour at Yankee Stadium', 'Yankee Stadium'), 'tours');
check('refine yankees game stays sports', refineCategory('sports', 'New York Yankees vs. Boston Red Sox', 'Yankee Stadium'), 'sports');
check('refine TM theater museum exhibit', refineCategory('theater', 'The Museum At Bethel Woods: Story of 60s & Woodstock', 'The Museum at Bethel Woods'), 'museums');
check('refine stage&film play stays theater', refineCategory('theater', 'TRIP AROUND THE SUN | Stage & Film Summer Season at Marist U', 'Marist University Symphonic Hall'), 'theater');
check('refine touring musical stays theater', refineCategory('theater', 'Beautiful: The Carole King Musical (Touring)', 'The Argyle Theatre'), 'theater');
check('refine parks exhibit', refineCategory('outdoor', "Ongoing Outdoor Museum Exhibit: Alice's Terracotta Garden", 'Conference House Park'), 'museums');
check('refine parks tour', refineCategory('outdoor', 'Hart Island Tour (South Island)', 'Hart Island'), 'tours');
check('refine parks gallery tour', refineCategory('outdoor', 'Public Gallery Tour', 'Wave Hill'), 'tours');
check('refine parks movie night', refineCategory('outdoor', 'Movies Under the Stars: Superman (2025)', 'Bowne Playground'), 'film');
check('refine parks stays outdoor', refineCategory('outdoor', 'Kids In Motion', 'Riverside Park'), 'outdoor');
check('refine comedy tour stays comedy', refineCategory('comedy', '"Weird Al" Yankovic: Bigger & Weirder 2026 Tour', 'Hartford HealthCare Amphitheater'), 'comedy');

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
check('candidate refines metadata music to tours',
  buildCandidate({ title: 'Radio City Music Hall Tour Experience', venue: 'Radio City Music Hall Tour Experience', start: at, category: 'live-music' }, 'ticketmaster').category,
  'tours');
check('candidate keeps concert tour as music',
  buildCandidate({ title: 'J. Cole: The Fall-Off Tour', venue: 'Barclays Center', start: at, category: 'live-music' }, 'ticketmaster').category,
  'live-music');
check('candidate parks exhibit to museums',
  buildCandidate({ title: 'Ongoing Museum Exhibit: Still Waters', venue: 'Conference House Park', start: at, category: 'outdoor' }, 'nyc-parks').category,
  'museums');

if (bad) { console.error(bad + ' FAILURES'); process.exit(1); }
console.log('ALL PASS');
