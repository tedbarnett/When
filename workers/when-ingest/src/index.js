/**
 * when-ingest — scheduled Worker for the Event Ideas pipeline (issue #13,
 * P0 adapters + P1 generic crawlers).
 *
 * Every 6 hours (cron trigger in wrangler.toml) — and on demand via POST /run
 * with the x-ingest-token header matching the INGEST_TOKEN secret — the Worker:
 *   1. reads enabled rows from D1 `sources`
 *   2. dispatches by sources.kind:
 *        'api'    — bespoke adapter (Tier A: ticketmaster, Tier B: nyc-parks)
 *        'jsonld' — generic schema.org Event crawler (crawl/jsonld.js)
 *        'ics'    — generic iCalendar feed crawler (crawl/ics.js)
 *        'signal' — skipped with last_status 'signal_p2' (leads, not facts;
 *                   resolve-to-primary lands in P2)
 *   3. normalizes + upserts candidates (dedupe/merge, see normalize.js)
 *   4. stamps sources.last_run / last_status / last_count / last_error
 *   5. expires candidates whose NY-local start date has passed
 *
 * Crawl guardrails: max 25 jsonld/ics sources per run, 400ms between fetches,
 * robots.txt honored (per-origin cache per run), HTTP 403 → 'blocked', and a
 * per-source try/catch so one bad source never kills the run.
 *
 * Bindings: WHEN_EVENTS (D1). Secrets: TM_API_KEY (optional — Ticketmaster
 * skips with last_status 'no_key' without it), INGEST_TOKEN (for /run).
 */

import * as nycParks from './adapters/nycParks.js';
import * as ticketmaster from './adapters/ticketmaster.js';
import * as crawlJsonld from './crawl/jsonld.js';
import * as crawlIcs from './crawl/ics.js';
import {
  buildCandidate,
  expirePast,
  nyISOFromDate,
  nyISOFromLocal,
  upsertCandidates,
} from './normalize.js';

/** sources.id -> adapter module (each exports run(env, helpers)). */
const ADAPTERS = {
  'nyc-parks': nycParks,
  ticketmaster: ticketmaster,
};

const HELPERS = { nyISOFromDate, nyISOFromLocal };

const MAX_CRAWL_SOURCES_PER_RUN = 25;
const CRAWL_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run one source row; returns {status, error, candidates: raw[]}. */
async function runSource(row, env, robotsCache) {
  if (row.kind === 'jsonld') {
    const r = await crawlJsonld.crawl(row, HELPERS, robotsCache);
    return { status: r.status, candidates: r.candidates };
  }
  if (row.kind === 'ics') {
    const r = await crawlIcs.crawl(row, HELPERS);
    return { status: r.status, candidates: r.candidates };
  }
  // kind 'api' (and legacy rows without kind): bespoke adapter by id.
  const adapter = ADAPTERS[row.id];
  if (!adapter) return null; // seeded-but-unimplemented source
  const r = await adapter.run(env, HELPERS);
  return { status: r.status, candidates: r.candidates };
}

async function runPipeline(env) {
  const db = env.WHEN_EVENTS;
  const summary = { sources: {}, expired: 0 };
  const robotsCache = new Map(); // per-run robots.txt cache (origin -> rules)

  const { results: sources } = await db
    .prepare('SELECT id, name, kind, crawl_url FROM sources WHERE enabled = 1')
    .all();

  // Per-run crawl budget: api sources always run; jsonld/ics are capped.
  let crawlBudget = MAX_CRAWL_SOURCES_PER_RUN;
  let lastFetchWasCrawl = false;

  for (const row of sources || []) {
    const isCrawl = row.kind === 'jsonld' || row.kind === 'ics';
    if (row.kind === 'signal') {
      summary.sources[row.id] = { status: 'signal_p2' };
      await db
        .prepare('UPDATE sources SET last_run = ?, last_status = ?, last_count = 0, last_error = ? WHERE id = ?')
        .bind(new Date().toISOString(), 'signal_p2', '', row.id)
        .run();
      continue;
    }
    if (isCrawl) {
      if (crawlBudget <= 0) continue; // leave state untouched; next run picks it up
      crawlBudget--;
      if (lastFetchWasCrawl) await sleep(CRAWL_DELAY_MS);
      lastFetchWasCrawl = true;
    }
    const startedAt = new Date().toISOString();
    let status;
    let lastError = '';
    let count = 0;
    try {
      const result = await runSource(row, env, robotsCache);
      if (!result) continue; // no adapter for this api row
      const canonical = [];
      for (const r of result.candidates) {
        const c = buildCandidate(r, row.id);
        if (c) canonical.push(c);
      }
      const { inserted, merged } = await upsertCandidates(db, canonical);
      status = result.status;
      count = canonical.length;
      summary.sources[row.id] = { status, candidates: count, inserted, merged };
    } catch (err) {
      lastError = (err && err.message ? err.message : String(err)).slice(0, 200);
      status = ('error: ' + lastError).slice(0, 200);
      summary.sources[row.id] = { status };
      console.error('when-ingest source failed', row.id, err);
    }
    await db
      .prepare('UPDATE sources SET last_run = ?, last_status = ?, last_count = ?, last_error = ? WHERE id = ?')
      .bind(startedAt, status, count, lastError, row.id)
      .run();
  }

  summary.expired = await expirePast(db);
  return summary;
}

export default {
  /** Cron entry point. */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runPipeline(env).then(
        (summary) => console.log('when-ingest run', JSON.stringify(summary)),
        (err) => console.error('when-ingest run failed', err)
      )
    );
  },

  /** Manual runs: POST /run with x-ingest-token = INGEST_TOKEN secret. */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }
    const token = request.headers.get('x-ingest-token') || '';
    if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
      return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    try {
      const summary = await runPipeline(env);
      return new Response(JSON.stringify({ ok: true, ...summary }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      console.error('when-ingest manual run failed', err);
      return new Response(JSON.stringify({ ok: false, error: 'pipeline failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  },
};
