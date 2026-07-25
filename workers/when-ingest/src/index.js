/**
 * when-ingest — scheduled Worker for the Event Ideas pipeline (issue #13, P0).
 *
 * Every 6 hours (cron trigger in wrangler.toml) — and on demand via POST /run
 * with the x-ingest-token header matching the INGEST_TOKEN secret — the Worker:
 *   1. reads enabled rows from D1 `sources`
 *   2. runs the matching adapter (Tier A: ticketmaster, Tier B: nyc-parks)
 *   3. normalizes + upserts candidates (dedupe/merge, see normalize.js)
 *   4. stamps sources.last_run / last_status per adapter
 *   5. expires candidates whose NY-local start date has passed
 *
 * Bindings: WHEN_EVENTS (D1). Secrets: TM_API_KEY (optional — Ticketmaster
 * skips with last_status 'no_key' without it), INGEST_TOKEN (for /run).
 */

import * as nycParks from './adapters/nycParks.js';
import * as ticketmaster from './adapters/ticketmaster.js';
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

async function runPipeline(env) {
  const db = env.WHEN_EVENTS;
  const summary = { sources: {}, expired: 0 };

  const { results: sources } = await db
    .prepare('SELECT id FROM sources WHERE enabled = 1')
    .all();

  for (const row of sources || []) {
    const adapter = ADAPTERS[row.id];
    if (!adapter) continue; // seeded-but-unimplemented source (future tiers)
    const startedAt = new Date().toISOString();
    let status;
    try {
      const { candidates: raw, status: adapterStatus } = await adapter.run(env, HELPERS);
      const canonical = [];
      for (const r of raw) {
        const c = buildCandidate(r, row.id);
        if (c) canonical.push(c);
      }
      const { inserted, merged } = await upsertCandidates(db, canonical);
      status = adapterStatus;
      summary.sources[row.id] = { status, candidates: canonical.length, inserted, merged };
    } catch (err) {
      status = ('error: ' + (err && err.message ? err.message : String(err))).slice(0, 200);
      summary.sources[row.id] = { status };
      console.error('when-ingest adapter failed', row.id, err);
    }
    await db
      .prepare('UPDATE sources SET last_run = ?, last_status = ? WHERE id = ?')
      .bind(startedAt, status, row.id)
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
