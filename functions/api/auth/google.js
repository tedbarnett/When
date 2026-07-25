/**
 * GET /api/auth/google — kick off Google sign-in (server-side code flow).
 * Scopes are identity-only: openid email profile. No calendar/gmail access.
 * redirect_uri is built from the request host so when.org and www both work.
 */
const GOOGLE_CLIENT_ID =
  '287432660870-nqjutd4q7ujuo8uuubippf199ndra16t.apps.googleusercontent.com';

export function onRequestGet({ request }) {
  const url = new URL(request.url);
  const redirectUri = `https://${url.host}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
  });
  return Response.redirect(
    'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
    302
  );
}
