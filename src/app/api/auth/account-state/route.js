// GET /api/auth/account-state — ACTIVEUSER.1.
//
// "My Supabase session is valid, so why am I on /login?" A deactivated staff
// member is the first state in the app where the SESSION is good and the
// PROFILE is unusable on purpose (a tombstone's auth user is banned, so its
// session simply dies). getCurrentUser() answers null for them, every gated
// page redirects to /login, and /login used to say nothing: the person signed
// in again, was bounced again, and had no way to know why. The login page asks
// this route and, on `deactivated`, clears the local session and says so.
//
// It answers about the CALLER'S OWN session only (the profile read is keyed on
// the session's user id, nothing caller-supplied), so it is no oracle for
// "is this email a staff account". It is not in the proxy's publicPaths, so it
// is only reachable with a valid Supabase session to begin with.
//
// States:
//   active       getCurrentUser() resolves — nothing to explain
//   signed_out   no Supabase session
//   deactivated  valid session, own profile has active=false (not a tombstone)
//   unknown      anything else: no staff profile (a member or host login), a
//                tombstone, or a profile we could not read. Never a guess —
//                the login page only acts on `deactivated`.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, createAuthClient } from '@/lib/auth'
import { isTombstone } from '@/lib/staff-tombstone'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const answer = (state) => NextResponse.json({ success: true, data: { state } })

export async function GET() {
  const user = await getCurrentUser()
  if (user) return answer('active')

  let sessionUser = null
  try {
    const supabase = await createAuthClient()
    const { data } = await supabase.auth.getUser()
    sessionUser = data?.user || null
  } catch {
    sessionUser = null
  }
  if (!sessionUser) return answer('signed_out')

  const db = createServerClient()
  // .maybeSingle(): zero rows is a legitimate answer (a member or host login
  // has no profiles row).
  const { data: profile, error } = await db
    .from('profiles')
    .select('id, active, deleted_at')
    .eq('id', sessionUser.id)
    .maybeSingle()
  if (error) {
    logError('account-state', 'could not read own profile', { err: error })
    return answer('unknown')
  }
  // Strictly `=== false`, as in getCurrentUser().
  if (profile && !isTombstone(profile) && profile.active === false) return answer('deactivated')
  return answer('unknown')
}
