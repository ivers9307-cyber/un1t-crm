// GET /api/public/host-connect/[token]
//
// Public — token-gated. Read-only host status for the self-serve onboarding
// page. The signed token authenticates the caller as this host; only
// non-sensitive fields are returned. (EVENTS-HOST.5)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyHostOnboardingToken } from '@/lib/host-onboarding-tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const payload = secret ? verifyHostOnboardingToken(params.token, secret) : null
  if (!payload) {
    return NextResponse.json({ success: false, error: 'This onboarding link is invalid or has expired.' }, { status: 400 })
  }
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, payment_provider, charges_enabled, payouts_enabled, details_submitted, stripe_connected_account_id')
    .eq('id', payload.hostId)
    .maybeSingle()
  if (!host || host.payment_provider !== 'stripe_connect') {
    return NextResponse.json({ success: false, error: 'Host not found.' }, { status: 404 })
  }
  return NextResponse.json({
    success: true,
    data: {
      name: host.name,
      charges_enabled: !!host.charges_enabled,
      payouts_enabled: !!host.payouts_enabled,
      details_submitted: !!host.details_submitted,
      connected: !!host.stripe_connected_account_id,
    },
  })
}
