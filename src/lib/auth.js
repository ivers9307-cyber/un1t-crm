import * as React from 'react'
import { createClient } from '@supabase/supabase-js'
import { createServerClient as createSSRClient } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'

// React 18's `cache()` is only exported from the server build of react.
// In the Vitest (Node) environment we get the client build which omits
// it, so fall back to identity. In production Next.js renders server
// components against react/server which has cache, so the dedupe
// behaviour we actually want kicks in there.
const cache = typeof React.cache === 'function' ? React.cache : (fn) => fn

// Auth-aware server client for SSR pages (reads session from cookies)
export function createAuthClient() {
  const cookieStore = cookies()
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
    auth = headers().get('authorization') || ''
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

// Get current user profile with permissions and location.
//
// Auth source priority:
//   1. Authorization: Bearer <supabase_jwt>  (iOS mobile app)
//   2. SSR session cookies                   (web browser)
//
// In either case, the rest of the function is identical — load the
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
  // the cookie-based session (web).
  let user = await getUserFromBearer()
  if (!user) {
    const supabase = createAuthClient()
    const result = await supabase.auth.getUser()
    user = result.data.user
  }
  if (!user) return null

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Profile fetch + lazy impersonation cookie import in parallel.
  // We can't fetch the impersonation TARGET in parallel because we
  // don't know whether to fetch it until realProfile is loaded
  // (only masters can impersonate), but the cookie read is cheap and
  // doesn't depend on the profile fetch.
  const [{ data: realProfile }, { readImpersonationCookie }] = await Promise.all([
    db.from('profiles').select('*').eq('id', user.id).single(),
    import('./impersonation.js'),
  ])

  if (!realProfile) return null

  // Master impersonation (mig 035). If a `un1t_impersonate` cookie
  // is set AND the underlying session belongs to a master, swap to
  // the target profile so the rest of the app sees what they'd see.
  // The original master identity is exposed as `impersonatingFrom`
  // so the banner / debug tools can show it.
  let profile = realProfile
  let impersonatingFrom = null
  if (realProfile.role === 'master') {
    const targetId = readImpersonationCookie()
    if (targetId && targetId !== realProfile.id) {
      const { data: target } = await db
        .from('profiles')
        .select('*')
        .eq('id', targetId)
        .single()
      if (target) {
        profile = target
        impersonatingFrom = {
          masterId: realProfile.id,
          masterName: realProfile.full_name,
          masterEmail: realProfile.email,
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

  const [{ data: locationLinks }, { data: allLocs }] = await Promise.all([
    linksPromise,
    allLocsPromise,
  ])

  let locations = (locationLinks || []).map(pl => pl.locations).filter(Boolean)

  // Master role bypasses profile_locations — they see every active
  // location automatically. RLS already short-circuits via
  // private.auth_is_master() — this just makes the in-memory user
  // object reflect the same reality.
  if (profile.role === 'master' && allLocs) {
    locations = allLocs
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
    const headerVal = headers().get('x-active-location') || ''
    headerLocation = headerVal ? locations.find(l => l.id === headerVal) : null
  } catch {
    // headers() throws outside a request scope; ignore.
  }

  const cookieStore = cookies()
  const locationCookie = cookieStore.get('un1t_active_location')?.value
  const cookieLocation = locationCookie
    ? locations.find(l => l.id === locationCookie)
    : null

  const defaultLink = (locationLinks || []).find(pl => pl.is_default)
  const activeLocation =
    headerLocation || cookieLocation || defaultLink?.locations || locations[0] || null

  return {
    ...profile,
    user,
    locations,
    activeLocation,
    // Set when a master is impersonating another user. The banner
    // + the API endpoints / sidebar entries read this to show the
    // 'Stop impersonating' UI and to know who the real caller is
    // for audit purposes.
    impersonatingFrom,
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
