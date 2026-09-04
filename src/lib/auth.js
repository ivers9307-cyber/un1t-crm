import * as React from 'react'
import { createClient } from '@supabase/supabase-js'
import { createServerClient as createSSRClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { mergeTemplates } from '@shared/permissions'
import { isApiKeyToken } from './api-keys'
import { hasPermission } from './permissions'
import { SUPPORT_COOKIE, verifySupportCookie } from './support-session-edge'

// React 18's `cache()` is only exported from the server build of react.
// In the Vitest (Node) environment we get the client build which omits
// it, so fall back to identity. In production Next.js renders server
// components against react/server which has cache, so the dedupe
// behaviour we actually want kicks in there.
const cache = typeof React.cache === 'function' ? React.cache : (fn) => fn

// Per-location role precedence — owner highest, staff lowest. Master
// is platform-wide and not in this scale; handled separately.
const ROLE_PRECEDENCE = Object.freeze({
  owner: 1, manager: 2, head_coach: 3, reception: 4, staff: 5,
})

/**
 * Build the rolesByLocation map from raw profile_locations rows.
 * Pure helper — exported for testability of the role-derivation logic
 * separately from the IO-heavy getCurrentUser() pipeline.
 *
 * @param {Array<{location_id?: string, role?: string}>|null|undefined} locationLinks
 * @returns {Record<string,string>}
 */
export function buildRolesByLocation(locationLinks) {
  const m = {}
  for (const link of (locationLinks || [])) {
    if (link?.location_id && link?.role) {
      m[link.location_id] = link.role
    }
  }
  return m
}

/**
 * SAAS-4 (mig 417) — expand an org admin's access maps with their
 * organizations' locations.
 *
 * Org-bounded mirror of the master expansion in getCurrentUser():
 * `locations` becomes the union of the explicit assignments and every
 * location in `orgLocations` (the active locations of the caller's
 * admin orgs, fetched by getCurrentUser); `rolesByLocation` gains a
 * synthetic 'owner' entry for each org location that has NO explicit
 * profile_locations assignment — explicit assignments always keep
 * their role. `syntheticLocationIds` lists the locations that got the
 * synthetic owner role so getCurrentUser can mirror them into
 * assignmentsByLocation (empty per-user permission overrides there).
 *
 * With `orgLocations` empty/null the inputs pass through by value
 * unchanged — a user with zero profile_organizations rows is
 * behaviourally identical to before the org-admin tier existed
 * (rollout-safety property, pinned in tests).
 *
 * Pure helper — exported for testability of the expansion logic
 * separately from the IO-heavy getCurrentUser() pipeline.
 *
 * @param {object} args
 * @param {Array<object>} args.locations                 user.locations so far (explicit assignments)
 * @param {Record<string,string>} args.rolesByLocation   explicit per-location roles
 * @param {Array<object>|null|undefined} args.orgLocations  active locations of the caller's admin orgs
 * @returns {{ locations: Array<object>, rolesByLocation: Record<string,string>, syntheticLocationIds: string[] }}
 */
export function expandOrgAdminAccess({ locations, rolesByLocation, orgLocations }) {
  const nextLocations = [...(locations || [])]
  const nextRoles = { ...(rolesByLocation || {}) }
  const have = new Set(nextLocations.map(l => l?.id).filter(Boolean))
  const syntheticLocationIds = []
  for (const loc of (orgLocations || [])) {
    if (!loc?.id) continue
    if (!have.has(loc.id)) {
      nextLocations.push(loc)
      have.add(loc.id)
    }
    if (!nextRoles[loc.id]) {
      nextRoles[loc.id] = 'owner'
      syntheticLocationIds.push(loc.id)
    }
  }
  return { locations: nextLocations, rolesByLocation: nextRoles, syntheticLocationIds }
}

/**
 * Resolve the effective role for the current request.
 *
 *   - master users:  always 'master'
 *   - non-master:    role at the active location, falling back to the
 *                    user's highest assignment role (back-compat for
 *                    callers that read `user.role` without location
 *                    context), and finally to profiles.role for users
 *                    with no per-location assignments yet.
 *
 * Pure helper — exported for tests.
 *
 * @param {object} args
 * @param {{role?: string} | null | undefined} args.profile
 * @param {Record<string,string>} args.rolesByLocation
 * @param {string | null | undefined} args.activeLocationId
 * @returns {string | undefined}
 */
export function resolveActiveLocationRole({ profile, rolesByLocation, activeLocationId }) {
  if (profile?.role === 'master') return 'master'
  if (activeLocationId && rolesByLocation[activeLocationId]) {
    return rolesByLocation[activeLocationId]
  }
  const highest = Object.values(rolesByLocation || {})
    .sort((a, b) => (ROLE_PRECEDENCE[a] || 99) - (ROLE_PRECEDENCE[b] || 99))[0]
  return highest || profile?.role
}

// Auth-aware server client for SSR pages (reads session from cookies).
//
// Next 15+: `cookies()` returns a Promise, so this is now async and
// every caller must await it. The cookie store object itself is still
// sync once awaited — `getAll`, `set` inside the SSR-client callbacks
// stay synchronous.
export async function createAuthClient() {
  const cookieStore = await cookies()
  return createSSRClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Ignore — can't set cookies in server components
          }
        },
      },
    }
  )
}

// Validate a Supabase JWT (the access_token from a mobile session) and
// return the corresponding auth user. Used by getCurrentUser() to support
// the iOS app's Authorization: Bearer <jwt> header without setting cookies.
// Returns null on any failure (malformed, expired, network blip).
async function getUserFromBearer() {
  let auth = ''
  try {
    auth = (await headers()).get('authorization') || ''
  } catch {
    // headers() throws outside a request scope (e.g. unit tests). Let
    // the caller fall back to cookie auth.
    return null
  }
  if (!auth.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length)
  // Skip the n8n CRM_API_KEY — that path doesn't carry a Supabase user;
  // routes that need a user under that token use requireApiKey() instead.
  if (process.env.CRM_API_KEY && token === process.env.CRM_API_KEY) return null
  // SAAS-3: per-org API keys (unitk_…) likewise never carry a Supabase
  // user — skip the doomed auth.getUser() round-trip; routes resolve
  // them via authenticateApiKey()/requireApiKeyOrManager() instead.
  if (isApiKeyToken(token)) return null
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )
    const { data: { user } } = await sb.auth.getUser(token)
    return user || null
  } catch {
    return null
  }
}

// STUDIO-PIN.3 — third auth source: the studio_session signed cookie.
// PIN-login on a paired studio device mints this cookie; the
// staffer's profile id is carried directly in the payload, so we don't
// need to call Supabase Auth at all for this code path.
//
// Returns a minimal `{ id, email }` user object on success so the rest
// of getCurrentUser() can run unchanged. Returns null on any failure
// (missing, malformed, signed with a different secret, idle-locked,
// or expired). The idle-locked vs hard-expired distinction is captured
// in the cookie itself via inspectStudioSession; either way auth.js
// treats the request as unauthenticated.
async function getUserFromStudioSession(db) {
  let cookieStore
  try {
    cookieStore = await cookies()
  } catch {
    return null
  }
  const raw = cookieStore.get('studio_session')?.value
  if (!raw) return null

  const { readStudioSession } = await import('./studio-session.js')
  const payload = readStudioSession(raw)
  if (!payload?.sub) return null

  // Load the bare auth-shape user object we'd otherwise get from
  // Supabase. profiles.id IS the Supabase auth user.id (FK to
  // auth.users) — no separate Supabase Auth call needed.
  const { data: profile } = await db
    .from('profiles')
    .select('id, email')
    .eq('id', payload.sub)
    .single()
  if (!profile) return null
  return { id: profile.id, email: profile.email }
}

// Get current user profile with permissions and location.
//
// Auth source priority:
//   1. Authorization: Bearer <supabase_jwt>  (iOS mobile app)
//   2. SSR session cookies                   (web browser)
//   3. studio_session signed cookie          (Mac shell / paired iPad)
//
// In every case, the rest of the function is identical — load the
// profile, location assignments, and resolve activeLocation. The mobile
// app sends an `x-active-location` header to override the cookie-based
// active-location resolution; the cookie path remains untouched.
// Wrapped in React.cache() so it dedupes within a single request render.
// Layouts + pages + nested server components that call getCurrentUser()
// now share the same Promise instead of each running the auth lookup
// from scratch. On a typical page that meant 2-3x the same 3-5 query
// roundtrip; now it's once per request.
export const getCurrentUser = cache(async function getCurrentUser() {
  // Try Bearer JWT first (mobile). If absent or invalid, fall back to
  // the cookie-based session (web). If that's also absent, try the
  // studio_session cookie (Mac shell / paired iPad).
  //
  // The service-role client is built lazily on demand so unauthenticated
  // requests (e.g. Next prerendering /_not-found at build time, when
  // env vars may not be present) don't try to construct one.
  let user = await getUserFromBearer()
  if (!user) {
    const supabase = await createAuthClient()
    const result = await supabase.auth.getUser()
    user = result.data.user
  }
  let db = null
  if (!user) {
    // Building db here so the studio-session path can use it. If THIS
    // path also yields no user, getCurrentUser returns null below and
    // the client was built for nothing — but that's still cheap (just
    // a couple of object allocations) versus the prerender-time crash
    // we'd hit if we constructed it unconditionally up top.
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      db = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      )
      user = await getUserFromStudioSession(db)
    }
  }
  if (!user) return null

  // Reuse the db we may have built for the studio-session lookup;
  // construct it now if it doesn't exist yet.
  if (!db) {
    db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  }

  // Profile fetch + lazy impersonation cookie import in parallel.
  // We can't fetch the impersonation TARGET in parallel because we
  // don't know whether to fetch it until realProfile is loaded
  // (only masters can impersonate), but the cookie read is cheap and
  // doesn't depend on the profile fetch.
  const [{ data: realProfile }, { readImpersonationTarget }] = await Promise.all([
    db.from('profiles').select('*').eq('id', user.id).single(),
    import('./impersonation.js'),
  ])

  if (!realProfile) return null

  // Master impersonation (mig 035). If `un1t_impersonate` cookie OR
  // `x-impersonate-target` header is set AND the underlying session
  // belongs to a master, swap to the target profile so the rest of
  // the app sees what they'd see. The original master identity is
  // exposed as `impersonatingFrom` so the banner / debug tools can
  // show it.
  //
  // Cookie path is for the web app (server components, API routes).
  // Header path is for mobile (Bearer JWT, no cookies). Both go
  // through the same readImpersonationTarget() so the master gate
  // and audit hooks work identically.
  let profile = realProfile
  let impersonatingFrom = null
  if (realProfile.role === 'master') {
    const targetId = await readImpersonationTarget()
    if (targetId && targetId !== realProfile.id) {
      const { data: target } = await db
        .from('profiles')
        .select('*')
        .eq('id', targetId)
        .single()
      // Only treat this as a live impersonation if there's an OPEN
      // impersonation_log row for this master+target. A leftover
      // un1t_impersonate cookie (e.g. the browser kept it after a
      // previous session was stopped server-side, or the stop cookie-
      // clear didn't land) otherwise keeps resurrecting the banner with
      // no real session behind it — which showed up as "Viewing as
      // <yourself> · signed in as Master". Gating on the audit row makes
      // the cookie inert once the session is closed.
      if (target) {
        const { data: openRow } = await db
          .from('impersonation_log')
          .select('id')
          .eq('master_user_id', realProfile.id)
          .eq('target_user_id', targetId)
          .is('ended_at', null)
          .limit(1)
          .maybeSingle()
        if (openRow) {
          profile = target
          impersonatingFrom = {
            masterId: realProfile.id,
            masterName: realProfile.full_name,
            masterEmail: realProfile.email,
          }
        }
      }
    }
  }

  // Get assigned locations — keyed off the EFFECTIVE profile id
  // (the impersonated user's, when an impersonation cookie is in
  // effect). The master's own profile_locations rows aren't loaded
  // here because they're irrelevant to the experience we're trying
  // to replicate.
  //
  // For masters we ALSO need every active location (mig 035 explainer
  // below). Fire both in parallel — masters see every active location
  // regardless of profile_locations, but the rows are still fetched
  // for the is_default flag used by active-location resolution.
  const effectiveProfileId = profile.id
  const linksPromise = db
    .from('profile_locations')
    .select('*, locations(*)')
    .eq('profile_id', effectiveProfileId)
  const allLocsPromise = profile.role === 'master'
    ? db.from('locations').select('*').eq('active', true).order('name')
    : Promise.resolve({ data: null })
  // Organizations (mig 079). Master sees every active org; non-master
  // sees the orgs whose locations they're a member of (resolved
  // server-side from locationLinks once that fetch resolves — no
  // separate query needed for non-masters because RLS would do the
  // same join anyway).
  const allOrgsPromise = profile.role === 'master'
    ? db.from('organizations').select('*').eq('active', true).order('name')
    : Promise.resolve({ data: null })
  // SAAS-4 — org-admin grants (mig 417). A SaaS org owner manages every
  // location in THEIR org without needing per-location rows. Master
  // skips the fetch entirely — the platform-wide bypass supersedes org
  // admin, and skipping keeps the master path free of extra queries.
  const orgAdminLinksPromise = profile.role === 'master'
    ? Promise.resolve({ data: null })
    : db.from('profile_organizations').select('*').eq('profile_id', effectiveProfileId)

  const [{ data: locationLinks }, { data: allLocs }, { data: allOrgs }, { data: orgAdminLinks }] = await Promise.all([
    linksPromise,
    allLocsPromise,
    allOrgsPromise,
    orgAdminLinksPromise,
  ])

  let locations = (locationLinks || []).map(pl => pl.locations).filter(Boolean)

  // Per-location roles (mig 051). Build a {location_id → role} map
  // straight from the profile_locations rows. master is platform-wide
  // and lives separately on profiles.role (CHECK constraint blocks it
  // from appearing as a per-location role).
  let rolesByLocation = buildRolesByLocation(locationLinks)

  // Master role bypasses profile_locations — they see every active
  // location automatically. RLS already short-circuits via
  // private.auth_is_master() — this just makes the in-memory user
  // object reflect the same reality.
  if (profile.role === 'master' && allLocs) {
    locations = allLocs
  }

  // SAAS-4 — org-admin expansion (mig 417). Org-bounded mirror of the
  // master expansion above: the user's reachable set becomes the union
  // of their explicit assignments and every ACTIVE location of the
  // orgs they hold an org_admin grant on, acting as 'owner' anywhere
  // there is no explicit assignment (explicit rows keep their role, so
  // an org admin deliberately assigned 'staff' at one studio stays
  // staff there). Zero profile_organizations rows → orgAdminOrgIds is
  // empty and this whole block is a no-op, so every existing user's
  // object is byte-identical (rollout-safety property, pinned in
  // auth.getCurrentUser.test.js). Master never reaches here
  // (orgAdminLinks is null — fetch skipped above).
  const orgAdminOrgIds = Array.from(new Set(
    (orgAdminLinks || [])
      .filter(l => l?.organization_id && l.role === 'org_admin')
      .map(l => l.organization_id)
  ))
  let orgAdminSyntheticLocationIds = []
  if (orgAdminOrgIds.length > 0) {
    const { data: orgLocs } = await db
      .from('locations')
      .select('*')
      .in('organization_id', orgAdminOrgIds)
      .eq('active', true)
      .order('name')
    const expanded = expandOrgAdminAccess({ locations, rolesByLocation, orgLocations: orgLocs })
    locations = expanded.locations
    rolesByLocation = expanded.rolesByLocation
    orgAdminSyntheticLocationIds = expanded.syntheticLocationIds
  }

  // Organizations (mig 079). Surface as a {org_id → row} map so
  // callers can look up an org's name/slug from a location's
  // organization_id without a second round-trip. For master we use
  // the dedicated allOrgs fetch (covers orgs they don't have any
  // location assignments in — important for the admin matrix);
  // for non-master we derive from location memberships, since RLS
  // would yield the same set anyway and we already have the data.
  const organizationsById = {}
  if (profile.role === 'master' && allOrgs) {
    for (const org of allOrgs) organizationsById[org.id] = org
  } else {
    // Non-master: fetch orgs referenced by any of their locations.
    // We need the full org row (name, slug) for the UI; the locations
    // only carry organization_id. Single query, indexed lookup.
    // SAAS-4: admin orgs are unioned in explicitly so an org_admin
    // grant on an org with zero active locations still surfaces the
    // org row (the location-derived set would miss it).
    const orgIds = Array.from(
      new Set([
        ...locations.map(l => l?.organization_id),
        ...orgAdminOrgIds,
      ].filter(Boolean))
    )
    if (orgIds.length > 0) {
      const { data: memberOrgs } = await db
        .from('organizations')
        .select('*')
        .in('id', orgIds)
      for (const org of (memberOrgs || [])) organizationsById[org.id] = org
    }
  }

  // Active-location resolution. Priority:
  //   1. x-active-location header  — set by the mobile app's location switcher
  //   2. un1t_active_location cookie — set by the web LocationSwitcher
  //   3. profile_locations.is_default — admin-assigned default
  //   4. first location in the assignment list
  //
  // We validate header / cookie values against the user's actual
  // assignments — a stale value or malicious header that points at
  // someone else's location is silently ignored, and the next priority
  // wins. This keeps the existing IDOR guarantees.
  let headerLocation = null
  try {
    const headerVal = (await headers()).get('x-active-location') || ''
    headerLocation = headerVal ? locations.find(l => l.id === headerVal) : null
  } catch {
    // headers() throws outside a request scope; ignore.
  }

  const cookieStore = await cookies()
  const locationCookie = cookieStore.get('un1t_active_location')?.value
  const cookieLocation = locationCookie
    ? locations.find(l => l.id === locationCookie)
    : null

  const defaultLink = (locationLinks || []).find(pl => pl.is_default)
  const activeLocation =
    headerLocation || cookieLocation || defaultLink?.locations || locations[0] || null

  // Resolve effective role for THIS request (mig 051):
  //   - master:        always 'master' (platform-wide)
  //   - non-master:    role at the active location, fallback to
  //                    highest assignment role (so legacy callers
  //                    reading user.role without location context
  //                    get the same answer pre-mig-051), final
  //                    fallback to profiles.role.
  //
  // Override `role` AFTER the spread of `...profile` so `user.role`
  // is the active-location-aware value. Original global value is
  // preserved on `user.profileRole` for the rare caller that wants
  // canonical/highest role without location context.
  const isMaster = profile.role === 'master'
  const activeLocationRole = resolveActiveLocationRole({
    profile,
    rolesByLocation,
    activeLocationId: activeLocation?.id,
  })

  // Per-location user permission overrides (mig 058). The user-level
  // override layer moved off profile.permissions (profile-wide) onto
  // profile_locations.permissions (per-assignment) so an owner at
  // one location and staff at another doesn't get owner-level toggles
  // leaked to the staff location. hasPermission() reads
  // `activeAssignment.permissions` at tier 2 instead of the old
  // `profile.permissions`.
  const assignmentsByLocation = {}
  for (const link of (locationLinks || [])) {
    if (!link?.location_id) continue
    assignmentsByLocation[link.location_id] = {
      role: link.role,
      permissions: link.permissions || {},
      is_default: !!link.is_default,
      unifi_door_access: !!link.unifi_door_access,
    }
  }
  // SAAS-4 — synthetic assignments for org-admin locations that have
  // no explicit profile_locations row, so hasPermission() /
  // hasPermissionForLocation() resolve role 'owner' with no per-user
  // overrides there (owner code defaults + the location's owner role
  // template apply). Explicit assignments are already in the map and
  // always win — the guard is belt-and-braces (syntheticLocationIds
  // only ever contains locations without an explicit row).
  for (const locId of orgAdminSyntheticLocationIds) {
    if (!assignmentsByLocation[locId]) {
      assignmentsByLocation[locId] = {
        role: 'owner',
        permissions: {},
        is_default: false,
        unifi_door_access: false,
      }
    }
  }
  const activeAssignment = activeLocation?.id
    ? assignmentsByLocation[activeLocation.id] || null
    : null

  // PERM-AUDIT.2 (mig 364) — operator-edited role permission
  // templates, resolved by the shared resolver between the per-user
  // override and the code role default. One small query for the
  // user's locations; keyed per location by the role THE USER holds
  // there (a template row for a different role at that location is
  // irrelevant to this user). Master skips the fetch entirely —
  // the resolver short-circuits master past tiers 2/2.5/3, so a
  // template can never change what a master sees.
  // RECEPTION.2 (mig 367): templates can carry employment-type
  // variants — an 'all' row applies to every user of the role, and
  // an 'fte' / 'contractor' / 'casual' row layers on top for users
  // whose profiles.employment_type matches. We merge here so every
  // consumer downstream still sees ONE template blob per location.
  const roleTemplatesByLocation = {}
  const acDeviceTemplatesByLocation = {}
  if (!isMaster) {
    const templateLocationIds = Object.keys(rolesByLocation)
    if (templateLocationIds.length > 0) {
      try {
        const { data: templateRows } = await db
          .from('location_role_permissions')
          .select('location_id, role, employment_type, permissions, ac_device_ids')
          .in('location_id', templateLocationIds)
        const findRow = (locId, emp) => (templateRows || []).find(r =>
          r.location_id === locId && r.role === rolesByLocation[locId] && r.employment_type === emp
        ) || null
        const rowFor = (locId, emp) => findRow(locId, emp)?.permissions || null
        for (const locId of templateLocationIds) {
          const merged = mergeTemplates(
            rowFor(locId, 'all'),
            profile.employment_type ? rowFor(locId, profile.employment_type) : null
          )
          if (merged) roleTemplatesByLocation[locId] = merged
          // AC-ROLE.1 — resolve the role-template AC device list:
          // employment-type variant wins if set (non-null), else the
          // 'all' row, else inherit (null). Stored ABSOLUTE, not diffed.
          const allRow = findRow(locId, 'all')
          const varRow = profile.employment_type ? findRow(locId, profile.employment_type) : null
          const acList = Array.isArray(varRow?.ac_device_ids)
            ? varRow.ac_device_ids
            : (Array.isArray(allRow?.ac_device_ids) ? allRow.ac_device_ids : null)
          if (acList !== null) acDeviceTemplatesByLocation[locId] = acList
        }
      } catch {
        // Defensive: a failed template fetch degrades to code
        // defaults (empty maps) rather than failing the request.
      }
    }
  }
  const activeRoleTemplate = activeLocation?.id
    ? roleTemplatesByLocation[activeLocation.id] || null
    : null
  const activeAcDeviceTemplate = activeLocation?.id
    ? (acDeviceTemplatesByLocation[activeLocation.id] ?? null)
    : null

  // Active organization mirrors active location — useful for any UI
  // that wants to badge "you're operating inside CCF Autos right now".
  const activeOrganization = activeLocation?.organization_id
    ? organizationsById[activeLocation.organization_id] || null
    : null

  // SUPPORT-ACCESS (Repset Phase 3) — surface an active tenant support
  // session for the banner. Only the REAL underlying session being a
  // master can carry one (the signed un1t_support cookie is minted
  // master-only by /api/support-session/start). We read it here, verify
  // the signature (cheap; only when the cookie is present), and resolve
  // the tenant name from organizationsById (already built above — no
  // extra DB round-trip). This is PRESENTATION only; the read-only
  // enforcement lives in the proxy. The cookie was already awaited into
  // cookieStore above.
  let supportSession = null
  if (realProfile.role === 'master') {
    const rawSupport = cookieStore.get(SUPPORT_COOKIE)?.value
    if (rawSupport) {
      try {
        const payload = await verifySupportCookie(rawSupport)
        const notExpired = payload && (typeof payload.exp !== 'number' || Date.now() <= payload.exp)
        if (payload && notExpired && payload.org) {
          supportSession = {
            mode: payload.mode === 'act_on_behalf' ? 'act_on_behalf' : 'read_only',
            organizationId: payload.org,
            organizationName: organizationsById[payload.org]?.name || null,
            impersonatedUserId: payload.imp || null,
          }
        }
      } catch {
        // A bad cookie is inert for the banner; the proxy still fails
        // closed on it. Leave supportSession null.
      }
    }
  }

  return {
    ...profile,
    user,
    locations,
    activeLocation,
    // { [org_id]: org row } — every org reachable by this caller.
    // Master sees every active org (mig 079); non-master sees only
    // orgs whose locations they're a member of.
    organizationsById,
    activeOrganization,
    // SAAS-4 (mig 417) — org ids the user holds an org_admin grant on.
    // Empty for everyone else (including master, whose platform-wide
    // bypass supersedes the tier — the fetch is skipped for masters).
    // Guards read this via assertOrganizationAdmin(); org-scoped
    // resource helpers via getOwnerOrganizationIds().
    orgAdminOrgIds,
    // { [location_id]: role } — never includes 'master' (CHECK
    // constraint); MAY include synthetic 'owner' entries for org-admin
    // locations without an explicit assignment (SAAS-4).
    rolesByLocation,
    // Full per-location assignment data including the per-location
    // permissions blob (mig 058). Server resolution helpers read
    // from `activeAssignment.permissions`; client code that needs
    // "what would I see at location X" can read from
    // `assignmentsByLocation[X]`.
    assignmentsByLocation,
    activeAssignment,
    // PERM-AUDIT.2 — { [location_id]: sparse template blob } for the
    // role the user holds at each location (mig 364). hasPermission
    // reads activeRoleTemplate; hasPermissionForLocation reads the map.
    roleTemplatesByLocation,
    activeRoleTemplate,
    acDeviceTemplatesByLocation,
    activeAcDeviceTemplate,
    // Active-location role — flips when the user switches location.
    role: activeLocationRole,
    // Original global value, for callers that need canonical/highest role.
    profileRole: profile.role,
    isMaster,
    // Set when a master is impersonating another user. The banner
    // + the API endpoints / sidebar entries read this to show the
    // 'Stop impersonating' UI and to know who the real caller is
    // for audit purposes.
    impersonatingFrom,
    // SUPPORT-ACCESS (Repset Phase 3) — non-null while a master is in a
    // tenant support session. { mode, organizationId, organizationName,
    // impersonatedUserId }. The SupportBanner reads this; the read-only
    // ENFORCEMENT is in src/proxy.js, not here.
    supportSession,
  }
})

/**
 * Returns an array of the user's assigned location IDs. Defensive against
 * a missing `locations` field. Use when building queries that need to
 * filter by every location the caller can see.
 *
 * @param {{ locations?: Array<{id: string}> } | null} user
 * @returns {string[]}
 */
export function getUserLocationIds(user) {
  return (user?.locations || []).map(l => l.id)
}

/**
 * Returns the distinct organization IDs the caller is an *owner* of —
 * derived from the locations where their per-location role is 'owner'
 * (mig 051), mapped to each location's organization_id (mig 079).
 *
 * Use for org-scoped resources (e.g. contracts, mig 106) on service-role
 * routes that must replicate the "owner sees their org" RLS model in the
 * app layer because `createServerClient()` bypasses RLS. Master callers
 * are handled separately by the caller (they see everything); this returns
 * only the explicit owner-org set, so a non-owner gets `[]`.
 *
 * SAAS-4: org-admin orgs (user.orgAdminOrgIds, mig 417) are included —
 * an org admin acts as owner across their whole org, so org-scoped
 * resources gated on this helper (contracts, contract templates, org
 * branding) are manageable by them too. Users without grants are
 * unaffected (empty array unions to nothing).
 *
 * @param {{ rolesByLocation?: Record<string,string>, locations?: Array<{id: string, organization_id?: string}>, orgAdminOrgIds?: string[] } | null} user
 * @returns {string[]}
 */
export function getOwnerOrganizationIds(user) {
  if (!user) return []
  const ownerLocationIds = Object.entries(user.rolesByLocation || {})
    .filter(([, role]) => role === 'owner')
    .map(([locationId]) => locationId)
  const orgIds = (user.locations || [])
    .filter(l => l && ownerLocationIds.includes(l.id))
    .map(l => l.organization_id)
    .filter(Boolean)
  return Array.from(new Set([...orgIds, ...(user.orgAdminOrgIds || [])]))
}

/**
 * Check that `locationId` is one of the locations the caller belongs to.
 * Use at the top of any session-auth route that takes a location_id from
 * user input (query string or request body) to prevent IDOR — a user
 * passing `?location_id=<some other tenant>` and reading their data.
 *
 * Bearer-auth routes (n8n) skip this — the API key holder is treated as
 * a system admin in this app's model.
 *
 * Behaviour:
 *   - user is null              → 401
 *   - locationId is null/undef  → null (caller said "no specific location",
 *                                 e.g. listing across all of the user's locations)
 *   - locationId is allowed     → null (request continues)
 *   - locationId is forbidden   → 403
 *
 * Usage:
 *   const guard = assertLocationAccess(user, requestedLocationId)
 *   if (guard) return guard
 *
 * @param {{ locations?: Array<{id: string}> } | null} user
 * @param {string | null | undefined} locationId
 * @returns {NextResponse | null}
 */
export function assertLocationAccess(user, locationId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!locationId) return null
  const allowed = (user.locations || []).some(l => l.id === locationId)
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: 'Forbidden — location not in your assignments' },
      { status: 403 }
    )
  }
  return null
}

/**
 * Like `assertLocationAccess`, but a forbidden location returns **404**
 * instead of 403.
 *
 * Use on DETAIL routes — a single resource fetched by a path-param id —
 * where the `location_id` comes from the *fetched row* and the guard runs
 * after a "fetch-by-id → 404 if absent" check. There, a 403 on a
 * cross-tenant row (vs a 404 on a missing one) lets an authenticated user
 * distinguish "this id exists at another tenant" from "this id doesn't
 * exist" — an existence/info-disclosure leak. Returning 404 for both
 * collapses the two cases, satisfying the repo's "detail routes return 404
 * not 403" invariant. Do NOT use this for list/collection routes or where
 * the location comes from a caller-supplied query/body param — those keep
 * the explicit 403 (see `assertLocationAccess`).
 *
 * Behaviour:
 *   - user is null              → 401
 *   - locationId is null/undef  → null (request continues)
 *   - locationId is allowed     → null (request continues)
 *   - locationId is forbidden   → 404 (identical to not-found)
 *
 * Usage:
 *   const guard = assertLocationAccessOr404(user, row.location_id)
 *   if (guard) return guard
 *
 * @param {{ locations?: Array<{id: string}> } | null} user
 * @param {string | null | undefined} locationId
 * @returns {NextResponse | null}
 */
export function assertLocationAccessOr404(user, locationId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!locationId) return null
  const allowed = (user.locations || []).some(l => l.id === locationId)
  if (!allowed) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  return null
}

// ─── Unified-inbox channel guard (INBOX-PERM.1) ─────────────────────
// Every /api/{whatsapp,instagram,email}/conversations* route uses the
// service-role client, so RLS does nothing there — hasPermission in app
// code is the ONLY channel gate. The map exists so one edit re-gates
// every conversation route on a channel at once.
//
// INBOX-PERM.2 (2026-08-07) — `em` was still pointed at `whatsapp`, the
// placeholder INBOX-PERM.1 left behind for "when email-inbox gets its
// own key". EMAIL-TICKET.2 shipped that key and nobody came back, so a
// staffer with WhatsApp ON and `email_inbox` OFF — holding no
// email_mailbox_access grant at all — could list the studio's email
// threads, read message bodies, resolve them, and send mail from the
// company address through the three legacy /api/email/conversations*
// routes, bypassing the two-level model the ticket surface enforces.
// It now resolves against `email_inbox`, the same key every
// /api/email/tickets* route checks.
//
// `ig` deliberately still rides `whatsapp`: there is no Instagram
// WEB_PERMISSIONS key to point it at, and inventing a mapping to a key
// that does not exist would fail closed for everyone. When one is
// added, change it here and every IG conversation route follows.
const INBOX_CHANNEL_PERMISSION_KEYS = Object.freeze({
  wa: 'whatsapp',
  ig: 'whatsapp',
  em: 'email_inbox',
})

/**
 * Channel-permission guard for unified-inbox conversation routes.
 * Same call contract as assertLocationAccess: null means continue,
 * otherwise return the NextResponse.
 *
 * Fails CLOSED on an unknown channel (403 even for master) — a typo'd
 * channel in a new route must never silently skip the gate.
 *
 * Usage (after getCurrentUser, before any DB work):
 *   const perm = requireInboxPermission(user, 'wa')
 *   if (perm) return perm
 *
 * @param {object|null} user  getCurrentUser() result
 * @param {'wa'|'ig'|'em'} channel
 * @returns {NextResponse | null}
 */
export function requireInboxPermission(user, channel) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const key = INBOX_CHANNEL_PERMISSION_KEYS[channel]
  if (!key || !hasPermission(user, key)) {
    return NextResponse.json({ success: false, error: 'Forbidden — inbox permission required' }, { status: 403 })
  }
  return null
}

// ─── Organization guards (SAAS-4, mig 417) ──────────────────────────
// Org-level mirrors of assertLocationAccess / assertLocationAccessOr404,
// for routes that take an organization_id instead of a location_id.
//
// Two tiers of semantics, decided deliberately:
//   • assertOrganizationAccess / Or404 = MEMBERSHIP (read tier).
//     Passes when the org is reachable by the caller at all — master,
//     org admin, or member of any of the org's locations. This mirrors
//     private.auth_is_in_organization() so app-layer checks on
//     service-role routes match what RLS would answer.
//   • assertOrganizationAdmin = MANAGEMENT (write tier). Master or
//     org_admin only — location membership (even owner-at-a-location)
//     is NOT enough; per-location owners manage org-scoped resources
//     via getOwnerOrganizationIds() where a surface opts them in.
//
// Membership is read from user.organizationsById — getCurrentUser
// builds it as exactly the reachable set (member orgs ∪ admin orgs for
// non-masters; every active org for masters) — with orgAdminOrgIds as
// a belt-and-braces union for the zero-location-org edge. Master
// short-circuits explicitly so an inactive org can't lock a master out.

/**
 * Check that `orgId` is an organization the caller belongs to (any
 * location membership or an org_admin grant). Use at the top of any
 * session-auth route that takes an organization_id from user input
 * (query string or request body) — same IDOR rationale as
 * assertLocationAccess.
 *
 * Behaviour:
 *   - user is null           → 401
 *   - orgId is null/undef    → null (caller said "no specific org")
 *   - master                 → null (request continues)
 *   - org reachable          → null (request continues)
 *   - org is foreign         → 403
 *
 * Usage:
 *   const guard = assertOrganizationAccess(user, requestedOrgId)
 *   if (guard) return guard
 *
 * @param {{ isMaster?: boolean, organizationsById?: Record<string, object>, orgAdminOrgIds?: string[] } | null} user
 * @param {string | null | undefined} orgId
 * @returns {NextResponse | null}
 */
export function assertOrganizationAccess(user, orgId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!orgId) return null
  if (user.isMaster) return null
  const allowed = !!user.organizationsById?.[orgId]
    || (user.orgAdminOrgIds || []).includes(orgId)
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: 'Forbidden — organization not in your memberships' },
      { status: 403 }
    )
  }
  return null
}

/**
 * Like `assertOrganizationAccess`, but a forbidden organization returns
 * **404** instead of 403. Use on DETAIL routes where the
 * organization_id comes from the *fetched row* — a cross-tenant org id
 * must be indistinguishable from a missing one (same
 * existence/info-disclosure rationale as assertLocationAccessOr404).
 *
 * Behaviour:
 *   - user is null           → 401
 *   - orgId is null/undef    → null (request continues)
 *   - master                 → null (request continues)
 *   - org reachable          → null (request continues)
 *   - org is foreign         → 404 (identical to not-found)
 *
 * @param {{ isMaster?: boolean, organizationsById?: Record<string, object>, orgAdminOrgIds?: string[] } | null} user
 * @param {string | null | undefined} orgId
 * @returns {NextResponse | null}
 */
export function assertOrganizationAccessOr404(user, orgId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!orgId) return null
  if (user.isMaster) return null
  const allowed = !!user.organizationsById?.[orgId]
    || (user.orgAdminOrgIds || []).includes(orgId)
  if (!allowed) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  return null
}

/**
 * Gate a route to masters, or org admins of the given organization —
 * the MANAGEMENT tier for org-scoped surfaces (grants management,
 * future org settings). Location membership, including owner-at-a-
 * location, does NOT pass; a mere member gets the same 403 as an
 * outsider (this is a role check, not an existence probe — no 404
 * variant needed).
 *
 * NOTE unlike the access guards, a null orgId does NOT pass for
 * non-masters: an org-less resource is master-only, and passing null
 * through here is treated as "no claim".
 *
 * Behaviour:
 *   - user is null                     → 401
 *   - master                           → null (request continues)
 *   - org_admin grant on orgId         → null (request continues)
 *   - anything else (incl. null orgId) → 403
 *
 * Usage:
 *   const guard = assertOrganizationAdmin(user, orgId)
 *   if (guard) return guard
 *
 * @param {{ isMaster?: boolean, orgAdminOrgIds?: string[] } | null} user
 * @param {string | null | undefined} orgId
 * @returns {NextResponse | null}
 */
export function assertOrganizationAdmin(user, orgId) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (user.isMaster) return null
  if (orgId && (user.orgAdminOrgIds || []).includes(orgId)) return null
  return NextResponse.json(
    { success: false, error: 'Master or organization admin role required.' },
    { status: 403 }
  )
}

/**
 * Gate a route to masters, or owners of the given location.
 *
 * Stricter than the usual MANAGER_ROLES check — used by config surfaces
 * that hold live credentials (e.g. whatsapp_numbers CRUD + the Embedded
 * Signup exchange), where managers/head coaches have no business.
 *
 * Behaviour:
 *   - profileRole is 'master'           → null (request continues)
 *   - per-location role is 'owner'      → null (request continues)
 *   - anything else                     → 403
 *
 * Usage (after assertLocationAccess):
 *   const guard = guardMasterOrOwner(user, params.id)
 *   if (guard) return guard
 *
 * @param {{ profileRole?: string, rolesByLocation?: Record<string,string> }} user
 * @param {string} locationId
 * @returns {NextResponse | null}
 */
export function guardMasterOrOwner(user, locationId) {
  if (user.profileRole === 'master') return null
  const role = user.rolesByLocation?.[locationId]
  if (role === 'owner') return null
  return NextResponse.json({ success: false, error: 'Master or owner role required.' }, { status: 403 })
}

/**
 * Is the caller's role AT `locationId` one of `allowedRoles`?
 *
 * LOCFIX-ROLEGATE.1 — a PREDICATE, not a guard, deliberately. Every route
 * that gates on a role tier has its own status code and its own copy (403
 * "Unauthorized", 403 "Forbidden", 403 "Manager+ required"), and a guard
 * would have had to flatten those. It also lets a route reuse the same
 * answer for a `can_edit` flag on its GET without a second predicate
 * drifting out of step with the write gate.
 *
 * WHY IT EXISTS: `user.role` is resolved at the caller's ACTIVE location
 * (resolveActiveLocationRole, with a highest-role-anywhere fallback), so a
 * `MANAGER_ROLES.includes(user.role)` check on a route that writes to a
 * PATH-PARAM location judges the wrong studio — a manager at Stillorgan who
 * is plain staff at Hatch passed it while acting on Hatch. Pass the target
 * id, never `user.activeLocation?.id`.
 *
 * Master bypass reads `profileRole` (the estate-level role on `profiles`),
 * NOT `user.role` — the same bypass `guardMasterOrOwner` uses. `user.role`
 * can read 'master' by fallback resolution, and a per-location row is not
 * where mastership lives; masters have no `rolesByLocation` entries at all.
 *
 * Fails CLOSED: a null user, a missing/blank locationId, or no per-location
 * role at the target all answer false. Note this differs from
 * assertLocationAccess, where a null locationId means "no specific location"
 * and passes — here a missing target means the caller's role cannot be
 * judged, which must never read as permission.
 *
 * MEMBERSHIP IS A SEPARATE QUESTION. Run assertLocationAccess (or
 * assertLocationAccessOr404 on a detail route) FIRST, so a caller who is not
 * at the location at all is told that, rather than getting a role complaint
 * that confirms the location exists.
 *
 * Usage:
 *   const guard = assertLocationAccess(user, locationId)
 *   if (guard) return guard
 *   if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
 *     return NextResponse.json({ success: false, error: '…' }, { status: 403 })
 *   }
 *
 * @param {{ profileRole?: string, rolesByLocation?: Record<string,string> } | null} user
 * @param {string | null | undefined} locationId  the TARGET location
 * @param {readonly string[]} allowedRoles
 * @returns {boolean}
 */
export function hasRoleAtLocation(user, locationId, allowedRoles) {
  if (!user || !locationId) return false
  if (user.profileRole === 'master') return true
  const role = user.rolesByLocation?.[locationId]
  if (!role) return false
  return (allowedRoles || []).includes(role)
}
