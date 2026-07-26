/**
 * Per-event shareable URLs: when.org/basics-nyc/{event-id} (issue #15).
 * Serves the NYC Basics browser page with that event's OG/schema markup
 * injected and the detail modal opened on load. Thin wrapper over the
 * shared factory (_lib/eventPage.js).
 */
import { makeEventPageHandler } from '../_lib/eventPage.js';

export const onRequestGet = makeEventPageHandler('basics-nyc', {
  calLabel: 'NYC Basics',
  fallbackDesc: 'A pick from NYC Basics on When.org.',
  organizer: { '@type': 'Organization', name: 'NYC Basics on When.org' },
}).onRequestGet;
