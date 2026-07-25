/**
 * GET /api/me — who is signed in?
 * 200 {email, name, isOwner} when a valid session cookie is present, else 401.
 */
import { readSession, json, OWNER_EMAIL } from '../_lib/session.js';

export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401);
  return json({
    email: session.email,
    name: session.name || '',
    isOwner: session.email === OWNER_EMAIL,
  });
}
