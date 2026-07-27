/**
 * Per-event shareable URLs: when.org/teds-dublin/{event-id}
 * Serves the Ted's Dublin browser page with that event's OG/schema markup
 * injected and the detail modal opened on load. Thin wrapper over the
 * shared factory (_lib/eventPage.js).
 */
import { makeEventPageHandler } from '../_lib/eventPage.js';

export const onRequestGet = makeEventPageHandler('teds-dublin', {
  calLabel: 'Ted’s Dublin',
  fallbackDesc: 'A pick from Ted’s Dublin on When.org.',
  organizer: { '@type': 'Person', name: 'Ted (Ted’s Dublin on When.org)' },
  cityName: 'Dublin',
  cityAddress: 'Dublin, Ireland',
}).onRequestGet;
