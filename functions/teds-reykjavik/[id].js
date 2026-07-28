/**
 * Per-event shareable URLs: when.org/teds-reykjavik/{event-id}
 * Serves the Ted's Reykjavik browser page with that event's OG/schema
 * markup injected and the detail modal opened on load. Thin wrapper over
 * the shared factory (_lib/eventPage.js).
 */
import { makeEventPageHandler } from '../_lib/eventPage.js';

export const onRequestGet = makeEventPageHandler('teds-reykjavik', {
  calLabel: 'Ted’s Reykjavik',
  fallbackDesc: 'A pick from Ted’s Reykjavik on When.org.',
  organizer: { '@type': 'Person', name: 'Ted (Ted’s Reykjavik on When.org)' },
  cityName: 'Reykjavik',
  cityAddress: 'Reykjavík, Iceland',
}).onRequestGet;
