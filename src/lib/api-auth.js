import { NextResponse } from 'next/server'
import { safeEqual } from './webhook-auth'
import { getCurrentUser } from './auth'
import { MANAGER_ROLES } from './schemas'

// Validates the API key sent by n8n in the Authorization header.
// Comparison is constant-time so an attacker can't observe how many leading
// bytes of CRM_API_KEY they got right by timing 401 responses. Vercel's edge
// adds enough latency noise that a real timing attack is impractical, but
// there's no reason to leave a `!==` here either.
//
// Note: token extraction now uses startsWith() instead of replace(), which
// previously would strip "Bearer " from anywhere in the string (e.g.
// "abcBearer xyz" became "abcxyz") rather than only the prefix.
//
// Usage: const error = requireApiKey(request); if (error) return error;
export function requireApiKey(request) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const expected = process.env.CRM_API_KEY

  if (!expected || !safeEqual(token, expected)) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    )
  }
  return null // auth OK
}

/**
 * Same as requireApiKey but ALSO accepts a logged-in manager+ user
 * (cookie auth) as a valid caller. Used by routes that started life
 * as n8n integration endpoints (POST /api/contacts, etc.) and now
 * also need to be reachable from the web UI.
 *
 * Return shape:
 *   { ok: true,  user: <user>|null }    — auth ok. user is null
 *                                          when the caller used the
 *                                          API key path; populated
 *                                          when they used cookies.
 *   { ok: false, response: <NextResponse> } — caller should return
 *                                              this directly.
 *
 * Why an object instead of mirroring `requireApiKey`'s
 * "null = ok": callers usually want the user object for audit
 * stamps (created_by, updated_by, etc.). API-key callers don't have
 * a user — that's a known property, not an error.
 */
export async function requireApiKeyOrManager(request) {
  // API-key path first (cheap, header-only). If the bearer token
  // matches the configured key we're done — no DB hit.
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const expected = process.env.CRM_API_KEY
  if (expected && token && safeEqual(token, expected)) {
    return { ok: true, user: null }
  }

  // Cookie path. Manager+ only — we don't want random staff
  // accidentally hitting these endpoints.
  const user = await getCurrentUser()
  if (user && MANAGER_ROLES.includes(user.role)) {
    return { ok: true, user }
  }

  return {
    ok: false,
    response: NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    ),
  }
}
