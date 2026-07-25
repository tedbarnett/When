# When

**An open calendar of everything happening.** [when.org](https://when.org)

When is an open-source feed layer for local events. The atomic unit is a
**calendar with an owner**: a curator who knows every jazz room in New York
publishes `when.org/nyc-jazz`, and you subscribe to it the way you'd
subscribe to a newsletter. Every calendar is simultaneously:

- a **web page** anyone can visit and share (with schema.org/Event markup),
- an **ICS feed** you can subscribe to in Apple or Google Calendar,
- a **JSON API** for apps and researchers,
- an **email digest** for subscribers who want one.

Think of it as **Substack for calendars**. Feeds are free forever; the
platform takes a small cut only when money moves (paid calendar
subscriptions, ~1% ticketing, tips). Reading, publishing, and subscribing
never cost anything. That's the .org promise.

Launching local-first: **New York City first, New Orleans next.**

From the founder of [When.com](https://en.wikipedia.org/wiki/AOL) (1998,
acquired by AOL in 1999), rebooted as open infrastructure.

## What's in this repo right now

Phase 0: the landing page and waitlist.

```
public/                  static site (hand-written HTML/CSS, no build step)
functions/api/waitlist.js  Cloudflare Pages Function backing the waitlist
docs/                    operational notes (DNS snapshots etc.)
```

- `POST /api/waitlist` stores signups (email, role, city) in Cloudflare KV,
  deduped by email, with a honeypot field for bots.
- `GET /api/waitlist?key=<admin key>` lists signups; the key lives in the
  Pages project environment (`WAITLIST_ADMIN_KEY`), never in this repo.

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
project to enable the admin listing.

## Self-hosting the platform

When is AGPL-3.0. When the core engine lands, anyone will be able to run a
When instance for their own town, campus, or scene, the same way you can
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
