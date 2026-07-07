// POST /api/public/host-connect/[token]/start
//
// Public — token-gated. The host clicked "Connect Stripe" on the self-serve
// page: create their connected account (first time) and mint a hosted
// onboarding Account Link, returned for the browser to redirect to. The Account
// Link is minted HERE (within the token-page session) and never emailed —
// Stripe-compliant. (EVENTS-HOST.5)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getAppUrl } from '@/lib/app-url'
import { verifyHostOnboardingToken } from '@/lib/host-onboarding-tokens'
import { createConnectedAccount, createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const payload = secret ? verifyHostOnboardingToken(params.token, secret) : null
  if (!payload) {
    return NextResponse.json({ success: false, error: 'This onboarding link is invalid or has expired.' }, { status: 400 })
  }
  const db = createServerClient()
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, email, payment_provider, stripe_connected_account_id')
    .eq('id', payload.hostId)
    .maybeSingle()
  if (!host || host.payment_provider !== 'stripe_connect') {
    return NextResponse.json({ success: false, error: 'Host not found.' }, { status: 404 })
  }

  try {
    let accountId = host.stripe_connected_account_id
    if (!accountId) {
      accountId = await createConnectedAccount({ name: host.name, email: host.email, hostId: host.id })
      const { error: upErr } = await db
        .from('event_hosts')
        .update({ stripe_connected_account_id: accountId })
        .eq('id', host.id)
      if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
    }
    const base = getAppUrl()
    const url = await createOnboardingLink({
      accountId,
      refreshUrl: `${base}/api/public/host-connect/${params.token}/refresh`,
      returnUrl: `${base}/host-connect/${params.token}?done=1`,
    })
    return NextResponse.json({ success: true, data: { url } })
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `Stripe onboarding failed: ${e.message || 'unknown'}` },
      { status: 502 },
    )
  }
}
