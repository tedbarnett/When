/**
 * GET /api/auth/verify?token=... — consume a magic-link token.
 * Valid token: set session cookie, redirect home. Otherwise a friendly
 * "link expired" page. Tokens are single-use (deleted on first sight).
 */
import { createSessionCookie } from '../../_lib/session.js';

function expiredPage() {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Link expired · When.org</title>` +
      `<body style="font-family:system-ui;background:#f6f6f3;color:#17191e;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:32rem;padding:24px"><h1 style="font-size:22px">That link has expired</h1>` +
      `<p style="color:#5b6068">Sign-in links only last 15 minutes and work once. Request a fresh one from the menu.</p>` +
      `<p><a href="/" style="color:#2138d6;font-weight:700">Back to When.org</a></p></div></body>`,
    { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return expiredPage();

  const raw = await env.WHEN_AUTH.get('magic:' + token);
  if (!raw) return expiredPage();
  await env.WHEN_AUTH.delete('magic:' + token);

  let email;
  try {
    email = JSON.parse(raw).email;
  } catch {
    return expiredPage();
  }
  if (!email) return expiredPage();

  const cookie = await createSessionCookie(env, {
    email,
    name: email.split('@')[0],
  });
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': cookie },
  });
}
