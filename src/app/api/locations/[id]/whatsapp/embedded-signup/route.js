// src/app/api/locations/[id]/whatsapp/embedded-signup/route.js
//
// WA-TECHPROV.3 — Embedded Signup v4 exchange, location-scoped.
//
// GET  → launch config for the "Connect with WhatsApp" button:
//        { configured, app_id, config_id }. Reports configured:false
//        instead of throwing (deliberate: the button renders a
//        "not configured" state; the no-silent-fallback rule applies
//        to the mutation path below, which DOES throw).
// POST → body { code, waba_id, phone_number_id } from the ES dialog.
//        Orchestrates: code→business-token exchange, ownership check
//        against whatsapp_numbers (a number owned by another location
//        409s BEFORE any Meta-side mutation), WABA webhook
//        subscription, conditional number registration, then upsert
//        into whatsapp_numbers. Nothing persists unless every Meta
//        call succeeded — safe to re-run with a fresh code.
//
// Master-or-owner gated, matching the numbers CRUD route.
// Design: docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.2.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import {
  exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber,
  needsRegistration, generatePin, registerNumber, planPersistence,
  buildSignupMeta,
} from '@/lib/whatsapp-embedded-signup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ExchangeSchema = z.object({
  code: z.string().min(1),
  waba_id: z.string().regex(/^\d+$/, 'waba_id must be a numeric Meta id'),
  phone_number_id: z.string().regex(/^\d+$/, 'phone_number_id must be a numeric Meta id'),
})

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
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
  const access = assertLocationAccess(user, params.id)
  if (access) return access
  const guard = guardMasterOrOwner(user, params.id)
  if (guard) return guard

  const result = await validateBody(request, ExchangeSchema)
  if (!result.ok) return result.response
  const { code, waba_id, phone_number_id } = result.data

  const appId = process.env.WHATSAPP_APP_ID
  const appSecret = process.env.WHATSAPP_APP_SECRET
  const configId = process.env.WHATSAPP_ES_CONFIG_ID
  if (!appId || !appSecret || !configId) {
    return NextResponse.json(
      { success: false, error: 'Embedded Signup not configured (WHATSAPP_APP_ID / WHATSAPP_APP_SECRET / WHATSAPP_ES_CONFIG_ID).' },
      { status: 500 },
    )
  }

  // 1. code → business token. Nothing persists before step 4.
  let token
  try {
    token = await exchangeCodeForBusinessToken({ code, appId, appSecret })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Code exchange failed: ${e.message}` }, { status: 502 })
  }

  // Ownership check BEFORE any Meta-side mutation: a number already
  // connected to a different location must not have its webhooks
  // re-routed or get re-registered. Sits behind the successful code
  // exchange (proof the caller ran the ES dialog) so this route can't
  // be used to enumerate which phone_number_ids exist in the DB.
  // phone_number_id is globally unique (mig 176).
  const db = createServerClient()
  const { data: existingRow, error: lookupError } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('phone_number_id', phone_number_id)
    .maybeSingle()
  if (lookupError) {
    return NextResponse.json({ success: false, error: lookupError.message }, { status: 500 })
  }

  const plan = planPersistence({ existingRow, locationId: params.id })
  if (plan.action === 'conflict') {
    return NextResponse.json(
      { success: false, error: 'This phone number is already connected to a different location.' },
      { status: 409 },
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
  let probe
  try {
    probe = await probeNumber({ phoneNumberId: phone_number_id, token })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Number probe failed: ${e.message}` }, { status: 502 })
  }
  let pin = null
  if (needsRegistration(probe)) {
    pin = existingRow?.signup_meta?.pin || generatePin()
    try {
      await registerNumber({ phoneNumberId: phone_number_id, token, pin })
    } catch (e) {
      return NextResponse.json({ success: false, error: `Number registration failed: ${e.message}` }, { status: 502 })
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

  if (plan.action === 'update') {
    const { data: updated, error } = await db
      .from('whatsapp_numbers')
      .update({
        access_token: token,
        token_type: 'business',
        connected_via: 'embedded_signup',
        signup_meta: signupMeta,
        business_account_id: waba_id,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', plan.id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: publicShape(updated) })
  }

  const { data: defaults, error: defaultsError } = await db
    .from('whatsapp_numbers')
    .select('id')
    .eq('location_id', params.id)
    .eq('is_default', true)
    .limit(1)
  if (defaultsError) {
    return NextResponse.json({ success: false, error: defaultsError.message }, { status: 500 })
  }

  const { data: inserted, error: insertError } = await db
    .from('whatsapp_numbers')
    .insert({
      location_id: params.id,
      label: probe.verified_name || `WhatsApp ${probe.display_phone_number || phone_number_id}`,
      phone_number_id,
      business_account_id: waba_id,
      app_id: appId,
      access_token: token,
      display_phone: probe.display_phone_number || null,
      source: 'cloud_api',
      token_type: 'business',
      connected_via: 'embedded_signup',
      signup_meta: signupMeta,
      is_default: !(defaults?.length),
      is_active: true,
    })
    .select('*')
    .single()
  if (insertError) {
    if (/duplicate key|unique constraint/i.test(insertError.message)) {
      return NextResponse.json(
        { success: false, error: 'This phone number was connected by a concurrent request — reload the numbers list.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ success: false, error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: publicShape(inserted) })
}
