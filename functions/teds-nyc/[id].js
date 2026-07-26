/**
 * Per-event shareable URLs: when.org/teds-nyc/{event-id}
 * Serves the Ted's NYC browser page with that event's OG/schema markup
 * injected and the detail modal opened on load. Thin wrapper over the
 * shared factory (_lib/eventPage.js) — inherited NYC Basics events resolve
 * here too.
 */
import { makeEventPageHandler } from '../_lib/eventPage.js';

export const onRequestGet = makeEventPageHandler('teds-nyc', {
  calLabel: 'Ted’s NYC',
  fallbackDesc: 'A pick from Ted’s NYC on When.org.',
  organizer: { '@type': 'Person', name: 'Ted (Ted’s NYC on When.org)' },
}).onRequestGet;
