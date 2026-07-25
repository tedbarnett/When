/**
 * GET /api/auth/google/callback — finish Google sign-in.
 * Exchanges the code, verifies the email is Google-verified, sets the
 * session cookie, and sends the user home.
 */
import { createSessionCookie } from '../../../_lib/session.js';

const GOOGLE_CLIENT_ID =
  '287432660870-nqjutd4q7ujuo8uuubippf199ndra16t.apps.googleusercontent.com';

function fail(message, status = 400) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Sign-in problem · When.org</title>` +
      `<body style="font-family:system-ui;background:#f6f6f3;color:#17191e;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">` +
      `<div style="text-align:center;max-width:32rem;padding:24px"><h1 style="font-size:22px">Sign-in didn&rsquo;t work</h1>` +
      `<p style="color:#5b6068">${message}</p>` +
      `<p><a href="/" style="color:#2138d6;font-weight:700">Back to When.org</a></p></div></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return fail('Google reported: ' + error.replace(/[^\w -]/g, '') + '.');
  const code = url.searchParams.get('code');
  if (!code) return fail('Missing authorization code.');

  const redirectUri = `https://${url.host}/api/auth/google/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || tokens.error || !tokens.access_token) {
    return fail('The sign-in code could not be exchanged. Try again.');
  }

  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!userRes.ok || !user.email) return fail('Could not read your Google profile. Try again.');
  if (user.email_verified !== true && user.email_verified !== 'true') {
    return fail('That Google account&rsquo;s email address is not verified.', 403);
  }

  const cookie = await createSessionCookie(env, {
    email: String(user.email).toLowerCase(),
    name: user.name || user.given_name || '',
  });
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': cookie },
  });
}
