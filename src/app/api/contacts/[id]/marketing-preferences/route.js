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
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('location_id')
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
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('location_id')
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

  // Mirror the customer preference centre's side-effect: when
  // email_marketing flips to false, set contacts.email_status to
  // 'unsubscribed' so the broadcast/audience builder filters
  // correctly (some queries gate on email_status rather than the
  // contact_preferences flag).
  if (typeof updates.email_marketing === 'boolean') {
    await db
      .from('contacts')
      .update({ email_status: 'active' })   // LOCCOMMS.5 — reputation only; never stamp 'unsubscribed'
      .eq('id', params.id)
  }

  return NextResponse.json({
    success: true,
    updated: Object.keys(updates).filter((k) => k !== 'updated_at'),
  })
}
