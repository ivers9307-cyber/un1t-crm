// src/app/api/locations/[id]/whatsapp/embedded-signup/route.js
//
// WA-TECHPROV.3 — Embedded Signup v4 launch config, location-scoped.
//
// GET  → launch config for the "Connect with WhatsApp" button:
//        { configured, app_id, config_id }. Reports configured:false
//        instead of throwing.
// POST → RETIRED (WAORGNUMBER.1): Embedded Signup runs at the organisation
//        now — POST /api/organizations/[id]/whatsapp/embedded-signup. Answers
//        410 with a pointer to /settings/whatsapp-numbers.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { numbersMovedToOrganisation } from '@/lib/org-whatsapp-numbers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  return numbersMovedToOrganisation()
}
