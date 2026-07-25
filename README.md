# When.org

**An open calendar of everything happening.** [when.org](https://when.org)

When.org is an open-source feed layer for local events. The atomic unit is a
**calendar with an owner**: a curator who knows every jazz room in New York
publishes `when.org/nyc-jazz`, and you subscribe to it the way you'd
subscribe to a newsletter. Every calendar is simultaneously:

- a **web page** anyone can visit and share (with schema.org/Event markup),
- an **ICS feed** you can subscribe to in Apple or Google Calendar,
- a **JSON API** for apps and researchers,
- an **email digest** for subscribers who want one.

Think of it as a **Substack for calendars**. The When.org platform is
free, but curators can sell calendar subscriptions, tickets, tips.
Calendars can be free or, if high-quality enough, paid. Reading,
publishing, and subscribing never cost anything. That's the .org promise.

Launching local-first: **New York City first, New Orleans next.**

From the founder of [When.com](https://en.wikipedia.org/wiki/AOL) (1998,
acquired by AOL in 1999), rebooted as open infrastructure.

## What's in this repo right now

Phase 0: the landing page, the waitlist, the first curated calendar
(Ted's NYC), and passwordless auth scaffolding.

```
public/                    static site (hand-written HTML/CSS, no build step)
public/teds-nyc.html       first curated calendar (page + JSON + ICS feed)
functions/api/waitlist.js  Cloudflare Pages Function backing the waitlist
functions/api/auth/        sign-in: Google OAuth + magic email links
functions/api/me.js        session check for the signed-in menu
docs/                      operational notes (DNS snapshots etc.)
```

- `POST /api/waitlist` stores signups (email, role, city) in Cloudflare KV,
  deduped by email, with a honeypot field for bots.
- `GET /api/waitlist?key=<admin key>` lists signups; the key lives in the
  Pages project environment (`WAITLIST_ADMIN_KEY`), never in this repo.
- Sign-in is passwordless: Google (identity scopes only) or a magic email
  link. Sessions are signed cookies (`SESSION_SECRET`); magic-link tokens
  live in KV with a 15-minute TTL. Secrets stay in the Pages project env.

The full platform (calendars, events, venues, ICS/JSON feeds, Stripe
Connect payouts) comes next; see the roadmap below.

## Running it yourself

The site is a static folder plus one Pages Function, deployed on
Cloudflare Pages:

```sh
npm install -g wrangler
wrangler kv namespace create WHEN_WAITLIST   # put the id in wrangler.toml
wrangler pages dev public                    # local dev
wrangler pages deploy public --project-name <your-project>
```

Set `WAITLIST_ADMIN_KEY` as a secret/environment variable on the Pages
project to enable the admin listing. For sign-in, also set
`SESSION_SECRET` (any long random string), `GOOGLE_CLIENT_SECRET` (a
Google OAuth web client with `/api/auth/google/callback` as redirect
URI), and optionally `RESEND_API_KEY` for magic-link emails, plus a
`WHEN_AUTH` KV namespace in `wrangler.toml`.

## Self-hosting the platform

When.org is AGPL-3.0. When the core engine lands, anyone will be able to
run a When.org instance for their own town, campus, or scene, the same way you can
self-host Ghost or Mastodon. when.org is the flagship hosted instance, not
the only one. Data out is sacred: ICS + JSON + schema.org markup on every
page, no lock-in, ever.

## Roadmap

- **Phase 0 (now):** manifesto, waitlist, and a handful of genuinely great
  hand-curated NYC calendars with live ICS feeds.
- **Phase 1:** calendar creation, event submission, moderation,
  claim-your-venue. Every page ships ICS + JSON from day one.
- **Phase 2:** money. Stripe Connect: paid subscriptions, native ticketing
  (~1% platform fee), tips.
- **Phase 3:** scale the supply. Importers, public API keys, embeds,
  digest emails.

## License

[AGPL-3.0](LICENSE)
