import { NextResponse } from 'next/server'
import { safeEqual } from './webhook-auth'
import { getCurrentUser } from './auth'
import { MANAGER_ROLES } from './schemas'
import { createServerClient } from './supabase'
import { hashApiKey, isApiKeyToken } from './api-keys'

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

/**
 * APIKEYS.1 — authenticate an external (n8n / integration) caller and
 * resolve the ORGANIZATION the key is scoped to. Supports two token
 * kinds during the rollout:
 *
 *   - per-org key (`unitk_…`): looked up by SHA-256 hash in `api_keys`;
 *     returns { orgId } so handlers can scope queries by organization.
 *   - legacy shared `CRM_API_KEY`: still accepted, returns orgId=null
 *     (unscoped, all-org) so existing n8n flows keep working until they
 *     migrate. Retire by unsetting CRM_API_KEY once migration is done.
 *
 * Return shape:
 *   { ok: true,  orgId: <uuid>|null, legacy: boolean, keyId?: uuid }
 *   { ok: false, response: <NextResponse 401> }
 *
 * Note: async (per-org keys require a DB lookup). Routes adopting this
 * should `await` it.
 */
export async function authenticateApiKey(request) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
  const unauthorized = () => ({
    ok: false,
    response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
  })
  if (!token) return unauthorized()

  // Legacy shared key first (cheap, header-only) — unscoped.
  const expected = process.env.CRM_API_KEY
  if (expected && safeEqual(token, expected)) {
    return { ok: true, orgId: null, legacy: true }
  }

  // Per-org key — look up by hash, must be active (not revoked).
  if (isApiKeyToken(token)) {
    const db = createServerClient()
    const { data } = await db
      .from('api_keys')
      .select('id, organization_id')
      .eq('key_hash', hashApiKey(token))
      .is('revoked_at', null)
      .maybeSingle()
    if (data) {
      // Fire-and-forget usage stamp — never block or fail auth on it.
      db.from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', data.id)
        .then(() => {}, () => {})
      return { ok: true, orgId: data.organization_id, legacy: false, keyId: data.id }
    }
  }

  return unauthorized()
}
