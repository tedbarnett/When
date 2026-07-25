/**
 * when-ingest adapter — NYC Parks public events (Tier B: open data).
 *
 * Feed: https://www.nycgovparks.org/xml/events_300_rss.xml — RSS 2.0 with a
 * custom `event:` namespace ("NYC Parks Public Events - Upcoming 14 Days",
 * ~1,800 items). Per <item> (verified live 2026-07-25):
 *   <title><![CDATA[…]]></title>
 *   <link>http://www.nycgovparks.org/events/…</link>
 *   <event:parkids>M072</event:parkids>          (borough letter prefix)
 *   <event:parknames>Riverside Park</event:parknames>
 *   <event:startdate>2026-07-25</event:startdate>
 *   <event:enddate>2026-07-25</event:enddate>
 *   <event:starttime>8:00 am</event:starttime>
 *   <event:endtime>10:00 am</event:endtime>
 *   <event:location><![CDATA[…]]></event:location>
 *   <description><![CDATA[<p>…]]></description>
 *
 * Legal posture (issue #13): facts only. The <description> prose is NEVER
 * copied into blurb (blurb stays '', blurb_origin 'none'), and feed images
 * are not rehosted or hotlinked. Regex parsing on purpose — no npm deps.
 */

const FEED_URL = 'https://www.nycgovparks.org/xml/events_300_rss.xml';
const USER_AGENT = 'When.org events bot (+https://when.org/bot)';

/* parkids prefix -> borough (NYC Parks property-number convention) */
const BOROUGH = { B: 'Brooklyn', M: 'Manhattan', Q: 'Queens', R: 'Staten Island', X: 'Bronx' };

function field(item, tag) {
  const m = item.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

/** "8:00 am" -> "08:00" (24h). Empty/unparseable -> ''. */
function time24(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m/i);
  if (!m) return '';
  let h = parseInt(m[1], 10) % 12;
  if (/p/i.test(m[3])) h += 12;
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

/**
 * Parse the feed XML into raw candidates (facts only).
 * Exported separately so it can be exercised standalone in tests.
 */
export function parseFeed(xml, nyISOFromLocal) {
  const out = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const chunk of items) {
    const item = chunk.split(/<\/item>/i)[0];
    const title = field(item, 'title');
    const startDate = field(item, 'event:startdate');
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) continue;

    const startTime = time24(field(item, 'event:starttime')) || '00:00';
    const start = nyISOFromLocal(startDate + 'T' + startTime);

    let end = '';
    const endDate = field(item, 'event:enddate');
    const endTime = time24(field(item, 'event:endtime'));
    if (/^\d{4}-\d{2}-\d{2}$/.test(endDate) && (endDate !== startDate || endTime)) {
      end = nyISOFromLocal(endDate + 'T' + (endTime || '23:59'));
    }

    const parkNames = field(item, 'event:parknames');
    const location = field(item, 'event:location');
    const url = field(item, 'link');
    const boroughLetter = (field(item, 'event:parkids') || '').charAt(0).toUpperCase();

    out.push({
      title,
      venue: parkNames || location,
      neighborhood: BOROUGH[boroughLetter] || '',
      start,
      end,
      price: '', // feed carries no price facts; most Parks events are free but we don't assert it
      url,
      source_url: url,
      image: '', // feed images are NYC Parks' own — we don't rehost/hotlink (Tier B stays facts-only)
      image_source: '',
      blurb: '', // never copy <description> prose
      blurb_origin: 'none',
    });
  }
  return out;
}

/**
 * Run the adapter: fetch + parse.
 * @returns {Promise<{candidates: object[], status: string}>}
 */
export async function run(env, helpers) {
  const res = await fetch(FEED_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('feed HTTP ' + res.status);
  const xml = await res.text();
  const candidates = parseFeed(xml, helpers.nyISOFromLocal);
  return { candidates, status: 'ok:' + candidates.length };
}
