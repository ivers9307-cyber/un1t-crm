// POST /api/hosts/[id]/invite
//
// Provision host-portal access: create (or re-link) a Supabase auth user for
// the host + a host_users row, and email them a link to set their password.
// Manager+ (ADMIN_ROLES), org-scoped. (HOST-PORTAL.1)
//
// STAFF-XOR invariant (see host-auth.js): a host auth user must never also hold
// a profiles row. Two things enforce it:
//   1. mig 387 gates handle_new_user so a host-portal invite (invited_for=
//      'host-portal' metadata) creates NO profiles/profile_locations row.
//   2. This route, before linking host_users, refuses if the resolved auth user
//      already has a profiles row (a real staff account — inviteUserByEmail
//      returns 200 for an existing UNCONFIRMED user, so we can't rely on it
//      erroring) or is already linked to a different host.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  if (!host.email) {
    return NextResponse.json({ success: false, error: 'This host has no email on file — add one first.' }, { status: 400 })
  }

  const email = String(host.email).trim().toLowerCase()
  const redirectTo = `${getAppUrl()}/host/set-password`

  // New host → invite (creates the auth user + sends the set-password email).
  // NB: inviteUserByEmail returns 200 (not an error) for an EXISTING UNCONFIRMED
  // user too — including invited-but-unaccepted staff, who already carry a
  // profiles row (created by the DB trigger). So the success path must NOT
  // blindly link: verify the resolved auth user is not staff and not already
  // another host's login BEFORE writing host_users. (STAFF-XOR)
  const { data: inv, error: invErr } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { invited_for: 'host-portal', host_id: host.id },
  })
  if (!invErr && inv?.user?.id) {
    const authUserId = inv.user.id
    const { data: staffProfile } = await db.from('profiles').select('id').eq('id', authUserId).maybeSingle()
    if (staffProfile) {
      return NextResponse.json({
        success: false,
        error: 'That email is a UN1T staff account — use a different email for the host portal.',
      }, { status: 400 })
    }
    const { data: otherLink } = await db.from('host_users').select('host_id').eq('auth_user_id', authUserId).maybeSingle()
    if (otherLink && otherLink.host_id !== host.id) {
      return NextResponse.json({
        success: false,
        error: 'That email already belongs to another host portal login.',
      }, { status: 400 })
    }
    await db.from('host_users').upsert(
      { host_id: host.id, auth_user_id: authUserId, email },
      { onConflict: 'auth_user_id' },
    )
    return NextResponse.json({ success: true, data: { sentTo: email, kind: otherLink ? 'reinvite' : 'invited' } })
  }

  // Invite errored. If the email already has an account, either it's already a
  // portal user for THIS host (→ resend a set-password link) or it belongs to
  // someone else / a staff login (→ refuse; staff-XOR).
  if (invErr && /already (registered|exists|been registered)/i.test(invErr.message || '')) {
    const { data: link } = await db
      .from('host_users')
      .select('auth_user_id')
      .eq('host_id', host.id)
      .eq('email', email)
      .maybeSingle()
    if (link) {
      const { error: recErr } = await db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } })
      if (recErr) {
        logError('host-invite', 'resend recovery link failed', { err: recErr })
        return NextResponse.json({ success: false, error: recErr.message }, { status: 400 })
      }
      return NextResponse.json({ success: true, data: { sentTo: email, kind: 'reinvite' } })
    }
    return NextResponse.json({
      success: false,
      error: 'That email already has an account and isn’t linked to this host — use a different email for the host portal.',
    }, { status: 400 })
  }

  logError('host-invite', 'invite failed', { err: invErr })
  return NextResponse.json({ success: false, error: invErr?.message || 'Could not send the invite.' }, { status: 400 })
}
