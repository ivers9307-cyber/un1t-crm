// POST /api/staff/[id]/send-password-reset
//
// Master/admin-only: send a password reset email to the named staff
// member. Wraps Supabase's `auth.admin.generateLink({ type: 'recovery' })`
// — same primitive the login page's "Forgot password?" link uses, just
// initiated by an admin against another user.
//
// Use cases:
//   - User missed the original invite email → admin re-sends to give
//     them a fresh link to set their initial password
//   - User forgot their password and wants admin help (or can't access
//     the login flow themselves)
//   - Suspected credential compromise — admin nukes the password and
//     forces a fresh one
//
// The email itself comes from Supabase's built-in template (Auth →
// Email Templates → Reset Password in the Supabase dashboard). To
// brand it via Postmark instead, swap to `auth.admin.generateLink`
// + a Postmark transactional send. Out of scope for v1.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getAppUrl } from '@/lib/app-url'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Master OR owner-tier at the active location can trigger a reset.
  // Same gate as staff create — admin operations require admin role.
  if (!user.isMaster && !ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: target, error: lookupErr } = await db
    .from('profiles')
    .select('id, email, full_name, active, profile_locations(location_id)')
    .eq('id', params.id)
    .single()
  if (lookupErr || !target) {
    return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 })
  }
  // Service-role read bypasses RLS — an admin must only be able to reset
  // a staffer who shares one of their locations, else a manager could
  // reset ANY user's password estate-wide. 404 (not 403) so the caller
  // can't enumerate which profile ids exist at other locations. Masters
  // bypass (platform-wide).
  if (!user.isMaster) {
    const callerLocations = new Set((user.locations || []).map(l => l.id))
    const targetLocations = (target.profile_locations || []).map(l => l.location_id)
    const overlap = targetLocations.some(l => callerLocations.has(l))
    if (!overlap) {
      return NextResponse.json({ success: false, error: 'Staff member not found' }, { status: 404 })
    }
  }
  if (!target.email) {
    return NextResponse.json({
      success: false,
      error: 'No email on file for this staff member.',
    }, { status: 400 })
  }
  if (!target.active) {
    return NextResponse.json({
      success: false,
      error: 'Staff member is deactivated. Reactivate before sending a password reset.',
    }, { status: 409 })
  }

  // Build the redirect URL. Falls back to Supabase's dashboard-configured
  // Site URL if NEXT_PUBLIC_APP_URL isn't set (won't happen in prod but
  // defensive).
  let redirectTo
  try {
    redirectTo = `${getAppUrl()}/reset-password`
  } catch {
    redirectTo = undefined
  }

  // resetPasswordForEmail dispatches the standard Supabase recovery
  // email. The user clicks the link, lands on /reset-password with a
  // recovery token, and sets their new password.
  const { error: sendErr } = await db.auth.resetPasswordForEmail(
    target.email,
    redirectTo ? { redirectTo } : undefined,
  )
  if (sendErr) {
    return NextResponse.json({
      success: false,
      error: `Failed to send reset email: ${sendErr.message}`,
    }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    sent_to: target.email,
    message: `Password reset email sent to ${target.email}.`,
  })
}
