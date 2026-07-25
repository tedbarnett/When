/**
 * When.org waitlist API - Cloudflare Pages Function
 *
 * POST /api/waitlist        { email, role?, city?, website? (honeypot) }
 * GET  /api/waitlist?key=X  admin listing (X must match env.WAITLIST_ADMIN_KEY)
 *
 * Storage: KV namespace bound as WHEN_WAITLIST, one record per email,
 * keyed `email:<lowercased address>`.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = new Set(['curious', 'curator', 'host', 'venue']);
const CITIES = new Set(['nyc', 'nola', 'other']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost({ request, env }) {
  let data = {};
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await request.json();
    } else {
      const form = await request.formData();
      data = Object.fromEntries(form.entries());
    }
  } catch {
    return json({ ok: false, error: 'Could not read the request body.' }, 400);
  }

  // Honeypot: bots fill hidden fields; pretend success, store nothing.
  if (typeof data.website === 'string' && data.website.trim() !== '') {
    return json({ ok: true, message: "You're on the list." });
  }

  const email = String(data.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'Enter a valid email address.' }, 400);
  }

  const role = ROLES.has(data.role) ? data.role : 'curious';
  const city = CITIES.has(data.city) ? data.city : 'other';
  const key = `email:${email}`;

  const existing = await env.WHEN_WAITLIST.get(key);
  if (existing) {
    return json({ ok: true, duplicate: true, message: "You're already on the list." });
  }

  await env.WHEN_WAITLIST.put(
    key,
    JSON.stringify({
      email,
      role,
      city,
      ts: new Date().toISOString(),
      ua: (request.headers.get('user-agent') || '').slice(0, 200),
      country: request.headers.get('cf-ipcountry') || '',
    })
  );

  return json({ ok: true, message: "You're on the list." });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!env.WAITLIST_ADMIN_KEY || key !== env.WAITLIST_ADMIN_KEY) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const signups = [];
  let cursor;
  do {
    const page = await env.WHEN_WAITLIST.list({ prefix: 'email:', cursor });
    const values = await Promise.all(
      page.keys.map((k) =>
        env.WHEN_WAITLIST.get(k.name).then((v) => {
          try {
            return JSON.parse(v);
          } catch {
            return { key: k.name, raw: v };
          }
        })
      )
    );
    signups.push(...values);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  signups.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return json({ ok: true, count: signups.length, signups });
}
