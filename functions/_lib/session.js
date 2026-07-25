/**
 * When.org session helpers.
 *
 * Session = signed cookie. Value: base64url(JSON {email, name, exp}) + "." +
 * base64url(HMAC-SHA256 signature over the payload), keyed by env.SESSION_SECRET.
 * Cookie: HttpOnly, Secure, SameSite=Lax, 30 days.
 *
 * This directory is underscore-prefixed so Pages Functions never routes it.
 */

export const OWNER_EMAIL = 'tedbarnett@gmail.com';

const COOKIE_NAME = 'when_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const enc = new TextEncoder();

function b64urlFromBytes(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages
  );
}

/** Build the Set-Cookie header value for a fresh 30-day session. */
export async function createSessionCookie(env, user) {
  const payload = {
    email: user.email,
    name: user.name || '',
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  };
  const body = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(env.SESSION_SECRET, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const value = body + '.' + b64urlFromBytes(sig);
  return `${COOKIE_NAME}=${value}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Set-Cookie header value that clears the session. */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Verify the session cookie. Returns {email, name, exp} or null. */
export async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = request.headers.get('cookie') || '';
  const m = cookies.match(/(?:^|;\s*)when_session=([^;\s]+)/);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  try {
    const key = await hmacKey(env.SESSION_SECRET, ['verify']);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      bytesFromB64url(parts[1]),
      enc.encode(parts[0])
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[0])));
    if (!payload || typeof payload.email !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
