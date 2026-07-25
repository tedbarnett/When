/**
 * GET /api/auth/logout — clear the session cookie, go home.
 */
import { clearSessionCookie } from '../../_lib/session.js';

export function onRequestGet() {
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': clearSessionCookie() },
  });
}
