# When.org

**An open calendar of everything happening.** [when.org](https://when.org)

<img width="1446" height="1638" alt="image" src="https://github.com/user-attachments/assets/2f9e09a4-0197-47b1-b85d-03f6e36847d0" />

When.org is an open-source feed layer for local events. The atomic unit is a
**calendar with an owner**: a curator who knows every jazz room in New York
publishes `when.org/nyc-jazz`, and you subscribe to it the way you'd
subscribe to a newsletter. Every calendar is simultaneously:

- a **web page** anyone can visit and share (with schema.org/Event markup),
- an **ICS feed** you can subscribe to in Apple or Google Calendar,
- a **JSON API** for apps, researchers — and your personal AI,
- an **email digest** for subscribers who want one.

Think of it as a **Substack for calendars**. The When.org platform is
free, but curators can sell calendar subscriptions, tickets, tips.
Calendars can be free or, if high-quality enough, paid. Reading,
publishing, and subscribing never cost anything. That's the .org promise.

Launching local-first: **New York City first** — with
[Ted's Dublin](https://when.org/teds-dublin) and
[Ted's Reykjavik](https://when.org/teds-reykjavik) as the first
follow-on cities (a city switcher on each calendar page jumps between
them).

From the founder of When.com (1998, acquired by AOL in 1999) — click
"When.com" in the footer of [when.org](https://when.org) for that story —
rebooted as open infrastructure.

## Live right now

- [when.org](https://when.org) — landing page, manifesto, waitlist, and the
  When.com history
- [when.org/teds-nyc](https://when.org/teds-nyc) — **Ted's NYC**, the first
  curated calendar: ~26 real geo-tagged events across the next 7 days in the
  "tonight-first" browser — week / day / month views, borough filter chips,
  a personal history view ("I was there"), one-tap sharing, dark/light
  themes, real venue/press photos (never AI-generated imagery)
- Every event has its own shareable URL —
  `when.org/teds-nyc/{event-id}` — with per-event OG tags and
  schema.org/Event markup
- [when.org/teds-nyc.ics](https://when.org/teds-nyc.ics) — its live ICS
  feed; subscribe once in Apple or Google Calendar and each week's picks
  arrive automatically
- [when.org/data/teds-nyc.json](https://when.org/data/teds-nyc.json) — the
  same calendar as JSON (merged with the curator's live edits)
- Curator tools (owner-only, no redeploys): hide events, edit-in-place,
  and a **paste-a-URL importer** — drop any event page link, the server
  reads its schema.org data (AI fallback for messy pages), you review a
  card, one tap adds it to the calendar

## What's in this repo

Phase 0: the landing page, the waitlist, the first curated calendar,
passwordless auth scaffolding, and the When.com history modal.

```
public/                          static site (hand-written HTML/CSS, no build step)
public/index.html                landing page + waitlist + history modal + menu
public/teds-nyc.html             the event browser (week/day/month, history, tray)
public/data/teds-nyc.json        base event data (KV overlay merges on top)
public/history/                  When.com artifacts (1999 homepage, original logo)
public/fonts/                    Satoshi + Bricolage Grotesque (self-hosted)
functions/teds-nyc.ics.js        ICS feed (merged, hidden events excluded)
functions/teds-nyc/[id].js       per-event pages: OG + schema.org injection
functions/data/teds-nyc.json.js  public JSON (merged view of base + overlay)
functions/api/calendars/teds-nyc/overlay.js  owner writes: hide/edit/add/reset
functions/api/calendars/teds-nyc/import.js   paste-a-URL extractor (JSON-LD + AI)
functions/api/calendars/teds-nyc/admin.js    owner-only full view
functions/api/me/prefs.js        account-synced saves/history/follows
functions/api/waitlist.js        waitlist storage (Cloudflare KV)
functions/api/auth/              sign-in: Google OAuth + magic email links
functions/api/me.js              session check for the signed-in menu
functions/_lib/session.js        signed-cookie sessions (HMAC, Web Crypto)
functions/_lib/calendar.js       the merge layer: base JSON + curator overlay
scripts/                         node test harnesses (import, overlay, prefs)
docs/                            operational notes (DNS snapshots etc.)
```

- `POST /api/waitlist` stores signups (email, role, city) in Cloudflare KV,
  deduped by email, with a honeypot field for bots.
- `GET /api/waitlist?key=<admin key>` lists signups; the key lives in the
  Pages project environment (`WAITLIST_ADMIN_KEY`), never in this repo.
- Sign-in is passwordless: Google (identity scopes only) or a magic email
  link. Sessions are signed cookies (`SESSION_SECRET`); magic-link tokens
  live in KV with a 15-minute TTL. Secrets stay in the Pages project env.
- Anonymous-first: browsing, feeds, and ICS subscriptions never require an
  account. Signing in exists only to *save* things — following calendars,
  favorites — and sync them across devices.

How the curator layer works: the base week lives in git
(`public/data/teds-nyc.json`); the curator's live changes (hidden events,
in-place edits, imported events) live in a Cloudflare KV overlay that one
shared module merges into every consumer — page, JSON, ICS, and per-event
pages never disagree, and nothing requires a redeploy.

The full platform (calendar creation for everyone, venues, Stripe Connect
payouts) is tracked in [the issues](https://github.com/tedbarnett/When/issues);
see the roadmap below.

## Design rules

- Hand-written HTML/CSS, no framework, no build step.
- **Real images only** — venue photos, show posters, press shots. Never
  AI-generated imagery. Events without a good real photo get typographic
  color-block cards instead.
- In prose the product is always called **When.org** (the 1998-99 company
  is "When.com"). The repo keeps the short name.

## Running it yourself

The site is a static folder plus Cloudflare Pages Functions:

```sh
npm install -g wrangler
wrangler kv namespace create WHEN_WAITLIST   # put the id in wrangler.toml
wrangler kv namespace create WHEN_AUTH       # ditto
wrangler pages dev public                    # local dev
wrangler pages deploy public --project-name <your-project>
```

Set `WAITLIST_ADMIN_KEY` as a secret/environment variable on the Pages
project to enable the admin listing. For sign-in, also set
`SESSION_SECRET` (any long random string) and `GOOGLE_CLIENT_SECRET`
(pair it with your own Google OAuth web client — set the client ID in
`functions/api/auth/google.js` and add
`https://<your-domain>/api/auth/google/callback` as an authorized
redirect URI), and optionally `RESEND_API_KEY` for magic-link emails.

## Self-hosting the platform

When.org is AGPL-3.0. When the core engine lands, anyone will be able to
run a When.org instance for their own town, campus, or scene, the same way
you can self-host Ghost or Mastodon. when.org is the flagship hosted
instance, not the only one. Data out is sacred: ICS + JSON + schema.org
markup on every page, no lock-in, ever.

## Roadmap

- **Phase 0 ✓:** manifesto, waitlist, the first hand-curated NYC calendar
  with a live ICS feed, passwordless sign-in.
- **Phase 1 (mostly ✓):** the redesigned tonight-first browser
  (week/day/month), geo filters, sharing, personal history,
  account-synced saves, curator hide + edit-in-place, and the paste-a-URL
  AI importer. Still open: automated nightly supply from venue scrapers
  and ICS ingest.
- **Phase 2:** calendars for everyone — a real publish backend
  ([#8](https://github.com/tedbarnett/When/issues/8)) so anyone (and any
  nightclub, band, or meetup —
  [#12](https://github.com/tedbarnett/When/issues/12)) claims
  `when.org/{handle}`; bundles + a personal-AI endpoint
  ([#10](https://github.com/tedbarnett/When/issues/10)); AI-native
  plumbing — llms.txt, welcoming robots.txt, MCP server
  ([#11](https://github.com/tedbarnett/When/issues/11)).
- **Phase 3:** money. Stripe Connect
  ([#9](https://github.com/tedbarnett/When/issues/9)): paid calendar
  subscriptions at any price the curator sets, native ticketing (~1%
  platform fee), tips. Then New Orleans.

## License

[AGPL-3.0](LICENSE)
