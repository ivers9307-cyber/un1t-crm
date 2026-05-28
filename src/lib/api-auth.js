import { NextResponse } from 'next/server'
import { safeEqual } from './webhook-auth'
import { getCurrentUser } from './auth'
import { MANAGER_ROLES } from './schemas'
import { createServerClient } from './supabase'
import { hashApiKey, isApiKeyToken } from './api-keys'

// APIKEYS.3 — shared per-org key lookup, used by both authenticateApiKey
// and requireApiKeyOrManager. Returns { orgId, keyId } for an active
// per-org key (and stamps last_used_at, fire-and-forget); null otherwise.
async function resolveApiKeyOrg(token) {
  if (!isApiKeyToken(token)) return null
  const db = createServerClient()
  const { data } = await db
    .from('api_keys')
    .select('id, organization_id')
    .eq('key_hash', hashApiKey(token))
    .is('revoked_at', null)
    .maybeSingle()
  if (!data) return null
  db.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {}, () => {})
  return { orgId: data.organization_id, keyId: data.id }
}

/**
 * APIKEYS.3 — location ids belonging to an organization. For scoping
 * list/lookup queries on resources that carry `location_id` (not
 * `organization_id`) — contacts, deals, bookings, etc. Returns [] when
 * the org has no locations; callers should treat [] as "match nothing".
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {string} orgId
 * @returns {Promise<string[]>}
 */
export async function orgLocationIds(db, orgId) {
  const { data } = await db.from('locations').select('id').eq('organization_id', orgId)
  return (data || []).map((l) => l.id)
}

// Sentinel uuid: an org with zero locations must match NOTHING, never
// fall through to "no filter" (which would expose every row).
const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * APIKEYS.3 — scope a list/select query to an org's locations (for
 * tables with a `location_id` column). No-op when orgId is falsy
 * (legacy shared key / cookie callers), so existing behaviour is kept.
 * @returns the (possibly) filtered query builder.
 */
export async function scopeQueryToOrg(query, db, orgId) {
  if (!orgId) return query
  const locIds = await orgLocationIds(db, orgId)
  return query.in('location_id', locIds.length ? locIds : [NO_MATCH_UUID])
}

/**
 * APIKEYS.3 — gate a CREATE on a location_id-bearing resource for a
 * per-org key. The target location is the explicit `locationId`, else
 * the `contactId`'s location. Returns null when allowed, or a
 * NextResponse (400 if no location resolvable, 403 if outside the org).
 * No-op (null) when orgId is falsy.
 */
export async function assertCreateInOrg({ db, orgId, locationId = null, contactId = null }) {
  if (!orgId) return null
  const locIds = await orgLocationIds(db, orgId)
  let loc = locationId || null
  if (!loc && contactId) {
    const { data } = await db.from('contacts').select('location_id').eq('id', contactId).maybeSingle()
    loc = data?.location_id || null
  }
  if (!loc) {
    return NextResponse.json({ success: false, error: 'location_id required for org-scoped key' }, { status: 400 })
  }
  if (!locIds.includes(loc)) {
    return NextResponse.json({ success: false, error: 'not in your organization' }, { status: 403 })
  }
  return null
}

/**
 * APIKEYS.3 — gate a read/mutate-by-id on a location_id-bearing resource
 * for a per-org key. Returns null when allowed, or a 404 NextResponse
 * (404 not 403, so we don't confirm the id exists across orgs). No-op
 * when orgId is falsy.
 */
export async function assertRowInOrg({ db, orgId, table, id }) {
  if (!orgId) return null
  const locIds = await orgLocationIds(db, orgId)
  const { data } = await db.from(table).select('location_id').eq('id', id).maybeSingle()
  if (!data || !locIds.includes(data.location_id)) {
    return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
  }
  return null
}

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
    // Legacy shared key — unscoped (orgId null) for back-compat.
    return { ok: true, user: null, orgId: null }
  }

  // APIKEYS.3 — per-org key. Returns the scoping org so handlers can
  // filter by organization; legacy + cookie callers get orgId null and
  // behave exactly as before.
  const resolved = await resolveApiKeyOrg(token)
  if (resolved) {
    return { ok: true, user: null, orgId: resolved.orgId }
  }

  // Cookie path. Manager+ only — we don't want random staff
  // accidentally hitting these endpoints.
  const user = await getCurrentUser()
  if (user && MANAGER_ROLES.includes(user.role)) {
    return { ok: true, user, orgId: null }
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
  const resolved = await resolveApiKeyOrg(token)
  if (resolved) {
    return { ok: true, orgId: resolved.orgId, legacy: false, keyId: resolved.keyId }
  }

  return unauthorized()
}
