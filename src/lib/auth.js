import { createClient } from '@supabase/supabase-js'
import { createServerClient as createSSRClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

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

// Get current user profile with permissions and location
export async function getCurrentUser() {
  const supabase = createAuthClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Get profile
  const { data: profile } = await db
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) return null

  // Get assigned locations
  const { data: locationLinks } = await db
    .from('profile_locations')
    .select('*, locations(*)')
    .eq('profile_id', user.id)

  const locations = (locationLinks || []).map(pl => pl.locations).filter(Boolean)

  // Check for location cookie (set by LocationSwitcher)
  const cookieStore = cookies()
  const locationCookie = cookieStore.get('un1t_active_location')?.value
  const cookieLocation = locationCookie
    ? locations.find(l => l.id === locationCookie)
    : null

  // Priority: cookie > default assignment > first location
  const defaultLink = (locationLinks || []).find(pl => pl.is_default)
  const activeLocation = cookieLocation || defaultLink?.locations || locations[0] || null

  return {
    ...profile,
    user,
    locations,
    activeLocation,
  }
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
