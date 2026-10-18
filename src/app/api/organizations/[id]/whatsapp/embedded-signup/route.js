// src/app/api/organizations/[id]/whatsapp/embedded-signup/route.js
//
// WAORGNUMBER.1 (Task 5, R8) — Embedded Signup v4 exchange, at the
// ORGANISATION (it was studio-level as WA-TECHPROV.3).
//
// GET  → launch config for the "Connect with WhatsApp" button:
//        { configured, app_id, config_id }. Reports configured:false
//        instead of throwing (deliberate: the button renders a
//        "not configured" state; the no-silent-fallback rule applies
//        to the mutation path below, which DOES throw).
// POST → body { mode?, code, waba_id, phone_number_id?, home_location_id? }
//        from the ES dialog. mode = 'cloud_api' (default) | 'coexistence'.
//        Cloud API supplies phone_number_id from the session; coexistence
//        omits it and the route resolves it server-side from the WABA, skips
//        /register (the number is already live on the Business app), and
//        stores source='coexistence'. Orchestrates: code→business-token
//        exchange, ownership check against whatsapp_numbers (a number owned
//        by another ORGANISATION 409s BEFORE any Meta-side mutation), WABA
//        webhook subscription, conditional number registration (cloud_api
//        only), then upsert into whatsapp_numbers. Nothing persists unless
//        every Meta call succeeded — safe to re-run with a fresh code.
//        A number this organisation already holds is refreshed in place and
//        keeps its home studio. A NEW number needs home_location_id (a studio
//        of this organisation; 400 otherwise, checked before any Meta-side
//        mutation) and is switched on there by mig 743's AFTER INSERT trigger
//        (R1: this route never inserts the link row).
//
// Org-admin gated (assertOrganizationAdmin; a master passes).
// Design: docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.2.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertOrganizationAdmin } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { orgWhatsAppEmbeddedSignupSchema } from '@/lib/schemas'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import { requireHomeStudioInOrg, stampHomeLinkCreatedBy } from '@/lib/org-whatsapp-numbers'
import {
  exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber,
  needsRegistration, generatePin, registerNumber, planPersistence,
  buildSignupMeta, getWabaPhoneNumber, initialHistorySyncState,
} from '@/lib/whatsapp-embedded-signup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertOrganizationAdmin(user, params.id)
  if (guard) return guard

  const appId = process.env.WHATSAPP_APP_ID || null
  const configId = process.env.WHATSAPP_ES_CONFIG_ID || null
  return NextResponse.json({
    success: true,
    data: { configured: Boolean(appId && configId), app_id: appId, config_id: configId },
  })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertOrganizationAdmin(user, params.id)
  if (guard) return guard

  const result = await validateBody(request, orgWhatsAppEmbeddedSignupSchema)
  if (!result.ok) return result.response
  const { mode, code, waba_id, phone_number_id: bodyPhoneNumberId, home_location_id: homeLocationId } = result.data

  const appId = process.env.WHATSAPP_APP_ID
  const appSecret = process.env.WHATSAPP_APP_SECRET
  const configId = process.env.WHATSAPP_ES_CONFIG_ID
  if (!appId || !appSecret || !configId) {
    return NextResponse.json(
      { success: false, error: 'Embedded Signup not configured (WHATSAPP_APP_ID / WHATSAPP_APP_SECRET / WHATSAPP_ES_CONFIG_ID).' },
      { status: 500 },
    )
  }

  const db = createServerClient()

  // The home studio is checked before the first Meta call: a bad one must not
  // cost a code exchange or leave a half-onboarded number.
  if (homeLocationId) {
    const home = await requireHomeStudioInOrg(db, params.id, homeLocationId)
    if (!home.ok) return home.response
  }

  // 1. code → business token. Nothing persists before step 4.
  let token
  try {
    token = await exchangeCodeForBusinessToken({ code, appId, appSecret })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Code exchange failed: ${e.message}` }, { status: 502 })
  }

  // Coexistence resolves the phone_number_id from the WABA (the number is
  // already registered on the Business app); Cloud API takes it from the body.
  let phone_number_id = bodyPhoneNumberId
  let coexistenceNumber = null
  if (mode === 'coexistence') {
    try {
      coexistenceNumber = await getWabaPhoneNumber({ wabaId: waba_id, token })
      phone_number_id = coexistenceNumber.phoneNumberId
    } catch (e) {
      return NextResponse.json({ success: false, error: `Coexistence phone-number lookup failed: ${e.message}` }, { status: 502 })
    }
  }
  if (!phone_number_id) {
    return NextResponse.json({ success: false, error: 'phone_number_id is required for Cloud API onboarding.' }, { status: 400 })
  }

  // Ownership check BEFORE any Meta-side mutation: a number already
  // connected to a different organisation must not have its webhooks
  // re-routed or get re-registered. Sits behind the successful code
  // exchange (proof the caller ran the ES dialog) so this route can't
  // be used to enumerate which phone_number_ids exist in the DB.
  // phone_number_id is globally unique (mig 176).
  const { data: existingRow, error: lookupError } = await db
    .from('whatsapp_numbers')
    .select('id, organization_id, location_id, signup_meta')
    .eq('phone_number_id', phone_number_id)
    .maybeSingle()
  if (lookupError) {
    return NextResponse.json({ success: false, error: lookupError.message }, { status: 500 })
  }

  const plan = planPersistence({ existingRow, organizationId: params.id })
  if (plan.action === 'conflict') {
    return NextResponse.json(
      { success: false, error: 'This phone number is already connected to a different organisation.' },
      { status: 409 },
    )
  }
  if (plan.action === 'insert' && !homeLocationId) {
    return NextResponse.json(
      { success: false, error: 'Choose a home studio for the new number.' },
      { status: 400 },
    )
  }

  // 2. Route the client WABA's webhooks to us.
  try {
    await subscribeAppToWaba({ wabaId: waba_id, token })
  } catch (e) {
    return NextResponse.json({ success: false, error: `WABA subscription failed: ${e.message}` }, { status: 502 })
  }

  // 3. Register only when needed (register is limited to 10/number/72h).
  //    Reuse the stored PIN when this number registered through us
  //    before — Meta requires the matching two-step PIN on /register.
  //    Coexistence numbers are already registered on the Business app —
  //    probing + /register is a Cloud-API-only concern and would be wrong here.
  let probe = null
  let pin = null
  if (mode === 'cloud_api') {
    try {
      probe = await probeNumber({ phoneNumberId: phone_number_id, token })
    } catch (e) {
      return NextResponse.json({ success: false, error: `Number probe failed: ${e.message}` }, { status: 502 })
    }
    if (needsRegistration(probe)) {
      pin = existingRow?.signup_meta?.pin || generatePin()
      try {
        await registerNumber({ phoneNumberId: phone_number_id, token, pin })
      } catch (e) {
        return NextResponse.json({ success: false, error: `Number registration failed: ${e.message}` }, { status: 502 })
      }
    }
  }

  // 4. Persist. buildSignupMeta preserves a previously-stored PIN when
  //    this connect didn't register (pin=null).
  const signupMeta = buildSignupMeta({
    wabaId: waba_id,
    pin,
    existingMeta: existingRow?.signup_meta,
    userId: user.id,
    probe,
    connectedAt: new Date().toISOString(),
  })

  if (mode === 'coexistence') {
    signupMeta.coexistence = true
    signupMeta.history_sync = existingRow?.signup_meta?.history_sync || initialHistorySyncState(new Date().toISOString())
  }
  const numberSource = mode === 'coexistence' ? 'coexistence' : 'cloud_api'

  if (plan.action === 'update') {
    const { data: updated, error } = await db
      .from('whatsapp_numbers')
      .update({
        access_token: token,
        token_type: 'business',
        connected_via: 'embedded_signup',
        signup_meta: signupMeta,
        business_account_id: waba_id,
        source: numberSource,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', plan.id)
      .eq('organization_id', params.id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: publicShape(updated) })
  }

  const { data: inserted, error: insertError } = await db
    .from('whatsapp_numbers')
    .insert({
      organization_id: params.id,
      location_id: homeLocationId,
      label: (probe?.verified_name) || coexistenceNumber?.verifiedName || `WhatsApp ${probe?.display_phone_number || coexistenceNumber?.displayPhone || phone_number_id}`,
      phone_number_id,
      business_account_id: waba_id,
      app_id: appId,
      access_token: token,
      display_phone: probe?.display_phone_number || coexistenceNumber?.displayPhone || null,
      source: numberSource,
      token_type: 'business',
      connected_via: 'embedded_signup',
      signup_meta: signupMeta,
      is_active: true,
    })
    .select('*')
    .single()
  if (insertError) {
    if (/duplicate key|unique constraint/i.test(insertError.message)) {
      const msg = /phone_number_id/i.test(insertError.message)
        ? 'This phone number was connected by a concurrent request — reload the numbers list.'
        : 'A WhatsApp number with this label already exists at that home studio — rename or remove it, then retry.'
      return NextResponse.json({ success: false, error: msg }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: insertError.message }, { status: 500 })
  }

  await stampHomeLinkCreatedBy(db, { numberId: inserted.id, locationId: inserted.location_id, userId: user.id })

  return NextResponse.json({ success: true, data: publicShape(inserted) })
}
