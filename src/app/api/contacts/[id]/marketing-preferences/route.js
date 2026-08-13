// Operator-facing marketing-preferences API for the contact profile.
//
// CONSENT.1 — pairs with ContactMarketingPreferencesCard.jsx. Lets
// master / owner-tier roles flip the three MARKETING channels for a
// contact (email_marketing, sms_marketing, whatsapp_marketing).
//
// Out of scope for this endpoint: the *_administrative flags
// (transactional / utility sends like booking confirmations,
// reminders, account updates). Operators almost never want to
// disable those, and the customer's own preference centre at
// /preferences/[token] already covers that case.
//
// Schema: writes to contact_preferences (mig 005, 063, 064). Mirrors
// the audit + side-effect logic in /api/preferences/[token] PUT so
// the consent_log row carries the same shape — just sourced as
// 'admin_panel' instead of 'preference_centre' and tagged with the
// acting profile_id.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { ADMIN_ROLES } from '@/lib/schemas'
import { getClientIp } from '@/lib/rate-limit'
import { consentActionFor } from '@/lib/consent-actions'
import { emailStatusNormaliseForOptIn } from '@/lib/email-reputation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  email_marketing:    z.boolean().optional(),
  sms_marketing:      z.boolean().optional(),
  whatsapp_marketing: z.boolean().optional(),
})

const ALLOWED_CHANNELS = ['email_marketing', 'sms_marketing', 'whatsapp_marketing']

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()

  // IDOR gate (2026-06 audit). Service-role client bypasses RLS, so
  // resolve the contact's studio and confirm it's one of the caller's
  // before returning consent state — same pattern as consent-log.
  //
  // HYGREL.1 — the deliverability columns ride along on the gate's existing
  // round trip. This endpoint returned consent and nothing else, so the card
  // above it could render "Email marketing: ON" for a contact that no send
  // would ever reach: email_suppressed_at (mig 395) and email_status are
  // separate gates in buildAudienceQuery, and neither was on screen anywhere on
  // the contact record. 1,128 contacts were in exactly that state on
  // 2026-08-12. Reading them here costs nothing and is what lets the card stop
  // lying.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('location_id, email_status, email_suppressed_at, email_hygiene_released_at')
    .eq('id', params.id)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('email_marketing, sms_marketing, whatsapp_marketing, email_administrative, sms_administrative, whatsapp_administrative, updated_at')
    .eq('contact_id', params.id)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // contact_preferences row is created on contact insert via trigger
  // (mig 005). If it's missing, return defaults — toggles will write
  // a fresh row on first save via upsert.
  return NextResponse.json({
    success: true,
    preferences: pref || {
      email_marketing: true,
      sms_marketing: true,
      whatsapp_marketing: true,
      email_administrative: true,
      sms_administrative: true,
      whatsapp_administrative: true,
      updated_at: null,
    },
    // HYGREL.1 — a SIBLING key, not folded into `preferences`. These are not
    // preferences and must not read as any: email_status is reputation and
    // email_suppressed_at is our hygiene call, neither of them the contact's
    // choice, and the one place this repo has already been bitten is code that
    // treated the two families as interchangeable (EMAILREP.2 put dead
    // mailboxes back in the audience by stamping reputation on a consent edit).
    // Read-only here on purpose: releasing a suppression is an operator action
    // with an audit trail, and it lives on the list-health page.
    deliverability: {
      email_status: contact.email_status || null,
      email_suppressed_at: contact.email_suppressed_at || null,
      email_hygiene_released_at: contact.email_hygiene_released_at || null,
    },
  })
}

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (!user.isMaster && !ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }

  const db = createServerClient()

  // IDOR gate (2026-06 audit) — confirm the contact is in one of the
  // caller's studios before mutating its consent / writing consent_log.
  // assertLocationAccess returns owned ∪ master; a contact owned by
  // another studio is a 403 even for an admin here.
  //
  // email_status rides along on the gate's existing round trip — the
  // EMAILREP.2 guard at the bottom needs the CURRENT reputation to decide
  // whether an opt-in may normalise it, and reading it here costs nothing.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('location_id, email_status')
    .eq('id', params.id)
    .maybeSingle()
  if (contactErr) {
    return NextResponse.json({ success: false, error: contactErr.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, contact.location_id)
  if (guard) return guard

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const ip = getClientIp(request)

  // Load current row so we only diff (avoids spurious consent_log
  // entries when the operator opens the panel + saves without changes).
  const { data: pref } = await db
    .from('contact_preferences')
    .select('id, email_marketing, sms_marketing, whatsapp_marketing')
    .eq('contact_id', params.id)
    .maybeSingle()

  const updates = {}
  const logEntries = []
  for (const channel of ALLOWED_CHANNELS) {
    if (typeof body[channel] !== 'boolean') continue
    const current = pref ? pref[channel] : true   // default for trigger-created row
    if (body[channel] === current) continue
    updates[channel] = body[channel]
    logEntries.push({
      contact_id: params.id,
      channel,
      action:  consentActionFor(body[channel]),
      source:  'admin_panel',
      ip_address: ip,
      performed_by: user.id || null,
    })
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true, message: 'No changes' })
  }
  updates.updated_at = new Date().toISOString()

  // Upsert by contact_id — the trigger should have created the row
  // already, but be defensive in case of an older contact whose
  // pre-trigger row never landed.
  const upsertRow = { contact_id: params.id, ...updates }
  const { error: writeErr } = await db
    .from('contact_preferences')
    .upsert(upsertRow, { onConflict: 'contact_id' })
  if (writeErr) {
    return NextResponse.json({ success: false, error: writeErr.message }, { status: 500 })
  }

  if (logEntries.length > 0) {
    await db.from('consent_log').insert(logEntries)
  }

  // EMAILREP.2 — contacts.email_status is REPUTATION, not consent, and this
  // route used to stamp it 'active' on ANY change to email_marketing. An
  // operator toggling a contact OFF therefore cleared a `bounced` /
  // `complained` flag, and that flag is a hard send-time gate:
  // buildAudienceQuery applies .not('email_status','in','("bounced",
  // "complained")') unconditionally, to administrative mail as well as
  // marketing. So a routine preference edit silently put dead and
  // complaining mailboxes back into the sendable audience (3 live rows;
  // mig 524 repairs them).
  //
  // The rule is now the shared one every other consent writer already used
  // (marketing-consent.js ×2, the bulk-import route): an opt-OUT never
  // touches reputation — it is fully recorded in contact_preferences +
  // consent_log above — and an opt-IN may only normalise legacy residue
  // (NULL / retired 'unsubscribed') to 'active'.
  //
  // EMAILREP.4 — consent from ANY source is subject to that rule, staff
  // toggle and customer preference centre alike. There used to be a carve-out
  // here claiming the customer centre was different because the contact
  // themselves re-consents; it wasn't, and the preference centre is now the
  // fourth caller of the shared helper. A click in an email that was
  // delivered BEFORE the bounce is not evidence the mailbox works NOW, and
  // Postmark keeps its own suppression list regardless of what this column
  // says. Reputation comes back via a corrected address
  // (emailStatusResetForAddressChange), real engagement, or a Postmark
  // un-suppression — never a consent write.
  if (updates.email_marketing === true) {
    const nextStatus = emailStatusNormaliseForOptIn(contact.email_status)
    if (nextStatus) {
      await db
        .from('contacts')
        .update({ email_status: nextStatus })
        .eq('id', params.id)
    }
  }

  return NextResponse.json({
    success: true,
    updated: Object.keys(updates).filter((k) => k !== 'updated_at'),
  })
}
