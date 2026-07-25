/**
 * POST /api/auth/email {email} — request a magic sign-in link.
 * Token goes to KV (WHEN_AUTH, 15-min TTL). If RESEND_API_KEY is set the link
 * is emailed via Resend (from address in AUTH_EMAIL_FROM, falling back to
 * signin@barnettlabs.tech until when.org is verified in Resend); until then
 * we answer {ok:true, dev:true}
 * and send nothing (the token still exists but is never revealed).
 */
import { json } from '../../_lib/session.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TOKEN_TTL_SECONDS = 15 * 60;

export async function onRequestPost({ request, env }) {
  let data = {};
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Could not read the request body.' }, 400);
  }

  const email = String(data.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'Enter a valid email address.' }, 400);
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let token = '';
  for (let i = 0; i < bytes.length; i++) token += bytes[i].toString(16).padStart(2, '0');

  await env.WHEN_AUTH.put(
    'magic:' + token,
    JSON.stringify({ email, ts: Date.now() }),
    { expirationTtl: TOKEN_TTL_SECONDS }
  );

  if (!env.RESEND_API_KEY) {
    // Email delivery not wired up yet (no Resend key). Don't leak the token.
    return json({ ok: true, dev: true });
  }

  const host = new URL(request.url).host;
  const link = `https://${host}/api/auth/verify?token=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM || 'When.org <signin@barnettlabs.tech>',
      to: [email],
      subject: 'Your When.org sign-in link',
      text:
        `Here is your When.org sign-in link (valid for 15 minutes):\n\n${link}\n\n` +
        `If you didn't request this, you can ignore this email.`,
      html:
        `<p>Here is your When.org sign-in link (valid for 15 minutes):</p>` +
        `<p><a href="${link}">Sign in to When.org</a></p>` +
        `<p style="color:#5b6068">If you didn&rsquo;t request this, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    return json({ ok: false, error: 'Could not send the email. Try again in a minute.' }, 502);
  }
  return json({ ok: true });
}
