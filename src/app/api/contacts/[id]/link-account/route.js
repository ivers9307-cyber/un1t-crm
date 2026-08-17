// /api/contacts/[id]/link-account — REPSET-P5 admin contact-linking tool.
//
//   GET    — current app-account link state for the contact (masked email
//            of the linked auth user + staff-profile flag). With ?email=
//            it also performs an EXACT-email auth-user search (the link
//            dialog's find step). Exact equality only, case-insensitive —
//            never a fuzzy listing of auth users, and the raw email is
//            never returned (masked via maskEmail).
//   POST   — link contacts.user_id to an EXISTING auth user.
//            Body: { userId, confirm: true } — confirm is the UI's
//            deliberate-action field and is schema-required.
//   DELETE — unlink. Body: { confirm: true }.
//
// Why this exists (Richard's locked decision, 17 Aug 2026): staff never
// self-link their member contact. The merged Repset app hard-disables
// self-linking whenever has_ever_been_staff is set (mobile/lib/identity.js)
// — an admin performs the link from the CRM instead. The target auth user
// may therefore be a staff profile's user (the dual staff+member case —
// the whole point of the tool) or a member-only auth user.
//
// Deliberately NOT here:
//   - auth-user creation (that's /api/contacts/[id]/invite-app — this
//     route 404s when the target auth user doesn't exist)
//   - bulk linking
//   - relink-in-one-step: an already-linked contact returns 409 with the
//     current state; the admin unlinks first (two deliberate steps)
//
// Authorization: master/owner ONLY (same bar as the password-override
// tool) + location scoping via assertLocationAccessOr404 (404, not 403,
// so contact ids can't be enumerated).
//
// Audit: mirrors the support-session pattern — logAuditEvent (category
// 'auth'), fire-and-forget. audit_events.target_profile_id has an FK to
// profiles, so target.id is only set when the auth user actually has a
// staff profile; a member-only auth user's identity rides in details.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { maskEmail } from '@/lib/audience-preview'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LinkBodySchema = z.object({
  userId: uuidLike,
  // The UI sends this explicitly from the confirm dialog — a missing or
  // false confirm is a 400, so no client can link by accident.
  confirm: z.literal(true),
})

const UnlinkBodySchema = z.object({
  confirm: z.literal(true),
})

// Master/owner only. `user.role` is 'master' for master users (auth.js
// pins that), but keep the isMaster check too so the gate can never
// widen if role derivation changes.
function requireAdmin(user) {
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!user.isMaster && user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }
  return null
}

// Load the contact + run the location guard. Returns { contact } or
// { response } (404 for missing contact OR out-of-scope location).
async function loadContact(db, user, id) {
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, name, email, location_id, user_id')
    .eq('id', id)
    .single()
  if (error || !contact) {
    return { response: NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 }) }
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return { response: guard }
  return { contact }
}

// Masked view of an auth user + its staff profile (if any). profiles.id
// IS the auth user id in this estate, so one maybeSingle answers the
// dual-case question. 0 rows is the normal member-only answer.
async function describeAuthUser(db, authUser) {
  const { data: profile } = await db
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', authUser.id)
    .maybeSingle()
  return {
    userId: authUser.id,
    maskedEmail: maskEmail(authUser.email),
    staff: profile ? { fullName: profile.full_name, role: profile.role } : null,
  }
}

// Exact-email auth-user lookup. gotrue-js exposes no server-side email
// filter on listUsers, so we paginate and match with strict equality
// (lowercased — auth emails are stored lowercased, but don't rely on it).
// NOT .ilike-shaped: no pattern semantics, no fuzzy results. The page cap
// bounds the worst case; this is a rare admin action.
async function findAuthUserByEmail(db, email) {
  const wanted = email.trim().toLowerCase()
  const perPage = 1000
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage })
    if (error) throw new Error(error.message)
    const users = data?.users || []
    const hit = users.find((u) => (u.email || '').toLowerCase() === wanted)
    if (hit) return hit
    if (users.length < perPage) break
  }
  return null
}

async function currentAccountState(db, contact) {
  if (!contact.user_id) return { linked: false, account: null }
  const { data, error } = await db.auth.admin.getUserById(contact.user_id)
  if (error || !data?.user) {
    // Dangling link (auth user deleted underneath us) — report it so the
    // admin can unlink; never pretend it's healthy.
    return { linked: true, account: { userId: contact.user_id, maskedEmail: null, staff: null, missing: true } }
  }
  return { linked: true, account: await describeAuthUser(db, data.user) }
}

// ============================================================
// GET — link state (+ ?email= exact search)
// ============================================================
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = requireAdmin(user)
  if (denied) return denied

  const db = createServerClient()
  const { contact, response } = await loadContact(db, user, params.id)
  if (response) return response

  const state = await currentAccountState(db, contact)

  const url = new URL(request.url)
  const email = url.searchParams.get('email')
  let search
  if (email !== null) {
    const trimmed = email.trim()
    // Minimal shape check — exact match against a non-address can never
    // hit, so refuse it loudly instead of returning a misleading miss.
    if (!trimmed || !trimmed.includes('@') || trimmed.includes(' ')) {
      return NextResponse.json({ success: false, error: 'Enter a full email address' }, { status: 400 })
    }
    const hit = await findAuthUserByEmail(db, trimmed)
    search = hit ? { found: true, ...(await describeAuthUser(db, hit)) } : { found: false }
  }

  return NextResponse.json({ success: true, data: { ...state, ...(search ? { search } : {}) } })
}

// ============================================================
// POST — link contacts.user_id → an existing auth user
// ============================================================
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = requireAdmin(user)
  if (denied) return denied

  const validation = await validateBody(request, LinkBodySchema)
  if (!validation.ok) return validation.response
  const { userId } = validation.data

  const db = createServerClient()
  const { contact, response } = await loadContact(db, user, params.id)
  if (response) return response

  // Already linked → 409 with the current state. Unlink first: the
  // two-step is deliberate, so a relink is never a one-click overwrite.
  if (contact.user_id) {
    const state = await currentAccountState(db, contact)
    return NextResponse.json(
      { success: false, error: 'Contact already has a linked app account — unlink it first', data: state },
      { status: 409 }
    )
  }

  // The target auth user must EXIST — this tool never creates one.
  const { data: got, error: userErr } = await db.auth.admin.getUserById(userId)
  if (userErr || !got?.user) {
    return NextResponse.json({ success: false, error: 'Auth user not found' }, { status: 404 })
  }
  const authUser = got.user

  // One auth user ↔ one contact per location. A second contact for the
  // same person is what person-groups (/link) are for, not a second
  // user_id link.
  const { data: holders, error: holderErr } = await db
    .from('contacts')
    .select('id, name')
    .eq('user_id', userId)
    .eq('location_id', contact.location_id)
    .neq('id', contact.id)
    .limit(1)
  if (holderErr) {
    return NextResponse.json({ success: false, error: holderErr.message }, { status: 500 })
  }
  if ((holders || []).length > 0) {
    return NextResponse.json(
      {
        success: false,
        error: 'This app account is already linked to another contact — unlink it there first',
        data: { conflictContactId: holders[0].id, conflictContactName: holders[0].name },
      },
      { status: 409 }
    )
  }

  const account = await describeAuthUser(db, authUser)

  const { error: writeErr } = await db
    .from('contacts')
    .update({ user_id: userId })
    .eq('id', contact.id)
  if (writeErr) {
    return NextResponse.json({ success: false, error: writeErr.message }, { status: 500 })
  }

  // Fire-and-forget audit (logAuditEvent never throws). target.id only
  // when the auth user has a staff profile — audit_events.target_profile_id
  // FKs profiles, and a member-only auth user id would silently drop the row.
  await logAuditEvent({
    category: 'auth',
    action: 'contact.app_account_linked',
    actor: user.id ? { id: user.id, full_name: user.full_name, email: user.email } : null,
    target: {
      ...(account.staff ? { id: authUser.id } : {}),
      label: contact.name || contact.email || contact.id,
      resource: `contacts/${contact.id}`,
    },
    locationId: contact.location_id,
    details: {
      auth_user_id: authUser.id,
      masked_email: account.maskedEmail,
      staff_profile: Boolean(account.staff),
    },
    request,
  })

  return NextResponse.json({ success: true, data: { linked: true, account } })
}

// ============================================================
// DELETE — unlink
// ============================================================
export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const denied = requireAdmin(user)
  if (denied) return denied

  const validation = await validateBody(request, UnlinkBodySchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { contact, response } = await loadContact(db, user, params.id)
  if (response) return response

  if (!contact.user_id) {
    return NextResponse.json({ success: false, error: 'Contact has no linked app account' }, { status: 400 })
  }

  const { error: writeErr } = await db
    .from('contacts')
    .update({ user_id: null })
    .eq('id', contact.id)
  if (writeErr) {
    return NextResponse.json({ success: false, error: writeErr.message }, { status: 500 })
  }

  await logAuditEvent({
    category: 'auth',
    action: 'contact.app_account_unlinked',
    actor: user.id ? { id: user.id, full_name: user.full_name, email: user.email } : null,
    target: {
      label: contact.name || contact.email || contact.id,
      resource: `contacts/${contact.id}`,
    },
    locationId: contact.location_id,
    details: { auth_user_id: contact.user_id },
    request,
  })

  return NextResponse.json({ success: true, data: { linked: false, account: null } })
}
