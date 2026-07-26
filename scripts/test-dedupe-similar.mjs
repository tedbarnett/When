// Ted's rule: "same location at same time, de-dupe!" — venue + exact start
// collapse unless titles are clearly different events. Pure-function checks
// on titlesSimilar/preferTitle drawn from live D1 dupe groups (2026-07-26),
// then an end-to-end upsertCandidates pass on a real SQLite db (node:sqlite)
// proving cross-source variants collapse while same-slot distinct events
// (Conference House exhibits, Bethel Woods tours) survive.
// Run: node scripts/test-dedupe-similar.mjs
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  buildCandidate,
  normVenue,
  preferTitle,
  titlesSimilar,
  upsertCandidates,
} from '../workers/when-ingest/src/normalize.js';

let failures = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${g}, want ${w})`}`);
}

// --- same event, must merge (each pair observed sharing venue + exact start)
const SAME = [
  ['Six (New York, NY)', 'Six: The Musical'],
  ['Six: The Musical', 'Six the Musical - New York'],
  ['Six (New York, NY)', 'Six the Musical - New York'],
  ['MJ', 'MJ (NY)'],
  ['MJ', 'MJ - The Musical - New York'],
  ['Operation Mincemeat: A New Musical', 'Operation Mincemeat - New York'],
  ['Operation Mincemeat: A New Musical', 'Operation Mincemeat: A New Musical (No Children Under 4)'],
  ['Chicago', 'Chicago the Musical - New York'],
  ['Heathers: The Musical', 'Heathers - New York'],
  ['Just In Time', 'Just In Time - New York'],
  ['Moulin Rouge', 'Moulin Rouge! The Musical - New York'],
  ['Cats - New York', 'CATS: The Jellicle Ball'],
  ['Wicked - New York', 'Wicked (NY)'],
  ['Hamilton (NY)', 'Hamilton - New York'],
  ['The Lion King (New York, NY)', 'The Lion King'],
  ['Arthur Miller\u2019s Death of a Salesman', 'Death of a Salesman - New York'],
  ['Les Misérables: The Arena Concert Spectacular', 'Les Miserables - New York'],
  ['Two Strangers (Carry a Cake Across New York)', 'Two Strangers'],
  ['Two Strangers (Carry a Cake Across New York) - New York', 'Two Strangers'],
  ['Sammy Virji (18+)', 'Sammy Virji (18 and Over)'],
  ['Clarent - All Ages (under 16 with adult)', 'Clarent'],
  ['Bon Jovi: Forever Tour', 'Bon Jovi'],
  ['Rush', 'RUSH: Fifty Something'],
  ['J. Cole: The Fall-Off Tour', 'J. Cole'],
  ['Daniel Caesar with Faye Webster', 'Daniel Caesar - Son Of Spergy Tour'],
  ['Wunderhorse with Been Stellar', 'Wunderhorse - North America 2026'],
  ['Metric with Broken Social Scene and Stars', 'ALL THE FEELINGS TOUR with METRIC, BROKEN SOCIAL SCENE, AND STARS'],
  ['New York Mets vs. Los Angeles Dodgers', 'Los Angeles Dodgers at New York Mets'],
  ['Winston-Salem Dash at Brooklyn Cyclones', 'Brooklyn Cyclones vs. Winston-Salem Dash'],
  ['Zuffa Boxing 09: Berlanga v. Butler', 'Zuffa Boxing 09: Berlanga vs Butler'],
  ['Rosie O\u2019Donnell', 'Rosie O\u2019Donnell: Common Knowledge'],
  ['Dave East', 'Dave East & Friends: Album Release Show'],
  ['Violent Vira', 'VIOLENT VIRA PRESENTS: LOVER OF A GHOST FILM PREMIERE'],
  ['Demi Adejuyigbe Sells Out', 'Demi Adejuyigbe'],
  ['Audien', 'Project 91 Presents Audien'],
  ['The Moth - Brooklyn', 'The Moth StorySLAM'],
  ['Drunk Bollywood Live - Brooklyn', 'DRUNK BOLLYWOOD LIVE!'],
  ['Annie', 'Annie - Englewood'],
  ['Happy Together Tour 2026', 'Happy Together Tour'],
  ['Gotta Dance!', 'Gotta Dance - New York'],
  ['Titanique - New York', 'Titanique (NY)'],
  ['Tattoo Convention', 'New York City Tattoo Arts Convention - Sunday'],
  ['Shakespeare As You Like It', 'Shakespeare in the Park "As You Like It"'],
  ['Kamasi Washington (18+)', 'Kamasi Washington (18 and Over)'],
  ['Noname - Telefone 10 Year Anniversary', 'Noname'],
  ['Buena Vista Social Club', 'Buena Vista Social Club - The Musical - New York'],
];

// --- genuinely different events sharing venue + exact start, must survive
const DIFFERENT = [
  // Conference House Park: four ongoing exhibits, all 11:00 (nyc-parks)
  ["Ongoing Outdoor Museum Exhibit: Alice's Terracotta Garden", "Ongoing Museum Exhibit: New York's Brick & Terra Cotta Industries"],
  ["Ongoing Museum Exhibit: New York's Brick & Terra Cotta Industries", 'Ongoing Museum Exhibit: Out of the Box Biodiversity: Student Art'],
  ['Ongoing Museum Exhibit: Out of the Box Biodiversity: Student Art', 'Ongoing Museum Exhibit: Still Waters: Reflections of a Maritime Community'],
  // The Museum at Bethel Woods: distinct tours at one timestamp (TM)
  ['Guided Docent Tour', 'Behind the Scenes Tour'],
  ['Behind the Scenes Tour', 'The Historic Site Tour'],
  ['The Historic Site Tour', 'Adults Only Tour'],
  ['Guided Docent Tour', '20th Anniversary Tour: Building Bethel Woods'],
  ['Adults Only Tour', '20th Anniversary Tour: Building Bethel Woods'],
  // Same-slot different programming (nyc-parks and TM)
  ['Piano in Bryant Park', 'Reel Talks at Bryant Park: Conversation on Eric Rohmer'],
  ['Piano in Bryant Park', 'BookClub at Bryant Park Reading Room'],
  ["Kids in Motion: St. Mary's Park West", 'Summer Sports Experience: St. Mary\'s Park "Game of Zones Girls Basketball Clinic"'],
  ['Kids In Motion: Lower Highland Playground', '7/31 Restoration Fridays at Highland Park'],
  ['Free Drag Prize Trivia + Bingo Night', 'Mahjong Night'],
  ['Maya Delilah', 'Abe Parker'],
  ['Shoot To Thrill', 'Whey Jennings'],
  ['An Evening With Grateful for Biggie', 'Zimmy Shelter Plays Dylan And The Dead'],
  ['Beginner Yoga', '8/1 Forest Restoration at Strack Pond'],
  ['Zumba', "Kids In Motion: St. John's park"],
  ['Summer on the Hudson: Sunset Yoga', 'Hudson Classical Theater Company presents: The Dancing Men'],
  ['Turtle Quest: Explore, Observe, Protect with Lizbeth Miron', 'Best Special Kids: Horticulture and Art Workshop with Gisselle Ramirez'],
];

for (const [a, b] of SAME) check(`same: ${a} ~ ${b}`, titlesSimilar(a, b) && titlesSimilar(b, a), true);
for (const [a, b] of DIFFERENT) check(`diff: ${a} !~ ${b}`, titlesSimilar(a, b) || titlesSimilar(b, a), false);

// --- venue spellings: city suffixes collapse, real city-bearing names survive
check('venue -NY suffix', normVenue('Ambassador Theatre-NY'), 'ambassador theatre');
check('venue " - New York" suffix', normVenue('Ambassador Theatre - New York'), 'ambassador theatre');
check('venue plain', normVenue('Ambassador Theatre'), 'ambassador theatre');
check('venue "-New York" suffix', normVenue('Broadway Theatre-New York'), 'broadway theatre');
check('venue city-in-name kept', normVenue('Museum of the City of New York'), 'museum of the city of new york');
check('venue stage suffix kept', normVenue('New World Stages - Stage 1'), 'new world stages stage 1');
check('venue leading article', normVenue('(Le) Poisson Rouge'), 'poisson rouge');

// --- canonical title preference: noise-free beats city/paren-suffixed
check('prefer clean over paren-noise', preferTitle('Six (New York, NY)', 'Six: The Musical'), 'Six: The Musical');
check('prefer clean over city-suffix', preferTitle('Six the Musical - New York', 'Six: The Musical'), 'Six: The Musical');
check('keep existing clean title', preferTitle('Six: The Musical', 'Six the Musical - New York'), 'Six: The Musical');
check('tie keeps existing', preferTitle('MJ', 'Rush'), 'MJ');

// --- end-to-end upsert on real SQLite
const sqlite = new DatabaseSync(':memory:');
for (const f of ['0001_event_ideas.sql', '0005_geo.sql', '0006_category.sql']) {
  sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
}
function makeD1(db) {
  return {
    prepare(sql) {
      return {
        sql,
        params: [],
        bind(...args) { this.params = args; return this; },
        async all() { return { results: db.prepare(this.sql).all(...this.params) }; },
        async run() { const r = db.prepare(this.sql).run(...this.params); return { meta: { changes: r.changes } }; },
      };
    },
    async batch(stmts) { for (const s of stmts) db.prepare(s.sql).run(...s.params); return []; },
  };
}
const d1 = makeD1(sqlite);
const at = '2026-08-01T14:00:00-04:00';
let r2;

// TM inserts two spellings of Six (distinct TM events) in ONE batch, then
// SeatGeek's spelling arrives in a later batch: one row, canonical title.
let r = await upsertCandidates(d1, [
  buildCandidate({ title: 'Six (New York, NY)', venue: 'Lena Horne Theatre', start: at }, 'ticketmaster'),
  buildCandidate({ title: 'Six: The Musical', venue: 'Lena Horne Theatre', start: at, price: 'From $89' }, 'ticketmaster'),
]);
check('intra-batch variant folds', [r.inserted, r.merged], [1, 1]);
r = await upsertCandidates(d1, [
  buildCandidate({ title: 'Six the Musical - New York', venue: 'Lena Horne Theatre', start: at, image: 'https://img/six.jpg', image_source: 'seatgeek' }, 'seatgeek'),
]);
check('cross-source variant merges', [r.inserted, r.merged], [0, 1]);
let rows = sqlite.prepare("SELECT title, price, image, signals FROM candidates WHERE venue = 'Lena Horne Theatre'").all();
check('one Six row remains', rows.length, 1);
check('canonical title kept', rows[0].title, 'Six: The Musical');
check('price + image backfilled across variants', [rows[0].price, rows[0].image], ['From $89', 'https://img/six.jpg']);
check('signals accumulate', JSON.parse(rows[0].signals), ['ticketmaster', 'seatgeek']);

// Conference House Park: four exhibits at the same slot stay four rows.
r = await upsertCandidates(d1, [
  buildCandidate({ title: "Ongoing Outdoor Museum Exhibit: Alice's Terracotta Garden", venue: 'Conference House Park', start: at }, 'nyc-parks'),
  buildCandidate({ title: "Ongoing Museum Exhibit: New York's Brick & Terra Cotta Industries", venue: 'Conference House Park', start: at }, 'nyc-parks'),
  buildCandidate({ title: 'Ongoing Museum Exhibit: Out of the Box Biodiversity: Student Art', venue: 'Conference House Park', start: at }, 'nyc-parks'),
  buildCandidate({ title: 'Ongoing Museum Exhibit: Still Waters: Reflections of a Maritime Community', venue: 'Conference House Park', start: at }, 'nyc-parks'),
]);
check('exhibits all insert', [r.inserted, r.merged], [4, 0]);

// Bethel Woods: distinct tours at one timestamp stay distinct.
r = await upsertCandidates(d1, [
  buildCandidate({ title: 'Guided Docent Tour', venue: 'The Museum at Bethel Woods', start: at }, 'ticketmaster'),
  buildCandidate({ title: 'Behind the Scenes Tour', venue: 'The Museum at Bethel Woods', start: at }, 'ticketmaster'),
  buildCandidate({ title: 'The Historic Site Tour', venue: 'The Museum at Bethel Woods', start: at }, 'ticketmaster'),
  buildCandidate({ title: 'Adults Only Tour', venue: 'The Museum at Bethel Woods', start: at }, 'ticketmaster'),
]);
check('tours all insert', [r.inserted, r.merged], [4, 0]);

// Chicago at the Ambassador: three venue spellings + three title spellings,
// same exact start -> one row.
r = await upsertCandidates(d1, [
  buildCandidate({ title: 'Chicago', venue: 'Ambassador Theatre', start: at }, 'ticketmaster'),
  buildCandidate({ title: 'Chicago - The Musical', venue: 'Ambassador Theatre-NY', start: at }, 'ticketmaster'),
]);
r2 = await upsertCandidates(d1, [
  buildCandidate({ title: 'Chicago - The Musical - New York', venue: 'Ambassador Theatre - New York', start: at }, 'seatgeek'),
]);
check('Chicago venue variants collapse', [r.inserted, r.merged, r2.inserted, r2.merged], [1, 1, 0, 1]);
rows = sqlite.prepare("SELECT title FROM candidates WHERE venue LIKE 'Ambassador%'").all();
check('one Chicago row', [rows.length, rows[0]?.title], [1, 'Chicago']);

// Same show, different exact times, same NY date: secondary key still merges
// (TM doors vs SG set time at music venues).
r = await upsertCandidates(d1, [
  buildCandidate({ title: 'Fedge | Anjoli Simone', venue: 'Mercury Lounge', start: '2026-08-02T19:30:00-04:00' }, 'ticketmaster'),
]);
r = await upsertCandidates(d1, [
  buildCandidate({ title: 'Fedge with Anjoli Simone (21+)', venue: 'Mercury Lounge', start: '2026-08-02T20:00:00-04:00' }, 'seatgeek'),
]);
check('venue+date+headliner key still merges across times', [r.inserted, r.merged], [0, 1]);

process.exit(failures ? 1 : 0);
