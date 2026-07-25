// Unit check for functions/api/me/prefs.js (no session secret -> anon 401;
// validation paths exercised with a stubbed session).
import * as prefs from '../functions/api/me/prefs.js';

const kv = new Map();
const env = {
  SESSION_SECRET: '', // readSession returns null without a secret -> anon
  WHEN_AUTH: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
  },
};
const req = (method, body, cookie) =>
  new Request('https://when.org/api/me/prefs', {
    method,
    headers: { cookie: cookie || '', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let failures = 0;
async function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (got ${got}, want ${want})`);
}

// anon
await check('GET anon -> 401', (await prefs.onRequestGet({ request: req('GET'), env })).status, 401);
await check('PUT anon -> 401', (await prefs.onRequestPut({ request: req('PUT', {}), env })).status, 401);
await check('DELETE -> 405', prefs.onRequest().status, 405);

// signed-in paths: forge a valid session with a known secret
const env2 = { ...env, SESSION_SECRET: 'test-secret' };
const { createSessionCookie } = await import('../functions/_lib/session.js');
const setCookie = await createSessionCookie(env2, { email: 'ted@example.com', name: 'Ted' });
const cookie = setCookie.split(';')[0];

const g1 = await prefs.onRequestGet({ request: req('GET', undefined, cookie), env: env2 });
await check('GET signed-in empty -> 200', g1.status, 200);
const d1 = await g1.json();
await check('empty followed=false', d1.followed, false);

await check('PUT bad (saved array) -> 400',
  (await prefs.onRequestPut({ request: req('PUT', { saved: [], attended: {}, followed: false }, cookie), env: env2 })).status, 400);
await check('PUT bad (followed string) -> 400',
  (await prefs.onRequestPut({ request: req('PUT', { saved: {}, attended: {}, followed: 'yes' }, cookie), env: env2 })).status, 400);
await check('PUT bad (id too long) -> 400',
  (await prefs.onRequestPut({ request: req('PUT', { saved: { ['x'.repeat(121)]: true }, attended: {}, followed: false }, cookie), env: env2 })).status, 400);
const tooMany = Object.fromEntries(Array.from({ length: 501 }, (_, i) => ['id' + i, true]));
await check('PUT bad (>500 entries) -> 400',
  (await prefs.onRequestPut({ request: req('PUT', { saved: tooMany, attended: {}, followed: false }, cookie), env: env2 })).status, 400);

const p1 = await prefs.onRequestPut({ request: req('PUT', { saved: { 'a-1': true }, attended: { 'b-2': true }, followed: true }, cookie), env: env2 });
await check('PUT good -> 200', p1.status, 200);
const g2 = await prefs.onRequestGet({ request: req('GET', undefined, cookie), env: env2 });
const d2 = await g2.json();
await check('roundtrip saved', d2.saved['a-1'], true);
await check('roundtrip attended', d2.attended['b-2'], true);
await check('roundtrip followed', d2.followed, true);
await check('roundtrip has updated', typeof d2.updated, 'string');
await check('KV key is prefs:{email}', kv.has('prefs:ted@example.com'), true);

process.exit(failures ? 1 : 0);
