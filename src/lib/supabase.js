import { createClient } from '@supabase/supabase-js'
import { createServerClient as createSSRClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Browser client (uses anon key, respects RLS)
export function createBrowserClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

// Server client (uses service role key, bypasses RLS — for API routes and triggers)
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

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

  const db = createServerClient()

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
  const defaultLink = (locationLinks || []).find(pl => pl.is_default)
  const activeLocation = defaultLink?.locations || locations[0] || null

  return {
    ...profile,
    user,
    locations,
    activeLocation,
  }
}
