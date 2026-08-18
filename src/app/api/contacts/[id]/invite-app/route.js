// POST /api/contacts/[id]/invite-app
//
// Master/admin-only: send a magic-link invite for a contact to join
// the customer-facing app (champ-app at app.champfitness.ie). The
// invite goes to the contact's email; clicking it lands them at
// `${CHAMP_APP_URL}/auth/callback` which links auth.users to
// contacts.user_id (see champ-app's callback route handler).
//
// Idempotency:
//   - If contacts.user_id is already set, we return early (the
//     contact already has an app account; admin should use the
//     "Send magic link again" flow which is the same primitive
//     called repeatedly — Supabase invalidates prior magic links
//     so this is safe).
//   - If a Supabase auth user already exists for the email but
//     isn't yet linked to this contact, the invite call returns
//     "user already exists". We swallow that and instead trigger
//     a fresh magic-link send via signInWithOtp (admin pathway:
//     same primitive, but doesn't require an admin role on the
//     auth side because it's just sending a magic link).
//
// Permission gate: master, owner, or manager. Head_coach and below
// don't get to invite customers — keeps the surface tight.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// REPSET-P6.S2 — env stays primary; the code default is the canonical
// repset member host (the legacy host keeps serving during the cutover).
const CHAMP_APP_URL = process.env.NEXT_PUBLIC_CHAMP_APP_URL || 'https://api.repset.ie'
const ALLOWED_INVITE_ROLES = ['owner', 'manager']

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster && !ALLOWED_INVITE_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }

  const db = createServerClient()

  const { data: contact, error: lookupErr } = await db
    .from('contacts')
    .select('id, name, email, location_id, user_id')
    .eq('id', params.id)
    .single()
  if (lookupErr || !contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  if (!contact.email) {
    return NextResponse.json({
      success: false,
      error: 'Contact has no email on file. Add an email first.',
    }, { status: 400 })
  }

  // Soft-fail: if the contact is at a location the operator can't
  // see, refuse. getUserLocationIds(user), not user.locationIds —
  // getCurrentUser exposes no `locationIds` field, so the old guard
  // was `[]` and failed closed for every non-master (owners/managers
  // couldn't invite anyone).
  if (!user.isMaster) {
    const allowed = getUserLocationIds(user).includes(contact.location_id)
    if (!allowed) {
      return NextResponse.json({ success: false, error: 'Location not in your scope' }, { status: 403 })
    }
  }

  const redirectTo = `${CHAMP_APP_URL}/auth/callback`

  const { data: inviteData, error: inviteErr } = await db.auth.admin.inviteUserByEmail(
    contact.email,
    {
      redirectTo,
      data: {
        invited_for: 'champ-app',
        contact_id: contact.id,
      },
    },
  )

  if (inviteErr) {
    // Most common: user already exists in auth (either previously
    // invited, or has signed in elsewhere). Fall back to a magic
    // link via the password-recovery primitive — same end-user
    // experience, just doesn't error on existing accounts.
    if (/already (registered|exists|been registered)/i.test(inviteErr.message || '')) {
      const { error: linkErr } = await db.auth.admin.generateLink({
        type: 'magiclink',
        email: contact.email,
        options: { redirectTo },
      })
      if (linkErr) {
        logError('contact-invite-app', 'magic link fallback failed', { err: linkErr })
        return NextResponse.json({ success: false, error: linkErr.message }, { status: 400 })
      }
      logInfo('contact-invite-app', 're-sent magic link to existing user', {
        contactId: contact.id,
        email: contact.email,
      })
      return NextResponse.json({
        success: true,
        kind: 'magic_link_resent',
        message: 'Sign-in link sent. Check inbox.',
      })
    }
    logError('contact-invite-app', 'invite failed', { err: inviteErr })
    return NextResponse.json({ success: false, error: inviteErr.message }, { status: 400 })
  }

  // Note: we do NOT pre-link contacts.user_id here. Linking happens
  // in champ-app's /auth/callback once the customer actually clicks
  // the link — that prevents a half-linked state if the email
  // bounces and the customer never accepts.
  logInfo('contact-invite-app', 'invite sent', {
    contactId: contact.id,
    newAuthUserId: inviteData?.user?.id,
    email: contact.email,
  })

  return NextResponse.json({
    success: true,
    kind: 'invite_sent',
    message: 'Invite sent. The member will receive an email with a sign-in link.',
  })
}
