import { NextResponse } from 'next/server'
import { safeEqual } from './webhook-auth'
import { getCurrentUser } from './auth'
import { hasRoleAtAnyLocation } from './role-at-location'
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
 * SAAS-3 — org location filter for list queries on `location_id`-bearing
 * tables. Returns null when the caller is unscoped (a cookie session —
 * keep today's behaviour; since W0.1 the legacy shared key is scoped
 * too), else the org's location ids;
 * an org with zero locations gets [NO_MATCH_UUID] so it matches NOTHING
 * rather than falling through unfiltered. Apply at the call site:
 *
 *   const orgLocs = await orgScopeLocationIds(db, auth.orgId)
 *   if (orgLocs) query = query.in('location_id', orgLocs)
 *
 * Replaces scopeQueryToOrg(query, db, orgId), which was an async function
 * RETURNING the builder — and supabase-js builders are thenables, so the
 * `await` at every call site assimilated the builder and executed the
 * query mid-chain. Routes that chained `.limit()`/`.eq()`/`.ilike()`
 * after it (campaigns, tasks, contacts/search GET) then threw a
 * TypeError on the plain response object for every API-key caller.
 * Returning ids instead of a builder makes that class of bug impossible.
 */
export async function orgScopeLocationIds(db, orgId) {
  if (!orgId) return null
  const locIds = await orgLocationIds(db, orgId)
  return locIds.length ? locIds : [NO_MATCH_UUID]
}

/**
 * APIKEYS.3 — gate a CREATE on a location_id-bearing resource for a
 * per-org key. The target location is the explicit `locationId`, else
 * the `contactId`'s location. Returns null when allowed, or a
 * NextResponse (400 if no location resolvable, 403 if outside the org).
 * No-op (null) when orgId is falsy.
 *
 * W0.1b — when BOTH are supplied the contact is no longer ignored: the
 * location decides the target (403 outside the org, as before) and the
 * contact is then checked as a REFERENCE — it must exist at one of the
 * org's locations, else 404 (the assertRowInOrg idiom: a cross-org id
 * is indistinguishable from a missing one). Before this a keyed caller
 * could create a task/activity/note at its own location against
 * another organisation's contact id.
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
  if (locationId && contactId) {
    const { data } = await db.from('contacts').select('location_id').eq('id', contactId).maybeSingle()
    if (!data || !locIds.includes(data.location_id)) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
    }
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

/**
 * W0.1b — gate a PROFILE reference (a task's assignee_id) for a per-org
 * key. Profiles carry no location_id or organization_id of their own, so
 * membership is read the way staff-fleet-scope.js reads it: a
 * profile_locations row at one of the org's locations, OR a
 * profile_organizations row for the org (org admins hold no location
 * row). Returns null when allowed, or a 404 NextResponse (404 not 403,
 * so the id's existence is not confirmed across orgs). No-op when orgId
 * is falsy.
 */
export async function assertProfileInOrg({ db, orgId, profileId }) {
  if (!orgId) return null
  const notFound = () => NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
  if (!profileId) return notFound()
  const locIds = await orgLocationIds(db, orgId)
  if (locIds.length) {
    const { data: atLocation } = await db
      .from('profile_locations')
      .select('profile_id')
      .eq('profile_id', profileId)
      .in('location_id', locIds)
      .limit(1)
    if (atLocation?.length) return null
  }
  const { data: orgAdmin } = await db
    .from('profile_organizations')
    .select('profile_id')
    .eq('profile_id', profileId)
    .eq('organization_id', orgId)
    .limit(1)
  if (orgAdmin?.length) return null
  return notFound()
}

// W0.1 — the legacy shared key is no longer unscoped. It acts as a per-org
// key for ONE organisation named by CRM_API_KEY_ORG_ID (UN1T Group in prod).
// No org id configured → the legacy key is refused outright (fail closed):
// an unscoped integration key is the SaaS leak this closes. Retire both env
// vars once n8n holds a unitk_ key.
function legacyKeyOrgId() {
  const id = (process.env.CRM_API_KEY_ORG_ID || '').trim()
  return id || null
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
// LEGACY and UNSCOPED: this returns no orgId, so a caller cannot tenant-filter.
// As of W0.1 it has no route callers (check:route-guards still recognises it);
// new routes use authenticateApiKey / requireApiKeyOrManager, which resolve the
// organisation. Do not adopt this for a new route.
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
 * ROLESWEEP.2 — the cookie branch is a COARSE pre-check only: the
 * caller holds a MANAGER_ROLES role at SOME location
 * (hasRoleAtAnyLocation). It used to read `user.role`, the role at the
 * ACTIVE studio, which refused a manager whose active studio is one
 * where they are staff, and admitted a head coach at A to act on B
 * where they are staff. EVERY caller must now judge the role at the
 * location it acts on — hasRoleAtLocation(auth.user, loc, MANAGER_ROLES)
 * after its membership check — before it reads or writes anything the
 * caller may not see. tests/role-at-target.test.js enforces that every
 * route calling this helper also calls hasRoleAtLocation (or another
 * target judgement) in the same file. The API-key branches are
 * unchanged.
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
    // W0.1 — legacy shared key, scoped to CRM_API_KEY_ORG_ID; refused
    // (no cookie fallback) when that org id is unset.
    const orgId = legacyKeyOrgId()
    if (!orgId) {
      return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
    }
    return { ok: true, user: null, orgId }
  }

  // APIKEYS.3 — per-org key. Returns the scoping org so handlers can
  // filter by organization; cookie callers get orgId null and behave
  // exactly as before.
  const resolved = await resolveApiKeyOrg(token)
  if (resolved) {
    return { ok: true, user: null, orgId: resolved.orgId }
  }

  // Cookie path. Manager+ SOMEWHERE — we don't want random staff
  // accidentally hitting these endpoints. Not the decision: the route
  // judges the role at its target (ROLESWEEP.2, see above).
  const user = await getCurrentUser()
  if (user && hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
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
 *   - legacy shared `CRM_API_KEY`: still accepted, but since W0.1 it is
 *     scoped to the ONE organisation in CRM_API_KEY_ORG_ID (returned as
 *     orgId, legacy: true) and refused when that env is unset. Retire by
 *     unsetting both envs once n8n holds a unitk_ key.
 *
 * Return shape:
 *   { ok: true,  orgId: <uuid>, legacy: boolean, keyId?: uuid }
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

  // Legacy shared key first (cheap, header-only) — scoped since W0.1.
  const expected = process.env.CRM_API_KEY
  if (expected && safeEqual(token, expected)) {
    const orgId = legacyKeyOrgId()
    if (!orgId) return unauthorized()
    return { ok: true, orgId, legacy: true }
  }

  // Per-org key — look up by hash, must be active (not revoked).
  const resolved = await resolveApiKeyOrg(token)
  if (resolved) {
    return { ok: true, orgId: resolved.orgId, legacy: false, keyId: resolved.keyId }
  }

  return unauthorized()
}
