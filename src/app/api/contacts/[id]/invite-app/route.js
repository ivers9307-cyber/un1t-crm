// POST /api/contacts/[id]/invite-app
//
// Master/admin-only: send a magic-link invite for a contact to join
// the customer-facing app (champ-app at app.champfitness.ie). The
// invite goes to the contact's email; clicking it lands them at
// `${getMemberAppUrl()}/auth/callback` which links auth.users to
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
//     "user already exists". We then email a prompt to the member
//     app's sign-in page (APPINVITE.1, member-app-sign-in-email.js);
//     the member requests their own link there, in their own browser.
//
// Permission gate: master, owner, or manager. Head_coach and below
// don't get to invite customers — keeps the surface tight.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logInfo, logError } from '@/lib/log'
// URLSEAM.1 — the member app is a DIFFERENT deployment; its base is
// NEXT_PUBLIC_CHAMP_APP_URL, never this repo's NEXT_PUBLIC_APP_URL. One
// accessor so the three copies of the literal stop drifting apart.
import { getMemberAppUrl } from '@/lib/app-url'
import { sendMemberAppSignInEmail } from '@/lib/member-app-sign-in-email'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_INVITE_ROLES = ['owner', 'manager']

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // ROLESWEEP.1c — coarse pre-check; the role is judged at the contact's location below.
  if (!user.isMaster && !hasRoleAtAnyLocation(user, ALLOWED_INVITE_ROLES)) {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }

  const db = createServerClient()

  const { data: contact, error: lookupErr } = await db
    .from('contacts')
    .select('id, name, first_name, email, location_id, user_id')
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
  // ROLESWEEP.1c — owner/manager at the contact's location.
  if (!user.isMaster && !hasRoleAtLocation(user, contact.location_id, ALLOWED_INVITE_ROLES)) {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }

  const redirectTo = `${getMemberAppUrl()}/auth/callback`

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
      // APPINVITE.1 — this branch used to call admin.generateLink and report
      // "Sign-in link sent": generateLink only MINTS a link, Supabase sends
      // nothing, so the member got no email. A server-minted link also could
      // not complete the app's PKCE sign-in (see member-app-sign-in-email.js),
      // so we email a prompt to the app's sign-in page instead, where the
      // member requests their own link. Success only once Postmark accepts it.
      try {
        await sendMemberAppSignInEmail(db, {
          contact,
          signInUrl: `${getMemberAppUrl()}/login`,
        })
      } catch (err) {
        logError('contact-invite-app', 'sign-in prompt email failed', { contactId: contact.id, err: err?.message })
        return NextResponse.json({
          success: false,
          error: 'The sign-in email could not be sent. Try again shortly.',
        }, { status: 502 })
      }
      logInfo('contact-invite-app', 'sent sign-in prompt to existing user', {
        contactId: contact.id,
      })
      return NextResponse.json({
        success: true,
        kind: 'sign_in_prompt_sent',
        message: 'Sign-in email sent. They sign in at the app with this email address.',
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
